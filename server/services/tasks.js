// Unified tasks across charliework and goosework.
//
// Mirror-with-write-through, chosen over a live proxy. The merged list is served from
// maverick's own table so it is fast and survives an origin being slow or unreachable; every
// local mutation is pushed straight back to whichever system owns the row.
//
// The failure mode a mirror invites is silently serving stale or wrong state, so three rules
// are enforced here rather than assumed:
//
//   1. Origin wins on conflict, UNLESS the local row is dirty (an edit not yet pushed).
//      A pull must never overwrite an edit that has not reached its origin yet.
//   2. A row is only deleted locally after it has been absent from N consecutive
//      SUCCESSFUL pulls. A failed pull never deletes anything.
//   3. Sync state is never hidden. A dirty row reports `synced: false`, and a failed
//      write-through keeps `push_error` so the UI can say so instead of lying.
//
// Nothing in here imports server/brain. The task API works with the assistant switched off,
// which is the layering rule the whole platform depends on.

const db = require('../db');
const cfg = require('../config');
const charliework = require('../integrations/charliework');
const goosework = require('../integrations/goosework');

const SOURCES = {
  charliework: { prefix: 'cw', client: charliework },
  goosework: { prefix: 'gw', client: goosework },
};
const BY_PREFIX = { cw: 'charliework', gw: 'goosework' };

const uid = (source, sourceId) => `${SOURCES[source].prefix}:${sourceId}`;

// Split 'cw:abc123' back into its parts. Returns null for anything malformed, which is how
// a hallucinated id from the model gets rejected instead of hitting the wrong system.
function parseId(id) {
  const m = /^(cw|gw):(.+)$/.exec(String(id || ''));
  if (!m) return null;
  return { source: BY_PREFIX[m[1]], sourceId: m[2] };
}

// ---- category -> space mapping -------------------------------------------------------
// Both systems have their own category vocabularies. Map onto the user's spaces where the
// names line up, and leave it null otherwise rather than guessing.
function spaceFor(category) {
  const first = String(category || '').split(',')[0].trim().toLowerCase();
  if (!first) return null;
  let spaces = [];
  try { spaces = db.prepare('SELECT key, label FROM spaces').all(); } catch (_) { return null; }
  const hit = spaces.find(s => s.key.toLowerCase() === first || s.label.toLowerCase() === first);
  return hit ? hit.key : null;
}

// ---- normalisation -------------------------------------------------------------------

function normalise(source, t) {
  const flags = {};
  for (const k of ['pinned', 'blocked', 'pending_review', 'awaiting_review', 'tier']) {
    if (t[k] !== undefined && t[k] !== null && t[k] !== 0 && t[k] !== false) flags[k] = t[k];
  }
  const iso = v => {
    if (v === null || v === undefined || v === '') return null;
    // goosework stamps unix seconds; charliework sends ISO strings.
    if (typeof v === 'number') return new Date(v * 1000).toISOString();
    return String(v);
  };
  return {
    id: uid(source, t.id),
    source,
    source_id: String(t.id),
    title: String(t.title || '').trim(),
    notes: t.notes == null ? null : String(t.notes),
    status: t.status === 'done' ? 'done' : 'open',
    priority: Number.isFinite(t.priority) ? t.priority : null,
    due_date: t.due_date || null,
    category: t.category || null,
    space: spaceFor(t.category),
    parent_id: t.parent_id ? uid(source, t.parent_id) : null,
    is_overdue: t.is_overdue ? 1 : 0,
    is_due_soon: t.is_due_soon ? 1 : 0,
    flags: Object.keys(flags).length ? JSON.stringify(flags) : null,
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
    completed_at: iso(t.completed_at),
  };
}

const UPSERT = db.prepare(`
  INSERT INTO tasks (id, source, source_id, title, notes, status, priority, due_date, category,
                     space, parent_id, is_overdue, is_due_soon, flags, created_at, updated_at,
                     completed_at, synced_at, misses)
  VALUES (@id,@source,@source_id,@title,@notes,@status,@priority,@due_date,@category,
          @space,@parent_id,@is_overdue,@is_due_soon,@flags,@created_at,@updated_at,
          @completed_at, datetime('now'), 0)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, notes=excluded.notes, status=excluded.status,
    priority=excluded.priority, due_date=excluded.due_date, category=excluded.category,
    space=excluded.space, parent_id=excluded.parent_id, is_overdue=excluded.is_overdue,
    is_due_soon=excluded.is_due_soon, flags=excluded.flags, updated_at=excluded.updated_at,
    completed_at=excluded.completed_at, synced_at=datetime('now'), misses=0
  WHERE tasks.dirty = 0
`);

