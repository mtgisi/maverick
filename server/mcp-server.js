#!/usr/bin/env node
// MCP stdio server spawned by `claude -p`. Exposes Maverick's tools.
// Shares the maverick SQLite DB with the main process (WAL). Timeclock edits are PENDING proposals only.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const db = require('./db');
const { TZ } = require('./config');
const timeclock = require('./integrations/timeclock');
const charliework = require('./integrations/charliework');
const bookmarks = require('./integrations/bookmarks');
const containers = require('./integrations/containers');
const gcal = require('./google/client');

const CONV = process.env.MAVERICK_CONVERSATION_ID || 'default';

const fmtLocal = iso => iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : null;

const dayInTZ = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const TOOLS = [
  { name: 'save_memory', description: 'Save a note, idea, or fact Matthew wants remembered.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'The thing to remember.' },
      kind: { type: 'string', description: 'Optional: note, idea, fact, reminder.' },
      role: { type: 'string', description: 'Optional space/role, e.g. Teaching, Robotics, Personal.' },
    }, required: ['text'] } },
  { name: 'list_memories', description: 'List recent memories, optionally filtered by a search term.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'schedule_reminder', description: 'Schedule a phone push (ntfy) at a specific time. Use for "remind me ... at/in/on <time>".',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Notification body.' },
      fire_at: { type: 'string', description: 'Full ISO-8601 UTC instant, computed from the current time + his timezone.' },
    }, required: ['text', 'fire_at'] } },
  { name: 'list_reminders', description: 'List upcoming (not-yet-sent) reminders.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_timesheet', description: "Read Matthew's timeclock entries for a day (default today).",
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD (local). Omit for today.' } } } },
  { name: 'propose_timesheet_change', description: "Propose changing a timesheet clock_in/clock_out. Creates a pending proposal confirmed in the UI — does NOT apply.",
    inputSchema: { type: 'object', properties: {
      entry_id: { type: 'number' }, field: { type: 'string', enum: ['clock_in', 'clock_out'] },
      new_value: { type: 'string', description: 'Full ISO-8601 UTC instant.' },
      summary: { type: 'string', description: 'Friendly local-time summary, e.g. "Clock-out 5:34 PM -> 6:34 PM".' },
    }, required: ['entry_id', 'field', 'new_value'] } },
  { name: 'list_calendar_events', description: 'Read Google Calendar events for a day across connected accounts.',
    inputSchema: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (local). Omit for today.' },
      account: { type: 'string', description: 'Optional account label/email; omit for all.' },
    } } },
  { name: 'draft_email', description: 'Create a Gmail DRAFT (never sends). Tell Matthew it is a draft for his review.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
      account: { type: 'string', description: "Which connected account: 'personal' | 'work' | email. Defaults to first connected." },
    }, required: ['subject', 'body'] } },
  { name: 'list_tasks', description: 'List open tasks from the charliework task manager (if connected).',
    inputSchema: { type: 'object', properties: { role: { type: 'string' } } } },
  { name: 'add_task', description: 'Add a task to the charliework task manager (if connected).',
    inputSchema: { type: 'object', properties: {
      title: { type: 'string' }, role: { type: 'string' }, due: { type: 'string' },
    }, required: ['title'] } },
  { name: 'list_bookmarks', description: 'List saved bookmarks (Powermark), if connected.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'container_status', description: 'Read-only summary of server containers (only if enabled).',
    inputSchema: { type: 'object', properties: {} } },
];

