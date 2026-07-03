const express = require('express');
const db = require('../db');
const { SPACE_PALETTE } = require('../config');

const router = express.Router();

const slug = s => String(s || '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'space';

// Ensure a key is unique by appending -2, -3, … if needed.
function uniqueKey(base) {
  let key = base, n = 2;
  while (db.prepare('SELECT 1 FROM spaces WHERE key=?').get(key)) key = `${base}-${n++}`;
  return key;
}

function withCounts(spaces) {
  const memCounts = db.prepare('SELECT role, COUNT(*) n FROM memories GROUP BY role').all()
    .reduce((m, r) => (m[r.role] = r.n, m), {});
  const noteCounts = db.prepare('SELECT role, COUNT(*) n FROM notes GROUP BY role').all()
    .reduce((m, r) => (m[r.role] = r.n, m), {});
  return spaces.map(s => ({ ...s, memories: memCounts[s.key] || 0, notes: noteCounts[s.key] || 0 }));
}

const allSpaces = () => db.prepare('SELECT key, label, color, sort FROM spaces ORDER BY sort ASC, label ASC').all();

// GET /api/spaces -> roles/contexts with live-ish counts (memories + notes per space)
router.get('/', (req, res) => {
  res.json(withCounts(allSpaces()));
});

// POST /api/spaces { label, color? } -> create a new space
router.post('/', (req, res) => {
  const label = (req.body && req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label_required' });
  const key = uniqueKey(slug(label));
  const nextSort = (db.prepare('SELECT MAX(sort) m FROM spaces').get().m || 0) + 1;
  const color = (req.body && req.body.color) || SPACE_PALETTE[(nextSort - 1) % SPACE_PALETTE.length];
  db.prepare('INSERT INTO spaces (key, label, color, sort) VALUES (?,?,?,?)').run(key, label, color, nextSort);
  res.status(201).json({ key, label, color, sort: nextSort, memories: 0, notes: 0 });
});

// PATCH /api/spaces/:key { label?, color?, sort? } -> rename / recolor / reorder (key is stable)
router.patch('/:key', (req, res) => {
  const cur = db.prepare('SELECT key, label, color, sort FROM spaces WHERE key=?').get(req.params.key);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const label = b.label != null ? String(b.label).trim() || cur.label : cur.label;
  const color = b.color != null ? String(b.color) : cur.color;
  const sort = b.sort != null ? Number(b.sort) : cur.sort;
  db.prepare('UPDATE spaces SET label=?, color=?, sort=? WHERE key=?').run(label, color, sort, cur.key);
  res.json({ key: cur.key, label, color, sort });
});

// DELETE /api/spaces/:key -> remove a space (its memories/notes keep their tag, just uncounted)
router.delete('/:key', (req, res) => {
  const info = db.prepare('DELETE FROM spaces WHERE key=?').run(req.params.key);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// PUT /api/spaces/reorder { keys: [...] } -> set sort to match the given key order
router.put('/reorder', (req, res) => {
  const keys = (req.body && req.body.keys) || [];
  if (!Array.isArray(keys)) return res.status(400).json({ error: 'keys_required' });
  const upd = db.prepare('UPDATE spaces SET sort=? WHERE key=?');
  const tx = db.transaction(list => list.forEach((k, i) => upd.run(i + 1, k)));
  tx(keys);
  res.json(withCounts(allSpaces()));
});

module.exports = router;
