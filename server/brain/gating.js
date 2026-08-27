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
  calendar: [
    'calendar', 'schedule', 'event', 'events', 'meeting', 'meetings', 'appointment',
    'busy', 'free', 'agenda', 'booked', 'today', 'tomorrow', 'week', 'monday', 'tuesday',
    'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'what\'s on', 'whats on',
  ],
  mail: [
    'email', 'e-mail', 'mail', 'draft', 'inbox', 'gmail', 'reply', 'send to', 'write to',
    'message to', 'compose',
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
function select(message, { sticky = [] } = {}) {
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

  // Any further matched group is optional and only joins if it fits under the cap.
  for (const g of scored.slice(0, 3)) {
    if (groups.includes(g.group)) continue;
    if (size([...groups, g.group]) > brain.maxToolsPerCall) continue;
    groups.push(g.group);
    break;   // at most two matched groups, per LOCAL-BRAIN-SPEC 8.3
  }

  const tools = groups.flatMap(g => registry.byGroup(g));
  if (tools.length > brain.maxToolsPerCall) {
    console.log(`[brain] tool cap exceeded by design: ${tools.length} schemas for groups ${groups.join(',')}`);
  }
  return { groups, tools };
}

// ollama /api/chat tool schema shape.
const toOllama = tools => tools.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.schema },
}));

module.exports = { select, toOllama, KEYWORDS };
