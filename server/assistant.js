// The one place that decides which brain answers a turn.
//
// BRAIN_BACKEND is the rollback lever for the soak window and nothing else (LOCAL-BRAIN-SPEC
// 12.1). It is not a hybrid router: a turn goes entirely to one brain or the other. Once the
// soak passes, the claude path and this switch both get deleted and callers go straight to
// brain/.
//
// Everything above this line (routes, voice, watch) calls run() and does not know or care
// which brain answered.

const cfg = require('./config');
const brain = require('./brain');

let claude = null;
function claudeBrain() {
  // Required lazily so the image can drop the CLI without breaking startup.
  if (!claude) claude = require('./claude');
  return claude;
}

// run(conversationId, message, opts) -> { reply, ... }
//
// opts.emit    progress callback for SSE (local brain only; the Claude path cannot stream)
// opts.stream  stream tokens through emit
// opts.voice   the reply will be spoken, so ask for plain spoken prose
// opts.surface 'web' | 'watch' | 'api', recorded in the audit trail
async function run(conversationId, message, opts = {}) {
  if (cfg.brain.isLocal) return brain.run(conversationId, message, opts);

  const { reply } = await claudeBrain().run(conversationId, message);
  return { reply, rounds: 1, toolsUsed: [], stopped: null, latency_ms: null };
}

async function status() {
  if (!cfg.brain.isLocal) return { backend: 'claude', up: true, model: cfg.MODEL };
  const s = await brain.status();
  return { backend: 'local', ...s };
}

const supportsStreaming = () => cfg.brain.isLocal;

module.exports = { run, status, supportsStreaming, BrainOffline: brain.BrainOffline };
