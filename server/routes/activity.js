// Observability over tool use. Answers "what did the assistant actually do, and how long
// did it take", from the audit table.
//
// Deliberately records observable actions only. No model reasoning is stored anywhere, so
// none can be exposed here.

const express = require('express');
const audit = require('../services/audit');
const registry = require('../tools/registry');

const router = express.Router();

// GET /api/activity?limit=&conversation_id=&tool=&tier=
router.get('/', (req, res) => {
  const rows = audit.recent({
    limit: req.query.limit,
    conversationId: req.query.conversation_id,
    tool: req.query.tool,
    tier: req.query.tier,
  });
  res.json(rows.map(r => ({
    ...r,
    args: safeParse(r.args_json),
    ok: r.ok === null ? null : !!r.ok,
    confirmed: !!r.confirmed,
  })));
});

// GET /api/activity/summary?hours=24 — call counts, failures and latency per tool.
router.get('/summary', (req, res) => {
  res.json({
    since_hours: Number(req.query.hours) || 24,
    tools: audit.summary({ sinceHours: req.query.hours }),
  });
});

// GET /api/activity/tools — what the registry currently exposes, with tiers and groups.
// Useful on its own and it is how the settings UI will show the permission surface.
router.get('/tools', (_req, res) => {
  res.json(registry.TOOLS.map(t => ({
    name: t.name,
    group: t.group,
    tier: t.tier,
    self_gated: !!t.selfGated,
    description: t.description,
  })));
});

// GET /api/activity/turn/:conversation_id — one conversation's tool calls in order, which
// is the "User -> Tool Request -> Tool Result -> Assistant" view.
router.get('/turn/:conversation_id', (req, res) => {
  const rows = audit.recent({ conversationId: req.params.conversation_id, limit: 200 });
  res.json(rows.reverse().map(r => ({
    ts: r.ts,
    actor: r.actor,
    surface: r.surface,
    tool: r.tool,
    tier: r.tier,
    args: safeParse(r.args_json),
    result: r.result_summary,
    error: r.error,
    ok: r.ok === null ? null : !!r.ok,
    latency_ms: r.latency_ms,
  })));
});

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return s; }
}

module.exports = router;
