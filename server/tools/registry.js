// The single source of truth for Maverick's tools.
//
// Every tool is one object: name, group, tier, description, JSON Schema, handler.
// `server/mcp-server.js` builds its MCP surface from this array; the local agent loop
// (server/brain/) will build its ollama `tools` array from the same one. There is exactly
// one definition of a tool, so the two paths cannot drift.
//
// group  -> tool gating (LOCAL-BRAIN-SPEC 8.3)
// tier   -> permission model. 'read' | 'write' | 'privileged'. Enforced in tools/index.js,
//           never in a prompt. A model cannot talk its way past a tier.
//
// Handlers receive (args, ctx) where ctx = { conversationId, actor, surface, now, tz }.
// Handlers return a string, or any JSON-serialisable value (stringified by the caller).
//
// PHASE 2 NOTE: handler bodies are moved verbatim from mcp-server.js's switch. Behaviour is
// deliberately unchanged here. Description rewrites happen in the agent-loop phase, per
// LOCAL-BRAIN-SPEC 8.3, so that a regression in this phase can only be a wiring bug.

const db = require('../db');
const { TZ } = require('../config');
const timeclock = require('../integrations/timeclock');
const charliework = require('../integrations/charliework');
const bookmarks = require('../integrations/bookmarks');
const containers = require('../integrations/containers');
const gcal = require('../google/client');
const workspace = require('../google/workspace');
const gpublic = require('../google/public');

// ---- helpers (identical semantics to mcp-server.js) ------------------------------------

// Spaces are user-defined and live in the DB. mcp-server.js read them once because it was
// spawned per turn; this module lives for the process lifetime, so read them per call to
// preserve the same "fresh every turn" behaviour.
function spaceKeys() {
  try { return db.prepare('SELECT key FROM spaces ORDER BY sort ASC').all().map(r => r.key); }
  catch (_) { return []; }
}
const spaceHint = () => { const k = spaceKeys(); return k.length ? k.join(', ') : 'e.g. work, personal'; };
const defaultRole = () => {
  const k = spaceKeys();
  return k.find(x => x.toLowerCase() === 'personal') || k[0] || 'personal';
};

const fmtLocal = iso => iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : null;

const dayInTZ = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// ---- the tools -------------------------------------------------------------------------

