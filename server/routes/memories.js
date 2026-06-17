const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/memories
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, text, kind, role, created_at FROM memories ORDER BY id DESC LIMIT 200').all());
});

// POST /api/memories { text, kind?, role? }
router.post('/', (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  const info = db.prepare('INSERT INTO memories (text, kind, role) VALUES (?,?,?)')
    .run(text, (req.body.kind || 'note'), (req.body.role || 'Personal'));
  res.json({ id: info.lastInsertRowid });
});

// DELETE /api/memories/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id=?').run(parseInt(req.params.id));
  res.json({ success: true });
});

module.exports = router;
