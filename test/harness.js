// Assistant regression harness (LOCAL-BRAIN-SPEC 11.1).
//
//   docker exec maverick node /app/test/harness.js
//   docker exec maverick node /app/test/harness.js --verbose
//
// Runs a fixed prompt set through the real /api/chat path and asserts on what the assistant
// DID, not on how it worded things. Three classes of check:
//
//   tool      the right tool was called, with sane arguments
//   truth     the reply agrees with ground truth read straight from the services
//   manner    no invented data, no offers, no follow-up questions
//
// Ground truth is computed live rather than hardcoded, so this stays valid as the calendar
// and task list change. The prompts are fixed; changing one invalidates comparison with an
// earlier run.

const express = require('express');
const tasksSvc = require('../server/services/tasks');
const gcal = require('../server/google/client');

const VERBOSE = process.argv.includes('--verbose');

// ---- running a turn ----------------------------------------------------------------------

function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/chat', require('../server/routes/chat'));
  return new Promise(res => { const s = app.listen(0, () => res(s)); });
}

async function turn(port, message, conversationId) {
  const started = Date.now();
  const out = { message, reply: '', tools: [], args: [], discarded: false, ms: 0 };
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, message, voice: false }),
  });
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const f = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
      if (!f.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(f.slice(5).trim()); } catch (_) { continue; }
      if (ev.type === 'token') out.reply += ev.text;
      else if (ev.type === 'tool_start') out.tools.push(ev.tool);
      else if (ev.type === 'discard') { out.discarded = true; out.reply = ''; }
      else if (ev.type === 'done') { out.reply = ev.reply || out.reply; out.stopped = ev.stopped; }
      else if (ev.type === 'error') out.error = ev.message || ev.error;
    }
  }
  out.ms = Date.now() - started;
  return out;
}

// ---- assertions --------------------------------------------------------------------------

let pass = 0, fail = 0;
const results = [];
const record = (prompt, name, ok, detail) => {
  if (ok) pass++; else fail++;
  results.push({ prompt, name, ok, detail });
  if (!ok || VERBOSE) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         ${detail}`}`);
};

// Manner checks apply to every reply, because they are the things the user asked to stop.
const OFFER = /\b(would you like|do you want|shall i|want me to|let me know if|feel free|if you need anything)\b/i;
const QUESTION_TAIL = /\?\s*$/;

function checkManner(prompt, t) {
  record(prompt, 'no offer to do more', !OFFER.test(t.reply), (t.reply.match(OFFER) || [])[0] + ` | ${t.reply.slice(-90)}`);
  record(prompt, 'does not end on a question', !QUESTION_TAIL.test(t.reply.trim()), t.reply.slice(-90));
}

// ---- ground truth ------------------------------------------------------------------------

async function groundTruth() {
  const [agenda, counts] = await Promise.all([
    gcal.listEvents({ scope: 'mine', include: 'agenda' }).catch(() => ({ events: [] })),
    Promise.resolve(tasksSvc.counts()),
  ]);
  const events = (agenda.events || []).filter(e => !e.error);
  return {
    events,
    eventTitles: events.map(e => e.title),
    eventCount: events.length,
    openTasks: counts.open,
    overdue: counts.overdue,
    personalTasks: tasksSvc.list({ source: 'goosework', limit: 500 }).length,
  };
}

// ---- the run -----------------------------------------------------------------------------

