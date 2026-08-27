// Thin googleapis wrappers: unified calendar read + Gmail draft creation (draft-only by design).
const { google } = require('googleapis');
const oauth = require('./oauth');
const { TZ, workCalendars } = require('../config');
const calPrefs = require('../services/calendars');

function dayBounds(dateStr) {
  // dateStr = 'YYYY-MM-DD' in TZ, or undefined for today. Returns ISO timeMin/timeMax for that local day.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = dateStr || fmt.format(new Date());
  // Build start/end as local-day boundaries. We lean on the calendar API's timeZone handling by
  // sending RFC3339 with no offset is not allowed, so approximate with a wide UTC window around the day
  // and let the API filter; good enough for a personal agenda.
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(`${day}T23:59:59`);
  return { day, timeMin: start.toISOString(), timeMax: end.toISOString() };
}

// Classify a calendarList entry so the assistant can scope queries:
//   owned    = your own calendars (you're the owner, or your primary)
//   resource = school/org resource calendars (rooms, equipment) — Google resource ids, or named like one
//   shared   = calendars shared/subscribed to you that you don't own (reader/writer)
function calKind(c) {
  const sum = (c.summary || '').toLowerCase();
  // Explicit work-calendar overrides win even over ownership (e.g. "Office ins and outs").
  if ((workCalendars || []).some(w => sum.includes(w))) return 'resource';
  if (c.primary || c.accessRole === 'owner') return 'owned';
  const id = c.id || '';
  if (/@resource\.calendar\.google\.com$/i.test(id) || /\b(resource|room|lab|cart|library|projector|chromebook)\b/i.test(c.summary || '')) return 'resource';
  return 'shared';
}

// Which calendars a scope selects. scope: 'mine'(default) | 'resource'/'work' | 'shared' | 'all'.
function scopeAllows(kind, scope) {
  switch (scope) {
    case 'all': return true;
    case 'resource': case 'work': return kind === 'resource';
    case 'shared': return kind === 'shared';
    case 'mine': default: return kind === 'owned';
  }
}

// List all calendars across one or all connected accounts.
async function listCalendars({ account } = {}) {
  const entries = account ? [oauth.clientFor(account)].filter(Boolean) : oauth.allClients();
  if (!entries.length) return { connected: false, calendars: [] };

  const out = [];
  for (const { client, account: acct } of entries) {
    try {
      const cal = google.calendar({ version: 'v3', auth: client });
      const { data } = await cal.calendarList.list();
      for (const c of (data.items || [])) {
        out.push({
          id: c.id,
          summary: c.summary || c.id,
          primary: !!c.primary,
          accessRole: c.accessRole || '',
          kind: calKind(c),
          account: acct.label || acct.email,
        });
      }
    } catch (e) {
      out.push({ error: `calendars ${acct.label || acct.email}: ${e.message}` });
    }
  }
  return { connected: true, calendars: out };
}

