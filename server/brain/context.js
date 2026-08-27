// Conversation storage and context-window assembly (LOCAL-BRAIN-SPEC 8.4).
//
// The Claude Code brain handed session management to the CLI via --resume. The local brain
// has no equivalent, so Maverick keeps its own transcript in `messages` and decides what
// fits. Budget for num_ctx 16384:
//
//   system prompt        <=   450   (brain/prompt.js)
//   tool schemas         <=   600   (capped at 8 tools by brain/gating.js)
//   rolling summary      <=   400
//   recent messages      <= 6,000   last 8 turns, oldest dropped first
//   tool results         <= 6,000   each capped at 1,500
//   reserved for output          800
//
// Token counting here is an estimate, not a tokenizer. chars/4 is close enough for qwen on
// English prose and it costs nothing; the budgets have enough slack to absorb the error.

const db = require('../db');
const { brain } = require('../config');

const estTokens = s => Math.ceil(String(s == null ? '' : s).length / 4);

const BUDGET = {
  summary: 400,
  recent: 6000,
  toolResult: () => brain.toolResultTokens,
};

// ---- persistence -----------------------------------------------------------------------

function append(conversationId, { role, content = '', toolCalls = null, toolName = null }) {
  const info = db.prepare(`
    INSERT INTO messages (conversation_id, role, content, tool_calls, tool_name)
    VALUES (?,?,?,?,?)
  `).run(conversationId, role, content || '', toolCalls ? JSON.stringify(toolCalls) : null, toolName);
  db.prepare(`
    INSERT INTO conversations (conversation_id, updated_at) VALUES (?, datetime('now'))
    ON CONFLICT(conversation_id) DO UPDATE SET updated_at=datetime('now')
  `).run(conversationId);
  return info.lastInsertRowid;
}

const conversation = id =>
  db.prepare('SELECT * FROM conversations WHERE conversation_id=?').get(id) || {};

// Recent history as ollama messages, newest-last, oldest dropped first when over budget.
// Rows already folded into the rolling summary (id <= summary_upto) are skipped.
function history(conversationId, { maxTurns = brain.historyTurns, maxTokens = BUDGET.recent } = {}) {
  const conv = conversation(conversationId);
  const upto = conv.summary_upto || 0;

  // A "turn" is a user message plus everything that followed it, so pull generously and trim.
  const rows = db.prepare(`
    SELECT * FROM messages WHERE conversation_id=? AND id > ?
    ORDER BY id DESC LIMIT ?
  `).all(conversationId, upto, maxTurns * 6).reverse();

  // Tool results NEVER cross a turn boundary.
  //
  // A tool result is a snapshot of the world at the moment it ran, and replaying it later
  // presents stale data as current. Observed: a calendar listing captured before per-calendar
  // roles were applied stayed in the context, and the model kept answering from that old
  // list, including events from calendars that had since been marked reference. The fresh
  // tool call was made and then ignored in favour of the stale text sitting above it.
  //
  // Anything the assistant concluded from a tool result is already in its own reply, which
  // IS kept. If a fact matters beyond the turn it belongs in memories, not in a transcript.
  //
  // Assistant turns that exist only to carry tool_calls go too: a call with no result is
  // malformed, and its content is empty anyway.
  const conversational = rows.filter(r => {
    if (r.role === 'tool') return false;
    if (r.role === 'assistant' && r.tool_calls && !(r.content || '').trim()) return false;
    return (r.content || '').trim().length > 0;
  }).map(r => ({ ...r, tool_calls: null }));

  let out = conversational;
  const cost = list => list.reduce((n, r) => n + estTokens(r.content), 0);
  while (out.length && cost(out) > maxTokens) out = out.slice(1);

  return out.map(toOllamaMessage);
}