const TOOLS = [
  // ===== core: memory and reminders =====
  {
    name: 'save_memory',
    group: 'core',
    tier: 'write',
    description: 'Save a note, idea, or fact to remember.',
    get schema() {
      return { type: 'object', properties: {
        text: { type: 'string', description: 'The thing to remember.' },
        kind: { type: 'string', description: 'Optional: note, idea, fact, reminder.' },
        role: { type: 'string', description: `Optional space key to tag this with. Available: ${spaceHint()}.` },
      }, required: ['text'] };
    },
    handler: async (a) => {
      db.prepare('INSERT INTO memories (text, kind, role) VALUES (?,?,?)')
        .run(a.text, a.kind || 'note', a.role || defaultRole());
      return `Saved: "${a.text}"`;
    },
  },
  {
    name: 'list_memories',
    group: 'core',
    tier: 'read',
    description: 'List recent memories, optionally filtered by a search term.',
    schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
    handler: async (a) => {
      const lim = Math.min(a.limit || 20, 100);
      const rows = a.query
        ? db.prepare('SELECT text, kind, role, created_at FROM memories WHERE text LIKE ? ORDER BY id DESC LIMIT ?').all(`%${a.query}%`, lim)
        : db.prepare('SELECT text, kind, role, created_at FROM memories ORDER BY id DESC LIMIT ?').all(lim);
      const defRole = defaultRole();
      return rows.length
        ? rows.map(r => `- ${r.text}${r.role && r.role !== defRole ? ` [${r.role}]` : ''}`).join('\n')
        : '(no memories yet)';
    },
  },
  {
    name: 'schedule_reminder',
    group: 'core',
    tier: 'write',
    description: 'Schedule a phone push (ntfy) at a specific time. Use for "remind me ... at/in/on <time>".',
    schema: { type: 'object', properties: {
      text: { type: 'string', description: 'Notification body.' },
      fire_at: { type: 'string', description: "Full ISO-8601 UTC instant, computed from the current time + the user's timezone." },
    }, required: ['text', 'fire_at'] },
    handler: async (a) => {
      if (!Number.isFinite(Date.parse(a.fire_at))) return 'error: fire_at must be an ISO-8601 instant';
      db.prepare('INSERT INTO reminders (text, fire_at) VALUES (?,?)').run(a.text, new Date(a.fire_at).toISOString());
      return `Reminder set for ${fmtLocal(a.fire_at)}: "${a.text}"`;
    },
  },
  {
    name: 'list_reminders',
    group: 'core',
    tier: 'read',
    description: 'List upcoming (not-yet-sent) reminders.',
    schema: { type: 'object', properties: {} },
    handler: async () => {
      const rows = db.prepare('SELECT text, fire_at FROM reminders WHERE sent=0 ORDER BY fire_at ASC LIMIT 50').all();
      return rows.length ? rows.map(r => `- ${fmtLocal(r.fire_at)}: ${r.text}`).join('\n') : '(no upcoming reminders)';
    },
  },

  // ===== timeclock =====
  {
    name: 'get_timesheet',
    group: 'timeclock',
    tier: 'read',
    description: 'Read your timeclock entries for a day (default today).',
    schema: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (local). Omit for today.' },
    } },
    handler: async (a) => {
      if (!timeclock.enabled()) return 'timeclock is not connected.';
      const day = a.date || dayInTZ();
      const entries = await timeclock.getEntries(day, day);
      const mapped = entries.map(e => ({
        id: e.id,
        clock_in_iso: e.clock_in, clock_in_local: fmtLocal(e.clock_in),
        clock_out_iso: e.clock_out, clock_out_local: fmtLocal(e.clock_out),
        total_minutes: e.total_minutes,
      }));
      return { date: day, timezone: TZ, entries: mapped };
    },
  },
  {
    name: 'propose_timesheet_change',
    group: 'timeclock',
    tier: 'privileged',
    // Self-gating: the handler only writes a pending_changes row. The real timeclock PATCH
    // happens when the user hits Confirm in the UI, with no model in that path. So calling
    // this tool cannot change anything on its own and needs no upfront confirmation.
    selfGated: true,
    description: 'Propose changing a timesheet clock_in/clock_out. Creates a pending proposal confirmed in the UI — does NOT apply.',
    schema: { type: 'object', properties: {
      entry_id: { type: 'number' },
      field: { type: 'string', enum: ['clock_in', 'clock_out'] },
      new_value: { type: 'string', description: 'Full ISO-8601 UTC instant.' },
      summary: { type: 'string', description: 'Friendly local-time summary, e.g. "Clock-out 5:34 PM -> 6:34 PM".' },
    }, required: ['entry_id', 'field', 'new_value'] },
    handler: async (a, ctx = {}) => {
      if (!['clock_in', 'clock_out'].includes(a.field)) return 'error: field must be clock_in or clock_out';
      if (!Number.isFinite(Date.parse(a.new_value))) return 'error: new_value must be an ISO-8601 instant';
      let old = null, found = false;
      try {
        const today = dayInTZ();
        const past = dayInTZ(new Date(Date.now() - 60 * 864e5));
        const list = await timeclock.getEntries(past, today);
        const hit = list.find(e => e.id === a.entry_id);
        if (hit) { found = true; old = hit[a.field]; }
      } catch (_) {}
      if (!found) return `error: no entry ${a.entry_id} found — call get_timesheet first`;
      const summary = a.summary || `${a.field} ${fmtLocal(old)} -> ${fmtLocal(a.new_value)}`;
      db.prepare(`INSERT INTO pending_changes (conversation_id, entry_id, field, old_value, new_value, summary, status)
                  VALUES (?,?,?,?,?,?, 'pending')`)
        .run(ctx.conversationId || 'default', a.entry_id, a.field, old, a.new_value, summary);
      return `Proposed (awaiting confirmation): ${summary}`;
    },
  },

  // ===== calendar =====
  {
    name: 'list_calendars',
    group: 'calendar',
    tier: 'read',
    description: 'List all Google calendars across connected accounts.',
    schema: { type: 'object', properties: {
      account: { type: 'string', description: 'Optional account label/email; omit for all.' },
    } },
    handler: async (a) => {
      const res = await gcal.listCalendars({ account: a.account });
      if (!res.connected) return 'No Google account connected yet. Connect one in Settings.';
      if (!res.calendars.length) return '(no calendars)';
      return res.calendars
        .map(c => c.error ? `(! ${c.error})` : `- ${c.summary} [${c.kind}${c.primary ? ', primary' : ''}] (${c.account})`)
        .join('\n');
    },
  },
  {
    name: 'list_calendar_events',
    group: 'calendar',
    tier: 'read',
    description: "Read Google Calendar events for a day. Scope controls which calendars: 'mine' (default — your own calendars plus events you're invited to), 'resource'/'work' (shared resource/room calendars), 'all'.",
    schema: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (local). Omit for today.' },
      account: { type: 'string', description: 'Optional account label/email; omit for all.' },
      scope: { type: 'string', enum: ['mine', 'resource', 'work', 'shared', 'all'], description: "Default 'mine'. Use 'resource' or 'work' for 'what's going on at work' / school resource calendars; 'all' for everything." },
    } },
    handler: async (a) => {
      const res = await gcal.listEvents({ account: a.account, date: a.date, scope: a.scope });
      if (!res.connected) return 'No Google account connected yet. Connect one in Settings.';
      if (!res.events.length) return `No events for ${res.day} (scope: ${a.scope || 'mine'}).`;
      return res.events
        .map(e => e.error ? `(! ${e.error})` : `${e.time || 'all day'} · ${e.title}${e.location ? ' @ ' + e.location : ''} [${e.calendar}]`)
        .join('\n');
    },
  },

  // ===== mail =====
  {
    name: 'draft_email',
    group: 'mail',
    tier: 'write',
    description: 'Create a Gmail DRAFT (never sends). Tell the user it is a draft for their review.',
    schema: { type: 'object', properties: {
      to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
      account: { type: 'string', description: "Which connected account: 'personal' | 'work' | email. Defaults to first connected." },
    }, required: ['subject', 'body'] },
    handler: async (a) => {
      const res = await gcal.createDraft({ account: a.account, to: a.to, subject: a.subject, body: a.body });
      if (!res.ok) return res.error === 'no_connected_account'
        ? 'No Google account connected to draft from.'
        : `error: ${res.error}`;
      return `Draft created in ${res.account} (id ${res.draftId}). It is NOT sent — review and send it yourself.`;
    },
  },

  // ===== tasks (charliework) =====
  {
    name: 'list_tasks',
    group: 'tasks',
    tier: 'read',
    description: 'List open tasks. Returns a count first, then the most urgent ones with their id. Call this before complete_task or reschedule_task to get a real id; never guess an id.',
    schema: { type: 'object', properties: {
      category: { type: 'string', description: 'Filter by category slug: tech, biz_comp, esports, robotics, st_croix, ultimate, personal.' },
      include_done: { type: 'boolean' },
      limit: { type: 'number', description: 'How many to list. Default 12.' },
    } },
    handler: async (a) => {
      if (!charliework.enabled()) return 'Task manager (Charliework) is not connected.';
      const res = await charliework.listTasks({ category: a.category, includeDone: !!a.include_done });
      const ts = res.tasks || [];
      if (!ts.length) return 'TOTAL: 0 open tasks.';

      // Lead with the count and sort by urgency rather than dumping the raw list.
      //
      // The raw 48-line dump made qwen2.5:7b answer "there are no open tasks" in voice mode:
      // it had the data and could not summarise it. A small model should not have to count
      // rows or infer priority. State the total, order by urgency, and cap the listing.
      const rank = t => t.is_overdue ? 0 : t.is_due_soon ? 1 : t.due_date ? 2 : 3;
      const sorted = [...ts].sort((x, y) =>
        rank(x) - rank(y) || String(x.due_date || '9999').localeCompare(String(y.due_date || '9999')));

      const overdue = ts.filter(t => t.is_overdue).length;
      const soon = ts.filter(t => !t.is_overdue && t.is_due_soon).length;
      const limit = Math.min(Math.max(Number(a.limit) || 12, 1), 50);
      const shown = sorted.slice(0, limit);

      const header = `TOTAL: ${ts.length} open task${ts.length === 1 ? '' : 's'}`
        + (overdue ? `, ${overdue} overdue` : '')
        + (soon ? `, ${soon} due soon` : '')
        + (a.category ? ` in category ${a.category}` : '')
        + `. Listing the ${shown.length} most urgent:`;

      const lines = shown.map(t => {
        const flags = [
          t.is_overdue ? 'OVERDUE' : (t.is_due_soon ? 'due soon' : ''),
          t.awaiting_review ? 'needs review' : '',
        ].filter(Boolean).join(', ');
        return `- ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}${t.category ? ` [${t.category}]` : ''}${flags ? ` <${flags}>` : ''}  id=${t.id}`;
      });

      const rest = ts.length - shown.length;
      return [header, ...lines, rest > 0 ? `(${rest} more not shown; ask for a category or a higher limit)` : '']
        .filter(Boolean).join('\n');
    },
  },
  {
    name: 'add_task',
    group: 'tasks',
    tier: 'write',
    description: 'Create a task in Charliework.',
    schema: { type: 'object', properties: {
      title: { type: 'string' },
      due_date: { type: 'string', description: 'YYYY-MM-DD.' },
      category: { type: 'string', description: 'Comma-separated slugs: tech, biz_comp, esports, robotics, st_croix, ultimate, personal.' },
      notes: { type: 'string' },
      tier: { type: 'string', enum: ['normal', 'someday'] },
      assignee: { type: 'string', enum: ['user_a', 'user_b', 'together'] },
    }, required: ['title'] },
    handler: async (a) => {
      if (!charliework.enabled()) return 'Task manager (Charliework) is not connected.';
      const r = await charliework.addTask({
        title: a.title, due_date: a.due_date, category: a.category,
        notes: a.notes, tier: a.tier, assignee: a.assignee,
      });
      return `Added task: "${a.title}"${a.due_date ? ` (due ${a.due_date})` : ''}${r.task && r.task.id ? ` id=${r.task.id}` : ''}`;
    },
  },
  {
    name: 'complete_task',
    group: 'tasks',
    tier: 'write',
    description: 'Mark a Charliework task done. Get task_id from list_tasks first.',
    schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    handler: async (a) => {
      if (!charliework.enabled()) return 'Task manager (Charliework) is not connected.';
      const r = await charliework.completeTask(a.task_id);
      return `Marked done: "${(r.task && r.task.title) || a.task_id}"`;
    },
  },
  {
    name: 'reschedule_task',
    group: 'tasks',
    tier: 'write',
    description: "Change a Charliework task's due date. Get task_id from list_tasks first.",
    schema: { type: 'object', properties: {
      task_id: { type: 'string' },
      due_date: { type: 'string', description: 'YYYY-MM-DD.' },
    }, required: ['task_id', 'due_date'] },
    handler: async (a) => {
      if (!charliework.enabled()) return 'Task manager (Charliework) is not connected.';
      const r = await charliework.rescheduleTask(a.task_id, a.due_date);
      return `Rescheduled "${(r.task && r.task.title) || a.task_id}" to ${a.due_date}.`;
    },
  },
  {
    name: 'ask_supervisor',
    group: 'tasks',
    tier: 'write',
    description: 'File a question for the supervisor in Charliework (Ask Supervisor).',
    schema: { type: 'object', properties: {
      body: { type: 'string' }, task_id: { type: 'string' },
    }, required: ['body'] },
    handler: async (a) => {
      if (!charliework.enabled()) return 'Task manager (Charliework) is not connected.';
      await charliework.askSupervisor({ body: a.body, task_id: a.task_id });
      return 'Filed a question for the supervisor.';
    },
  },

  // ===== workspace (read-only) =====
  {
    name: 'list_drive_files',
    group: 'workspace',
    tier: 'read',
    description: 'Search/list Google Drive files (read-only).',
    schema: { type: 'object', properties: { query: { type: 'string' }, account: { type: 'string' } } },
    handler: async (a) => {
      const res = await workspace.listDriveFiles({ account: a.account, query: a.query });
      if (!res.connected) return 'No Google account connected yet. Connect one in Settings.';
      return (res.files || []).map(f => `- ${f.name} (${f.mimeType}) ${f.webViewLink || ''}`).join('\n') || '(no files)';
    },
  },
  {
    name: 'read_doc',
    group: 'workspace',
    tier: 'read',
    description: 'Read a Google Doc as plain text.',
    schema: { type: 'object', properties: {
      documentId: { type: 'string' }, account: { type: 'string' },
    }, required: ['documentId'] },
    handler: async (a) => {
      const res = await workspace.readDoc({ account: a.account, documentId: a.documentId });
      if (!res.connected) return 'No Google account connected yet.';
      if (res.error) return `error: ${res.error}`;
      return `# ${res.title}\n\n${res.text}`;
    },
  },
  {
    name: 'read_sheet',
    group: 'workspace',
    tier: 'read',
    description: 'Read a range from a Google Sheet.',
    schema: { type: 'object', properties: {
      spreadsheetId: { type: 'string' },
      range: { type: 'string', description: "A1 range, e.g. 'Sheet1!A1:D20'." },
      account: { type: 'string' },
    }, required: ['spreadsheetId'] },
    handler: async (a) => {
      const res = await workspace.readSheet({ account: a.account, spreadsheetId: a.spreadsheetId, range: a.range });
      if (!res.connected) return 'No Google account connected yet.';
      if (res.error) return `error: ${res.error}`;
      return { range: res.range, values: res.values };
    },
  },
  {
    name: 'read_slides',
    group: 'workspace',
    tier: 'read',
    description: 'Read text from a Google Slides presentation.',
    schema: { type: 'object', properties: {
      presentationId: { type: 'string' }, account: { type: 'string' },
    }, required: ['presentationId'] },
    handler: async (a) => {
      const res = await workspace.readSlides({ account: a.account, presentationId: a.presentationId });
      if (!res.connected) return 'No Google account connected yet.';
      if (res.error) return `error: ${res.error}`;
      return `# ${res.title}\n\n` + (res.slides || []).map((s, i) => `Slide ${i + 1}:\n${s}`).join('\n\n');
    },
  },

  // ===== misc =====
  {
    name: 'list_bookmarks',
    group: 'misc',
    tier: 'read',
    description: 'List saved bookmarks (Powermark), if connected.',
    schema: { type: 'object', properties: { query: { type: 'string' } } },
    handler: async (a) => {
      if (!bookmarks.enabled()) return 'Bookmarks (Powermark) is not connected yet.';
      const res = await bookmarks.list({ query: a.query });
      return (res.items || []).slice(0, 30).map(b => `- ${b.title || b.name}: ${b.url}`).join('\n') || '(no bookmarks)';
    },
  },
  {
    name: 'container_status',
    group: 'misc',
    tier: 'read',
    description: 'Read-only summary of server containers (only if enabled).',
    schema: { type: 'object', properties: {} },
    handler: async () => {
      if (!containers.enabled()) return 'Container tool is disabled.';
      const res = await containers.status();
      const running = res.containers.filter(c => c.state === 'running').length;
      return `${running}/${res.count} running.\n` + res.containers.map(c => `- ${c.name}: ${c.status}`).join('\n');
    },
  },
  {
    name: 'search_youtube',
    group: 'misc',
    tier: 'read',
    description: 'Search YouTube for videos (public data, API key).',
    schema: { type: 'object', properties: {
      query: { type: 'string' }, max: { type: 'number' },
    }, required: ['query'] },
    handler: async (a) => {
      const res = await gpublic.searchYouTube({ query: a.query, max: a.max });
      if (!res.enabled) return 'YouTube is not enabled (no API key set).';
      if (res.error) return `error: ${res.error}`;
      return (res.results || []).map(v => `- ${v.title} — ${v.channel}\n  ${v.url}`).join('\n') || '(no results)';
    },
  },
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));
const GROUPS = [...new Set(TOOLS.map(t => t.group))];

const get = name => BY_NAME.get(name) || null;
const byGroup = group => TOOLS.filter(t => t.group === group);
const names = () => TOOLS.map(t => t.name);

module.exports = { TOOLS, BY_NAME, GROUPS, get, byGroup, names };
