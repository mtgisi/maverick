// Health log for the PWA (behind the Google session gate, mounted under /api/health).
const express = require('express');
const health = require('../services/health');
const cfg = require('../config');

const router = express.Router();

// GET /api/health/day/:day  ("today" works) -> { summary, entries, shared }
// `shared` is exactly what the accountability bot receives, so the app can show it.
router.get('/day/:day', (req, res) => {
  const d = health.resolveDay(req.params.day === 'today' ? '' : req.params.day);
  // Reads may look further back than writes are allowed to.
  const day = d.day || (health.isDay(req.params.day) ? req.params.day : null);
  if (!day) return res.status(400).json({ error: d.error || 'bad_date' });
  res.json({
    summary: health.summarise(day),
    entries: health.entries(day),
    shared: health.sharedView(day, { shareWeight: cfg.share.shareWeight }),
  });
});

// POST /api/health/log { day?, entries: [{ kind, value?, label? }] }
router.post('/log', (req, res) => {
  const body = req.body || {};
  const d = health.resolveDay(body.day);
  if (d.error) return res.status(400).json({ error: d.error });
  const list = Array.isArray(body.entries) ? body.entries : [];
  if (!list.length || list.length > 12) return res.status(400).json({ error: 'entries must hold 1-12 items' });
  try {
    health.log(d.day, list.map(e => ({ kind: e.kind, value: e.value, label: e.label })), 'web');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ summary: health.summarise(d.day), entries: health.entries(d.day) });
});

// DELETE /api/health/entries/:id
router.delete('/entries/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
  res.json({ removed: health.remove(id) });
});

module.exports = router;
