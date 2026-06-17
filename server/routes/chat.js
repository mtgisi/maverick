const express = require('express');
const db = require('../db');
const claude = require('../claude');

const router = express.Router();

// POST /api/chat { conversation_id, message }
router.post('/', async (req, res) => {
  const conv = (req.body && req.body.conversation_id) || 'web';
  const message = (req.body && req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'empty_message' });
  try {
    const { reply } = await claude.run(conv, message);
    const pending = db.prepare(
      "SELECT id, entry_id, field, old_value, new_value, summary FROM pending_changes WHERE conversation_id=? AND status='pending' ORDER BY id DESC"
    ).all(conv);
    console.log(`[chat] conv=${conv} msg="${message.slice(0, 60)}" pending=${pending.length}`);
    res.json({ reply, pending });
  } catch (e) {
    console.error('[chat]', e.message);
    res.status(500).json({ error: 'chat_failed', detail: e.message });
  }
});

module.exports = router;
