const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { SPACE_PALETTE } = require('./config');

const DB_PATH = process.env.MAVERICK_DB_PATH || '/app/data/maverick.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safe concurrent access (main process + MCP subprocess)

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    kind TEXT DEFAULT 'note',
    role TEXT DEFAULT 'Personal',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    cc_session_id TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Scheduled reminders. The agent writes rows; a poller in index.js fires an ntfy push at fire_at.
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    fire_at TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Proposed timesheet edits (status=pending). Real timeclock write happens on user Confirm in the UI.
  CREATE TABLE IF NOT EXISTS pending_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    entry_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT NOT NULL,
    summary TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Connected Google accounts (for Gmail/Calendar APIs). Tokens stored server-side only.
  CREATE TABLE IF NOT EXISTS google_accounts (
    email TEXT PRIMARY KEY,
    label TEXT,                 -- 'personal' | 'work' | freeform
    refresh_token TEXT,
    access_token TEXT,
    expiry INTEGER,             -- ms epoch
    scope TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Roles / spaces. Seeded from the Aureo design; the UI scopes content by these.
  CREATE TABLE IF NOT EXISTS spaces (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    color TEXT NOT NULL,
    sort INTEGER DEFAULT 0
  );

  -- Unified task mirror across charliework and goosework.
  --
  -- Mirrored rather than proxied so the merged list is fast, works when an origin is slow,
  -- and can be queried without two network round trips. The cost is real sync machinery,
  -- which lives in server/services/tasks.js. Rules there, not here:
  --   origin wins on conflict UNLESS dirty=1 (a local edit not yet pushed)
  --   a row absent from its origin for two consecutive SUCCESSFUL pulls is deleted locally
  --   the UI never hides sync state; an unpushed edit says so
  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,          -- 'cw:<origin id>' | 'gw:<origin id>'
    source       TEXT NOT NULL,             -- 'charliework' | 'goosework'
    source_id    TEXT NOT NULL,
    title        TEXT NOT NULL,
    notes        TEXT,
    status       TEXT NOT NULL DEFAULT 'open',
    priority     INTEGER,
    due_date     TEXT,                      -- YYYY-MM-DD
    category     TEXT,
    space        TEXT,                      -- maverick space key, mapped from category
    parent_id    TEXT,
    is_overdue   INTEGER DEFAULT 0,
    is_due_soon  INTEGER DEFAULT 0,
    flags        TEXT,                      -- JSON: pinned, blocked, awaiting_review, tier
    created_at   TEXT,
    updated_at   TEXT,
    completed_at TEXT,
    synced_at    TEXT,
    misses       INTEGER NOT NULL DEFAULT 0,-- consecutive successful pulls this row was absent from
    dirty        INTEGER NOT NULL DEFAULT 0,-- 1 = local edit awaiting write-through
    dirty_fields TEXT,                      -- JSON of the pending change
    push_error   TEXT                       -- last write-through failure, surfaced in the UI
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source, source_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_dirty ON tasks(dirty) WHERE dirty=1;

  -- Conversation history. Under the Claude Code brain this lived inside the CLI's own
  -- session (replayed with --resume). The local brain has no such thing, so Maverick keeps
  -- its own transcript and assembles the context window itself (LOCAL-BRAIN-SPEC 8.4).
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,      -- 'user' | 'assistant' | 'tool'
    content         TEXT NOT NULL DEFAULT '',
    tool_calls      TEXT,               -- JSON array, on assistant turns that called tools
    tool_name       TEXT,               -- set when role='tool'
    created_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

  -- Every tool invocation, whoever asked for it. The spine of the observability view
  -- (/api/turns) and the evidence trail for privileged actions. Written by
  -- server/tools/index.js before the side effect and updated after, so a crash
  -- mid-operation still leaves a record that it was attempted.
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    actor TEXT,                 -- 'user' | 'model' | 'system'
    surface TEXT,               -- 'web' | 'watch' | 'mcp' | 'api'
    conversation_id TEXT,
    tool TEXT NOT NULL,
    tier TEXT,                  -- 'read' | 'write' | 'privileged'
    args_json TEXT,
    result_summary TEXT,
    ok INTEGER,                 -- NULL while in flight, 1 ok, 0 failed
    confirmed INTEGER DEFAULT 0,-- did this cross a confirmation gate
    latency_ms INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_conv ON audit(conversation_id, id);

  -- Lightweight local notes (the Notes module).
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    role TEXT DEFAULT 'Personal',
    pinned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Additive column migrations. better-sqlite3 has no ADD COLUMN IF NOT EXISTS, so guard each
// with a table_info check. Nothing is ever dropped here, including the now-dead
// conversations.cc_session_id: dropping a column in SQLite is a full table rebuild for no gain.
function addColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
addColumn('conversations', 'summary', 'TEXT');           // rolling summary of folded-out turns
addColumn('conversations', 'summary_upto', 'INTEGER');   // highest messages.id covered by it

// Seed a neutral, generic set of spaces on first run — every user renames/adds/removes these
// from the Spaces screen. Override the starter set with DEFAULT_SPACES (comma-separated labels).
const slug = s => String(s || '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'space';

const defaultLabels = (process.env.DEFAULT_SPACES || 'Work, Personal, Health, Learning, Projects, Finance')
  .split(',').map(s => s.trim()).filter(Boolean);
// De-dupe by key so colliding labels (e.g. "Work" twice, or "Side-Project"/"Side Project") never
// collide on the primary key and crash the seed at boot.
const seenKeys = new Set();
const seedSpaces = [];
defaultLabels.forEach(label => {
  let key = slug(label), n = 2;
  while (seenKeys.has(key)) key = `${slug(label)}-${n++}`;
  seenKeys.add(key);
  seedSpaces.push([key, label, SPACE_PALETTE[seedSpaces.length % SPACE_PALETTE.length], seedSpaces.length + 1]);
});

const count = db.prepare('SELECT COUNT(*) n FROM spaces').get().n;
if (count === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO spaces (key, label, color, sort) VALUES (?,?,?,?)');
  const tx = db.transaction(rows => rows.forEach(r => ins.run(...r)));
  tx(seedSpaces);
}

module.exports = db;