(async () => {
  const truth = await groundTruth();
  console.log('Ground truth read from the services:');
  console.log(`  agenda today : ${truth.eventCount} events — ${truth.eventTitles.join(' | ') || '(none)'}`);
  console.log(`  open tasks   : ${truth.openTasks} (${truth.overdue} overdue, ${truth.personalTasks} personal)`);
  console.log();

  const srv = await startServer();
  const port = srv.address().port;
  const conv = () => 'harness-' + Math.random().toString(36).slice(2, 8);
  const turns = [];

  const run = async (message, checks, conversationId) => {
    const t = await turn(port, message, conversationId || conv());
    turns.push(t);
    console.log(`\n> ${message}`);
    console.log(`  [${t.tools.join(', ') || 'no tools'}] ${t.ms}ms${t.discarded ? ' (discarded+refetched)' : ''}`);
    console.log(`  ${JSON.stringify(t.reply.slice(0, 170))}`);
    checkManner(message, t);
    await checks(t);
    return t;
  };

  // --- calendar: completeness is the thing that has been failing -------------------------
  await run("what's on my calendar today", async t => {
    record(t.message, 'called the calendar tool', t.tools.includes('list_calendar_events'), t.tools.join(','));
    const named = truth.eventTitles.filter(x => t.reply.toLowerCase().includes(x.toLowerCase().slice(0, 14)));
    record(t.message, `names all ${truth.eventCount} events`, named.length === truth.eventCount,
      `named ${named.length}/${truth.eventCount}: missing ${truth.eventTitles.filter(x => !named.includes(x)).join(', ')}`);
    record(t.message, 'did not invent an event',
      !/jane smith|1-on-1|standup|8th grader/i.test(t.reply), t.reply.slice(0, 120));
  });

  // --- tasks: the count must be right ------------------------------------------------------
  await run('how many open tasks do I have', async t => {
    record(t.message, 'called the task tool', t.tools.includes('list_tasks'), t.tools.join(','));
    record(t.message, `states the true count (${truth.openTasks})`,
      new RegExp(`\\b${truth.openTasks}\\b`).test(t.reply), t.reply.slice(0, 140));
  });

  await run('what personal tasks do I have', async t => {
    record(t.message, 'called the task tool', t.tools.includes('list_tasks'), t.tools.join(','));
    record(t.message, 'does not claim there are none',
      truth.personalTasks === 0 || !/\b(no|zero|none|not have any)\b.{0,24}task/i.test(t.reply), t.reply.slice(0, 140));
  });

  // --- efficiency: repeated identical lookups in one turn ----------------------------------
  await run('what is on the docket for today', async t => {
    const counts = {};
    for (const x of t.tools) counts[x] = (counts[x] || 0) + 1;
    const repeated = Object.entries(counts).filter(([, n]) => n > 1);
    record(t.message, 'does not call the same tool twice', repeated.length === 0, JSON.stringify(counts));
    record(t.message, 'under 6 seconds', t.ms < 6000, `${t.ms}ms`);
  });

  // --- a place, not a person ---------------------------------------------------------------
  await run('what is going on in the wilke today', async t => {
    record(t.message, 'queried the named calendar', t.tools.includes('list_calendar_events'), t.tools.join(','));
    record(t.message, 'answer is about the room, not the user',
      !truth.eventTitles.some(x => x && t.reply.includes(x)), t.reply.slice(0, 140));
  });

  // --- a dead end must read as a dead end, with no offer ------------------------------------
  await run('anything on my calendar in 2031', async t => {
    record(t.message, 'says there is nothing', /\b(no|nothing|not any|none)\b/i.test(t.reply), t.reply.slice(0, 140));
    record(t.message, 'did not invent events', !/\d{1,2}:\d{2}\s*(am|pm)/i.test(t.reply), t.reply.slice(0, 140));
  });

  // --- follow-up must still reach the data --------------------------------------------------
  const c = conv();
  await run("what's on my calendar today", async () => {}, c);
  await run('and what about this afternoon', async t => {
    record(t.message, 'still consulted a tool', t.tools.length > 0 || t.discarded, t.tools.join(','));
    record(t.message, 'did not invent an afternoon',
      !/jane smith|1-on-1|8th grader|dr\./i.test(t.reply), t.reply.slice(0, 140));
  }, c);

  // --- a non-data question must not trigger tools -------------------------------------------
  await run('reply with just the word ok', async t => {
    record(t.message, 'no tool call for a trivial request', t.tools.length === 0, t.tools.join(','));
    record(t.message, 'reply is short', t.reply.trim().length < 40, JSON.stringify(t.reply));
  });

  srv.close();

  // ---- summary ------------------------------------------------------------------------------
  const slow = turns.filter(t => t.ms > 6000).length;
  const multi = turns.filter(t => new Set(t.tools).size < t.tools.length).length;
  console.log('\n' + '-'.repeat(62));
  console.log(`turns: ${turns.length}   median ${median(turns.map(t => t.ms))}ms   over 6s: ${slow}   with repeated tools: ${multi}`);
  console.log(`checks: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nfailures:');
    for (const r of results.filter(x => !x.ok)) console.log(`  - [${r.prompt}] ${r.name}\n      ${r.detail}`);
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('harness error:', e); process.exit(2); });

function median(a) { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; }
