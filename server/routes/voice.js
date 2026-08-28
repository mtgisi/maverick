// Voice endpoints. Two modes, deliberately separate, because they are different products
// and conflating them is why a single mic button never feels right.
//
//   POST /api/voice/transcribe   dictation. Audio in, text out. NO assistant turn fires.
//                                This is the WhisperFlow-style typing replacement: the
//                                transcript lands in the input box and nothing else happens.
//
//   POST /api/voice/speak        text in, audio out. Used by the conversation loop.
//
// The conversation loop itself lives in the browser (public/voice.js): VAD detects
// end-of-speech locally, so silence never crosses the network and turn-end is detected in
// milliseconds rather than after a round trip. It then calls /api/voice/transcribe,
// /api/chat (SSE), and /api/voice/speak in sequence.

const express = require('express');
const cfg = require('../config');
const pronounce = require('../services/pronounce');
const ollama = require('../brain/ollama');

const router = express.Router();

// Accept raw audio bodies from MediaRecorder as well as JSON base64 from the watch relay.
const rawAudio = express.raw({
  type: ['audio/*', 'application/octet-stream'],
  limit: '25mb',
});

function audioFrom(req) {
  if (Buffer.isBuffer(req.body) && req.body.length) {
    const ct = req.get('Content-Type') || '';
    const ext = ct.includes('webm') ? 'webm'
      : ct.includes('ogg') ? 'ogg'
      : ct.includes('mp4') || ct.includes('m4a') ? 'mp4'
      : ct.includes('mpeg') ? 'mp3'
      : 'wav';
    return { buf: req.body, ext };
  }
  if (req.body && req.body.audio_b64) {
    try {
      return {
        buf: Buffer.from(req.body.audio_b64, 'base64'),
        ext: String(req.body.ext || 'wav').replace(/[^a-z0-9]/gi, '') || 'wav',
      };
    } catch (_) { return { buf: null }; }
  }
  return { buf: null };
}

// Shared by this route and routes/device.js so the watch and the browser cannot drift apart
// on the Whisper contract.
async function transcribe(buf, ext) {
  const fd = new FormData();
  fd.append('audio_file', new Blob([buf]), `audio.${ext}`);
  const started = Date.now();
  const r = await fetch(
    `${cfg.whisperUrl}/asr?task=transcribe&language=en&output=json&encode=true`,
    { method: 'POST', body: fd },
  );
  if (!r.ok) {
    const e = new Error(`whisper ${r.status}`);
    e.code = 'stt_failed';
    e.status = r.status;
    throw e;
  }
  const j = await r.json().catch(() => ({}));
  return { text: (j.text || '').trim(), ms: Date.now() - started };
}

// POST /api/voice/transcribe -> { transcript, ms }
router.post('/transcribe', rawAudio, async (req, res) => {
  const { buf, ext } = audioFrom(req);
  if (!buf || !buf.length) return res.status(400).json({ error: 'no_audio' });
  try {
    const { text, ms } = await transcribe(buf, ext);
    console.log(`[voice] stt ${ms}ms ${buf.length}B "${text.slice(0, 60)}"`);
    res.json({ transcript: text, ms });
  } catch (e) {
    console.error('[voice/transcribe]', e.message);
    res.status(e.code === 'stt_failed' ? 502 : 500).json({ error: e.code || 'transcribe_failed' });
  }
});

// POST /api/voice/speak { text, voice?, speed? } -> audio bytes
//
// Streams the upstream body straight through rather than buffering it, so playback can
// start before synthesis finishes. Kokoro is CPU-bound here; the browser splits replies at
// sentence boundaries and pipelines the requests so the first sentence plays while the
// second is still being made.
router.post('/speak', async (req, res) => {
  if (!cfg.tts.enabled) return res.status(503).json({ error: 'tts_disabled' });
  const raw = String((req.body && req.body.text) || '').trim();
  if (!raw) return res.status(400).json({ error: 'empty_text' });
  if (raw.length > 2000) return res.status(413).json({ error: 'text_too_long' });
  // Rewrite local words the voice mispronounces. Speech only: the text on screen is
  // untouched and stays spelled correctly.
  const text = pronounce.apply(raw);

  try {
    const started = Date.now();
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
      console.error('[voice/speak] tts', upstream.status);
      return res.status(502).json({ error: 'tts_failed', status: upstream.status });
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || `audio/${cfg.tts.format}`);
    res.setHeader('Cache-Control', 'no-store');

    // Node 18+ web stream -> express response.
    const reader = upstream.body.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (!res.write(Buffer.from(value))) {
        await new Promise(r => res.once('drain', r));
      }
    }
    res.end();
    console.log(`[voice] tts ${Date.now() - started}ms ${bytes}B "${raw.slice(0, 50)}"`);
  } catch (e) {
    console.error('[voice/speak]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'tts_failed', detail: e.message });
    else res.end();
  }
});

