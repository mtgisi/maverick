// Read-only + propose client for the existing timeclock app's token-guarded agent API.
// We never write directly from the agent path — index.js/routes apply confirmed changes.
const { timeclock } = require('../config');

async function getEntries(from, to) {
  if (!timeclock.enabled) throw new Error('timeclock not configured');
  const r = await fetch(`${timeclock.url}/api/agent/entries?from=${from}&to=${to}`, {
    headers: { 'X-Agent-Token': timeclock.token },
  });
  if (!r.ok) throw new Error(`timeclock ${r.status}`);
  return r.json();
}

async function patchEntry(id, body) {
  if (!timeclock.enabled) throw new Error('timeclock not configured');
  const r = await fetch(`${timeclock.url}/api/agent/entries/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': timeclock.token },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('timeclock_rejected'); e.detail = j; throw e; }
  return j;
}

module.exports = { getEntries, patchEntry, enabled: () => timeclock.enabled };
