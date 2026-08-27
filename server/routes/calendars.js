// Per-calendar roles: which calendars are your day, which are reference, which are off.
// See server/services/calendars.js for what each role means.

const express = require('express');
const calPrefs = require('../services/calendars');
const gcal = require('../google/client');

const router = express.Router();

// GET /api/calendars — every calendar across connected accounts, with its role.
//
// Degrades rather than failing: if Google is unreachable or a token has expired, the stored
// preferences are still returned (with cached labels) so the screen renders and roles stay
// editable. Losing calendar access should not also mean losing the ability to configure it.
router.get('/', async (_req, res) => {
  let live = [];
  let connected = false;
  let error = null;
  try {
    const r = await gcal.listCalendars({});
    connected = !!r.connected;
    live = (r.calendars || []).filter(c => !c.error);
    const errs = (r.calendars || []).filter(c => c.error);
    if (errs.length) error = errs[0].error;
    calPrefs.rememberLabels(live);
  } catch (e) {
    error = e.message;
  }

  const calendars = calPrefs.merge(live);
  res.json({
    connected,
    error,
    modes: calPrefs.MODES,
    default_mode: calPrefs.DEFAULT_MODE,
    counts: calPrefs.MODES.reduce((m, mode) => (m[mode] = calendars.filter(c => c.mode === mode).length, m), {}),
    calendars: calendars.sort((a, b) =>
      String(a.account).localeCompare(String(b.account)) || String(a.summary).localeCompare(String(b.summary))),
  });
});

// PATCH /api/calendars { account, calendar_id, mode }  — set one calendar's role.
// mode:null clears the explicit setting and returns the calendar to heuristic handling.
router.patch('/', (req, res) => {
  const b = req.body || {};
  const account = String(b.account || '').trim();
  const calendarId = String(b.calendar_id || '').trim();
  if (!account || !calendarId) return res.status(400).json({ error: 'account and calendar_id required' });

  if (b.mode === null) {
    return res.json({ cleared: calPrefs.clear(account, calendarId) });
  }
  if (!calPrefs.isMode(b.mode)) {
    return res.status(400).json({ error: `mode must be one of: ${calPrefs.MODES.join(', ')}` });
  }
  try {
    res.json(calPrefs.set(account, calendarId, b.mode, b.label));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