// POST /api/voice/pronunciations/interpret { word, description } -> { say_as, phonemes }
//
// Turn a free-text description into ONE respelling, then phonemize it.
//
// Describing a sound is naturally full of alternatives and asides: "Crayonts or kr (start
// of kracken)-ants". Stored verbatim, all of that is spoken aloud, "or" and brackets
// included. So the description is distilled first, and the result is validated hard: the
// model is a convenience here, not an authority, and a bad respelling is worse than none.
router.post('/pronunciations/interpret', async (req, res) => {
  const word = String((req.body && req.body.word) || '').trim();
  const description = String((req.body && req.body.description) || '').trim();
  if (!word || !description) return res.status(400).json({ error: 'word and description required' });

  const prompt = `A person is explaining how to say the name "${word}" out loud.

Their explanation: ${description}

Rewrite it as ONE respelling of the sound.
Rules:
- Output the respelling and NOTHING else. No quotes, no explanation, no alternatives.
- All lower case. Letters and spaces only. No hyphens, no capitals, no punctuation.
- Never leave a single letter on its own: write "kruh" or "kra", never "k".
- Spell it the way it SOUNDS, as if teaching a child to read it.
- If they gave several options, pick the first clear one.

Examples:
  "like milky but with a W" -> will key
  "juh-LAM-us, soft J"      -> juh lam us
  "rhymes with wants"       -> krahnts

Respelling:`;

  let candidate = '';
  try {
    const out = await ollama.chat({ messages: [{ role: 'user', content: prompt }] });
    candidate = String((out.message && out.message.content) || '').trim();
  } catch (e) {
    return res.status(503).json({ error: 'brain_offline', detail: e.message });
  }

  // Take the first line and strip the ways a small model dresses up a one-word answer.
  candidate = candidate.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
  candidate = candidate.replace(/^respelling\s*:\s*/i, '')
    .replace(/^["'\u201c\u2018]|["'\u201d\u2019]$/g, '')
    .replace(/[.!]+$/, '')
    .trim();

  const clean = pronounce.sanitizeSayAs(candidate);
  if (!clean.ok) {
    return res.status(422).json({
      error: 'could_not_distil',
      candidate,
      detail: `The model returned "${candidate}", which ${clean.problem || clean.error}. Write the respelling yourself.`,
    });
  }

  // Phonemize through Kokoro's own G2P so the stored IPA is exactly what it will speak.
  let phonemes = null;
  try {
    const r = await fetch(`${cfg.tts.url}/dev/phonemize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: pronounce.normalizeForG2P(clean.value), language: 'a' }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) phonemes = String((await r.json()).phonemes || '').trim() || null;
  } catch (_) {}

  res.json({ word, say_as: clean.value, phonemes, description });
});

// POST /api/voice/pronunciations/phonemize { text } -> { phonemes }
//
// Runs a plain-English respelling through Kokoro's OWN grapheme-to-phoneme pass. That is the
// point: whatever IPA comes back is exactly what the voice would say for that spelling, so
// storing it pins the pronunciation instead of hoping the respelling survives.
//
// Write "will key", get /wˈɪlki/, and the gym stops being called "wilk".
router.post('/pronunciations/phonemize', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'empty_text' });
  try {
    const r = await fetch(`${cfg.tts.url}/dev/phonemize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: pronounce.normalizeForG2P(text), language: 'a' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return res.status(502).json({ error: 'phonemize_failed', status: r.status });
    const j = await r.json().catch(() => ({}));
    const phonemes = String(j.phonemes || '').trim();
    if (!phonemes) return res.status(502).json({ error: 'no_phonemes' });
    res.json({ text, phonemes });
  } catch (e) {
    res.status(502).json({ error: 'phonemize_failed', detail: e.message });
  }
});

// GET|POST|DELETE /api/voice/pronunciations — teach the voice a word.
router.get('/pronunciations', (_req, res) => res.json(pronounce.all()));
router.post('/pronunciations', (req, res) => {
  try { res.json(pronounce.set(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/pronunciations/:word', (req, res) =>
  res.json({ removed: pronounce.remove(req.params.word) }));

// GET /api/voice/status — what the conversation UI needs to know before it starts.
router.get('/status', async (_req, res) => {
  const out = { stt: { url: cfg.whisperUrl, up: false }, tts: { enabled: cfg.tts.enabled, voice: cfg.tts.voice, up: false } };
  await Promise.all([
    fetch(`${cfg.whisperUrl}/docs`, { signal: AbortSignal.timeout(2000) })
      .then(r => { out.stt.up = r.ok; }).catch(() => {}),
    cfg.tts.enabled
      ? fetch(`${cfg.tts.url}/v1/audio/voices`, { signal: AbortSignal.timeout(2000) })
          .then(r => { out.tts.up = r.ok; }).catch(() => {})
      : Promise.resolve(),
  ]);
  res.json(out);
});

module.exports = router;
module.exports.transcribe = transcribe;
