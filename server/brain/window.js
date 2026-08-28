// What slice of the day a question is actually about.
//
// "What's on my schedule today" does not mean "list everything including the four things
// that already finished". It means what is LEFT. The tool was returning the whole day and
// the model was relaying it verbatim, so a question asked at 4pm answered with a 7:50am
// meeting.
//
// Deciding this is not the model's job, for the same reason resolving "tomorrow at 9" is
// not: it is a deterministic reading of the words, and a 7B gets it wrong often enough to
// matter. Node reads the intent, the tool filters, and the model only has to phrase what it
// is handed.
//
//   remaining  (DEFAULT) still to come, plus anything currently running
//   now        happening at this moment, plus the one just finishing and the one next up
//   next       the next thing only
//   past       already finished  ("what did I do today", "what was on earlier")
//   all        the whole day     ("everything today", "all day")
//   segment    a named part of the day (morning / afternoon / evening / tonight)

const { TZ } = require('../config');

// Ordered: the first match wins, so the more specific phrases come first.
const PATTERNS = [
  // Past tense is the signal, and it hides in more shapes than an explicit "what did I do":
  // "what is everything I did today" was falling through to the default and answering
  // "nothing still to come", which is the opposite of what was asked.
  ['past',  /\b(did i (do|have|go|attend)|i (did|had|went|attended)|what happened|what (was|were) (on|there|scheduled)|already (had|done|happened)|so far( today)?|earlier (today|on)|before now|up to now|been to)\b/i],
  ['now',   /\b(right now|happening now|currently|at the moment|on now|going on now|in progress)\b/i],
  ['next',  /\b(next up|what'?s next|coming up next|my next|the next (thing|event|meeting))\b/i],
  ['all',   /\b(all day|whole day|entire day|everything (today|on|scheduled|i have)|full (day|schedule)|the day'?s|both past and)\b/i],
];

// Local-day segments. Bounds are deliberately generous at the edges: "this evening" asked at
// 4:55pm should not exclude a 5pm thing.
const SEGMENTS = [
  ['morning',   /\b(morning|this am|before lunch)\b/i,                       0,    12],
  ['afternoon', /\b(afternoon|this pm|after lunch)\b/i,                      12,   17],
  ['evening',   /\b(evening|tonight|to-?night|after work|end of the day)\b/i, 17,   24],
];

// The local wall-clock hour, as a float, for an instant.
function localHour(date, timeZone = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map(x => [x.type, x.value]));
  const h = p.hour === '24' ? 0 : Number(p.hour);
  return h + Number(p.minute) / 60;
}

// Read the intent. `explicitDate` is true when the question named a day other than today,
// in which case "remaining" is meaningless and the whole day is wanted.
function resolve(message, { now = new Date(), timeZone = TZ, explicitDate = false } = {}) {
  const text = String(message || '');

  for (const [label, re, from, to] of SEGMENTS) {
    if (re.test(text)) return { window: 'segment', segment: { label, from, to } };
  }
  for (const [label, re] of PATTERNS) {
    if (re.test(text)) return { window: label, segment: null };
  }
  // A named day that is not today has no "remaining": you want all of it.
  return { window: explicitDate ? 'all' : 'remaining', segment: null };
}

const ms = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

// An event with no end time is assumed to run an hour, which is the common default and is
// only used to decide whether it is still "current".
const ASSUMED_MS = 60 * 60 * 1000;

// Split events into what the question asked for and what it did not. Returning BOTH lets the
// tool say "3 remaining, 4 already finished" rather than silently hiding half the day, which
// would be its own kind of wrong answer.
function apply(events, { window, segment }, { now = new Date(), timeZone = TZ } = {}) {
  const t = now.getTime();
  const all = events.filter(e => !e.error);
  if (window === 'all') return { kept: all, dropped: [], reason: null };

  const startOf = e => ms(e.start);
  const endOf = e => ms(e.end) || (startOf(e) != null ? startOf(e) + ASSUMED_MS : null);

  // All-day entries have no clock time. They belong to the day rather than to a moment, so
  // they survive every window except the ones that are explicitly about a point in time.
  const isAllDay = e => !!e.allDay;

  let keep;
  let reason;
  switch (window) {
    case 'past':
      keep = e => !isAllDay(e) && endOf(e) != null && endOf(e) <= t;
      reason = 'already finished';
      break;
    case 'now':
      // Currently running, plus the one just finished and the one next up: at 4:58 the
      // useful answer includes the thing ending at 5 and the thing starting at 5.
      keep = e => {
        if (isAllDay(e)) return true;
        const s = startOf(e), en = endOf(e);
        if (s == null) return false;
        return (s <= t && en > t) || Math.abs(s - t) < 30 * 60 * 1000 || (en > t - 30 * 60 * 1000 && en <= t);
      };
      reason = 'not happening around now';
      break;
    case 'next': {
      const upcoming = all.filter(e => !isAllDay(e) && startOf(e) != null && startOf(e) > t)
        .sort((a, b) => startOf(a) - startOf(b));
      const first = upcoming[0];
      return {
        kept: first ? [first] : [],
        dropped: all.filter(e => e !== first),
        reason: 'not the next thing',
      };
    }
    case 'segment': {
      const { from, to } = segment;
      keep = e => {
        if (isAllDay(e)) return true;
        const s = startOf(e);
        if (s == null) return false;
        const h = localHour(new Date(s), timeZone);
        return h >= from && h < to;
      };
      reason = `outside the ${segment.label}`;
      break;
    }
    case 'remaining':
    default:
      // Still to come, or running right now. A finished event is not on your schedule.
      keep = e => isAllDay(e) || (endOf(e) != null && endOf(e) > t);
      reason = 'already finished';
      break;
  }

  const kept = all.filter(keep);
  return { kept, dropped: all.filter(e => !kept.includes(e)), reason };
}

// How the tool should title the list, so the model cannot misreport the scope.
const HEADING = {
  remaining: 'STILL TO COME today',
  now: 'HAPPENING NOW (plus the one just finishing and the one next up)',
  next: 'NEXT UP',
  past: 'ALREADY FINISHED today',
  all: 'THE WHOLE DAY',
};
const heading = ({ window, segment }) =>
  window === 'segment' ? `THIS ${segment.label.toUpperCase()}` : (HEADING[window] || HEADING.remaining);

module.exports = { resolve, apply, heading, localHour, PATTERNS, SEGMENTS };
