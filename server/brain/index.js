// The agent loop (LOCAL-BRAIN-SPEC 8.2).
//
//   1. load history
//   2. resolve relative times deterministically
//   3. select the tool subset
//   4. call ollama
//   5. if the reply has tool_calls: validate, run, truncate, append role:'tool', goto 4
//   6. otherwise persist the assistant message, emit it, return
//
// Hard limits, all non-negotiable, all of them because a 7B that starts looping loops
// forever:
//
//   rounds per turn        6
//   identical repeat calls 3, then that call is refused with an error the model can read
//   wall clock per turn    90s
//   tool result size       1,500 tokens, truncated with an explicit marker
//   tools per request      8
//
// When a limit trips, the turn returns a plain reply saying what happened. It never returns
// a silent empty string, and it never returns a reply claiming a tool ran when it did not.

const ollama = require('./ollama');
const gating = require('./gating');
const context = require('./context');
const prompt = require('./prompt');
const time = require('./time');
const { dispatch } = require('../tools');
const calPrefs = require('../services/calendars');
const { brain, TZ } = require('../config');

const MAX_IDENTICAL = 3;

const callKey = c => `${c.function.name}:${stableArgs(c.function.arguments)}`;
const stableArgs = a => {
  // ollama 0.32.14 gives arguments as an object; older builds and other providers give a
  // JSON string. Normalise both, and sort keys so {a,b} and {b,a} count as the same call.
  let o = a;
  if (typeof a === 'string') { try { o = JSON.parse(a); } catch (_) { return a; } }
  if (!o || typeof o !== 'object') return JSON.stringify(o);
  return JSON.stringify(Object.keys(o).sort().reduce((m, k) => (m[k] = o[k], m), {}));
};
const argsObject = a => {
  if (typeof a === 'string') { try { return JSON.parse(a); } catch (_) { return {}; } }
  return a && typeof a === 'object' ? a : {};
};

