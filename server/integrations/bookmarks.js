// Read client for Powermark (the bookmarks app). Requires a token-guarded agent route on that app,
// supplied via BOOKMARKS_AGENT_TOKEN. Disabled (no-op) until that exists — we do NOT modify the
// bookmarks app here (preserve-first); add an agent route there later, mirroring timeclock's.
const { bookmarks } = require('../config');

async function list({ query } = {}) {
  if (!bookmarks.enabled) return { connected: false, items: [] };
  const q = query ? `?q=${encodeURIComponent(query)}` : '';
  const r = await fetch(`${bookmarks.url}/api/agent/items${q}`, {
    headers: { 'X-Agent-Token': bookmarks.token },
  });
  if (!r.ok) throw new Error(`bookmarks ${r.status}`);
  const data = await r.json();
  return { connected: true, items: Array.isArray(data) ? data : (data.items || []) };
}

module.exports = { list, enabled: () => bookmarks.enabled };