// ---- pull ----------------------------------------------------------------------------

async function pullSource(source) {
  const { client } = SOURCES[source];
  if (!client.enabled()) return { source, connected: false, count: 0 };

  const res = await client.listTasks({ includeDone: true, includeSubtasks: true });
  if (!res.connected) return { source, connected: false, count: 0 };
  const rows = (res.tasks || []).map(t => normalise(source, t)).filter(r => r.title);

  const seen = new Set(rows.map(r => r.id));
  db.transaction(() => {
    for (const r of rows) UPSERT.run(r);

    // Absent rows: bump the miss counter, and only delete once it crosses the threshold.
    // Dirty rows are exempt, since a locally-created row may not exist upstream yet.
    const local = db.prepare('SELECT id, misses FROM tasks WHERE source=? AND dirty=0').all(source);
    const bump = db.prepare('UPDATE tasks SET misses=misses+1 WHERE id=?');
    const drop = db.prepare('DELETE FROM tasks WHERE id=?');
    for (const row of local) {
      if (seen.has(row.id)) continue;
      if (row.misses + 1 >= cfg.tasksSync.missesBeforeDelete) drop.run(row.id);
      else bump.run(row.id);
    }
  })();

  return { source, connected: true, count: rows.length };
}

// ---- write-through --------------------------------------------------------------------

// Apply a pending change to its origin. On success the origin's response becomes truth; on
// failure the row stays dirty with the error recorded, and the next sync retries it.
async function pushOne(row) {
  const { client } = SOURCES[row.source];
  if (!client.enabled()) return false;
  let fields = {};
  try { fields = JSON.parse(row.dirty_fields || '{}'); } catch (_) {}
  if (!Object.keys(fields).length) {
    db.prepare('UPDATE tasks SET dirty=0, dirty_fields=NULL, push_error=NULL WHERE id=?').run(row.id);
    return true;
  }

  try {
    const res = await client.patchTask(row.source_id, fields);
    const fresh = res && res.task;
    if (fresh && fresh.id) {
      const n = normalise(row.source, fresh);
      db.prepare('UPDATE tasks SET dirty=0, dirty_fields=NULL, push_error=NULL WHERE id=?').run(row.id);
      UPSERT.run(n);
    } else {
      db.prepare('UPDATE tasks SET dirty=0, dirty_fields=NULL, push_error=NULL WHERE id=?').run(row.id);
    }
    return true;
  } catch (e) {
    db.prepare('UPDATE tasks SET push_error=? WHERE id=?').run(e.message.slice(0, 300), row.id);
    console.warn(`[tasks] push failed ${row.id}: ${e.message}`);
    return false;
  }
}

async function pushDirty() {
  const rows = db.prepare('SELECT * FROM tasks WHERE dirty=1 ORDER BY id').all();
  let ok = 0;
  for (const row of rows) if (await pushOne(row)) ok++;
  return { attempted: rows.length, ok };
}

// ---- sync ------------------------------------------------------------------------------

let syncing = false;
let lastSync = null;

async function sync() {
  if (syncing) return lastSync;
  syncing = true;
  const started = Date.now();
  const result = { at: new Date().toISOString(), sources: [], pushed: null, errors: [] };
  try {
    // Push first. Pulling first would fetch origin state that is about to change, then the
    // push would leave the mirror one revision behind until the next cycle.
    result.pushed = await pushDirty();
    for (const source of Object.keys(SOURCES)) {
      try { result.sources.push(await pullSource(source)); }
      catch (e) {
        result.errors.push(`${source}: ${e.message}`);
        result.sources.push({ source, connected: true, count: null, error: e.message });
        console.warn(`[tasks] pull failed ${source}: ${e.message}`);
      }
    }
  } finally {
    syncing = false;
    result.ms = Date.now() - started;
    lastSync = result;
  }
  return result;
}

let timer = null;
function startSync() {
  if (!cfg.tasksSync.enabled || timer) return;
  const connected = Object.values(SOURCES).filter(s => s.client.enabled()).length;
  if (!connected) { console.log('[tasks] no task sources connected; sync not started'); return; }
  sync().then(r => console.log(`[tasks] initial sync ${r.ms}ms ${r.sources.map(s => `${s.source}=${s.count}`).join(' ')}`))
    .catch(e => console.warn('[tasks] initial sync failed:', e.message));
  timer = setInterval(() => { sync().catch(() => {}); }, cfg.tasksSync.intervalMs);
  if (timer.unref) timer.unref();
}

// ---- reads -------------------------------------------------------------------------------

