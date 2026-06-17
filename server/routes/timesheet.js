const express = require('express');
const db = require('../db');
const timeclock = require('../integrations/timeclock');

const router = express.Router();

// GET /api/timesheet?date=YYYY-MM-DD  (today if omitted)
router.get('/', async (req, res) => {
  if (!timeclock.enabled()) return res.json({ connected: false, entries: [] });
  const day = req.query.date || new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'America/Chicago' }).format(new Date());
  try {
    const entries = await timeclock.getEntries(day, day);
    res.json({ connected: true, date: day, entries });
  } catch (e) {
    res.status(502).json({ connected: true, error: e.message });
  }
});

// GET /api/timesheet/pending?conversation_id=
router.get('/pending', (req, res) => {
  const conv = req.query.conversation_id || 'web';
  res.json(db.prepare(
    "SELECT id, entry_id, field, old_value, new_value, summary FROM pending_changes WHERE conversation_id=? AND status='pending' ORDER BY id DESC"
  ).all(conv));
});

// POST /api/timesheet/confirm { id } -> applies the change to timeclock (no LLM in this path)
router.post('/confirm', async (req, res) => {
  const id = req.body && req.body.id;
  const row = db.prepare("SELECT * FROM pending_changes WHERE id=? AND status='pending'").get(id);
  if (!row) return res.status(404).json({ error: 'not_pending' });
  try {
    await timeclock.patchEntry(row.entry_id, { [row.field]: row.new_value });
    db.prepare("UPDATE pending_changes SET status='applied' WHERE id=?").run(id);
    res.json({ success: true, applied: row.summary });
  } catch (e) {
    res.status(502).json({ error: 'timeclock_rejected', detail: e.detail || e.message });
  }
});

// POST /api/timesheet/cancel { id }
router.post('/cancel', (req, res) => {
  const id = req.body && req.body.id;
  db.prepare("UPDATE pending_changes SET status='cancelled' WHERE id=? AND status='pending'").run(id);
  res.json({ success: true });
});

module.exports = router;
