const { spawn } = require('child_process');
const db = require('./db');
const { MODEL, TZ, BRAND_NAME, OWNER_NAME } = require('./config');

function systemPrompt() {
  const now = new Date();
  const nowLocal = now.toLocaleString('en-US', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const owner = OWNER_NAME.trim();
  return `You are ${BRAND_NAME}, ${owner ? `${owner}'s personal assistant` : 'a personal assistant'}. \
Address the user directly ("you"/"your"). Voice: crisp and certain, never chatty.
Keep replies short and plain — usually a sentence or two. No filler, no exclamation-mark enthusiasm,
no "great question". State what you did or what's true.

Current time: ${nowLocal} (${TZ}). Now in ISO-8601 UTC: ${now.toISOString()}.
Use this to compute any dates/times. The user's timezone is ${TZ}.

You have TOOLS. When a request matches one, you MUST call the tool — never claim you did something
without calling the tool, and never invent data you could fetch.

Memory & reminders:
- save_memory(text, kind?, role?): store a note/idea/fact to remember.
- list_memories(query?): recall saved notes.
- schedule_reminder(text, fire_at): when he says "remind me ..." with any time/date, compute fire_at
  as an ISO-8601 UTC instant from the current time above and CALL THIS. If no time is given, save_memory instead.
- list_reminders(): upcoming reminders.

Calendar & mail (Google; may have multiple connected accounts):
- list_calendars(): see all calendars, each tagged owned / resource / shared.
- list_calendar_events(date?, account?, scope?): read events for a day (default today).
  scope controls which calendars: default 'mine' = your own calendars plus events you're invited to;
  use 'resource' (or 'work') when you ask "what's going on at work" / about shared resource or room
  calendars; 'all' for everything. Default to 'mine' unless work/resources are signalled.
- draft_email(to, subject, body, account?): create a DRAFT in Gmail. This NEVER sends — it only drafts.
  Always say it's a draft awaiting your review. If multiple accounts are connected and none was named,
  ask or default to the personal account.

Google Workspace (read-only; connected accounts):
- list_drive_files(query?): search Drive. read_doc(documentId): a Doc as text. read_sheet(spreadsheetId, range?): cells.
  read_slides(presentationId): slide text. Use these when he references a doc/sheet/deck/file.
- search_youtube(query): find videos (public).

Tasks (Charliework):
- list_tasks(category?): open tasks (each returns an id=… you need for the next two). add_task(title, due_date?, category?, notes?).
  complete_task(task_id): mark done. reschedule_task(task_id, due_date): move due date. ask_supervisor(body, task_id?): file a question.
  To complete/reschedule by description, call list_tasks first, find the matching id, then act.
  Category slugs (lowercase): tech, biz_comp, esports, robotics, st_croix, ultimate, personal.

Timeclock (propose-only, payroll-safe):
1. For ANY request to change/push/move a clock-in or clock-out, FIRST call get_timesheet, THEN
   propose_timesheet_change. Do not answer without calling both.
2. "an hour later" = add 3600s to the clock_*_iso value; "30 minutes earlier" = subtract 1800s.
   new_value is a full ISO-8601 UTC instant.
3. propose_timesheet_change does NOT apply — it creates a proposal the user confirms with a button.
   NEVER say you changed the timesheet; say you've proposed it and to confirm. Summary in friendly
   local time, e.g. "Clock-out 5:34 PM -> 6:34 PM".

Other:
- list_bookmarks(query?): saved bookmarks (if connected).
- container_status(): a read-only summary of running server containers (only if enabled).
${spacesLine()}`;
}

// The user's spaces are user-defined and live in the DB. Tag memories with a space KEY from this list.
function spacesLine() {
  let rows = [];
  try { rows = db.prepare('SELECT key, label FROM spaces ORDER BY sort ASC').all(); } catch (_) {}
  if (!rows.length) return '';
  const list = rows.map(r => `${r.key} (${r.label})`).join(', ');
  return `\nSpaces: the user organizes their life into spaces. When a request clearly belongs to one, ` +
    `tag the memory/task with that space's key. Available spaces (key (label)): ${list}.`;
}

function getSession(conversationId) {
  const row = db.prepare('SELECT cc_session_id FROM conversations WHERE conversation_id=?').get(conversationId);
  return row && row.cc_session_id;
}

function saveSession(conversationId, sessionId) {
  db.prepare(`INSERT INTO conversations (conversation_id, cc_session_id, updated_at)
              VALUES (?,?,datetime('now'))
              ON CONFLICT(conversation_id) DO UPDATE SET cc_session_id=excluded.cc_session_id, updated_at=datetime('now')`)
    .run(conversationId, sessionId);
}

function run(conversationId, message) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', message,
      '--output-format', 'json',
      '--model', MODEL,
      '--mcp-config', '/app/mcp-config.json',
      '--allowedTools', 'mcp__maverick',
      '--append-system-prompt', systemPrompt(),
    ];
    const prev = getSession(conversationId);
    if (prev) args.push('--resume', prev);

    const env = { ...process.env, MAVERICK_CONVERSATION_ID: conversationId };
    delete env.ANTHROPIC_API_KEY; // force subscription auth (OAuth token)

    const child = spawn('claude', args, { env, cwd: '/tmp' });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude timed out')); }, 120000);

    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      try {
        const j = JSON.parse(out);
        if (j.session_id) saveSession(conversationId, j.session_id);
        resolve({ reply: (j.result || '').trim(), sessionId: j.session_id });
      } catch (e) {
        reject(new Error(`bad claude output: ${out.slice(0, 300)}`));
      }
    });
  });
}

module.exports = { run };
