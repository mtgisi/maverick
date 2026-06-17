const express = require('express');
const gcal = require('../google/client');
const oauth = require('../google/oauth');

const router = express.Router();

// GET /api/mail/accounts
router.get('/accounts', (req, res) => res.json(oauth.listAccounts()));

// GET /api/mail/drafts?account=label
router.get('/drafts', async (req, res) => {
  try { res.json(await gcal.listDrafts({ account: req.query.account })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// POST /api/mail/draft { account, to, subject, body }  -> creates a DRAFT (never sends)
router.post('/draft', async (req, res) => {
  const { account, to, subject, body } = req.body || {};
  if (!subject && !body) return res.status(400).json({ error: 'empty' });
  try {
    const r = await gcal.createDraft({ account, to, subject, body });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
