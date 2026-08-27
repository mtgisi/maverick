// Client for the Charliework task manager API (https://technology.edgewoodhs.org/charliework).
// Bearer-token auth. GET /api/tasks returns ALL tasks (filter client-side); POST/PATCH mutate.
// Disabled (no-op) until CHARLIEWORK_API_URL + CHARLIEWORK_API_TOKEN are set.
const { charliework } = require('../config');

// Valid category slugs (per the API handoff). The assistant should send these, not display labels.
const CATEGORIES = ['tech', 'biz_comp', 'esports', 'robotics', 'st_croix', 'ultimate', 'personal'];

function headers() {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (charliework.token) h['Authorization'] = `Bearer ${charliework.token}`;
  return h;
}

async function api(path, opts = {}) {
  const r = await fetch(`${charliework.url}${path}`, { headers: headers(), ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `charliework ${r.status}`);
  return body;
}

// List tasks. By default only open, top-level. category filters by slug; includeDone/includeSubtasks opt-in.
async function listTasks({ category, includeDone = false, includeSubtasks = false } = {}) {
  if (!charliework.enabled) return { connected: false, tasks: [] };
  let tasks = await api('/api/tasks');
  if (!Array.isArray(tasks)) tasks = tasks.tasks || [];
  if (!includeDone) tasks = tasks.filter(t => t.status === 'open');
  if (!includeSubtasks) tasks = tasks.filter(t => !t.parent_id);
  if (category) tasks = tasks.filter(t => String(t.category || '').split(',').map(s => s.trim()).includes(category));
  return { connected: true, tasks };
}

// Create a task. Pass charliework fields directly.
async function addTask({ title, due_date, category, assignee, notes, tier, parent_id, pinned, awaiting_review }) {
  if (!charliework.enabled) return { connected: false };
  const body = { title };
  if (due_date) body.due_date = due_date;
  if (category) body.category = category;
  if (assignee) body.assignee = assignee;
  if (notes) body.notes = notes;
  if (tier) body.tier = tier;
  if (parent_id) body.parent_id = parent_id;
  if (pinned != null) body.pinned = pinned;
  if (awaiting_review != null) body.awaiting_review = awaiting_review;
  return { connected: true, task: await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) }) };
}

async function patchTask(id, fields) {
  if (!charliework.enabled) return { connected: false };
  return { connected: true, task: await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }) };
}

const completeTask = (id) => patchTask(id, { status: 'done' });
const reopenTask = (id) => patchTask(id, { status: 'open' });
const rescheduleTask = (id, due_date) => patchTask(id, { due_date });
const setNotes = (id, notes) => patchTask(id, { notes });

// File a question for the supervisor (Ask Supervisor).
async function askSupervisor({ body, context, task_id }) {
  if (!charliework.enabled) return { connected: false };
  return { connected: true, question: await api('/api/questions', { method: 'POST', body: JSON.stringify({ body, context, task_id }) }) };
}

module.exports = {
  CATEGORIES, listTasks, addTask, patchTask, completeTask, reopenTask, rescheduleTask,
  setNotes, askSupervisor,
  enabled: () => charliework.enabled,
};
