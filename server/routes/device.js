// Device endpoint for the Amazfit watch (and any non-browser client).
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

// POST /api/device/chat { message, conversation_id? } -> { reply }  (text in)
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

// POST /api/device/transcribe -> { transcript, reply }
// Accepts the audio either as raw bytes (Content-Type: application/octet-stream) or as a JSON body
// { audio_b64, ext?, conversation_id? } (the watch sends base64 so it can ride the zml httpRequest relay).
// Forwards audio to the self-hosted Whisper service, then runs the assistant on the transcript.
router.post('/transcribe', express.raw({ type: 'application/octet-stream', limit: '12mb' }), async (req, res) => {
  let buf = null, ext = 'wav';
  if (Buffer.isBuffer(req.body) && req.body.length) {
    buf = req.body;
  } else if (req.body && req.body.audio_b64) {
    try { buf = Buffer.from(req.body.audio_b64, 'base64'); } catch (e) {}
    if (req.body.ext) ext = String(req.body.ext).replace(/[^a-z0-9]/gi, '') || 'wav';
  }
  if (!buf || !buf.length) return res.status(400).json({ error: 'no_audio' });
  const conv = (req.body && req.body.conversation_id) || req.get('X-Conversation') || 'watch';
  try {
    const fd = new FormData();
    fd.append('audio_file', new Blob([buf]), 'audio.' + ext);
    const r = await fetch(`${cfg.whisperUrl}/asr?task=transcribe&language=en&output=json&encode=true`, { method: 'POST', body: fd });
    if (!r.ok) return res.status(502).json({ error: 'stt_failed', status: r.status });
    const j = await r.json().catch(() => ({}));
    const transcript = (j.text || '').trim();
    if (!transcript) return res.json({ transcript: '', reply: "I didn't catch that — try again." });
    console.log(`[device/transcribe] "${transcript.slice(0, 60)}"`);
    const { reply } = await claude.run(conv, transcript);
    res.json({ transcript, reply });
  } catch (e) {
    console.error('[device/transcribe]', e.message);
    res.status(500).json({ error: 'transcribe_failed', detail: e.message });
  }
});

module.exports = router;
