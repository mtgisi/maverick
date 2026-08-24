// Audit trail for tool invocations.
//
// Two-phase on purpose: begin() writes the row BEFORE the side effect, finish() updates it
// after. A crash or timeout mid-tool therefore leaves an ok=NULL row saying what was
// attempted, which is the case you most want evidence for.
//
// Argument values are recorded, so handlers must never receive secrets as arguments.
// Nothing in server/tools/registry.js does; keep it that way.

const db = require('../db');

// Args can carry a whole email body or a Doc. Cap what lands in the row.
const MAX_ARGS = 4000;
const MAX_SUMMARY = 2000;

const clip = (s, n) => {
  s = typeof s === 'string' ? s : JSON.stringify(s == null ? null : s);
  if (s == null) return null;
  return s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s;
};

const insert = db.prepare(`
  INSERT INTO audit (actor, surface, conversation_id, tool, tier, args_json, confirmed, ok)
  VALUES (@actor, @surface, @conversation_id, @tool, @tier, @args_json, @confirmed, NULL)
`);

const update = db.prepare(`
  UPDATE audit SET ok=@ok, result_summary=@result_summary, error=@error, latency_ms=@latency_ms
  WHERE id=@id
`);

// Open an audit row. Returns { id, done(ok, summaryOrError) }.
function begin({ tool, tier = 'read', args = {}, ctx = {} }) {
  const started = Date.now();
  let id = null;
  try {
    id = insert.run({
      actor: ctx.actor || 'model',
      surface: ctx.surface || 'api',
      conversation_id: ctx.conversationId || null,
      tool,
      tier,
      args_json: clip(args, MAX_ARGS),
      confirmed: ctx.confirmed ? 1 : 0,
    }).lastInsertRowid;
  } catch (e) {
    // Auditing must never be the reason a tool fails. Log and carry on unaudited.
    console.error('[audit] begin failed:', e.message);
  }
  return {
    id,
    done(ok, detail) {
      if (id == null) return;
      try {
        update.run({
          id,
          ok: ok ? 1 : 0,
          result_summary: ok ? clip(detail, MAX_SUMMARY) : null,
          error: ok ? null : clip(detail && detail.message ? detail.message : detail, MAX_SUMMARY),
          latency_ms: Date.now() - started,
        });
      } catch (e) {
        console.error('[audit] finish failed:', e.message);
      }
    },
  };
}

// Recent rows, newest first. Optional filters.
function recent({ limit = 100, conversationId, tool, tier } = {}) {
  const where = [];
  const params = {};
  if (conversationId) { where.push('conversation_id = @conversationId'); params.conversationId = conversationId; }
  if (tool) { where.push('tool = @tool'); params.tool = tool; }
  if (tier) { where.push('tier = @tier'); params.tier = tier; }
  params.limit = Math.min(Number(limit) || 100, 500);
  return db.prepare(`
    SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT @limit
  `).all(params);
}

// Counts by tool over a window, for the activity view.
function summary({ sinceHours = 24 } = {}) {
  return db.prepare(`
    SELECT tool, tier,
           COUNT(*) AS calls,
           SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN ok IS NULL THEN 1 ELSE 0 END) AS incomplete,
           CAST(AVG(latency_ms) AS INTEGER) AS avg_ms,
           MAX(latency_ms) AS max_ms
    FROM audit
    WHERE ts >= datetime('now', @since)
    GROUP BY tool, tier ORDER BY calls DESC
  `).all({ since: `-${Math.max(1, Number(sinceHours) || 24)} hours` });
}

module.exports = { begin, recent, summary };
