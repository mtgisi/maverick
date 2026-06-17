// Device endpoint for the Amazfit watch mini program (and any non-browser client).
// Auth = static DEVICE_TOKEN in the X-Device-Token header. Kept OFF the Google-session gate.
const express = require('express');
const claude = require('../claude');
const cfg = require('../config');

const router = express.Router();

router.use((req, res, next) => {
  if (!cfg.deviceToken) return res.status(503).json({ error: 'device_disabled' });
  if ((req.get('X-Device-Token') || '') !== cfg.deviceToken) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// POST /api/device/chat { message, conversation_id? } -> { reply }
router.post('/chat', async (req, res) => {
  const message = (req.body && req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'empty_message' });
  const conv = (req.body && req.body.conversation_id) || 'watch';
  try {
    const { reply } = await claude.run(conv, message);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'chat_failed', detail: e.message });
  }
});

module.exports = router;
