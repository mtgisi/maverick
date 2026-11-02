// Tool gating (LOCAL-BRAIN-SPEC 8.3).
//
// Sending all 21 tool schemas costs roughly 1,400-1,900 tokens and measurably degrades a
// small model's tool selection. Both problems have the same fix: send a subset.
//
// Selection is a deterministic keyword match over the user's message, NOT a model call. A
// router model call would double the latency to save tokens, which is the wrong trade at
// these speeds.

const registry = require('../tools/registry');
const { brain } = require('../config');

// Keyword table. Kept in one place and deliberately generous: a false positive costs a few
// hundred tokens, a false negative costs the model the tool it needed.
const KEYWORDS = {
  // FIRST on purpose: groups often tie on score ("how many calories have I had today" also
  // hits calendar on "today"), the sort is stable, and the loser of a tie misses the cap.
  // A message naming a health word is about health.
  // Phrases, not bare short words: plain includes() matching means 'ate' would hit "update"
  // and "late", and 'ran' would hit "grant".
  health: [
    'calorie', 'kcal', 'protein', 'breakfast', 'lunch', 'dinner', 'snack', 'i ate', 'just ate',
    'water', 'ounces', ' oz', 'steps', 'slept', 'sleep', 'weigh', 'weight', 'pounds', ' lbs',
    'workout', 'worked out', 'work out', 'gym', 'lifted', 'lifting', 'went for a run', 'cardio',
    'habit', 'meditat', 'log that', 'log it', 'undo that', 'scratch that', 'how am i doing',
    'accountab',
  ],
  calendar: [
    'calendar', 'schedule', 'event', 'events', 'meeting', 'meetings', 'appointment',
    'busy', 'free', 'agenda', 'booked', 'today', 'tomorrow', 'week', 'monday', 'tuesday',
    'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'what\'s on', 'whats on',
    // Plain speech for the same question, and the parts of a day a follow-up names.
    'docket', 'morning', 'afternoon', 'evening', 'tonight', 'rest of the day',
    'coming up', 'next up', 'later today', 'my day', 'on deck',
  ],
  mail: [
    // Keywords must be specific to mail. Bare 'reply', 'from', 'messages', 'sender' and
    // 'subject' were all here and are far too general: "reply with just the word ok"
    // matched on 'reply', which made the loop treat a trivial request as a mail question,
    // discard a correct answer, and force-fetch the inbox.
    'email', 'e-mail', 'emails', 'inbox', 'gmail', 'unread',
    'my mail', 'the mail', 'check mail', 'draft an', 'draft a', 'reply to', 'reply back',
    'send to', 'write to', 'message to', 'compose', 'heard from', 'hear from', 'catch me up',
    'anything come in', 'attachment',
  ],
  timeclock: [
    'timeclock', 'timesheet', 'clock in', 'clock out', 'clocked', 'clock-in', 'clock-out',
    'hours', 'payroll', 'shift', 'punch',
  ],
  tasks: [
    'task', 'tasks', 'todo', 'to-do', 'to do', 'due', 'done', 'finish', 'finished',
    'complete', 'completed', 'reschedule', 'assignment', 'checklist', 'supervisor',
    'working on', 'work on', 'priorit',
  ],
  workspace: [
    'drive', 'doc', 'docs', 'document', 'sheet', 'sheets', 'spreadsheet', 'slide', 'slides',
    'presentation', 'deck', 'file', 'files', 'folder',
  ],
  misc: [
    'bookmark', 'bookmarks', 'saved link', 'container', 'containers', 'docker', 'server status',
    'youtube', 'video', 'videos', 'watch a',
  ],
};

const ALWAYS = 'core';

// Groups used by the previous turn of a conversation, so a follow-up keeps the tools its
// subject needs.
//
// Without this, "what is on the docket today" matched calendar and answered correctly, then
// "and what about my afternoon" matched NOTHING (no calendar keyword in it), got core only,
// and the model invented two meetings rather than saying it could not check. A follow-up
// almost never restates its subject, so keyword matching alone cannot see it.
//
// In memory rather than persisted: it is a conversational hint, and losing it on restart
// just means the next message is matched on its own words, which is the old behaviour.
const recent = new Map();
const RECENT_MAX = 200;

