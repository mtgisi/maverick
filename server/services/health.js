// Daily health log: calories, protein, water, steps, sleep, weight, workouts, habits.
//
// Storage is an append-only entry table, not one row per day. "Log 650 calories" twice in a
// day must add up, and "undo that" must be able to take back exactly the last thing said.
// A day's numbers are always DERIVED from its entries here, in code. The model never adds
// calories up itself: a 7B is not trustworthy at arithmetic, and the totals are what the
// accountability bot grades.
//
// How each kind rolls up into a day:
//   sum     calories, protein_g, water_oz          (each entry is an increment)
//   latest  steps, sleep_h, weight_lb              (each entry restates the day's value)
//   any     workout, habit                         (logged at least once = done)
//
// Days are local calendar dates stored as 'YYYY-MM-DD' text, never as instants. Sleep logged
// in the morning counts for the day it is logged on.

const crypto = require('crypto');
const db = require('../db');
const { TZ } = require('../config');

const SUM = ['calories', 'protein_g', 'water_oz'];
const LATEST = ['steps', 'sleep_h', 'weight_lb'];
const KINDS = [...SUM, ...LATEST, 'workout', 'habit'];

// Sanity ceilings. Anything past these is a transcription or unit slip ("6500 calories" from
// "650 calories", ounces heard as millilitres), and it would land in a post friends read.
const LIMITS = {
  calories: [0, 6000], protein_g: [0, 500], water_oz: [0, 400],
  steps: [0, 100000], sleep_h: [0, 24], weight_lb: [50, 700], workout: [0, 600], habit: [0, 1],
};

const MAX_BACKDATE_DAYS = 14;

const dayInTZ = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// 'YYYY-MM-DD' arithmetic done on the date alone. Going through a Date at local midnight
// would shift a day across DST or UTC; noon UTC cannot.
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

// Resolve what the user or model said into a local date. Returns { day } or { error }.
function resolveDay(input, now = new Date()) {
  const today = dayInTZ(now);
  const s = String(input == null ? '' : input).trim().toLowerCase();
  let day;
  if (!s || s === 'today' || s === 'tonight' || s === 'this morning') day = today;
  else if (s === 'yesterday' || s === 'last night') day = addDays(today, -1);
  else if (isDay(s)) day = s;
  else return { error: `"${input}" is not a day. Use "today", "yesterday", or YYYY-MM-DD.` };
  if (day > today) return { error: `${day} is in the future. Health entries can only be logged for today or earlier.` };
  if (day < addDays(today, -MAX_BACKDATE_DAYS)) {
    return { error: `${day} is more than ${MAX_BACKDATE_DAYS} days ago and can no longer be changed.` };
  }
  return { day };
}

