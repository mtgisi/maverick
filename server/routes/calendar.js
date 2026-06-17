const express = require('express');
const gcal = require('../google/client');

const router = express.Router();

// GET /api/calendar?date=YYYY-MM-DD&account=label
router.get('/', async (req, res) => {
  try {
    const data = await gcal.listEvents({ account: req.query.account, date: req.query.date });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/calendar/calendars?account=label
router.get('/calendars', async (req, res) => {
  try {
    const data = await gcal.listCalendars({ account: req.query.account });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
