// ollama HTTP client for the local brain.
//
// Structure follows /bastion/projects/promptsmith/src/ollama.js, which is already proven
// against this exact machine (LOCAL-BRAIN-SPEC 8.1). What it buys:
//
//   health probe with a cached verdict  - a sleeping desktop costs one 2s probe, not a
//                                         30s stall on every request
//   circuit breaker                     - a failed generation invalidates the cached "up"
//   serial queue with a bounded depth   - OLLAMA_NUM_PARALLEL is 1, so concurrent requests
//                                         would queue inside ollama anyway; queueing here
//                                         means we can reject past the bound instead of
//                                         letting a caller hang
//
// Differences from promptsmith: /api/chat with a tools array rather than plain completions,
// streaming, and num_ctx set explicitly on every request. Omitting num_ctx makes ollama use
// the model's own default, which is not what the VRAM budget was calculated against.

const { brain } = require('../config');

let health = { up: null, checkedAt: 0 };

const now = () => Date.now();

// ---- health ---------------------------------------------------------------------------

function invalidateHealth() { health = { up: null, checkedAt: 0 }; }

async function isUp() {
  const ttl = health.up ? brain.probeUpTtlMs : brain.probeDownTtlMs;
  if (health.up !== null && now() - health.checkedAt < ttl) return health.up;

  let up = false;
  try {
    const ctl = AbortSignal.timeout(brain.probeTimeoutMs);
    const r = await fetch(`${brain.url}/api/tags`, { signal: ctl });
    up = r.ok;
  } catch (_) {
    up = false;
  }
  health = { up, checkedAt: now() };
  if (!up) console.warn(`[brain] ollama probe failed at ${brain.url}`);
  return up;
}

// ---- serial queue ---------------------------------------------------------------------

let active = 0;
const waiting = [];

function acquire() {
  if (active === 0) { active = 1; return Promise.resolve(); }
  if (waiting.length >= brain.queueMax) {
    return Promise.reject(Object.assign(new Error('brain is busy'), { code: 'queue_full' }));
  }
  return new Promise(resolve => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active = 0;
}

// ---- chat -----------------------------------------------------------------------------

function body({ messages, tools, stream }) {
  const b = {
    model: brain.model,
    stream: !!stream,
    keep_alive: -1,
    options: {
      num_ctx: brain.numCtx,
      temperature: brain.temperature,
      top_p: brain.topP,
      num_predict: brain.numPredict,
    },
    messages,
  };
  // Send `tools` only when there are some. An empty array is not the same as absent, and
  // some builds will still bias toward emitting a call when the key is present.
  if (tools && tools.length) b.tools = tools;
  return b;
}

class BrainOffline extends Error {
  constructor(msg = 'The local brain is offline.') { super(msg); this.code = 'brain_offline'; }
}

// Non-streaming chat. Returns the assistant message object as ollama produced it:
//   { role:'assistant', content:'', tool_calls:[{ id, function:{ name, arguments } }] }
// NOTE arguments is an OBJECT on ollama 0.32.14, not a JSON string. Verified against the
// running instance on 2026-08-27; re-verify after any ollama upgrade.
async function chat({ messages, tools }) {
  if (!(await isUp())) throw new BrainOffline();
  await acquire();
  try {
    const r = await fetch(`${brain.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body({ messages, tools, stream: false })),
      signal: AbortSignal.timeout(brain.genTimeoutMs),
    });
    if (!r.ok) {
      invalidateHealth();
      throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    const j = await r.json();
    return { message: j.message || { role: 'assistant', content: '' }, raw: j };
  } catch (e) {
    invalidateHealth();
    throw e;
  } finally {
    release();
  }
}

// Streaming chat. Yields ollama's NDJSON chunks as parsed objects. Each carries a partial
// `message`; the final one has done:true and the timing fields.
//
// Tool calls do arrive on the streaming path, but they arrive whole rather than
// incrementally, in a chunk whose message has a tool_calls array. The loop treats any chunk
// carrying tool_calls as terminal for that round.
async function* chatStream({ messages, tools, signal }) {
  if (!(await isUp())) throw new BrainOffline();
  await acquire();
  try {
    const r = await fetch(`${brain.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body({ messages, tools, stream: true })),
      signal: signal || AbortSignal.timeout(brain.genTimeoutMs),
    });
    if (!r.ok) {
      invalidateHealth();
      throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // NDJSON: one JSON object per line. A chunk boundary can split a line, so keep the tail.
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { yield JSON.parse(line); }
        catch (_) { /* a malformed line is not worth killing the stream over */ }
      }
    }
    if (buf.trim()) { try { yield JSON.parse(buf.trim()); } catch (_) {} }
  } catch (e) {
    invalidateHealth();
    throw e;
  } finally {
    release();
  }
}

// For /healthz and the PWA's brain-offline state.
async function status() {
  const up = await isUp();
  let loaded = null;
  if (up) {
    try {
      const r = await fetch(`${brain.url}/api/ps`, { signal: AbortSignal.timeout(brain.probeTimeoutMs) });
      const j = await r.json();
      const m = (j.models || [])[0];
      if (m) loaded = { name: m.name, vram_bytes: m.size_vram, context_length: m.context_length };
    } catch (_) {}
  }
  return { provider: 'ollama', url: brain.url, model: brain.model, up, loaded, queued: waiting.length };
}

module.exports = { chat, chatStream, isUp, status, invalidateHealth, BrainOffline };
