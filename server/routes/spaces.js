const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/spaces -> roles/contexts with live-ish counts (memories + notes per role)
router.get('/', (req, res) => {
  const spaces = db.prepare('SELECT key, label, color, sort FROM spaces ORDER BY sort ASC').all();
  const memCounts = db.prepare('SELECT role, COUNT(*) n FROM memories GROUP BY role').all()
    .reduce((m, r) => (m[r.role] = r.n, m), {});
  const noteCounts = db.prepare('SELECT role, COUNT(*) n FROM notes GROUP BY role').all()
    .reduce((m, r) => (m[r.role] = r.n, m), {});
  res.json(spaces.map(s => ({ ...s, memories: memCounts[s.key] || 0, notes: noteCounts[s.key] || 0 })));
});

module.exports = router;
