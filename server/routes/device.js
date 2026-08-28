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

// POST /api/device/chat/stream { message, conversation_id? }
//
// Server-Sent Events for desktop clients — Work Cockpit's overlay is the first.
// Same auth and same event vocabulary as /api/chat (token | tool_start | tool_end |
// done | error), so one client parser covers both surfaces.
//
// The watch keeps using the blocking /api/device/chat above: teaching the Zepp OS
// httpRequest relay to speak SSE is not worth it and a watch reply is short
// (LOCAL-BRAIN-SPEC 9). A desktop turn is not short — measured 12s off-LAN — which
// is exactly why this exists.
//
// Falls back to a single `done` event when the brain cannot stream, so the client
// never needs a second code path.
router.post('/chat/stream', async (req, res) => {
  const message = (req.body && req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'empty_message' });
  const conv = (req.body && req.body.conversation_id) || 'desktop';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // stop any proxy buffering the stream into one lump
  });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Listen on `res`, not `req`. On a POST, req 'close' fires as soon as the request
  // BODY has arrived, which is immediately, and aborting on it kills every turn before
  // the first token. Same trap as routes/chat.js.
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  try {
    const { reply, stopped, toolsUsed, latency_ms } = await assistant.run(conv, message, {
      voice: false, surface: 'desktop',
      stream: assistant.supportsStreaming(), signal: ac.signal,
      emit: ev => send(ev),
    });
    if (!res.writableEnded) {
      send({ type: 'done', reply, stopped, toolsUsed, latency_ms });
      res.end();
    }
  } catch (e) {
    console.error('[device/chat/stream]', e.message);
    if (!res.writableEnded) {
      const code = e.code === 'brain_offline' ? 'brain_offline'
                 : e.code === 'queue_full' ? 'busy' : 'chat_failed';
      send({ type: 'error', error: code, message: e.message });
      res.end();
    }
  }
});

// POST /api/device/stt -> { transcript, ms }
//
// Transcribe only, no brain. The overlay's push-to-talk needs the transcript back
// fast so it can show what was heard, then stream the reply separately through
// /chat/stream. /api/device/transcribe still does both in one blocking call for the
// watch, which has no use for the split.
router.post('/stt', express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (req, res) => {
  let buf = null, ext = 'webm';
  if (Buffer.isBuffer(req.body) && req.body.length) {
    buf = req.body;
  } else if (req.body && req.body.audio_b64) {
    try { buf = Buffer.from(req.body.audio_b64, 'base64'); } catch (e) {}
  }
  // MediaRecorder in Electron produces webm/opus. Whisper is called with encode=true,
  // so ffmpeg decodes whatever container arrives and the extension is only a hint.
  const hinted = (req.get('X-Audio-Ext') || (req.body && req.body.ext) || '').replace(/[^a-z0-9]/gi, '');
  if (hinted) ext = hinted;

  if (!buf || !buf.length) return res.status(400).json({ error: 'no_audio' });
  try {
    const { text, ms } = await transcribe(buf, ext);
    console.log(`[device/stt] ${ms}ms ${buf.length}B "${text.slice(0, 60)}"`);
    res.json({ transcript: text, ms });
  } catch (e) {
    console.error('[device/stt]', e.message);
    res.status(502).json({ error: 'stt_failed' });
  }
});

// POST /api/device/speak { text, voice?, speed? } -> audio stream
//
// Device-token TTS, so a desktop client can run the same hands-free loop the PWA
// runs. /api/voice/speak is identical but sits behind the Google session gate,
// which a non-browser client cannot hold.
//
// Written self-contained rather than by extracting a shared helper out of
// routes/voice.js: everything this file adds is additive, so it can be reviewed
// and reverted without touching a route the PWA depends on. If this outlives the
// review, fold the two together — the duplication is deliberate, not accidental.
router.post('/speak', async (req, res) => {
  if (!cfg.tts.enabled) return res.status(503).json({ error: 'tts_disabled' });
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'empty_text' });
  if (text.length > 2000) return res.status(413).json({ error: 'text_too_long' });

  try {
    const upstream = await fetch(`${cfg.tts.url}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kokoro',
        voice: (req.body && req.body.voice) || cfg.tts.voice,
        input: text,
        response_format: cfg.tts.format,
        speed: Number((req.body && req.body.speed) || cfg.tts.speed),
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!upstream.ok) {
      console.error('[device/speak] tts', upstream.status);
      return res.status(502).json({ error: 'tts_failed', status: upstream.status });
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || `audio/${cfg.tts.format}`);
    res.setHeader('Cache-Control', 'no-store');

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        // Respect backpressure: the client is a desktop app on a school network,
        // not localhost, and mp3 for a long reply is not small.
        await new Promise(r => res.once('drain', r));
      }
    }
    res.end();
  } catch (e) {
    console.error('[device/speak]', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'tts_failed' });
    else res.end();
  }
});

module.exports = router;
