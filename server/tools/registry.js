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
const tasks = require('../services/tasks');
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

// A model that guesses a task id must be told exactly why it failed, or it guesses again.
// Naming the real format and the tool that produces it is what makes the retry succeed.
const badId = id => `error: "${id}" is not a known task id. Ids look like "cw:<id>" (work) or `
  + `"gw:<id>" (personal) and only come from list_tasks. Call list_tasks and use an id exactly as printed.`;

// What the user calls each system. The internal names mean nothing to them or to the model.
const SOURCE_LABEL = { charliework: 'work', goosework: 'personal' };

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
    description: "Read calendar events for a day. By default this returns only the user's ACTUAL commitments. Some calendars are marked reference, not activities: birthdays, the kitchen menu, an office who-is-in-and-out board. Those are excluded unless you ask for them with include='reference', which you should do when the question is about them (\"who is out today\", \"whose birthday is it\", \"what is for lunch\"). Never present reference entries as things the user has to do.",
    schema: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (local). Omit for today.' },
      account: { type: 'string', description: 'Optional account label/email; omit for all.' },
      include: {
        type: 'string', enum: ['agenda', 'reference', 'all'],
        description: "Default 'agenda' = real commitments only. Use 'reference' for birthdays, menus, in/out boards. Use 'all' only when the user genuinely wants both.",
      },
      scope: { type: 'string', enum: ['mine', 'resource', 'work', 'shared', 'all'], description: "Default 'mine'. Use 'resource' or 'work' for shared resource or room calendars; 'all' for everything." },
    } },
    handler: async (a) => {
      const include = ['agenda', 'reference', 'all'].includes(a.include) ? a.include : 'agenda';
      const res = await gcal.listEvents({ account: a.account, date: a.date, scope: a.scope, include });
      if (!res.connected) return 'No Google account connected yet. Connect one in Settings.';

      if (!res.events.length) {
        // Distinguish "nothing on" from "nothing on, but there IS reference material", so a
        // question about a birthday or the menu is not answered with a flat no.
        if (include === 'agenda') {
          const ref = await gcal.listEvents({ account: a.account, date: a.date, scope: a.scope, include: 'reference' })
            .catch(() => ({ events: [] }));
          const n = (ref.events || []).filter(e => !e.error).length;
          if (n) return `No commitments for ${res.day}. (${n} reference entr${n === 1 ? 'y' : 'ies'} exist on birthday/menu/in-out style calendars; call again with include='reference' if that is what was asked.)`;
        }
        return `No events for ${res.day}.`;
      }

      const line = e => e.error ? `(! ${e.error})`
        : `${e.time || 'all day'} · ${e.title}${e.location ? ' @ ' + e.location : ''} [${e.calendar}${e.calendarMode === 'reference' ? ', reference only' : ''}]`;
      const header = include === 'reference' ? 'REFERENCE entries (not commitments):\n'
        : include === 'all' ? 'Commitments and reference entries (reference ones are marked):\n'
        : '';
      return header + res.events.map(line).join('\n');
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
    description: 'List open tasks from both task systems merged into one list. Returns a total count first, then the most urgent tasks each with an id like "cw:abc" or "gw:xyz". Always call this before complete_task, reschedule_task or add_task_note, and use an id exactly as printed. Never invent an id.',
    schema: { type: 'object', properties: {
      source: {
        type: 'string', enum: ['charliework', 'goosework'],
        // The system names are opaque, and "personal" is also a category slug in BOTH
        // systems, so the model previously answered "you have no personal tasks" while five
        // sat in goosework. The mapping has to be spelled out here, next to the schema,
        // because that is what the model reads.
        description: 'Which system. "charliework" holds WORK and school tasks. "goosework" holds PERSONAL and home tasks. If the user says personal, home, my own, or life, use goosework. If they say work, school, or the job, use charliework. Omit to search both.',
      },
      category: { type: 'string', description: 'Optional, and usually omit it. Only pass this when the user named a specific category. Do NOT pass it just because they said "personal" or "work" — that is what `source` is for. charliework slugs: tech, biz_comp, esports, robotics, st_croix, ultimate, personal. goosework slugs: server, work, esports, family, personal.' },
      include_done: { type: 'boolean', description: 'Include completed tasks. Default false.' },
      limit: { type: 'number', description: 'How many to list. Default 12.' },
    } },
    handler: async (a) => {
      const st = tasks.status();
      if (!st.sources.some(s => s.connected)) return 'No task system is connected.';

      const status = a.include_done ? 'all' : 'open';
      const rows = tasks.list({ source: a.source, category: a.category, status, limit: 500 });

      if (!rows.length) {
        // An empty result is ambiguous: genuinely nothing, or a filter that excluded
        // everything. Observed: the model answered "personal" by passing BOTH
        // source=goosework and category=personal, and every goosework row has a null
        // category, so it reported zero tasks while five existed. Say what was excluded so
        // the model can drop the filter and retry instead of confidently reporting nothing.
        const broader = tasks.list({ source: a.source, status, limit: 500 });
        if (a.category && broader.length) {
          return `TOTAL: 0 tasks match category "${a.category}"`
            + (a.source ? ` in ${SOURCE_LABEL[a.source] || a.source}` : '')
            + `. However there ARE ${broader.length} task(s) there once the category filter is dropped. `
            + `Call list_tasks again without "category".`;
        }
        const all = tasks.list({ status, limit: 500 });
        if (a.source && all.length) {
          return `TOTAL: 0 tasks in ${SOURCE_LABEL[a.source] || a.source}. `
            + `There are ${all.length} across both systems; call list_tasks without "source" to see them.`;
        }
        return 'TOTAL: 0 open tasks.';
      }

      // Lead with the count and sort by urgency rather than dumping the raw list.
      //
      // The raw 48-line dump made qwen2.5:7b answer "there are no open tasks" in voice mode:
      // it had the data and could not summarise it. A small model should not have to count
      // rows or infer priority. State the total, order by urgency, and cap the listing.
      const open = rows.filter(t => t.status === 'open');
      const overdue = open.filter(t => t.is_overdue).length;
      const soon = open.filter(t => !t.is_overdue && t.is_due_soon).length;
      const limit = Math.min(Math.max(Number(a.limit) || 12, 1), 50);
      const shown = rows.slice(0, limit);

      // Report the split in the words the user uses, not the internal system names.
      const bySource = {};
      for (const t of open) bySource[t.source] = (bySource[t.source] || 0) + 1;
      const split = Object.entries(bySource)
        .map(([s, n]) => `${n} ${SOURCE_LABEL[s] || s}`).join(', ');

      const header = `TOTAL: ${open.length} open task${open.length === 1 ? '' : 's'}`
        + (split ? ` (${split})` : '')
        + (overdue ? `, ${overdue} overdue` : '')
        + (soon ? `, ${soon} due soon` : '')
        + (a.category ? ` in category ${a.category}` : '')
        + `. Listing the ${shown.length} most urgent:`;

      const lines = shown.map(t => {
        const flags = [
          t.status === 'done' ? 'DONE' : '',
          t.is_overdue ? 'OVERDUE' : (t.is_due_soon ? 'due soon' : ''),
          t.flags && (t.flags.awaiting_review || t.flags.pending_review) ? 'needs review' : '',
          t.synced ? '' : 'not yet synced',
        ].filter(Boolean).join(', ');
        const where = SOURCE_LABEL[t.source] || t.source;
        return `- ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''} [${where}${t.category ? `/${t.category}` : ''}]${flags ? ` <${flags}>` : ''}  id=${t.id}`;
      });

      const rest = rows.length - shown.length;
      return [header, ...lines, rest > 0 ? `(${rest} more not shown; narrow by category or raise the limit)` : '']
        .filter(Boolean).join('\n');
    },
  },
  {
    name: 'add_task',
    group: 'tasks',
    tier: 'write',
    description: 'Create a task. Choose the system with `source`. If the user did not make clear whether it is work or personal, ask them rather than guessing.',
    schema: { type: 'object', properties: {
      title: { type: 'string' },
      source: {
        type: 'string', enum: ['charliework', 'goosework'],
        description: 'Which system. "charliework" for WORK and school tasks. "goosework" for PERSONAL and home tasks.',
      },
      due_date: { type: 'string', description: 'YYYY-MM-DD.' },
      category: { type: 'string', description: 'Category slug for the chosen system.' },
      notes: { type: 'string' },
      tier: { type: 'string', enum: ['normal', 'someday'] },
    }, required: ['title', 'source'] },
    handler: async (a) => {
      const r = await tasks.create({
        source: a.source, title: a.title, due_date: a.due_date,
        category: a.category, notes: a.notes, tier: a.tier,
      });
      if (!r.ok) return `error: ${r.error}`;
      return `Added to ${a.source}: "${r.task.title}"${r.task.due_date ? ` (due ${r.task.due_date})` : ''}  id=${r.task.id}`;
    },
  },
  {
    name: 'complete_task',
    group: 'tasks',
    tier: 'write',
    description: 'Mark a task done in whichever system owns it. task_id must be an id from list_tasks, in the form "cw:..." or "gw:...".',
    schema: { type: 'object', properties: {
      task_id: { type: 'string', description: 'Exactly as printed by list_tasks, e.g. "cw:62eb2a14" or "gw:9f1c...".' },
    }, required: ['task_id'] },
    handler: async (a) => {
      const known = tasks.get(a.task_id);
      if (!known) return badId(a.task_id);
      const r = await tasks.update(a.task_id, { status: 'done' });
      if (!r.ok) return `error: ${r.error}`;
      return r.pushed
        ? `Marked done in ${known.source}: "${known.title}"`
        : `Marked done locally: "${known.title}", but ${known.source} did not accept it yet. It will retry.`;
    },
  },
  {
    name: 'reschedule_task',
    group: 'tasks',
    tier: 'write',
    description: "Change a task's due date in whichever system owns it. task_id must be an id from list_tasks.",
    schema: { type: 'object', properties: {
      task_id: { type: 'string', description: 'Exactly as printed by list_tasks.' },
      due_date: { type: 'string', description: 'YYYY-MM-DD.' },
    }, required: ['task_id', 'due_date'] },
    handler: async (a) => {
      const known = tasks.get(a.task_id);
      if (!known) return badId(a.task_id);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.due_date))) return 'error: due_date must be YYYY-MM-DD';
      const r = await tasks.update(a.task_id, { due_date: a.due_date });
      if (!r.ok) return `error: ${r.error}`;
      return `Rescheduled "${known.title}" to ${a.due_date}.`;
    },
  },
  {
    name: 'add_task_note',
    group: 'tasks',
    tier: 'write',
    description: "Add a note to a task, appended to whatever notes it already has. task_id must be an id from list_tasks.",
    schema: { type: 'object', properties: {
      task_id: { type: 'string', description: 'Exactly as printed by list_tasks.' },
      note: { type: 'string', description: 'The text to append.' },
    }, required: ['task_id', 'note'] },
    handler: async (a) => {
      const known = tasks.get(a.task_id);
      if (!known) return badId(a.task_id);
      const stamp = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      const merged = [known.notes, `${stamp}: ${a.note}`].filter(Boolean).join('\n');
      const r = await tasks.update(a.task_id, { notes: merged });
      if (!r.ok) return `error: ${r.error}`;
      return `Added a note to "${known.title}".`;
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
