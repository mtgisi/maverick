// Client for the goosework task manager (goosework.matthewgisi.com, container `goosework`).
//
// Bearer-token auth against the agent API added to goosework's server/auth.js. Disabled
// (no-op) until GOOSEWORK_API_URL + GOOSEWORK_API_TOKEN are set, matching how every other
// optional integration here fails closed.
//
// GET /api/tasks returns ALL tasks (open first, then done), each annotated with is_overdue
// and is_due_soon by the server. Filtering is done here.

const { goosework } = require('../config');

// Canonical category slugs, mirroring goosework's server/categories.js. Kept here so the
// tool schema can advertise them without a round trip.
const CATEGORIES = ['server', 'work', 'esports', 'family', 'personal'];

function headers() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (goosework.token) h.Authorization = `Bearer ${goosework.token}`;
  return h;
}

async function api(path, opts = {}) {
  const r = await fetch(`${goosework.url}${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(15000),
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `goosework ${r.status}`);
  return body;
}

async function listTasks({ category, includeDone = false, includeSubtasks = false } = {}) {
  if (!goosework.enabled) return { connected: false, tasks: [] };
  let tasks = await api('/api/tasks');
  if (!Array.isArray(tasks)) tasks = tasks.tasks || [];
  if (!includeDone) tasks = tasks.filter(t => t.status === 'open');
  if (!includeSubtasks) tasks = tasks.filter(t => !t.parent_id);
  if (category) {
    tasks = tasks.filter(t =>
      String(t.category || '').split(',').map(s => s.trim()).includes(category));
  }
  return { connected: true, tasks };
}

async function addTask({ title, due_date, category, notes, tier, parent_id, pinned }) {
  if (!goosework.enabled) return { connected: false };
  const body = { title };
  if (due_date) body.due_date = due_date;
  if (category) body.category = category;
  if (notes) body.notes = notes;
  if (tier) body.tier = tier;
  if (parent_id) body.parent_id = parent_id;
  if (pinned != null) body.pinned = pinned;
  return { connected: true, task: await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) }) };
}

async function patchTask(id, fields) {
  if (!goosework.enabled) return { connected: false };
  return {
    connected: true,
    task: await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  };
}

const completeTask = id => patchTask(id, { status: 'done' });
const reopenTask = id => patchTask(id, { status: 'open' });
const rescheduleTask = (id, due_date) => patchTask(id, { due_date });
const setNotes = (id, notes) => patchTask(id, { notes });

module.exports = {
  CATEGORIES, listTasks, addTask, patchTask, completeTask, reopenTask, rescheduleTask, setNotes,
  enabled: () => goosework.enabled,
};
