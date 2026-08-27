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
async function listEvents({ account, date, calendarId, scope = 'mine', include = 'agenda' } = {}) {
  const entries = account ? [oauth.clientFor(account)].filter(Boolean) : oauth.allClients();
  if (!entries.length) return { connected: false, events: [] };
  const { day, timeMin, timeMax } = dayBounds(date);
  const prefs = calPrefs.map();

  const roleAllows = mode => {
    if (mode === 'off') return false;
    if (include === 'all') return true;
    if (include === 'reference') return mode === 'reference';
    return mode === 'agenda';
  };

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
          // Role first: an explicit decision outranks everything, including scope.
          .filter(c => roleAllows(c.mode))
          // Then the kind heuristic, but ONLY for calendars nobody has ruled on. Once you
          // have said "this is my agenda", it should not then be dropped for being a shared
          // calendar you are not an attendee of.
          .filter(c => c.explicit
            || scopeAllows(c.kind, scope)
            || (scope === 'mine' && c.kind === 'shared'))
          .slice(0, MAX_CALS);
      }
      await Promise.all(cals.map(async (c) => {
        // On shared calendars under the default 'mine' scope, keep only events you're actually a part of.
        // Skipped when the calendar was explicitly set: a birthday or in/out board has no
        // attendees, so self-filtering would empty it and make "who is out today" useless.
        const selfOnly = !calendarId && !c.explicit && scope === 'mine' && c.kind === 'shared';
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
