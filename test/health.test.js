// Health log + the accountability-bot share API.
//
//   docker exec maverick node /app/test/health.test.js
//
// Runs against a throwaway DB. The share checks start a real listener on 127.0.0.1 so the
// auth, routing and payload allowlist are exercised over HTTP, the way the bot sees them.

const crypto = require('crypto');
process.env.MAVERICK_DB_PATH = '/tmp/health-test.db';
require('fs').rmSync(process.env.MAVERICK_DB_PATH, { force: true });
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
process.env.SHARE_TOKEN_SHA256 = crypto.createHash('sha256').update(TOKEN).digest('hex');
process.env.HEALTH_SHARE_WEIGHT = '';

const h = require('../server/services/health');
const registry = require('../server/tools/registry');
const { dispatch } = require('../server/tools');
const share = require('../server/share');
const gating = require('../server/brain/gating');

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (e) { got = `threw: ${e.message}`; }
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}\n         ${JSON.stringify(got)}`); }
};

(async () => {
  const today = h.dayInTZ();
  const yesterday = h.addDays(today, -1);

  // ---- day resolution ----------------------------------------------------------------
  check('blank resolves to today', h.resolveDay('').day === today);
  check('"yesterday" resolves', h.resolveDay('yesterday').day === yesterday);
  check('future refused', !!h.resolveDay(h.addDays(today, 1)).error);
  check('too-old refused', !!h.resolveDay(h.addDays(today, -30)).error);
  check('nonsense refused', !!h.resolveDay('last tuesday-ish').error);
  check('impossible date refused', !h.isDay('2026-02-30'));
  check('addDays crosses month', h.addDays('2026-10-31', 1) === '2026-11-01');

  // ---- roll-up rules -----------------------------------------------------------------
  h.log(today, [{ kind: 'calories', value: 650 }, { kind: 'protein_g', value: 40 }], 'test');
  h.log(today, [{ kind: 'calories', value: 800 }], 'test');
  h.log(today, [{ kind: 'steps', value: 3000 }], 'test');
  h.log(today, [{ kind: 'steps', value: 9100 }], 'test');
  let s = h.summarise(today);
  check('calories sum across entries', s.calories === 1450, s);
  check('steps take the latest, not the sum', s.steps === 9100, s);
  check('unlogged number is null, not 0', s.water_oz === null, s);
  check('no workout yet', s.workouts.length === 0, s);

  check('6500 kcal in one entry is refused', () => { try { h.log(today, [{ kind: 'calories', value: 6500 }]); return false; } catch (_) { return true; } });
  check('a bad entry rolls back the whole batch', () => {
    try { h.log(today, [{ kind: 'water_oz', value: 20 }, { kind: 'sleep_h', value: 40 }]); } catch (_) {}
    return h.summarise(today).water_oz === null;
  });

  // ---- tools -------------------------------------------------------------------------
  check('three health tools registered', registry.byGroup('health').length === 3);
  let r = await dispatch('log_health', { calories: '300', workout: 'lifting', workout_minutes: 45 }, { surface: 'test', actor: 'model' });
  check('log_health coerces "300" and reports the new total', r.ok && /1,750 kcal/.test(r.result), r.result);
  check('log_health records the workout', /workout done \(lifting 45 min\)/.test(r.result), r.result);
  r = await dispatch('log_health', {}, { surface: 'test' });
  check('empty log_health is an error the model can read', !r.ok && /nothing to log/.test(r.result), r.result);
  r = await dispatch('log_health', { calories: 100, day: h.addDays(today, 2) }, { surface: 'test' });
  check('log_health refuses a future day', !r.ok, r.result);
  r = await dispatch('log_health', { habit: 'Meditate!' }, { surface: 'test' });
  r = await dispatch('health_today', {}, { surface: 'test' });
  check('health_today reads totals back', r.ok && /1,750 kcal/.test(r.result) && /meditate/.test(r.result), r.result);
  r = await dispatch('undo_health_log', {}, { surface: 'test' });
  check('undo removes only the last call (the habit)', r.ok && /habit: meditate/.test(r.result) && !/1,750/.test(r.result.split('Removed')[1].split('from')[0]), r.result);
  check('undo left the calories alone', h.summarise(today).calories === 1750);

  h.log(today, [{ kind: 'weight_lb', value: 201.4 }], 'test');

  // ---- gating ------------------------------------------------------------------------
  const g = msg => gating.select(msg).groups;
  check('"log 650 calories" gets the health tools', g('log 650 calories and 40g protein').includes('health'), g('log 650 calories and 40g protein'));
  check('"I worked out" gets the health tools', g('I worked out for an hour').includes('health'));
  check('"update my calendar" does NOT get health (ate/update trap)', !g('update my calendar for later').includes('health'), g('update my calendar for later'));
  check('core + health fits the 8-tool cap', gating.select('slept 7 hours').tools.length <= 8, gating.select('slept 7 hours').tools.length);

  // ---- deterministic statement parsing (services/health-parse.js) ----------------------
  const hp = require('../server/services/health-parse');
  const P = m => hp.parseLog(m);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [msg, want] of [
    ['log 650 calories and 40 grams of protein', { calories: 650, protein_g: 40 }],
    ['I lifted for 45 minutes', { workout: 'lifting', workout_minutes: 45 }],
    ['drank 24 oz of water', { water_oz: 24 }],
    ['slept 7 and a half hours last night', { sleep_hours: 7.5 }],
    ['slept seven hours', { sleep_hours: 7 }],
    ['did my meditation', { habit: 'meditation' }],
    ['ran 3 miles in 28 minutes', { workout: '3 mile run', workout_minutes: 28 }],
    ['hit the gym for an hour', { workout: 'workout', workout_minutes: 60 }],
    ['weighed in at 201.4', { weight_lb: 201.4 }],
    ['12,400 steps today', { steps: 12400 }],
    ['had a 900 calorie burrito yesterday', { calories: 900, day: 'yesterday' }],
    ['played basketball for 90 minutes', { workout: 'basketball', workout_minutes: 90 }],
  ]) check(`parses "${msg}"`, () => same(P(msg), want), P(msg));
  for (const msg of [
    'how many calories have I had today?', 'did I work out today', "I didn't work out today",
    'going to lift later', 'had a burrito for lunch', 'log 600 calories and what is on my calendar',
    'remind me to drink 20 oz of water', 'I skipped the gym', 'what should I eat for dinner',
  ]) check(`leaves "${msg}" to the model`, () => P(msg) === null, P(msg));
  check('"undo that" is an undo when health is in scope', hp.isUndo('undo that', true));
  check('"undo that last one" in a health thread', hp.isUndo('undo that last one', true));
  check('"scratch the calories" is an undo even out of scope', hp.isUndo('scratch the calories', false));
  check('"undo that" with nothing health in scope is NOT taken', !hp.isUndo('undo that', false));
  check('"delete that task" is not a health undo', !hp.isUndo('delete that task', true));

  // ---- share API over HTTP -----------------------------------------------------------
  const server = await new Promise(res => { const sv = share.buildApp().listen(0, '127.0.0.1', () => res(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  check('no token -> 401', (await get(`/api/day/${today}`)).status === 401);
  check('wrong token -> 401', (await get(`/api/day/${today}`, TOKEN + 'x')).status === 401);
  check('token as query string is not accepted', (await fetch(`${base}/api/day/${today}?token=${TOKEN}`)).status === 401);
  const resp = await get(`/api/day/${today}`, TOKEN);
  const body = await resp.json();
  check('right token -> 200', resp.status === 200, resp.status);
  check('payload matches the bot\'s metrics.yml paths',
    body.nutrition.calories === 1750 && body.nutrition.protein_g === 40 && body.activity.steps === 9100
    && body.workout.completed === true && body.weighin.logged === true && body.sleep.hours === null, body);
  check('raw weight is NOT shared by default', !('weight_lb' in body.weighin), body.weighin);
  check('no entry-level data leaks (sources, ids, notes)', !JSON.stringify(body).includes('test') && !('entries' in body), body);
  check('response is no-store', resp.headers.get('cache-control') === 'no-store');
  check('day before tracking began -> 404', (await get(`/api/day/${h.addDays(today, -5)}`, TOKEN)).status === 404);
  check('future day -> 404', (await get(`/api/day/${h.addDays(today, 1)}`, TOKEN)).status === 404);
  check('bad date -> 400', (await get('/api/day/../../etc', TOKEN)).status !== 200);
  check('no write verbs', (await fetch(`${base}/api/day/${today}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).status === 404);
  check('nothing else is mounted (no /api/chat, /api/memories)',
    (await get('/api/memories', TOKEN)).status === 404 && (await get('/api/chat', TOKEN)).status === 404);
  check('refuses to start bound to 0.0.0.0', (() => {
    const cfg = require('../server/config'); const old = cfg.share.bind; cfg.share.bind = '0.0.0.0';
    const sv = share.start(); cfg.share.bind = old; return sv === null;
  })());
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
