const express = require('express');
const workspace = require('../google/workspace');
const gpublic = require('../google/public');

const router = express.Router();

// GET /api/google/drive?query=&account=
router.get('/drive', async (req, res) => {
  try { res.json(await workspace.listDriveFiles({ account: req.query.account, query: req.query.query })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /api/google/youtube?query=&max=
router.get('/youtube', async (req, res) => {
  try { res.json(await gpublic.searchYouTube({ query: req.query.query, max: Number(req.query.max) || 8 })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /api/google/maps/embed?query=&mode=  -> { url } for an <iframe>
router.get('/maps/embed', (req, res) => {
  res.json({ url: gpublic.mapsEmbedUrl({ query: req.query.query || '', mode: req.query.mode || 'place' }) });
});

module.exports = router;