// List events across one or all connected accounts for a given local day.
// When calendarId is omitted, enumerates every calendar on each account; otherwise queries just that one.
//
// `include` selects which per-calendar roles are in play (see services/calendars.js):
//   'agenda'    (default) only calendars that count as your day
//   'reference' only the consult-on-request ones (birthdays, menus, who is in/out)
//   'all'       both
// Calendars set to 'off' are never fetched under any value.
async function listEvents({ account, date, calendarId, calendar, scope = 'mine', include = 'agenda' } = {}) {
  const entries = account ? [oauth.clientFor(account)].filter(Boolean) : oauth.allClients();
  if (!entries.length) return { connected: false, events: [] };
  const { day, timeMin, timeMax } = dayBounds(date);
  const prefs = calPrefs.map();

  // A calendar asked for BY NAME is an explicit request, so its role no longer filters it.
  // Most rooms and boards are marked reference precisely so they stay out of the agenda;
  // that must not also make "what is going on in the Wilke today" unanswerable. `off` still
  // means off, since that is the one setting that says "never fetch this".
  const named = String(calendar || '').trim().toLowerCase();

  const roleAllows = mode => {
    if (mode === 'off') return false;
    if (named) return true;
    if (include === 'all') return true;
    if (include === 'reference') return mode === 'reference';
    return mode === 'agenda';
  };

  const matchedNames = [];
  const allNames = [];

  const MAX_TOTAL = 50;
  const PER_CAL = 25;
  const MAX_CALS = 30;   // cap calendars queried per account (you have many resource calendars)
  const all = [];
  // Query accounts AND their calendars concurrently — sequential was ~26s with 30+ calendars.
  await Promise.all(entries.map(async ({ client, account: acct }) => {
    const acctName = acct.label || acct.email;
    try {
      const cal = google.calendar({ version: 'v3', auth: client });
      let cals;
      if (calendarId) {
        cals = [{ id: calendarId, summary: calendarId, kind: 'owned', mode: 'agenda', explicit: true }];
      } else {
        const { data } = await cal.calendarList.list();
        cals = (data.items || [])
          .map(c => {
            const k = calPrefs.key(acctName, c.id);
            return {
              id: c.id, summary: c.summary || c.id, kind: calKind(c),
              mode: prefs.get(k) || calPrefs.DEFAULT_MODE,
              explicit: prefs.has(k),
            };
          })
          .filter(c => { allNames.push(c.summary); return true; })
          // Role first: an explicit decision outranks everything, including scope.
          .filter(c => roleAllows(c.mode))
          // A name match replaces the scope/kind heuristics entirely: you asked for this
          // calendar, so nothing else gets to veto it.
          .filter(c => {
            if (!named) {
              return c.explicit
                || scopeAllows(c.kind, scope)
                || (scope === 'mine' && c.kind === 'shared');
            }
            const hit = c.summary.toLowerCase().includes(named);
            if (hit) matchedNames.push(c.summary);
            return hit;
          })
          .slice(0, MAX_CALS);
      }
      await Promise.all(cals.map(async (c) => {
        // On shared calendars under the default 'mine' scope, keep only events you're actually a part of.
        // Skipped when the calendar was explicitly set or asked for by name: a birthday
        // board or a room booking has no attendees, so self-filtering would empty it.
        const selfOnly = !calendarId && !named && !c.explicit && scope === 'mine' && c.kind === 'shared';
        try {
          const { data } = await cal.events.list({
            calendarId: c.id, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: PER_CAL,
          });
          for (const ev of (data.items || [])) {
            if (selfOnly) {
              const mine = (ev.attendees || []).some(a => a.self && a.responseStatus !== 'declined') ||
                (ev.organizer && ev.organizer.self) || (ev.creator && ev.creator.self);
              if (!mine) continue;
            }
            const startISO = ev.start && (ev.start.dateTime || ev.start.date);
            // An all-day event carries a bare 'YYYY-MM-DD', which Date parses as UTC
            // midnight, so formatting it in a negative-offset zone renders the evening
            // BEFORE. Every birthday and menu entry was showing as "7:00 PM". All-day
            // events have no clock time, so do not invent one.
            const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
            // End time, so callers can tell "happening right now" from "already finished".
            // Without it the home card offered to prep a 7:50 AM meeting at 4 in the afternoon.
            const endISO = ev.end && (ev.end.dateTime || ev.end.date);
            all.push({
              id: ev.id,
              account: acctName,
              calendar: c.summary,
              calendarKind: c.kind,
              calendarMode: c.mode || 'agenda',
              title: ev.summary || '(no title)',
              location: ev.location || '',
              start: startISO,
              end: endISO || null,
              allDay: isAllDay,
              time: (!isAllDay && startISO)
                ? new Date(startISO).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
                : '',
              hangoutLink: ev.hangoutLink || '',
            });
          }
        } catch (e) {
          all.push({ error: `calendar ${acctName}/${c.summary}: ${e.message}` });
        }
      }));
    } catch (e) {
      all.push({ error: `calendar ${acctName}: ${e.message}` });
    }
  }));
  // All-day entries sort first within a day: their bare date string compares below any
  // same-day timestamp, which is what we want, but only because it has no time component.
  all.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  // Collapse the same event seen through more than one account. A calendar subscribed on
  // both the personal and the work account yields two copies of every event, which read as
  // two commitments: "Help George T Gialamas" appeared twice in today's agenda.
  //
  // Deduped on the Google event id ONLY, never on title plus time. Two genuinely separate
  // bookings can share a name and a slot (two swim practices in the same pool), and merging
  // those would delete real information. Same id means the same underlying event, full stop.
  const seenIds = new Map();
  const deduped = [];
  for (const e of all) {
    if (e.error || !e.id) { deduped.push(e); continue; }
    const prior = seenIds.get(e.id);
    if (prior) {
      // Keep a record of where else it was found rather than silently dropping the copy.
      if (!prior.alsoOn) prior.alsoOn = [prior.account];
      if (!prior.alsoOn.includes(e.account)) prior.alsoOn.push(e.account);
      continue;
    }
    seenIds.set(e.id, e);
    deduped.push(e);
  }
  all.length = 0;
  all.push(...deduped);
  // Report what a name actually resolved to. Without this a typo silently returns nothing
  // and the model presents "no events" as fact rather than "I could not find that calendar".
  const result = { connected: true, day, events: all.slice(0, MAX_TOTAL) };
  if (named) {
    result.matchedCalendars = [...new Set(matchedNames)];
    if (!result.matchedCalendars.length) {
      result.noMatch = true;
      result.availableCalendars = [...new Set(allNames)];
    }
  }
  return result;
}

