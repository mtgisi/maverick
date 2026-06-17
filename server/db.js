const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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

// Seed spaces once (matches Aureo brand guide role palette).
const seedSpaces = [
  ['Teaching', 'Teaching', '#e6a92c', 1],
  ['Tech', 'Tech Coordinator', '#9ca980', 2],
  ['Freelance', 'Freelance', '#c2906a', 3],
  ['Field Sci', 'Field Science', '#6fa195', 4],
  ['Ultimate', 'Ultimate', '#7e93b0', 5],
  ['Esports', 'Esports', '#a98aa0', 6],
  ['Robotics', 'Robotics', '#cf9f5a', 7],
  ['Media', 'Media & Broadcast', '#8f9bb0', 8],
  ['Personal', 'Personal', '#a3a392', 9],
];
const count = db.prepare('SELECT COUNT(*) n FROM spaces').get().n;
if (count === 0) {
  const ins = db.prepare('INSERT INTO spaces (key, label, color, sort) VALUES (?,?,?,?)');
  const tx = db.transaction(rows => rows.forEach(r => ins.run(...r)));
  tx(seedSpaces);
}

module.exports = db;