function toOllamaMessage(row) {
  if (row.role === 'tool') {
    return { role: 'tool', content: row.content, tool_name: row.tool_name || undefined };
  }
  const m = { role: row.role, content: row.content || '' };
  if (row.tool_calls) {
    try { m.tool_calls = JSON.parse(row.tool_calls); } catch (_) {}
  }
  return m;
}

// ---- assembly --------------------------------------------------------------------------

// Build the message array for the first ollama call of a turn.
function assemble({ conversationId, systemPrompt, userMessage }) {
  const messages = [{ role: 'system', content: systemPrompt }];

  const conv = conversation(conversationId);
  if (conv.summary) {
    messages.push({
      role: 'system',
      content: `Earlier in this conversation: ${clip(conv.summary, BUDGET.summary)}`,
    });
  }

  messages.push(...history(conversationId));
  messages.push({ role: 'user', content: userMessage });
  return messages;
}

// Cap a tool result and say so explicitly. A silent truncation reads to the model as a
// complete answer, which is how you get confident replies built on half a calendar.
function truncateToolResult(text, maxTokens = BUDGET.toolResult()) {
  const s = String(text == null ? '' : text);
  const maxChars = maxTokens * 4;
  if (s.length <= maxChars) return s;
  const kept = s.slice(0, maxChars);
  const lines = s.split('\n').length;
  const keptLines = kept.split('\n').length;
  const more = lines > keptLines ? `${lines - keptLines} more rows` : `${s.length - maxChars} more chars`;
  return `${kept}\n[truncated, ${more}]`;
}

const clip = (s, maxTokens) => {
  const maxChars = maxTokens * 4;
  const str = String(s || '');
  return str.length > maxChars ? `${str.slice(0, maxChars)}…` : str;
};

// ---- rolling summary -------------------------------------------------------------------

// Fold the oldest messages into the rolling summary. Called AFTER the reply is sent, never
// before, so summarisation never sits in the user's latency path.
async function maybeSummarize(conversationId, generate) {
  const conv = conversation(conversationId);
  const upto = conv.summary_upto || 0;
  const rows = db.prepare(
    'SELECT * FROM messages WHERE conversation_id=? AND id > ? ORDER BY id ASC'
  ).all(conversationId, upto);

  const cost = rows.reduce((n, r) => n + estTokens(r.content), 0);
  if (cost <= BUDGET.recent) return false;

  // Fold everything except the most recent few turns.
  const keep = brain.historyTurns * 2;
  const fold = rows.slice(0, Math.max(0, rows.length - keep));
  if (!fold.length) return false;

  const transcript = fold
    .map(r => `${r.role}${r.tool_name ? `(${r.tool_name})` : ''}: ${clip(r.content, 200)}`)
    .join('\n');

  try {
    const summary = await generate(
      `${conv.summary ? `Existing summary:\n${conv.summary}\n\n` : ''}` +
      `New transcript to fold in:\n${transcript}\n\n` +
      `Rewrite the summary in under 150 words. Keep decisions, facts, names, ids and open ` +
      `threads. Drop pleasantries. Write plain prose, no preamble.`
    );
    if (!summary || !summary.trim()) return false;
    db.prepare('UPDATE conversations SET summary=?, summary_upto=? WHERE conversation_id=?')
      .run(summary.trim(), fold[fold.length - 1].id, conversationId);
    console.log(`[brain] summarised ${fold.length} messages for ${conversationId}`);
    return true;
  } catch (e) {
    console.warn('[brain] summarisation failed:', e.message);
    return false;
  }
}

function reset(conversationId) {
  // Drop the carried tool groups too, or a cleared conversation still behaves as though it
  // were mid-subject.
  try { require('./gating').forget(conversationId); } catch (_) {}
  db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conversationId);
  db.prepare('UPDATE conversations SET summary=NULL, summary_upto=NULL WHERE conversation_id=?')
    .run(conversationId);
}

module.exports = {
  append, history, assemble, truncateToolResult, maybeSummarize, reset,
  conversation, estTokens, BUDGET,
};