// ---- Gmail read -------------------------------------------------------------------------
//
// gmail.readonly is already granted on both connected accounts; it simply was not used.
// Read only: nothing here mutates a mailbox, and messages.send is never called anywhere in
// this file. Gated by cfg.mailRead so the capability is an explicit choice, not a default.

const HEADER = (headers, name) =>
  ((headers || []).find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

// Walk the MIME tree for readable text. Prefers text/plain; falls back to stripped HTML.
function extractBody(payload) {
  if (!payload) return '';
  const decode = d => { try { return Buffer.from(d, 'base64').toString('utf8'); } catch (_) { return ''; } };

  const walk = (part, wantHtml) => {
    if (!part) return '';
    const mime = part.mimeType || '';
    if (mime === (wantHtml ? 'text/html' : 'text/plain') && part.body && part.body.data) {
      return decode(part.body.data);
    }
    for (const child of (part.parts || [])) {
      const found = walk(child, wantHtml);
      if (found) return found;
    }
    return '';
  };

  const plain = walk(payload, false);
  if (plain) return plain;
  const html = walk(payload, true);
  return html
    ? html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
    : '';
}

// Search mail across connected accounts. `query` is Gmail search syntax, passed through, so
// "from:pam after:2026/08/01 has:attachment" works as written rather than being guessed at.
async function searchMail({ account, query, max = 10 } = {}) {
  const entries = account ? [oauth.clientFor(account)].filter(Boolean) : oauth.allClients();
  if (!entries.length) return { connected: false, messages: [] };
  const limit = Math.min(Math.max(Number(max) || 10, 1), 25);

  const out = [];
  await Promise.all(entries.map(async ({ client, account: acct }) => {
    const acctName = acct.label || acct.email;
    try {
      const gmail = google.gmail({ version: 'v1', auth: client });
      const { data } = await gmail.users.messages.list({
        userId: 'me', q: query || 'in:inbox', maxResults: limit,
      });
      const ids = (data.messages || []).map(m => m.id);
      // Gmail's batch endpoints 403 for this token type, so fetch individually. Metadata
      // format keeps each response small; full bodies are only pulled by read_email.
      const msgs = await Promise.all(ids.map(async id => {
        try {
          const { data: full } = await gmail.users.messages.get({
            userId: 'me', id, format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          });
          const h = (full.payload && full.payload.headers) || [];
          return {
            id, threadId: full.threadId, account: acctName,
            from: HEADER(h, 'From'), to: HEADER(h, 'To'),
            subject: HEADER(h, 'Subject') || '(no subject)',
            date: HEADER(h, 'Date'),
            snippet: (full.snippet || '').trim(),
            unread: (full.labelIds || []).includes('UNREAD'),
          };
        } catch (_) { return null; }
      }));
      out.push(...msgs.filter(Boolean));
    } catch (e) {
      out.push({ error: `mail ${acctName}: ${e.message}` });
    }
  }));
  return { connected: true, query: query || 'in:inbox', messages: out };
}

// Full text of one message. Body is capped by the caller's tool-result budget.
async function readEmail({ account, id } = {}) {
  const entries = account ? [oauth.clientFor(account)].filter(Boolean) : oauth.allClients();
  if (!entries.length) return { connected: false };
  for (const { client, account: acct } of entries) {
    try {
      const gmail = google.gmail({ version: 'v1', auth: client });
      const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const h = (data.payload && data.payload.headers) || [];
      return {
        connected: true, found: true, id, account: acct.label || acct.email,
        from: HEADER(h, 'From'), to: HEADER(h, 'To'), cc: HEADER(h, 'Cc'),
        subject: HEADER(h, 'Subject') || '(no subject)', date: HEADER(h, 'Date'),
        body: extractBody(data.payload).trim(),
      };
    } catch (_) {
      // Wrong account for this id; try the next one before giving up.
    }
  }
  return { connected: true, found: false };
}

// A count-first overview, the same shape the task tool uses: a small model should be told
// the totals rather than made to derive them from a list.
async function inboxSummary({ account, hours = 24 } = {}) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 14);
  const days = Math.max(1, Math.ceil(h / 24));
  const res = await searchMail({ account, query: `in:inbox newer_than:${days}d`, max: 25 });
  if (!res.connected) return { connected: false };
  const msgs = (res.messages || []).filter(m => !m.error);
  const senders = {};
  for (const m of msgs) {
    const name = (m.from.match(/^\s*"?([^"<]+?)"?\s*</) || [])[1] || m.from;
    senders[name.trim()] = (senders[name.trim()] || 0) + 1;
  }
  return {
    connected: true, hours: h,
    total: msgs.length,
    unread: msgs.filter(m => m.unread).length,
    top_senders: Object.entries(senders).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([name, n]) => ({ name, count: n })),
    messages: msgs,
    errors: (res.messages || []).filter(m => m.error).map(m => m.error),
  };
}