const slug = s => String(s || '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Validate one entry. Returns a normalised row or throws with a readable message.
function normalise({ kind, value, label = null }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown health kind "${kind}"`);
  let v = value;
  if (kind === 'habit') {
    label = slug(label);
    if (!label) throw new Error('a habit needs a name');
    v = 1;
  } else if (kind === 'workout') {
    label = String(label || '').trim().slice(0, 80) || 'workout';
    v = v == null || v === '' ? null : Number(v);
  } else {
    v = Number(v);
  }
  if (v != null) {
    if (!Number.isFinite(v)) throw new Error(`${kind} must be a number`);
    const [lo, hi] = LIMITS[kind];
    if (v < lo || v > hi) throw new Error(`${kind} of ${v} is outside the believable range ${lo}-${hi}; check the number and units`);
  }
  return { kind, value: v, label };
}

const insert = db.prepare(
  'INSERT INTO health_entries (day, kind, value, label, source, batch) VALUES (?,?,?,?,?,?)');

// Log several entries for one day atomically. All or nothing: a meal logged as calories +
// protein should never half-land.
function log(day, entries, source = 'web') {
  const rows = entries.map(normalise);
  const batch = crypto.randomUUID();
  const tx = db.transaction(() => rows.map(r => insert.run(day, r.kind, r.value, r.label, source, batch).lastInsertRowid));
  const ids = tx();
  return { day, ids, rows };
}

function entries(day) {
  return db.prepare(
    'SELECT id, day, kind, value, label, source, created_at FROM health_entries '
    + 'WHERE day = ? AND deleted_at IS NULL ORDER BY id ASC').all(day);
}

// Roll a day's entries up into totals. Absent numbers are null, not 0: "no data" and
// "zero" are different claims, and the bot reports them differently.
function summarise(day) {
  const rows = entries(day);
  const out = {
    day,
    entries: rows.length,
    calories: null, protein_g: null, water_oz: null,
    steps: null, sleep_h: null, weight_lb: null,
    workouts: [], habits: [],
    updated_at: null,
  };
  for (const r of rows) {
    if (SUM.includes(r.kind)) out[r.kind] = (out[r.kind] || 0) + r.value;
    else if (LATEST.includes(r.kind)) out[r.kind] = r.value;     // ordered by id: last wins
    else if (r.kind === 'workout') out.workouts.push({ label: r.label, minutes: r.value });
    else if (r.kind === 'habit' && !out.habits.includes(r.label)) out.habits.push(r.label);
    out.updated_at = r.created_at;
  }
  return out;
}

// Has anything ever been logged on or before this day? Days before tracking began are
// reported as missing, not as a row of failures.
function trackingStarted(day) {
  return !!db.prepare('SELECT 1 FROM health_entries WHERE day <= ? AND deleted_at IS NULL LIMIT 1').get(day);
}

// Soft-delete the most recent log call made in the last 24h. Soft so the record of what was
// claimed and then retracted survives.
//
// "Undo that" means the whole call: a meal logged as calories + protein is one thing to the
// user. Grouped by the batch id written per call, NOT by created_at, which has one-second
// resolution and would sweep up separate calls made in the same second.
function undoLast() {
  const last = db.prepare(
    "SELECT id, day, batch FROM health_entries "
    + "WHERE deleted_at IS NULL AND created_at >= datetime('now','-1 day') ORDER BY id DESC LIMIT 1").get();
  if (!last) return null;
  const batch = last.batch
    ? db.prepare("SELECT id, day, kind, value, label FROM health_entries "
        + "WHERE deleted_at IS NULL AND batch = ? ORDER BY id ASC").all(last.batch)
    : db.prepare("SELECT id, day, kind, value, label FROM health_entries WHERE id = ?").all(last.id);
  db.prepare(`UPDATE health_entries SET deleted_at = datetime('now') WHERE id IN (${batch.map(() => '?').join(',')})`)
    .run(...batch.map(b => b.id));
  return { day: last.day, removed: batch };
}

function remove(id) {
  return db.prepare("UPDATE health_entries SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL")
    .run(id).changes > 0;
}

// ---- human-readable text (tool results, so the model reads totals rather than computing) --

const n = v => Math.round(v).toLocaleString('en-US');
const KIND_TEXT = {
  calories: v => `${n(v)} kcal`,
  protein_g: v => `${n(v)} g protein`,
  water_oz: v => `${n(v)} oz water`,
  steps: v => `${n(v)} steps`,
  sleep_h: v => `${+v.toFixed(1)} h sleep`,
  weight_lb: v => `weight ${+v.toFixed(1)} lb`,
};

function describeEntry(r) {
  if (r.kind === 'workout') return `workout: ${r.label}${r.value ? ` (${n(r.value)} min)` : ''}`;
  if (r.kind === 'habit') return `habit: ${r.label}`;
  return KIND_TEXT[r.kind](r.value);
}

function describeDay(s) {
  const parts = [];
  for (const k of ['calories', 'protein_g', 'water_oz', 'steps', 'sleep_h', 'weight_lb']) {
    if (s[k] != null) parts.push(KIND_TEXT[k](s[k]));
  }
  parts.push(s.workouts.length
    ? `workout done (${s.workouts.map(w => w.label + (w.minutes ? ` ${n(w.minutes)} min` : '')).join(', ')})`
    : 'no workout yet');
  if (s.habits.length) parts.push(`habits: ${s.habits.join(', ')}`);
  return parts.join(', ');
}

// ---- the shared view (what the accountability bot is allowed to see) ----------------------
//
// An explicit allowlist, built field by field. Nothing reaches the bot because it happens to
// be in the summary object: notes, entry sources and timestamps of individual entries never
// leave, and raw body weight only leaves if HEALTH_SHARE_WEIGHT=true. Adding a field to the
// summary later does NOT add it here.
function sharedView(day, { shareWeight = false } = {}) {
  const s = summarise(day);
  const minutes = s.workouts.reduce((t, w) => t + (w.minutes || 0), 0);
  const weighin = { logged: s.weight_lb != null };
  if (shareWeight && s.weight_lb != null) weighin.weight_lb = s.weight_lb;
  return {
    date: day,
    updated_at: s.updated_at,
    workout: {
      completed: s.workouts.length > 0,
      sessions: s.workouts.length,
      minutes: minutes || null,
      activities: s.workouts.map(w => w.label),
    },
    nutrition: { calories: s.calories, protein_g: s.protein_g, water_oz: s.water_oz },
    activity: { steps: s.steps },
    sleep: { hours: s.sleep_h },
    weighin,
    habits: Object.fromEntries(s.habits.map(h => [h, true])),
  };
}

module.exports = {
  KINDS, SUM, LATEST, LIMITS, MAX_BACKDATE_DAYS,
  dayInTZ, addDays, isDay, resolveDay, slug, normalise,
  log, entries, summarise, trackingStarted, undoLast, remove,
  describeEntry, describeDay, sharedView,
};