function remember(conversationId, groups) {
  if (!conversationId) return;
  recent.delete(conversationId);              // re-insert so the Map stays LRU-ordered
  recent.set(conversationId, groups.filter(g => g !== ALWAYS));
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
}

const carried = conversationId => (conversationId && recent.get(conversationId)) || [];
const forget = conversationId => recent.delete(conversationId);

// Score a group by how many distinct keywords hit. Longer phrases score higher so
// "clock out" beats a bare "out".
function score(text, words) {
  let n = 0;
  for (const w of words) {
    if (text.includes(w)) n += w.includes(' ') ? 2 : 1;
  }
  return n;
}

// Pick the tool subset for a turn.
//
//   sticky: groups already used earlier in THIS turn. They stay available even if a later
//           round would not have matched them. Dropping a tool mid-turn strands the model
//           holding an id it can no longer spend.
function select(message, { sticky = [], conversationId = null } = {}) {
  const text = String(message || '').toLowerCase();

  const scored = Object.entries(KEYWORDS)
    .map(([group, words]) => ({ group, score: score(text, words) }))
    .filter(g => g.score > 0)
    .sort((a, b) => b.score - a.score);

  const size = gs => gs.reduce((n, g) => n + registry.byGroup(g).length, 0);

  // core and anything already used this turn are non-negotiable, and so is the single
  // best-matching group. The cap must never drop the group the user just asked for: core(4)
  // + tasks(5) is 9 against a cap of 8, and obeying the cap there means answering "what are
  // my open tasks" with no task tool at all. One extra schema costs ~80 tokens; losing the
  // matched group costs the answer.
  const groups = [ALWAYS, ...sticky.filter(g => g !== ALWAYS)];
  const top = scored.find(s => !groups.includes(s.group));
  if (top) groups.push(top.group);

  // Nothing in this message matched. Carry the previous turn's groups so a follow-up
  // ("and what about my afternoon", "what about tomorrow", "any others?") still has the
  // tools its subject needs. Only when nothing matched: a message that clearly names a new
  // subject should not drag the old one along.
  if (!scored.length) {
    for (const g of carried(conversationId)) if (!groups.includes(g)) groups.push(g);
  }

  // Any further matched group is optional and only joins if it fits under the cap.
  for (const g of scored.slice(0, 3)) {
    if (groups.includes(g.group)) continue;
    if (size([...groups, g.group]) > brain.maxToolsPerCall) continue;
    groups.push(g.group);
    break;   // at most two matched groups, per LOCAL-BRAIN-SPEC 8.3
  }

  remember(conversationId, groups);

  // Groups this message matched on its OWN words, separate from ones carried from the
  // previous turn. Callers use it to tell "the user just asked about the calendar" from
  // "the calendar happened to still be in scope", which are very different things.
  const matched = scored.map(x => x.group).filter(g => groups.includes(g));

  const tools = groups.flatMap(g => registry.byGroup(g));
  if (tools.length > brain.maxToolsPerCall) {
    console.log(`[brain] tool cap exceeded by design: ${tools.length} schemas for groups ${groups.join(',')}`);
  }
  return { groups, tools, matched };
}

// ollama /api/chat tool schema shape.
const toOllama = tools => tools.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.schema },
}));

// Groups that carry live data the model cannot know without asking. An answer about one of
// these that did not come from a tool call is fabricated, by definition.
const DATA_GROUPS = ['calendar', 'mail', 'timeclock', 'tasks', 'workspace', 'health'];

// The obvious read for each data group, used when the model asks about one and then does
// not call anything. Deterministic and read-only: no write tool is ever forced.
const PRIMARY_READ = {
  calendar: 'list_calendar_events',
  tasks: 'list_tasks',
  timeclock: 'get_timesheet',
  workspace: 'list_drive_files',
  mail: 'inbox_summary',
  health: 'health_today',
};

module.exports = { select, toOllama, KEYWORDS, DATA_GROUPS, PRIMARY_READ, forget, carried };
