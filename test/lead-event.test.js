// The home lead card must never offer to prep something that already happened.
//
//   node test/lead-event.test.js
//
// leadEvent() is extracted from public/app.js at run time rather than copied, so the test
// cannot drift from the shipped code.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const m = src.match(/function leadEvent\(list\)\{[\s\S]*?\n\}/);
if (!m) {
  console.error('FAIL: leadEvent() not found in public/app.js — renamed or removed?');
  process.exit(1);
}
// eslint-disable-next-line no-eval
const leadEvent = eval(`(${m[0]})`);

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (e) { got = `threw: ${e.message}`; }
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}  got: ${JSON.stringify(got)}`); }
};

const NOW = Date.now();
const at = mins => new Date(NOW + mins * 60000).toISOString();
const ev = (title, startMin, endMin, allDay = false) =>
  ({ title, start: allDay ? '2026-08-27' : at(startMin), end: allDay ? null : at(endMin), allDay, time: 'x' });

// The reported bug: at 4pm it still led with the 7:50am meeting and offered "Start prep".
let r = leadEvent([ev('Morning meeting', -480, -420), ev('Lunch', -180, -120)]);
check('an entirely past day does not lead with a finished event', () => r.ev === null, r.ev && r.ev.title);
check('a finished day reports state "done"', () => r.state === 'done', r.state);

// Past events must not shadow a real upcoming one.
r = leadEvent([ev('Morning meeting', -480, -420), ev('Standup', 90, 120)]);
check('leads with the upcoming event, not the earliest', () => r.ev.title === 'Standup', r.ev && r.ev.title);
check('upcoming reports state "next"', () => r.state === 'next', r.state);

// In progress beats not-yet-started, and must not offer prep.
r = leadEvent([ev('Running now', -10, 40), ev('Later', 200, 240)]);
check('an in-progress event wins', () => r.ev.title === 'Running now', r.ev && r.ev.title);
check('in progress reports state "now"', () => r.state === 'now', r.state);

// No end time: assume an hour, so a just-started event still counts as current.
r = leadEvent([{ title: 'No end', start: at(-15), end: null, allDay: false }]);
check('a recently started event with no end is current', () => r.state === 'now', r.state);
r = leadEvent([{ title: 'No end', start: at(-120), end: null, allDay: false }]);
check('a long-past event with no end is not current', () => r.state === 'done', r.state);

// All-day entries are context for the day, not a "right now".
r = leadEvent([ev('Someones Birthday', 0, 0, true), ev('Standup', 90, 120)]);
check('a timed upcoming event outranks an all-day one', () => r.ev.title === 'Standup', r.ev && r.ev.title);
r = leadEvent([ev('Someones Birthday', 0, 0, true), ev('Past thing', -300, -240)]);
check('all-day leads only when nothing timed is left', () => r.state === 'today' && r.ev.title === 'Someones Birthday', r);

// Empty and malformed input must not throw.
r = leadEvent([]);
check('an empty day is "clear"', () => r.state === 'clear' && r.ev === null, r);
r = leadEvent([{ title: 'Broken', start: 'not-a-date', allDay: false }]);
check('an unparseable start is ignored, not crashed on', () => r.state === 'clear', r);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