const server = new Server({ name: 'maverick', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
  try {
    switch (name) {
      case 'save_memory': {
        db.prepare('INSERT INTO memories (text, kind, role) VALUES (?,?,?)').run(a.text, a.kind || 'note', a.role || 'Personal');
        return text(`Saved: "${a.text}"`);
      }
      case 'list_memories': {
        const lim = Math.min(a.limit || 20, 100);
        const rows = a.query
          ? db.prepare('SELECT text, kind, role, created_at FROM memories WHERE text LIKE ? ORDER BY id DESC LIMIT ?').all(`%${a.query}%`, lim)
          : db.prepare('SELECT text, kind, role, created_at FROM memories ORDER BY id DESC LIMIT ?').all(lim);
        return text(rows.length ? rows.map(r => `- ${r.text}${r.role && r.role !== 'Personal' ? ` [${r.role}]` : ''}`).join('\n') : '(no memories yet)');
      }
      case 'schedule_reminder': {
        if (!Number.isFinite(Date.parse(a.fire_at))) return text('error: fire_at must be an ISO-8601 instant');
        db.prepare('INSERT INTO reminders (text, fire_at) VALUES (?,?)').run(a.text, new Date(a.fire_at).toISOString());
        return text(`Reminder set for ${fmtLocal(a.fire_at)}: "${a.text}"`);
      }
      case 'list_reminders': {
        const rows = db.prepare("SELECT text, fire_at FROM reminders WHERE sent=0 ORDER BY fire_at ASC LIMIT 50").all();
        return text(rows.length ? rows.map(r => `- ${fmtLocal(r.fire_at)}: ${r.text}`).join('\n') : '(no upcoming reminders)');
      }
      case 'get_timesheet': {
        if (!timeclock.enabled()) return text('timeclock is not connected.');
        const day = a.date || dayInTZ();
        const entries = await timeclock.getEntries(day, day);
        const mapped = entries.map(e => ({
          id: e.id,
          clock_in_iso: e.clock_in, clock_in_local: fmtLocal(e.clock_in),
          clock_out_iso: e.clock_out, clock_out_local: fmtLocal(e.clock_out),
          total_minutes: e.total_minutes,
        }));
        return text({ date: day, timezone: TZ, entries: mapped });
      }
      case 'propose_timesheet_change': {
        if (!['clock_in', 'clock_out'].includes(a.field)) return text('error: field must be clock_in or clock_out');
        if (!Number.isFinite(Date.parse(a.new_value))) return text('error: new_value must be an ISO-8601 instant');
        let old = null, found = false;
        try {
          const today = dayInTZ();
          const past = dayInTZ(new Date(Date.now() - 60 * 864e5));
          const list = await timeclock.getEntries(past, today);
          const hit = list.find(e => e.id === a.entry_id);
          if (hit) { found = true; old = hit[a.field]; }
        } catch (_) {}
        if (!found) return text(`error: no entry ${a.entry_id} found — call get_timesheet first`);
        const summary = a.summary || `${a.field} ${fmtLocal(old)} -> ${fmtLocal(a.new_value)}`;
        db.prepare(`INSERT INTO pending_changes (conversation_id, entry_id, field, old_value, new_value, summary, status)
                    VALUES (?,?,?,?,?,?, 'pending')`).run(CONV, a.entry_id, a.field, old, a.new_value, summary);
        return text(`Proposed (awaiting confirmation): ${summary}`);
      }
      case 'list_calendar_events': {
        const res = await gcal.listEvents({ account: a.account, date: a.date });
        if (!res.connected) return text('No Google account connected yet. Connect one in Settings.');
        if (!res.events.length) return text(`No events for ${res.day}.`);
        return text(res.events.map(e => e.error ? `(! ${e.error})` : `${e.time || 'all day'} · ${e.title}${e.location ? ' @ ' + e.location : ''} [${e.account}]`).join('\n'));
      }
      case 'draft_email': {
        const res = await gcal.createDraft({ account: a.account, to: a.to, subject: a.subject, body: a.body });
        if (!res.ok) return text(res.error === 'no_connected_account' ? 'No Google account connected to draft from.' : `error: ${res.error}`);
        return text(`Draft created in ${res.account} (id ${res.draftId}). It is NOT sent — review and send it yourself.`);
      }
      case 'list_tasks': {
        if (!charliework.enabled()) return text('Task manager (charliework) is not connected yet.');
        const res = await charliework.listTasks({ role: a.role });
        const open = (res.tasks || []).filter(t => !t.done && !t.completed);
        return text(open.length ? open.map(t => `- ${t.title || t.name}${t.due ? ` (due ${t.due})` : ''}`).join('\n') : '(no open tasks)');
      }
      case 'add_task': {
        if (!charliework.enabled()) return text('Task manager (charliework) is not connected yet.');
        await charliework.addTask({ title: a.title, role: a.role, due: a.due });
        return text(`Added task: "${a.title}"`);
      }
      case 'list_bookmarks': {
        if (!bookmarks.enabled()) return text('Bookmarks (Powermark) is not connected yet.');
        const res = await bookmarks.list({ query: a.query });
        return text((res.items || []).slice(0, 30).map(b => `- ${b.title || b.name}: ${b.url}`).join('\n') || '(no bookmarks)');
      }
      case 'container_status': {
        if (!containers.enabled()) return text('Container tool is disabled.');
        const res = await containers.status();
        const running = res.containers.filter(c => c.state === 'running').length;
        return text(`${running}/${res.count} running.\n` + res.containers.map(c => `- ${c.name}: ${c.status}`).join('\n'));
      }
      default:
        return text(`unknown tool: ${name}`);
    }
  } catch (e) {
    return text(`error: ${e.message}`);
  }
});

(async () => { await server.connect(new StdioServerTransport()); })();
