const express = require('express');
const charliework = require('../integrations/charliework');

const router = express.Router();

// GET /api/tasks?role=
router.get('/', async (req, res) => {
  try { res.json(await charliework.listTasks({ role: req.query.role })); }
  catch (e) { res.status(502).json({ connected: true, error: e.message, tasks: [] }); }
});

// POST /api/tasks { title, role?, due? }
router.post('/', async (req, res) => {
  const { title, role, due } = req.body || {};
  if (!title) return res.status(400).json({ error: 'empty' });
  try { res.json(await charliework.addTask({ title, role, due })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
