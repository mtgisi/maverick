// The system prompt (LOCAL-BRAIN-SPEC 8.6).
//
// The Claude-era prompt was ~1,300 tokens of dense per-tool guidance, written for a model
// that reads all of it. Under gating the model sees at most 8 tool schemas, and the
// description next to the schema is what it actually attends to. So per-tool guidance moved
// into tool descriptions and this holds only four things:
//
//   who the assistant is and the voice rule  (kept verbatim; it is good and it is cheap)
//   current time, timezone, resolved times
//   three hard rules
//   the spaces list
//
// If a piece of guidance belongs to a specific tool, it goes in that tool's description,
// not here. Budget is 450 tokens.

const db = require('../db');
const { TZ, BRAND_NAME, OWNER_NAME } = require('../config');

function spacesLine() {
  let rows = [];
  try { rows = db.prepare('SELECT key, label FROM spaces ORDER BY sort ASC').all(); } catch (_) {}
  if (!rows.length) return '';
  const list = rows.map(r => `${r.key} (${r.label})`).join(', ');
  return `\nSpaces (tag memories/tasks with the matching key): ${list}.`;
}

// opts.resolvedTimes: the block from brain/time.js promptBlock(), or ''.
// opts.voice: true when the reply will be spoken aloud, which changes the formatting rule.
function build({ resolvedTimes = '', resolvedCalendars = '', voice = false } = {}) {
  const now = new Date();
  const nowLocal = now.toLocaleString('en-US', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const owner = (OWNER_NAME || '').trim();

  return [
    `You are ${BRAND_NAME}, ${owner ? `${owner}'s personal assistant` : 'a personal assistant'}. ` +
    `Address the user directly ("you"/"your"). Voice: crisp and certain, never chatty. ` +
    `Keep replies short and plain, usually a sentence or two. No filler, no exclamation-mark ` +
    `enthusiasm, no "great question". State what you did or what's true.`,

    `Current time: ${nowLocal} (${TZ}). Now in ISO-8601 UTC: ${now.toISOString()}.`,
    resolvedTimes,
    resolvedCalendars,

    // Formatting sits BEFORE the rules, not after. An earlier revision put an emphatic
    // OUTPUT FORMAT block last, on the theory that a 7B weights the end most heavily. It
    // does, and the cost was that the format rule displaced rule 1: the model stopped
    // calling list_tasks entirely and answered from nothing. Tool-calling is the rule that
    // must be last.
    //
    // It also carries NO example sentence. The earlier version illustrated the desired shape
    // with realistic-sounding task names, and the model recited them back as though they
    // were real data. Never put plausible fake content in a system prompt.
    voice
      ? `This reply will be spoken aloud. Write it the way you would say it: flowing sentences
with full stops, no markdown, no bullet points, no numbered lists, no headings, no code, no
URLs, no line breaks. Never begin a line with a dash, asterisk or digit. When a tool returns
several items, say how many there are and name a few in a sentence, then offer the rest.`
      : '',

    spacesLine(),

    `Rules, in order of importance:
1. When a request matches a tool, CALL THE TOOL. Every time. A reply about tasks, calendar,
   mail, timesheet, files or reminders that did not come from a tool call is wrong, even if
   it sounds right.
2. Never invent data. Names, counts, dates and ids come from tool results and nowhere else.
   If a tool returned nothing, say it returned nothing.
3. Say plainly when you could not do something, and why.`,
  ].filter(Boolean).join('\n\n');
}

module.exports = { build };
