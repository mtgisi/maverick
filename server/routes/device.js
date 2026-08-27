// Device endpoint for the Amazfit watch (and any non-browser client).
// Auth = static DEVICE_TOKEN in the X-Device-Token header. Kept OFF the Google-session gate.
//
// The JSON contracts here are deliberately unchanged by the local-brain rework. Teaching the
// Zepp OS httpRequest relay to speak SSE is not worth it, and a watch reply is short enough
// that streaming would buy little (LOCAL-BRAIN-SPEC 9).
const express = require('express');
const assistant = require('../assistant');
const cfg = require('../config');
const { transcribe } = require('./voice');

const router = express.Router();

router.use((req, res, next) => {
  if (!cfg.deviceToken) return res.status(503).json({ error: 'device_disabled' });
  if ((req.get('X-Device-Token') || '') !== cfg.deviceToken) return res.status(401).json({ error: 'unauthorized' });
  next();
});

const brainError = (res, e) => {
  console.error('[device]', e.message);
  // A specific offline state, so the watch's Talk page can say what is actually wrong
  // rather than showing a generic error. Under the hard cutover this state is more likely
  // than it was, and the message is cheap.
  if (e.code === 'brain_offline') {
    return res.status(503).json({ error: 'brain_offline', reply: 'My brain is offline right now.' });
  }
  if (e.code === 'queue_full') {
    return res.status(429).json({ error: 'busy', reply: 'Still on the last thing. Ask again in a second.' });
  }
  return res.status(500).json({ error: 'chat_failed', detail: e.message });
};

// POST /api/device/chat { message, conversation_id? } -> { reply }  (text in)
router.post('/chat', async (req, res) => {
  const message = (req.body && req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'empty_message' });
  const conv = (req.body && req.body.conversation_id) || 'watch';
  try {
    // voice:true — a watch reply is read on a 466px round screen or spoken, so ask for
    // plain prose rather than markdown.
    const { reply } = await assistant.run(conv, message, { voice: true, surface: 'watch' });
    res.json({ reply });
  } catch (e) {
    brainError(res, e);
  }
});

// POST /api/device/transcribe -> { transcript, reply }
// Audio arrives either as raw bytes (Content-Type: application/octet-stream) or as JSON
// { audio_b64, ext?, conversation_id? } — the watch sends base64 so it can ride the zml
// httpRequest relay.
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

  let transcript;
  try {
    ({ text: transcript } = await transcribe(buf, ext));
  } catch (e) {
    console.error('[device/transcribe] stt', e.message);
    return res.status(502).json({ error: 'stt_failed' });
  }
  if (!transcript) return res.json({ transcript: '', reply: "I didn't catch that — try again." });
  console.log(`[device/transcribe] "${transcript.slice(0, 60)}"`);

  try {
    const { reply } = await assistant.run(conv, transcript, { voice: true, surface: 'watch' });
    res.json({ transcript, reply });
  } catch (e) {
    // The transcript is worth returning even when the brain failed: the watch can show what
    // it heard, which makes the failure legible instead of mysterious.
    if (e.code === 'brain_offline') {
      return res.status(503).json({ transcript, error: 'brain_offline', reply: 'My brain is offline right now.' });
    }
    brainError(res, e);
  }
});

module.exports = router;
