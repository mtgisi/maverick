const express = require('express');
const bookmarks = require('../integrations/bookmarks');

const router = express.Router();

// GET /api/bookmarks?query=
router.get('/', async (req, res) => {
  try { res.json(await bookmarks.list({ query: req.query.query })); }
  catch (e) { res.status(502).json({ connected: true, error: e.message, items: [] }); }
});

module.exports = router;
