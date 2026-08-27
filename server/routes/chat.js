const express = require('express');
const db = require('../db');
const assistant = require('../assistant');

const router = express.Router();

const pendingFor = conv => db.prepare(
  "SELECT id, entry_id, field, old_value, new_value, summary FROM pending_changes " +
  "WHERE conversation_id=? AND status='pending' ORDER BY id DESC"
).all(conv);

// POST /api/chat { conversation_id, message, voice? }
//
// Streams Server-Sent Events by default. A client that wants the old blocking JSON contract
// sends `Accept: application/json`, which keeps anything not yet updated working
// (LOCAL-BRAIN-SPEC 9).
//
// Events: token | tool_start | tool_end | done | error
// `done` carries the pending array, because the timeclock confirm UI depends on it.
router.post('/', async (req, res) => {
  const conv = (req.body && req.body.conversation_id) || 'web';
  const message = (req.body && req.body.message || '').trim();
  const voice = !!(req.body && req.body.voice);
  if (!message) return res.status(400).json({ error: 'empty_message' });

  const wantsJson = (req.get('Accept') || '').includes('application/json');
  const canStream = assistant.supportsStreaming();

  if (wantsJson || !canStream) {
    try {
      const { reply, stopped } = await assistant.run(conv, message, { voice, surface: 'web' });
      const pending = pendingFor(conv);
      console.log(`[chat] conv=${conv} msg="${message.slice(0, 60)}" pending=${pending.length}`);
      return res.json({ reply, pending, stopped });
    } catch (e) {
      return failJson(res, e);
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // stop any proxy buffering the stream into one lump
  });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Client hung up (navigated away, or barge-in cancelled the turn). Abort the generation
  // rather than letting it run on burning a queue slot.
  //
  // This listens on `res`, not `req`. On a POST, req 'close' fires as soon as the request
  // BODY has been fully received, which is immediately, so aborting on it kills every turn
  // before the first token. res 'close' with writableEnded still false is the actual
  // client-went-away signal.
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  try {
    const { reply, stopped, toolsUsed, latency_ms } = await assistant.run(conv, message, {
      voice, surface: 'web', stream: true, signal: ac.signal,
      emit: ev => send(ev),
    });
    if (!res.writableEnded) {
      send({ type: 'done', reply, pending: pendingFor(conv), stopped, toolsUsed, latency_ms });
      res.end();
    }
  } catch (e) {
    console.error('[chat]', e.message);
    if (!res.writableEnded) {
      send({ type: 'error', error: e.code || 'chat_failed', message: friendly(e) });
      res.end();
    }
  }
});

// DELETE /api/chat/history { conversation_id } — forget this conversation.
//
// Useful when a turn captured something now wrong: tool results no longer cross turns, but
// the assistant's own replies do, and a reply that described the old state can still mislead.
// Only the transcript goes. Memories, reminders, tasks and the audit trail are untouched.
router.delete('/history', (req, res) => {
  const conv = (req.body && req.body.conversation_id) || 'web';
  require('../brain/context').reset(conv);
  console.log(`[chat] cleared history for ${conv}`);
  res.json({ ok: true, conversation_id: conv });
});

// GET /api/chat/status — brain reachability, for the PWA's offline state.
router.get('/status', async (_req, res) => {
  try { res.json(await assistant.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

function failJson(res, e) {
  console.error('[chat]', e.message);
  const offline = e.code === 'brain_offline';
  return res.status(offline ? 503 : 500).json({
    error: e.code || 'chat_failed',
    detail: friendly(e),
  });
}

const friendly = e =>
  e.code === 'brain_offline' ? 'The local brain is offline. Check that goose-desktop is awake.'
  : e.code === 'queue_full' ? 'Still working on the last thing. Try again in a moment.'
  : e.message;

module.exports = router;
