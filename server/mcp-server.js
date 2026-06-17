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
const workspace = require('./google/workspace');
const gpublic = require('./google/public');

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
  { name: 'list_calendars', description: "List all of Matthew's Google calendars across connected accounts.",
    inputSchema: { type: 'object', properties: {
      account: { type: 'string', description: 'Optional account label/email; omit for all.' },
    } } },
  { name: 'list_calendar_events', description: "Read Google Calendar events for a day. Scope controls which calendars: 'mine' (default — Matthew's own calendars plus events he's invited to), 'resource'/'work' (school resource/room calendars), 'all'.",
    inputSchema: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (local). Omit for today.' },
      account: { type: 'string', description: 'Optional account label/email; omit for all.' },
      scope: { type: 'string', enum: ['mine', 'resource', 'work', 'shared', 'all'], description: "Default 'mine'. Use 'resource' or 'work' for 'what's going on at work' / school resource calendars; 'all' for everything." },
    } } },
  { name: 'draft_email', description: 'Create a Gmail DRAFT (never sends). Tell Matthew it is a draft for his review.',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
      account: { type: 'string', description: "Which connected account: 'personal' | 'work' | email. Defaults to first connected." },
    }, required: ['subject', 'body'] } },
  { name: 'list_tasks', description: 'List open tasks from the Charliework task manager. Returns each task with its id (needed to complete/reschedule).',
    inputSchema: { type: 'object', properties: {
      category: { type: 'string', description: 'Filter by category slug: tech, biz_comp, esports, robotics, st_croix, ultimate, personal.' },
      include_done: { type: 'boolean' },
    } } },
  { name: 'add_task', description: 'Create a task in Charliework.',
    inputSchema: { type: 'object', properties: {
      title: { type: 'string' },
      due_date: { type: 'string', description: 'YYYY-MM-DD.' },
      category: { type: 'string', description: 'Comma-separated slugs: tech, biz_comp, esports, robotics, st_croix, ultimate, personal.' },
      notes: { type: 'string' },
      tier: { type: 'string', enum: ['normal', 'someday'] },
      assignee: { type: 'string', enum: ['user_a', 'user_b', 'together'] },
    }, required: ['title'] } },
  { name: 'complete_task', description: 'Mark a Charliework task done. Get task_id from list_tasks first.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  { name: 'reschedule_task', description: "Change a Charliework task's due date. Get task_id from list_tasks first.",
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, due_date: { type: 'string', description: 'YYYY-MM-DD.' } }, required: ['task_id', 'due_date'] } },
  { name: 'ask_supervisor', description: 'File a question for the supervisor in Charliework (Ask Supervisor).',
    inputSchema: { type: 'object', properties: { body: { type: 'string' }, task_id: { type: 'string' } }, required: ['body'] } },
  { name: 'list_bookmarks', description: 'List saved bookmarks (Powermark), if connected.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'container_status', description: 'Read-only summary of server containers (only if enabled).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_drive_files', description: 'Search/list Google Drive files (read-only).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, account: { type: 'string' } } } },
  { name: 'read_doc', description: 'Read a Google Doc as plain text.',
    inputSchema: { type: 'object', properties: { documentId: { type: 'string' }, account: { type: 'string' } }, required: ['documentId'] } },
  { name: 'read_sheet', description: 'Read a range from a Google Sheet.',
    inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string', description: "A1 range, e.g. 'Sheet1!A1:D20'." }, account: { type: 'string' } }, required: ['spreadsheetId'] } },
  { name: 'read_slides', description: 'Read text from a Google Slides presentation.',
    inputSchema: { type: 'object', properties: { presentationId: { type: 'string' }, account: { type: 'string' } }, required: ['presentationId'] } },
  { name: 'search_youtube', description: 'Search YouTube for videos (public data, API key).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number' } }, required: ['query'] } },
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
      case 'list_calendars': {
        const res = await gcal.listCalendars({ account: a.account });
        if (!res.connected) return text('No Google account connected yet. Connect one in Settings.');
        if (!res.calendars.length) return text('(no calendars)');
        return text(res.calendars.map(c => c.error ? `(! ${c.error})` : `- ${c.summary} [${c.kind}${c.primary ? ', primary' : ''}] (${c.account})`).join('\n'));
      }
      case 'list_calendar_events': {
        const res = await gcal.listEvents({ account: a.account, date: a.date, scope: a.scope });
        if (!res.connected) return text('No Google account connected yet. Connect one in Settings.');
        if (!res.events.length) return text(`No events for ${res.day} (scope: ${a.scope || 'mine'}).`);
        return text(res.events.map(e => e.error ? `(! ${e.error})` : `${e.time || 'all day'} · ${e.title}${e.location ? ' @ ' + e.location : ''} [${e.calendar}]`).join('\n'));
      }
      case 'draft_email': {
        const res = await gcal.createDraft({ account: a.account, to: a.to, subject: a.subject, body: a.body });
        if (!res.ok) return text(res.error === 'no_connected_account' ? 'No Google account connected to draft from.' : `error: ${res.error}`);
        return text(`Draft created in ${res.account} (id ${res.draftId}). It is NOT sent — review and send it yourself.`);
      }
      case 'list_tasks': {
        if (!charliework.enabled()) return text('Task manager (Charliework) is not connected.');
        const res = await charliework.listTasks({ category: a.category, includeDone: !!a.include_done });
        const ts = res.tasks || [];
        if (!ts.length) return text('(no open tasks)');
        return text(ts.map(t => {
          const flags = [t.is_overdue ? 'OVERDUE' : (t.is_due_soon ? 'due soon' : ''), t.awaiting_review ? 'needs review' : ''].filter(Boolean).join(', ');
          return `- ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}${t.category ? ` [${t.category}]` : ''}${flags ? ` <${flags}>` : ''}  id=${t.id}`;
        }).join('\n'));
      }
      case 'add_task': {
        if (!charliework.enabled()) return text('Task manager (Charliework) is not connected.');
        const r = await charliework.addTask({ title: a.title, due_date: a.due_date, category: a.category, notes: a.notes, tier: a.tier, assignee: a.assignee });
        return text(`Added task: "${a.title}"${a.due_date ? ` (due ${a.due_date})` : ''}${r.task && r.task.id ? ` id=${r.task.id}` : ''}`);
      }
      case 'complete_task': {
        if (!charliework.enabled()) return text('Task manager (Charliework) is not connected.');
        const r = await charliework.completeTask(a.task_id);
        return text(`Marked done: "${(r.task && r.task.title) || a.task_id}"`);
      }
      case 'reschedule_task': {
        if (!charliework.enabled()) return text('Task manager (Charliework) is not connected.');
        const r = await charliework.rescheduleTask(a.task_id, a.due_date);
        return text(`Rescheduled "${(r.task && r.task.title) || a.task_id}" to ${a.due_date}.`);
      }
      case 'ask_supervisor': {
        if (!charliework.enabled()) return text('Task manager (Charliework) is not connected.');
        await charliework.askSupervisor({ body: a.body, task_id: a.task_id });
        return text('Filed a question for the supervisor.');
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
      case 'list_drive_files': {
        const res = await workspace.listDriveFiles({ account: a.account, query: a.query });
        if (!res.connected) return text('No Google account connected yet. Connect one in Settings.');
        return text((res.files || []).map(f => `- ${f.name} (${f.mimeType}) ${f.webViewLink || ''}`).join('\n') || '(no files)');
      }
      case 'read_doc': {
        const res = await workspace.readDoc({ account: a.account, documentId: a.documentId });
        if (!res.connected) return text('No Google account connected yet.');
        if (res.error) return text(`error: ${res.error}`);
        return text(`# ${res.title}\n\n${res.text}`);
      }
      case 'read_sheet': {
        const res = await workspace.readSheet({ account: a.account, spreadsheetId: a.spreadsheetId, range: a.range });
        if (!res.connected) return text('No Google account connected yet.');
        if (res.error) return text(`error: ${res.error}`);
        return text({ range: res.range, values: res.values });
      }
      case 'read_slides': {
        const res = await workspace.readSlides({ account: a.account, presentationId: a.presentationId });
        if (!res.connected) return text('No Google account connected yet.');
        if (res.error) return text(`error: ${res.error}`);
        return text(`# ${res.title}\n\n` + (res.slides || []).map((s, i) => `Slide ${i + 1}:\n${s}`).join('\n\n'));
      }
      case 'search_youtube': {
        const res = await gpublic.searchYouTube({ query: a.query, max: a.max });
        if (!res.enabled) return text('YouTube is not enabled (no API key set).');
        if (res.error) return text(`error: ${res.error}`);
        return text((res.results || []).map(v => `- ${v.title} — ${v.channel}\n  ${v.url}`).join('\n') || '(no results)');
      }
      default:
        return text(`unknown tool: ${name}`);
    }
  } catch (e) {
    return text(`error: ${e.message}`);
  }
});

(async () => { await server.connect(new StdioServerTransport()); })();
