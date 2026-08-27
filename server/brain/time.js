// Resolve relative times in Node, not in the model (LOCAL-BRAIN-SPEC 8.5).
//
// This is not a nice-to-have. Measured against the live qwen2.5:7b on 2026-08-27, asking
// "remind me to call the dentist tomorrow at 9am" produced:
//
//     {"fire_at": "2023-10-10T09:00:00Z", "text": "Call the dentist"}
//
// Three years wrong, reproducibly, with the correct current time in the system prompt. A 7B
// does not do calendar arithmetic reliably no matter how the prompt is worded. The two
// places this matters most are reminders that fire at the wrong time and timesheet
// proposals that are simply wrong, so the arithmetic is taken away from the model entirely:
// Node resolves the phrases, the prompt hands over the answers, and handlers validate that
// what came back is plausible.

const chrono = require('chrono-node');
const { TZ } = require('../config');

// The UTC offset for a zone at a given instant, in minutes. Needed because chrono wants a
// numeric offset and TZ is an IANA name whose offset moves with DST.
function offsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  // 24 comes back for midnight in some ICU versions; normalise it.
  const hour = p.hour === '24' ? '00' : p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

const fmtLocal = (d, timeZone = TZ) => d.toLocaleString('en-US', {
  timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

// Anything more than a year out is chrono latching onto a number that was not a date
// ("16x25x1", "call 911"). Better to drop it than to hand the model a confident wrong answer.
const MAX_AHEAD_MS = 365 * 864e5;
const MAX_BEHIND_MS = 365 * 864e5;

// Parse a user message for time expressions. Returns [{ text, iso, local }].
function resolve(message, { reference = new Date(), timeZone = TZ } = {}) {
  if (!message || typeof message !== 'string') return [];
  let results = [];
  try {
    results = chrono.parse(message, {
      instant: reference,
      timezone: offsetMinutes(reference, timeZone),
    }, { forwardDate: true });   // "at 9" with 9am past means tomorrow, which is what people mean
  } catch (e) {
    console.warn('[brain/time] chrono failed:', e.message);
    return [];
  }

  const out = [];
  for (const r of results) {
    let d;
    try { d = r.start && r.start.date(); } catch (_) { continue; }
    if (!d || !Number.isFinite(d.getTime())) continue;
    const delta = d.getTime() - reference.getTime();
    if (delta > MAX_AHEAD_MS || -delta > MAX_BEHIND_MS) continue;
    out.push({ text: r.text, iso: d.toISOString(), local: fmtLocal(d, timeZone) });
  }
  return out;
}

// The block injected into the system prompt. Empty string when nothing was found, so the
// prompt does not carry a dangling header.
function promptBlock(hits) {
  if (!hits || !hits.length) return '';
  const lines = hits.map(h => `"${h.text}" = ${h.iso} (${h.local})`).join('; ');
  return `Resolved times: ${lines}\nUse these values verbatim. Do not recompute them.`;
}

// Handler-side guard. Checks an ISO instant is parseable and inside a plausible window, and
// on failure returns the resolved candidates so the model's retry has the right answer in
// front of it rather than another guess.
function validateInstant(value, hits, { reference = new Date(), label = 'value' } = {}) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) {
    return { ok: false, error: `${label} must be a full ISO-8601 instant. ${candidates(hits)}` };
  }
  const delta = t - reference.getTime();
  if (delta > MAX_AHEAD_MS || -delta > MAX_BEHIND_MS) {
    return {
      ok: false,
      error: `${label} resolves to ${new Date(t).toISOString()}, which is more than a year from now `
           + `and is almost certainly wrong. ${candidates(hits)}`,
    };
  }
  return { ok: true, iso: new Date(t).toISOString() };
}

const candidates = hits => (hits && hits.length)
  ? `The correct value is one of: ${hits.map(h => `"${h.text}" = ${h.iso}`).join('; ')}.`
  : 'No time expression was found in the request; ask the user for a specific time.';

// Relative durations for timeclock deltas: "+3600s", "-30m", "+1h". Offering the model a
// form it cannot get wrong beats validating one it can (LOCAL-BRAIN-SPEC 8.5).
const REL = /^([+-])\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i;
const UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };

function applyRelative(base, expr) {
  const m = String(expr || '').trim().match(REL);
  if (!m) return null;
  const t = Date.parse(base);
  if (!Number.isFinite(t)) return null;
  const unit = m[3].toLowerCase()[0];
  const ms = Number(m[2]) * UNIT_MS[unit];
  return new Date(t + (m[1] === '-' ? -ms : ms)).toISOString();
}

const isRelative = expr => REL.test(String(expr || '').trim());

module.exports = {
  resolve, promptBlock, validateInstant, applyRelative, isRelative,
  offsetMinutes, fmtLocal,
  MAX_AHEAD_MS, MAX_BEHIND_MS,
};
