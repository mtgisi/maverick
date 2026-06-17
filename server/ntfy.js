// Publish a push to ntfy. Internal URL (http://ntfy:80) + shared NTFY_TOKEN.
// NOTE: ntfy header values must be latin1 — no emoji in Title/Tags (emoji goes in the body).
const NTFY_URL = process.env.NTFY_URL || 'http://ntfy:80';
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'maverick';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';

async function push(message, { title = 'Maverick', priority = 'default', tags = 'bell' } = {}) {
  const headers = { 'Title': title, 'Priority': priority, 'Tags': tags, 'Content-Type': 'text/plain' };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
  const r = await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body: message });
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
  return true;
}

module.exports = { push, NTFY_TOPIC };