// Run one turn. `emit` is optional; when given it receives progress events, which is what
// the SSE route streams to the browser.
//
//   emit({ type:'tool_start', tool })
//   emit({ type:'tool_end',   tool, ok, preview })
//   emit({ type:'token',      text })          // only on the streaming final round
//
// Returns { reply, rounds, toolsUsed, stopped }.
async function run(conversationId, message, opts = {}) {
  const { emit = null, voice = false, surface = 'web', stream = false, signal = null } = opts;
  const started = Date.now();
  const deadline = started + brain.turnTimeoutMs;

  const hits = time.resolve(message, { timeZone: TZ });

  // Resolve a named place to a calendar here, not in the model. Same reasoning as the time
  // resolver: told about a `calendar` argument, qwen2.5:7b called the wrong tool and then
  // answered about the user's own day labelled "at Wilke".
  let calendarHits = [];
  try { calendarHits = await calPrefs.resolveFromMessage(message); } catch (_) {}
  const calendarHint = calendarHits.length ? calendarHits[0].token : null;

  const systemPrompt = prompt.build({
    resolvedTimes: time.promptBlock(hits),
    resolvedCalendars: calendarHits.length
      ? `Named calendars in this request: ${calendarHits.map(h => `"${h.token}" = ${h.cal.summary}`).join('; ')}. `
        + `The user is asking about that place, not about their own schedule. Call `
        + `list_calendar_events with calendar:"${calendarHint}".`
      : '',
    voice,
  });

  const messages = context.assemble({ conversationId, systemPrompt, userMessage: message });
  context.append(conversationId, { role: 'user', content: message });

  const sticky = [];
  const seen = new Map();
  const toolsUsed = [];
  let rounds = 0;
  let stopped = null;
  let nudged = false;

  while (rounds < brain.maxRounds) {
    if (Date.now() > deadline) { stopped = 'timeout'; break; }
    rounds++;

    const { groups, tools, matched } = gating.select(message, { sticky, conversationId });
    const ollamaTools = gating.toOllama(tools);
    // Did this message itself ask about live data the model cannot know unaided?
    const wantsData = matched.some(g => gating.DATA_GROUPS.includes(g));

    // Always stream when the caller wants streaming. LOCAL-BRAIN-SPEC 8.1 left open whether
    // tool calls survive stream:true and offered a non-streamed fallback for tool-carrying
    // rounds. Verified against the running ollama 0.32.14 on 2026-08-27: they do, arriving
    // whole in a single chunk whose content is empty, so no fallback is needed and the loop
    // stays one code path. Re-verify after any ollama upgrade.
    let assistant;
    if (stream) {
      assistant = await streamRound(messages, ollamaTools, emit, signal);
    } else {
      const res = await ollama.chat({ messages, tools: ollamaTools });
      assistant = res.message;
    }

    const calls = assistant.tool_calls || [];

    if (!calls.length) {
      let reply = (assistant.content || '').trim();

      // The model answered a live-data question without looking anything up. That answer is
      // fabricated by construction, and it does happen: asked "and what about my afternoon"
      // as a follow-up, qwen2.5:7b invented "a meeting with Dr. Jane Smith at 3:00 PM"
      // while the calendar tools sat unused in front of it. Its own earlier reply is in the
      // context and it continues the story rather than checking.
      //
      // The prompt already forbids this and the tools are already offered, so neither is
      // the fix. Force one retry with the omission named. If it still will not call, the
      // reply is discarded rather than shown: a plain "I could not check" is worth far more
      // than a confident invented schedule.
      if (wantsData && !toolsUsed.length && !nudged) {
        nudged = true;
        // Do not argue with it: fetch the data and hand it over.
        //
        // Asking again does not work. Told it had answered without checking, qwen2.5:7b
        // simply produced a second invented schedule. So the loop runs the obvious
        // read-only tool for the matched group itself and feeds the result back. The model
        // then has real data in front of it and only has to phrase it.
        //
        // Read-only by construction: PRIMARY_READ maps to list/get tools only. Nothing that
        // writes is ever invoked on the model's behalf.
        const forced = [...new Set(matched
          .map(g => gating.PRIMARY_READ[g])
          .filter(Boolean))];

        if (forced.length) {
          if (emit) emit({ type: 'discard' });   // drop the invented text already streamed
          for (const name of forced) {
            if (emit) emit({ type: 'tool_start', tool: name });
            const out = await dispatch(name, {}, {
              conversationId, actor: 'system', surface, now: new Date(), tz: TZ,
              resolvedTimes: hits, calendarHint,
            });
            const res = context.truncateToolResult(out.result);
            toolsUsed.push({ tool: name, ok: out.ok, forced: true });
            if (emit) emit({ type: 'tool_end', tool: name, ok: out.ok, preview: res.slice(0, 160) });
            messages.push({ role: 'tool', content: res, tool_name: name });
            context.append(conversationId, { role: 'tool', content: res, toolName: name });
          }
          messages.push({
            role: 'system',
            content: 'You answered without checking. The tool results above are the real, '
              + 'current data. Answer again using ONLY those results. If they show nothing, '
              + 'say there is nothing.',
          });
          console.log(`[brain] ${conversationId} forced ${forced.join(',')} after a no-tool answer`);
          continue;
        }

        // No read tool exists for the matched group. Refusing beats inventing.
        stopped = 'refused_to_call_tool';
        if (emit) emit({ type: 'discard' });
        reply = "I couldn't check that just now, so I'd rather not guess. Ask me again?";
        console.warn(`[brain] ${conversationId} answered a data question with no tool available`);
      }

      if (!reply) {
        // A 7B occasionally returns an empty assistant turn. Do not hand back silence.
        reply = "I didn't get that one out. Say it again?";
        stopped = 'empty_reply';
      }
      context.append(conversationId, { role: 'assistant', content: reply });
      return finish({ conversationId, reply, rounds, toolsUsed, stopped, started });
    }

    // Persist and replay the assistant's tool-call turn before the results.
    messages.push({ role: 'assistant', content: assistant.content || '', tool_calls: calls });
    context.append(conversationId, {
      role: 'assistant', content: assistant.content || '', toolCalls: calls,
    });

    for (const call of calls) {
      if (Date.now() > deadline) { stopped = 'timeout'; break; }
      const name = call.function && call.function.name;
      const key = callKey(call);
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);

      let result;
      if (n > MAX_IDENTICAL) {
        // Same tool, same arguments, repeatedly. Refusing with a readable reason breaks the
        // loop without ending the turn, which usually gets a different call next round.
        result = `error: you have already called ${name} with these exact arguments ${MAX_IDENTICAL} times `
               + `and got the same result. Do not call it again. Answer with what you have, or say `
               + `what is missing.`;
        stopped = stopped || 'repeat_limit';
      } else {
        if (emit) emit({ type: 'tool_start', tool: name });
        const out = await dispatch(name, argsObject(call.function.arguments), {
          conversationId, actor: 'model', surface, now: new Date(), tz: TZ,
          resolvedTimes: hits, calendarHint,
        });
        result = context.truncateToolResult(out.result);
        toolsUsed.push({ tool: name, ok: out.ok });
        if (emit) emit({ type: 'tool_end', tool: name, ok: out.ok, preview: result.slice(0, 160) });

        const tool = require('../tools/registry').get(name);
        if (tool && !sticky.includes(tool.group)) sticky.push(tool.group);
      }

      messages.push({ role: 'tool', content: result, tool_name: name });
      context.append(conversationId, { role: 'tool', content: result, toolName: name });
    }
  }

  // Fell out of the loop: round limit, timeout, or the deadline hit mid-tool.
  if (!stopped) stopped = 'round_limit';
  const reply = stopped === 'timeout'
    ? "That took too long and I stopped it. The tools I did run are recorded; try asking for one thing at a time."
    : "I went round in circles on that one and stopped. Try asking for one thing at a time.";
  context.append(conversationId, { role: 'assistant', content: reply });
  return finish({ conversationId, reply, rounds, toolsUsed, stopped, started });
}

async function streamRound(messages, tools, emit, signal) {
  let content = '';
  let toolCalls = null;
  for await (const chunk of ollama.chatStream({ messages, tools, signal })) {
    const m = chunk.message;
    if (!m) continue;
    if (m.tool_calls && m.tool_calls.length) { toolCalls = m.tool_calls; break; }
    if (m.content) {
      content += m.content;
      if (emit) emit({ type: 'token', text: m.content });
    }
  }
  return { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}

function finish({ conversationId, reply, rounds, toolsUsed, stopped, started }) {
  const ms = Date.now() - started;
  console.log(`[brain] ${conversationId} ${ms}ms rounds=${rounds} tools=${toolsUsed.map(t => t.tool).join(',') || 'none'}${stopped ? ` stopped=${stopped}` : ''}`);

  // Summarise after the reply is out, never in the user's latency path.
  setImmediate(() => {
    context.maybeSummarize(conversationId, async (p) => {
      const res = await ollama.chat({ messages: [{ role: 'user', content: p }] });
      return (res.message.content || '').trim();
    }).catch(() => {});
  });

  return { reply, rounds, toolsUsed, stopped, latency_ms: ms };
}

module.exports = { run, status: ollama.status, BrainOffline: ollama.BrainOffline };
