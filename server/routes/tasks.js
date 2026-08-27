// Unified task API over charliework + goosework.
//
// No assistant anywhere in this file. The task surface works with the brain switched off,
// which is the layering rule the platform depends on: the AI is an interface over these
// services, not the services themselves.

const express = require('express');
const tasks = require('../services/tasks');

const router = express.Router();

// GET /api/tasks?status=open|done|all&source=&space=&category=&limit=
router.get('/', (req, res) => {
  const items = tasks.list({
    status: req.query.status || 'open',
    source: req.query.source,
    space: req.query.space,
    category: req.query.category,
    limit: req.query.limit,
  });
  const st = tasks.status();
  res.json({
    connected: st.sources.some(s => s.connected),
    sources: st.sources,
    counts: tasks.counts(),
    last_sync: st.last_sync ? st.last_sync.at : null,
    unsynced: st.dirty,
    tasks: items,
  });
});

// GET /api/tasks/status — sync health, for the settings screen.
router.get('/status', (_req, res) => res.json(tasks.status()));

// POST /api/tasks/sync — force a pull now rather than waiting for the interval.
router.post('/sync', async (_req, res) => {
  try { res.json(await tasks.sync()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tasks { source, title, due_date?, category?, notes?, tier? }
router.post('/', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!b.source) return res.status(400).json({ error: 'source required (charliework | goosework)' });
  try {
    const r = await tasks.create({ ...b, title });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.task);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id { status?, due_date?, notes?, title? }
// The id is the prefixed one ('cw:...' / 'gw:...'); the service routes it to the right origin.
router.patch('/:id', async (req, res) => {
  try {
    const r = await tasks.update(req.params.id, req.body || {});
    if (!r.ok) return res.status(r.error && r.error.startsWith('no task') ? 404 : 400).json({ error: r.error });
    // 202 when the local edit is recorded but the origin has not confirmed it yet, so the
    // client can show "not synced" rather than claiming success.
    res.status(r.pushed ? 200 : 202).json(r.task);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
