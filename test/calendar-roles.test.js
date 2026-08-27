// Per-calendar roles: agenda / reference / off.
//
//   docker exec maverick node /app/test/calendar-roles.test.js
//
// Google is stubbed rather than called, so this runs without a live token and asserts the
// real filtering code in server/google/client.js, not a reimplementation of it.
//
// Uses a scratch DB so it never touches the live maverick.db.

process.env.MAVERICK_DB_PATH = '/tmp/cal-roles-test.db';
require('fs').rmSync(process.env.MAVERICK_DB_PATH, { force: true });

const Module = require('module');

// --- stub googleapis + oauth before anything requires them -----------------------------
const CALENDARS = [
  { id: 'primary@x', summary: 'Matthew', primary: true, accessRole: 'owner' },
  { id: 'birthdays@x', summary: 'Birthdays', accessRole: 'reader' },
  { id: 'menu@x', summary: 'Kitchen Menu', accessRole: 'reader' },
  { id: 'inout@x', summary: 'Office In Out', accessRole: 'reader' },
  { id: 'noise@x', summary: 'Holidays in United States', accessRole: 'reader' },
];

// One all-day event per calendar, none with attendees — which is what a birthday or an
// in/out board actually looks like, and the case self-filtering used to swallow.
const EVENTS = Object.fromEntries(CALENDARS.map(c => [c.id, [{
  id: `ev-${c.id}`, summary: `${c.summary} entry`,
  start: { date: '2026-08-27' }, end: { date: '2026-08-28' },
}]]));

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'googleapis') {
    return { google: {
      calendar: () => ({
        calendarList: { list: async () => ({ data: { items: CALENDARS } }) },
        events: { list: async ({ calendarId }) => ({ data: { items: EVENTS[calendarId] || [] } }) },
      }),
      gmail: () => ({}),
    } };
  }
  const m = origLoad.apply(this, arguments);
  if (request === './oauth' && m && typeof m === 'object' && 'allClients' in m) {
    return { ...m,
      allClients: () => [{ client: {}, account: { label: 'work', email: 'w@x' } }],
      clientFor: () => ({ client: {}, account: { label: 'work', email: 'w@x' } }) };
  }
  return m;
};

const calPrefs = require('../server/services/calendars');
const gcal = require('../server/google/client');

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (e) { got = `threw: ${e.message}`; }
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}  got: ${JSON.stringify(got)}`); }
};

const titles = r => (r.events || []).filter(e => !e.error).map(e => e.calendar).sort();

(async () => {
  // Baseline: no preferences stored, so nothing changes from the pre-existing behaviour.
  let r = await gcal.listEvents({ scope: 'all', include: 'agenda' });
  check('with no prefs set, every calendar is still included',
    () => titles(r).length === CALENDARS.length, titles(r));

  // Exactly the user's three: reference, not activities.
  calPrefs.set('work', 'birthdays@x', 'reference', 'Birthdays');
  calPrefs.set('work', 'menu@x', 'reference', 'Kitchen Menu');
  calPrefs.set('work', 'inout@x', 'reference', 'Office In Out');
  calPrefs.set('work', 'noise@x', 'off', 'Holidays in United States');

  r = await gcal.listEvents({ scope: 'all', include: 'agenda' });
  check('agenda excludes the reference calendars', () => titles(r).join() === 'Matthew', titles(r));
  check('agenda excludes the off calendar', () => !titles(r).includes('Holidays in United States'), titles(r));

  r = await gcal.listEvents({ scope: 'all', include: 'reference' });
  check('reference returns exactly the three reference calendars',
    () => titles(r).join() === 'Birthdays,Kitchen Menu,Office In Out', titles(r));
  check('reference still excludes off', () => !titles(r).includes('Holidays in United States'), titles(r));

  r = await gcal.listEvents({ scope: 'all', include: 'all' });
  check("include:'all' returns agenda plus reference, but never off",
    () => titles(r).length === 4 && !titles(r).includes('Holidays in United States'), titles(r));

  // The reason self-filtering has to be skipped for explicit calendars: these events have no
  // attendees, so under the old 'mine' rules they would all be dropped and "who is out
  // today" would answer nothing.
  r = await gcal.listEvents({ scope: 'mine', include: 'reference' });
  check('reference survives the default mine scope despite having no attendees',
    () => titles(r).length === 3, titles(r));

  // Events carry their role so a caller can label them without re-deriving it.
  check('events report their calendar role',
    () => (r.events || []).every(e => e.calendarMode === 'reference'),
    (r.events || []).map(e => e.calendarMode));

  // Clearing returns a calendar to heuristic handling.
  calPrefs.clear('work', 'birthdays@x');
  r = await gcal.listEvents({ scope: 'all', include: 'agenda' });
  check('clearing a preference puts the calendar back in the agenda',
    () => titles(r).includes('Birthdays'), titles(r));

  // A stored preference whose calendar has vanished stays visible and removable.
  calPrefs.set('work', 'deleted@x', 'off', 'Deleted Calendar');
  const merged = calPrefs.merge(CALENDARS.map(c => ({ ...c, account: 'work', kind: 'shared' })));
  const ghost = merged.find(c => c.id === 'deleted@x');
  check('a preference for a missing calendar is still listed', () => ghost && ghost.missing === true, ghost);

  check('rejects an invalid mode', () => {
    try { calPrefs.set('work', 'x@x', 'sometimes'); return false; } catch (_) { return true; }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