function shape(r) {
  let flags = {};
  try { flags = JSON.parse(r.flags || '{}'); } catch (_) {}
  return {
    id: r.id,
    source: r.source,
    title: r.title,
    notes: r.notes,
    status: r.status,
    due_date: r.due_date,
    category: r.category,
    space: r.space,
    parent_id: r.parent_id,
    is_overdue: !!r.is_overdue,
    is_due_soon: !!r.is_due_soon,
    flags,
    completed_at: r.completed_at,
    // Sync state is part of the record, not hidden. An edit that has not reached its origin
    // must be visible as such.
    synced: !r.dirty,
    push_error: r.push_error || null,
  };
}

function list({ source, status = 'open', space, category, limit = 200 } = {}) {
  const where = [];
  const p = {};
  if (status && status !== 'all') { where.push('status=@status'); p.status = status; }
  if (source) { where.push('source=@source'); p.source = source; }
  if (space) { where.push('space=@space'); p.space = space; }
  if (category) { where.push("(',' || COALESCE(category,'') || ',') LIKE @cat"); p.cat = `%,${category},%`; }
  p.limit = Math.min(Number(limit) || 200, 500);

  const rows = db.prepare(`
    SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE WHEN status='open' THEN 0 ELSE 1 END,
      is_overdue DESC,
      is_due_soon DESC,
      CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
      due_date ASC,
      COALESCE(priority, 999999) ASC,
      title ASC
    LIMIT @limit
  `).all(p);
  return rows.map(shape);
}

const get = id => {
  const r = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  return r ? shape(r) : null;
};

function counts() {
  const r = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN is_overdue=1 THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN is_overdue=0 AND is_due_soon=1 THEN 1 ELSE 0 END) AS due_soon,
           SUM(CASE WHEN source='charliework' THEN 1 ELSE 0 END) AS charliework,
           SUM(CASE WHEN source='goosework' THEN 1 ELSE 0 END) AS goosework
    FROM tasks WHERE status='open'
  `).get();
  return {
    open: r.total || 0, overdue: r.overdue || 0, due_soon: r.due_soon || 0,
    by_source: { charliework: r.charliework || 0, goosework: r.goosework || 0 },
  };
}

// ---- writes ------------------------------------------------------------------------------

// Mark a local edit and push it immediately. The row is updated optimistically so the UI
// reacts at once, flagged dirty so a concurrent pull cannot clobber it, and cleaned up when
// the origin confirms.
async function update(id, fields) {
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) return { ok: false, error: `no task ${id}` };

  const allowed = {};
  if (fields.status === 'done' || fields.status === 'open') allowed.status = fields.status;
  if (typeof fields.due_date === 'string' || fields.due_date === null) allowed.due_date = fields.due_date;
  if (typeof fields.notes === 'string') allowed.notes = fields.notes;
  if (typeof fields.title === 'string' && fields.title.trim()) allowed.title = fields.title.trim();
  if (!Object.keys(allowed).length) return { ok: false, error: 'nothing to update' };

  const local = { ...allowed };
  if (allowed.status === 'done') local.completed_at = new Date().toISOString();
  if (allowed.status === 'open') local.completed_at = null;

  const sets = Object.keys(local).map(k => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE tasks SET ${sets}, dirty=1, dirty_fields=@__f, push_error=NULL WHERE id=@__id`)
    .run({ ...local, __f: JSON.stringify(allowed), __id: id });

  const fresh = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const pushed = await pushOne(fresh);
  return { ok: true, pushed, task: get(id) };
}

// Create in a chosen origin, then mirror the row it returns.
async function create({ source, title, due_date, category, notes, tier }) {
  const src = SOURCES[source];
  if (!src) return { ok: false, error: `unknown source "${source}" (use charliework or goosework)` };
  if (!src.client.enabled()) return { ok: false, error: `${source} is not connected.` };

  const res = await src.client.addTask({ title, due_date, category, notes, tier });
  const t = res && res.task;
  if (!t || !t.id) return { ok: false, error: `${source} did not return the created task` };
  const n = normalise(source, t);
  UPSERT.run(n);
  return { ok: true, task: get(n.id) };
}

const status = () => ({
  enabled: cfg.tasksSync.enabled,
  interval_ms: cfg.tasksSync.intervalMs,
  sources: Object.entries(SOURCES).map(([name, s]) => ({ source: name, connected: s.client.enabled() })),
  last_sync: lastSync,
  dirty: db.prepare('SELECT COUNT(*) n FROM tasks WHERE dirty=1').get().n,
});

module.exports = {
  list, get, counts, update, create, sync, startSync, status, parseId, SOURCES,
};
