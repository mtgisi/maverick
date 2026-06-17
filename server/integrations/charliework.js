// Client for the charliework task manager (github.com/mtgisi/charliework).
// Generic REST shape; adjust paths once charliework exposes its API. Disabled when CHARLIEWORK_API_URL is blank.
const { charliework } = require('../config');

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (charliework.token) h['Authorization'] = `Bearer ${charliework.token}`;
  return h;
}

async function listTasks({ role } = {}) {
  if (!charliework.enabled) return { connected: false, tasks: [] };
  const q = role && role !== 'All' ? `?role=${encodeURIComponent(role)}` : '';
  const r = await fetch(`${charliework.url}/api/tasks${q}`, { headers: headers() });
  if (!r.ok) throw new Error(`charliework ${r.status}`);
  const data = await r.json();
  return { connected: true, tasks: Array.isArray(data) ? data : (data.tasks || []) };
}

async function addTask({ title, role, due }) {
  if (!charliework.enabled) return { connected: false };
  const r = await fetch(`${charliework.url}/api/tasks`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ title, role, due }),
  });
  if (!r.ok) throw new Error(`charliework ${r.status}`);
  return { connected: true, task: await r.json() };
}

module.exports = { listTasks, addTask, enabled: () => charliework.enabled };
