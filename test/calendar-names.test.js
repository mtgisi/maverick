// Resolving a place name in a message to a calendar.
//
//   node test/calendar-names.test.js
//
// The risk here is asymmetric. A missed match means one question goes unanswered. A FALSE
// match silently redirects a general question ("what is on my calendar today") at a single
// room and answers confidently with the wrong data. So the false-positive cases matter more
// than the hits, and they are tested first.

process.env.MAVERICK_DB_PATH = '/tmp/cal-names-test.db';
require('fs').rmSync(process.env.MAVERICK_DB_PATH, { force: true });

const calPrefs = require('../server/services/calendars');

// Real calendar names from the deployment, including the awkward ones: capacity suffixes,
// hyphenated location prefixes, and several sharing the word "esports".
const CALENDARS = [
  'EHS-Ground-Wilke Gym (400)', 'EHS-Sub-Basement-Pool (50)',
  'EHS-Sub-Basement-Krantz Center (400)', 'EHS-Second-Esports Arena (40)',
  'EHS-First-Library Conference Room (40)', 'EHS-Ground-Admin Conference Room (SMALL) (15)',
  'PAC-1-Auditorium (500)', 'PAC-1-Choir Room (50)',
  'Edgewood Lunch Menu', 'Kitchen Meal Calendar', 'Office Ins & Outs', 'EHS Birthdays',
  'Edgewood Calendar', 'EHS Scheduler', 'EHS Esports', 'Redbird Esports Varsity Overwatch',
  'Personal', 'Routine', 'Tech Crew',
].map((summary, i) => ({ id: `cal${i}@x`, summary, account: 'work', kind: 'shared' }));

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (e) { got = `threw: ${e.message}`; }
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}  got: ${JSON.stringify(got)}`); }
};

const resolve = msg => calPrefs.resolveName(msg, CALENDARS);
const top = msg => { const h = resolve(msg); return h.length ? h[0].cal.summary : null; };

// --- must NOT match: a general question redirected at a room is worse than no answer -----
const GENERAL = [
  'what is on my calendar today',
  'whats on the docket for today',
  'what are my tasks',
  'remind me to call the dentist tomorrow at 9',
  'what should I work on tonight',
  'and what about my afternoon',
  'am I free on Tuesday',
  'what is happening today',
];
for (const msg of GENERAL) {
  check(`no false match: ${JSON.stringify(msg)}`, () => resolve(msg).length === 0,
        resolve(msg).map(h => h.cal.summary));
}

// --- must match, and match the right one -------------------------------------------------
check('wilke -> the gym', () => top('what is everything going on in the wilke today') === 'EHS-Ground-Wilke Gym (400)', top('what is everything going on in the wilke today'));
check('pool -> the pool', () => top('anything in the pool today') === 'EHS-Sub-Basement-Pool (50)', top('anything in the pool today'));
check('krantz -> Krantz Center', () => top('what about the krantz center') === 'EHS-Sub-Basement-Krantz Center (400)', top('what about the krantz center'));
check('auditorium -> the auditorium', () => top('is the auditorium booked tonight') === 'PAC-1-Auditorium (500)', top('is the auditorium booked tonight'));
check('lunch menu -> the menu', () => top('what is for lunch today') === 'Edgewood Lunch Menu', top('what is for lunch today'));

// The disambiguation that was wrong before ranking by specificity: "esports" appears in
// three calendar names, "arena" in one. The narrower token has to win.
check('esports arena -> the arena, not a team calendar',
  () => top('is the esports arena free') === 'EHS-Second-Esports Arena (40)',
  top('is the esports arena free'));

// "conference room" alone is ambiguous across two rooms; both may come back, neither should
// be presented as certain, but it must not throw or pick something unrelated.
const conf = resolve('is a conference room open');
check('ambiguous "conference room" returns only conference rooms',
  () => conf.length === 0 || conf.every(h => /Conference Room/.test(h.cal.summary)),
  conf.map(h => h.cal.summary));

// --- shape ---------------------------------------------------------------------------------
check('results are ordered most specific first', () => {
  const h = resolve('is the esports arena free');
  return h.length < 2 || h[0].breadth <= h[1].breadth;
}, resolve('is the esports arena free').map(h => `${h.token}:${h.breadth}`));

check('empty message resolves to nothing', () => resolve('').length === 0);
check('no calendars resolves to nothing', () => calPrefs.resolveName('wilke', []).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
