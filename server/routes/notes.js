const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/notes?role=
router.get('/', (req, res) => {
  const role = req.query.role;
  const rows = role && role !== 'All'
    ? db.prepare('SELECT * FROM notes WHERE role=? ORDER BY pinned DESC, updated_at DESC LIMIT 200').all(role)
    : db.prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT 200').all();
  res.json(rows);
});

// POST /api/notes { title, body?, role?, pinned? }
router.post('/', (req, res) => {
  const { title, body, role, pinned } = req.body || {};
  if (!title) return res.status(400).json({ error: 'empty' });
  const info = db.prepare('INSERT INTO notes (title, body, role, pinned) VALUES (?,?,?,?)')
    .run(title, body || '', role || 'Personal', pinned ? 1 : 0);
  res.json({ id: info.lastInsertRowid });
});

// DELETE /api/notes/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id=?').run(parseInt(req.params.id));
  res.json({ success: true });
});

module.exports = router;