// Create a Gmail DRAFT (never sends). Returns the draft id.
async function createDraft({ account, to, subject, body }) {
  const entry = oauth.clientFor(account);
  if (!entry) return { ok: false, error: 'no_connected_account' };
  const gmail = google.gmail({ version: 'v1', auth: entry.client });

  const headers = [
    `To: ${to || ''}`,
    `Subject: ${subject || ''}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
  ];
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body || ''}`)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const { data } = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return { ok: true, draftId: data.id, account: entry.account.label || entry.account.email };
}

// List recent drafts (so the UI can show what's waiting for review).
async function listDrafts({ account, max = 20 } = {}) {
  const entries = account ? [oauth.clientFor(account)].filter(Boolean) : oauth.allClients();
  if (!entries.length) return { connected: false, drafts: [] };
  const out = [];
  for (const { client, account: acct } of entries) {
    try {
      const gmail = google.gmail({ version: 'v1', auth: client });
      const { data } = await gmail.users.drafts.list({ userId: 'me', maxResults: max });
      for (const d of (data.drafts || [])) {
        const { data: full } = await gmail.users.drafts.get({ userId: 'me', id: d.id, format: 'metadata' });
        const h = (full.message && full.message.payload && full.message.payload.headers) || [];
        const get = n => (h.find(x => x.name.toLowerCase() === n) || {}).value || '';
        out.push({ id: d.id, account: acct.label || acct.email, to: get('to'), subject: get('subject'), snippet: full.message && full.message.snippet || '' });
      }
    } catch (e) {
      out.push({ error: `drafts ${acct.label || acct.email}: ${e.message}` });
    }
  }
  return { connected: true, drafts: out };
}

module.exports = { listCalendars, listEvents, createDraft, listDrafts, searchMail, readEmail, inboxSummary };
