// Thin googleapis wrappers: unified calendar read + Gmail draft creation (draft-only by design).
const { google } = require('googleapis');
const oauth = require('./oauth');
const { TZ, workCalendars } = require('../config');

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
async function listEvents({ account, date, calendarId, scope = 'mine' } = {}) {
  const entries = account ? [oauth.clientFor(account)].filter(Boolean) : oauth.allClients();
  if (!entries.length) return { connected: false, events: [] };
  const { day, timeMin, timeMax } = dayBounds(date);

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
        cals = [{ id: calendarId, summary: calendarId, kind: 'owned' }];
      } else {
        const { data } = await cal.calendarList.list();
        cals = (data.items || [])
          .map(c => ({ id: c.id, summary: c.summary || c.id, kind: calKind(c) }))
          // 'mine' also peeks at shared calendars (for events you're invited to); resource is excluded unless asked.
          .filter(c => scopeAllows(c.kind, scope) || (scope === 'mine' && c.kind === 'shared'))
          .slice(0, MAX_CALS);
      }
      await Promise.all(cals.map(async (c) => {
        // On shared calendars under the default 'mine' scope, keep only events you're actually a part of.
        const selfOnly = !calendarId && scope === 'mine' && c.kind === 'shared';
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
            all.push({
              id: ev.id,
              account: acctName,
              calendar: c.summary,
              calendarKind: c.kind,
              title: ev.summary || '(no title)',
              location: ev.location || '',
              start: startISO,
              allDay: !!(ev.start && ev.start.date && !ev.start.dateTime),
              time: startISO ? new Date(startISO).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '',
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
  all.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return { connected: true, day, events: all.slice(0, MAX_TOTAL) };
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

module.exports = { listCalendars, listEvents, createDraft, listDrafts };
