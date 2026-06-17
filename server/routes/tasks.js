const express = require('express');
const charliework = require('../integrations/charliework');

const router = express.Router();

// GET /api/tasks?category=&include_done=
router.get('/', async (req, res) => {
  try {
    res.json(await charliework.listTasks({ category: req.query.category, includeDone: req.query.include_done === '1' }));
  } catch (e) { res.status(502).json({ connected: true, error: e.message, tasks: [] }); }
});

// POST /api/tasks  { title, due_date?, category?, notes?, tier?, assignee? }
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'empty' });
  try { res.json(await charliework.addTask(b)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// PATCH /api/tasks/:id  { status?, due_date?, ... } — used by the UI to complete/reschedule
router.patch('/:id', async (req, res) => {
  try { res.json(await charliework.patchTask(req.params.id, req.body || {})); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
