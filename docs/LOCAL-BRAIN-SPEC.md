# Maverick — local inference rework

**Status:** specification, not yet implemented.
**Written:** 2026-08-24, against Maverick as deployed on gisiserver.
**Audience:** the agent that implements this on gisiserver, and whoever maintains it later.

## 1. What this changes

Maverick's brain is currently the Claude Code CLI. Every chat turn spawns `claude -p`
against `claude-sonnet-4-6` with an MCP tool server attached over stdio. Watch dictation
goes through a Whisper `base` model running on gisiserver's CPU.

Both move onto the RTX 3070 in goose-desktop. After this rework Maverick runs entirely on
hardware in the house: a local instruct model serves the assistant turns, and a GPU Whisper
service serves dictation. The Anthropic dependency leaves the runtime completely — no
`claude` binary in the image, no OAuth token in `.env`, no network call to Anthropic on any
request path.

This is a hard cutover, chosen deliberately. Section 12 states what gets worse as a result,
because some things will.

### Why this is worth doing

Three things improve, and they are the reason to accept section 12's costs.

**Latency.** A `claude -p` spawn pays Node startup, CLI startup, MCP subprocess spawn, and a
round trip to Anthropic before the first token exists. A resident 7B on a local GPU answers a
simple turn in well under a second of time-to-first-token. Combined with response streaming
(section 9), which Maverick does not do today, the assistant should feel immediate rather than
considered.

**Privacy.** Maverick reads a real calendar, a real inbox, and a real timeclock. Today those
tool results travel to Anthropic as context. After the rework they do not leave the LAN. Watch
audio already stays local; this extends that property to everything else.

**Cost and availability of the subscription.** The brain no longer consumes Claude subscription
capacity, and Maverick no longer breaks when a token expires or a rate limit trips.

## 2. Measured current state

Everything in this section was read off the running system on 2026-08-24. Verify it again
before building, since the deployment moves.

### Maverick

| Item | Value |
| --- | --- |
| Compose project | `/gisiserver/infra/docker/maverick` |
| Containers | `maverick` (app, port 3000, `proxy` network), `maverick-whisper` |
| Brain | `server/claude.js` spawns `claude -p --output-format json --mcp-config /app/mcp-config.json --allowedTools mcp__maverick` |
| Model | `MAVERICK_MODEL=claude-sonnet-4-6` (`server/config.js` defaults to `claude-haiku-4-5` if unset) |
| Continuity | one Claude Code `session_id` per conversation, stored in `conversations.cc_session_id`, replayed with `--resume` |
| Turn timeout | 120 s hard kill in `claude.js` |
| Tools | 21, defined in `server/mcp-server.js` as a `TOOLS` array plus a `switch` dispatch |
| System prompt | built per turn in `claude.js`, roughly 1,300 tokens, current time injected every call |
| STT | `onerahmet/openai-whisper-asr-webservice:latest`, `ASR_MODEL=base`, `ASR_ENGINE=openai_whisper`, CPU only |
| DB | SQLite at `/app/data/maverick.db`, WAL |

The 21 tools, grouped as section 8 will use them:

- Memory and reminders: `save_memory`, `list_memories`, `schedule_reminder`, `list_reminders`
- Calendar: `list_calendars`, `list_calendar_events`
- Mail: `draft_email`
- Timeclock: `get_timesheet`, `propose_timesheet_change`
- Tasks (Charliework): `list_tasks`, `add_task`, `complete_task`, `reschedule_task`, `ask_supervisor`
- Workspace (read-only): `list_drive_files`, `read_doc`, `read_sheet`, `read_slides`
- Other: `list_bookmarks`, `container_status`, `search_youtube`

### goose-desktop

| Item | Value |
| --- | --- |
| Address | `192.168.68.76`, same `/22` as gisiserver (`192.168.68.69/22` on `eno2`) |
| MAC | `d8:bb:c1:d2:29:df` |
| OS | Windows. Port 445 and 139 open, 22 and 3389 closed or filtered. Ollama's `modified_at` carries a Windows-style 7-digit fractional second. |
| Ollama | 0.32.14, bound `0.0.0.0:11434`, reachable from the LAN |
| Models present | `qwen2.5:7b` only — Q4_K_M, 7.6B params, `context_length` 32768, `capabilities: ["completion","tools"]` |
| Currently loaded | `qwen2.5:7b` resident in VRAM at `num_ctx` 4096, `expires_at` year 2318 (an effective `keep_alive: -1`) |
| GPU | RTX 3070, 8 GB VRAM |

Two facts that shape the whole design:

**The maverick container reaches ollama directly.** Verified from inside the container:
`fetch('http://192.168.68.76:11434/api/version')` returns `{"version":"0.32.14"}`. Bastion needs
an SSH-forward hop to reach this same endpoint (`promptsmith-hop.service`). gisiserver does not,
because it is on the same LAN segment. **Do not port the hop service.** It would add a failure
mode for nothing.

**There is no SSH into goose-desktop.** Port 22 times out, WinRM (5985/5986) is closed. Anything
installed on that machine is a hands-on step performed at the desktop. The spec is written so
that only section 6 and section 10 require physical access.

## 3. Target architecture

```
PWA / watch
    │
    ├── POST /api/chat            (SSE stream, new)
    ├── POST /api/device/chat     (JSON, unchanged contract)
    └── POST /api/device/transcribe
              │
              ▼
      maverick container (gisiserver, proxy net)
              │
    server/brain/index.js      agent loop: build → call → run tools → repeat
    server/brain/ollama.js     HTTP client, health probe, circuit breaker, serial queue
    server/brain/context.js    history assembly, token budget, rolling summary
    server/brain/gating.js     tool subset selection
    server/tools/registry.js   the 21 tools as plain functions + JSON Schema  ← single source of truth
              │
              ├─────────────────────────────► 192.168.68.76:11434  ollama /api/chat
              └─────────────────────────────► 192.168.68.76:9000   Whisper /asr
                                                    (both on the 3070)
```

`server/mcp-server.js` stops holding tool implementations and becomes a thin MCP adapter over
`server/tools/registry.js`. It stays in the tree. It costs nothing to keep, it makes the tools
reachable from a dev machine's `claude` CLI for debugging, and it means the registry has exactly
one definition of every tool rather than two that drift.

## 4. The VRAM budget

This is the governing constraint on every other decision, so it comes before the phases.

An RTX 3070 has 8 GiB. goose-desktop is a desktop, so the Windows compositor and whatever is on
screen hold roughly 0.6–1.0 GiB of that before Maverick asks for anything. Assume 7.0 GiB usable
and treat anything above it as a configuration error rather than bad luck.

`qwen2.5:7b` Q4_K_M weights are 4.36 GiB on disk and load at about that size. The KV cache is the
part that scales with the decision you make about context length. qwen2.5-7B has 28 layers, 4 KV
heads under GQA, and a head dimension of 128, which is 56 KiB per token at f16:

| `num_ctx` | KV cache, f16 | KV cache, `q8_0` |
| --- | --- | --- |
| 4096 (current) | 229 MiB | 115 MiB |
| 8192 | 458 MiB | 229 MiB |
| 16384 | 917 MiB | 459 MiB |
| 32768 | 1.79 GiB | 918 MiB |

The current 4096 is too small. Section 7's context budget needs roughly 4,000 tokens of prompt
before the model has said anything, and a calendar day or a Drive listing can add a thousand more.
A 4096 window will silently truncate mid-conversation and produce exactly the class of failure
that is hardest to diagnose: the model behaving as if it never saw the tool result.

**Target configuration:**

| Component | VRAM |
| --- | --- |
| `qwen2.5:7b` Q4_K_M weights | 4.36 GiB |
| KV cache, `num_ctx` 16384, `q8_0` | 0.45 GiB |
| Compute graph and buffers | ~0.6 GiB |
| Whisper `small`, faster-whisper `int8_float16` | ~0.7 GiB |
| **Total** | **~6.1 GiB** |

That leaves roughly 0.9 GiB of headroom against the 7.0 GiB working assumption. It is enough, and
it is not generous. Two consequences follow.

Quantized KV cache requires flash attention, so set `OLLAMA_FLASH_ATTENTION=1` and
`OLLAMA_KV_CACHE_TYPE=q8_0` as machine environment variables on goose-desktop. If either is
missing, ollama falls back to f16 KV and the 16K window costs 917 MiB instead of 459 MiB, which
eats the headroom.

Whisper `medium` at float16 is roughly 2.5 GiB and does not fit alongside the model. Do not reach
for it. If `small` proves insufficient for dictation accuracy, the escape hatch is
`distil-large-v3` at int8, roughly 1.5 GiB, which needs the KV cache dropped to `num_ctx` 8192 to
pay for itself. Measure before making that trade.

## 5. Phase 0 — baseline measurement

Do this first and record the numbers in `docs/BASELINE.md`. Every latency claim later in this
spec is a target, not a fact, and targets without a baseline are decoration.

Measure, five runs each, against the current Claude-backed deployment:

1. Wall-clock for `POST /api/chat` with `"what's on my calendar today"`.
2. Wall-clock for `POST /api/chat` with `"remind me to call the dentist tomorrow at 9"`.
3. Wall-clock for `POST /api/chat` with `"save a note: the boiler filter is 16x25x1"`.
4. Wall-clock for `POST /api/device/transcribe` with a 6-second WAV, split into the Whisper
   segment and the brain segment (log timestamps around the `fetch` to `cfg.whisperUrl`).
5. Peak RSS of the `maverick` container during a turn (`docker stats --no-stream`).

Also capture, verbatim, the replies to a set of ten representative prompts covering every tool
group in section 2. These become the regression corpus in section 11. The point is not that the
local model must match Sonnet's wording. The point is that it must call the same tools with the
same arguments.

## 6. Phase 1 — goose-desktop preparation

Hands-on at the machine. Nothing else in the spec works until this is done.

### 6.1 Availability

Under a hard cutover a sleeping goose-desktop means Maverick has no brain at all. This is the
single largest operational risk in the design and it is addressed here rather than in code.

At the desktop:

1. Set the Windows power plan so the machine never sleeps and never turns off disks.
2. Disable Fast Startup. It puts the NIC in a state where Wake-on-LAN does not fire after a
   shutdown, which makes the recovery path in 6.2 useless.
3. In Device Manager, on the network adapter's Power Management tab, clear "Allow the computer to
   turn off this device to save power" and set "Wake on Magic Packet" to enabled.
4. In BIOS/UEFI, enable Wake-on-LAN (often labelled "Power On by PCI-E" or "Resume by LAN").

### 6.2 Wake-on-LAN recovery from gisiserver

Belt and braces for the case where the machine sleeps or is shut down anyway.

```bash
sudo apt-get install -y wakeonlan
```

Add a systemd timer on gisiserver that probes `http://192.168.68.76:11434/api/version` every
60 seconds and, after two consecutive failures, sends a magic packet to `d8:bb:c1:d2:29:df` on the
broadcast address for `192.168.68.0/22`. Rate-limit the packets to one per five minutes so a
genuinely powered-off machine does not generate a broadcast storm. Log each wake attempt.

This is recovery, not the primary mechanism. If the timer is firing regularly, 6.1 was not done
correctly.

### 6.3 Ollama configuration

Set these as **machine** environment variables (System Properties → Environment Variables →
System variables), then restart the Ollama service so they take effect:

| Variable | Value | Why |
| --- | --- | --- |
| `OLLAMA_HOST` | `0.0.0.0:11434` | already set; confirm it survives the restart |
| `OLLAMA_KEEP_ALIVE` | `-1` | model stays resident. A cold load mid-turn is a multi-second stall. |
| `OLLAMA_FLASH_ATTENTION` | `1` | required for quantized KV cache |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | halves KV cache cost, per section 4 |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | a second model loading would exceed VRAM and evict the first |
| `OLLAMA_NUM_PARALLEL` | `1` | single user; parallel slots multiply the KV cache allocation |

`OLLAMA_NUM_PARALLEL` matters more than it looks. Ollama allocates KV cache per parallel slot, so
leaving it at the default multiplies the section 4 budget by the slot count and pushes the model
into partial CPU offload without saying so.

Verify from gisiserver after the restart:

```bash
curl -s http://192.168.68.76:11434/api/version
curl -s http://192.168.68.76:11434/api/tags | jq '.models[].name'
```

### 6.4 Model bake-off

`qwen2.5:7b` is the baseline: it is already resident, it is already proven for tool calling in
Promptsmith, and it advertises the `tools` capability. It is not automatically the right answer
for Maverick, whose turns are tool-heavy in a way Promptsmith's are not.

Pull the candidates and run the harness in section 11 against each. Record the results in
`docs/MODEL-BAKEOFF.md`:

- `qwen2.5:7b` (baseline)
- `qwen2.5:7b-instruct-q5_K_M` — better quality per token, roughly 5.4 GiB of weights, which
  forces `num_ctx` down to 8192. A real trade, worth measuring rather than assuming.
- `llama3.1:8b` — different tool-calling training, sometimes better at multi-tool turns
- One additional current 7–9B instruct model with a `tools` capability, chosen at build time.
  Check `ollama list` on the registry rather than trusting this document's date.

Score on three axes, in this order of importance:

1. **Tool-call correctness.** Did it call the right tool with the right arguments? This is
   pass/fail per prompt and it dominates. A model that writes beautiful prose and calls the wrong
   tool is useless here.
2. **Time to first token**, and total turn latency including tool round trips.
3. **Reply quality** against the Phase 0 corpus. Judged by hand, not scored.

Anything that cannot hold `num_ctx` 16384 within the section 4 budget is disqualified regardless
of how it scores.

## 7. Phase 2 — extract the tool registry

Mechanical, and it unblocks everything after it.

Create `server/tools/registry.js` exporting an array of tool objects:

```js
{
  name: 'schedule_reminder',
  group: 'memory',                    // for the gating in section 8
  description: '...',                 // see 8.3 — descriptions get rewritten
  schema: { type: 'object', properties: { ... }, required: [...] },
  handler: async (args, ctx) => { ... }   // ctx = { conversationId, now, tz }
}
```

Move each `case` body out of `mcp-server.js`'s `switch` into the matching `handler`. Do not change
behaviour in this phase. The `.env`-gated integrations keep failing closed exactly as they do now.

Then rewrite `server/mcp-server.js` to build its `TOOLS` array and its dispatch from the registry.
It should end up under 60 lines. Confirm the MCP path still works before moving on:

```bash
docker exec -it maverick sh -c \
  'echo "list my reminders" | claude -p --mcp-config /app/mcp-config.json --allowedTools mcp__maverick'
```

That check is only possible while the Claude CLI is still in the image, which is why this phase
comes before Phase 7's cleanup.

**Do not delete anything in this phase.** If a file stops being used, leave it. Deletion happens
in Phase 7, once the local path has soaked.

## 8. Phase 3 — the agent loop

The substance of the rework.

### 8.1 `server/brain/ollama.js`

Copy the structure from `/bastion/projects/promptsmith/src/ollama.js`. It is already the right
shape and it is already proven against this exact machine. What carries over:

- Health probe against `/api/tags` with a cached verdict, short TTL when up, longer when down
- Circuit breaker: a failed generation invalidates the cached "up" verdict
- Serial queue with a bounded depth, rejecting past the bound rather than hanging
- Fail-fast timeouts so a sleeping desktop costs one probe, not a 30-second stall

What changes for Maverick:

- `/api/chat` with a `tools` array, not the plain completions call Promptsmith makes
- Streaming enabled (section 9)
- `keep_alive: -1` and `options.num_ctx` set explicitly on every request. Ollama uses the model's
  default context if you omit `num_ctx`, and that default is not what section 4 budgeted for.

Request body shape:

```js
{
  model: OLLAMA_MODEL,
  stream: true,
  keep_alive: -1,
  tools: gatedTools,                  // section 8.3
  options: {
    num_ctx: 16384,
    temperature: 0.2,                 // tool-calling wants low, not zero
    top_p: 0.9,
    num_predict: 800
  },
  messages: [...]
}
```

Verify the tool-call message shape against the running ollama 0.32.14 rather than against this
document. As of that version an assistant turn that calls a tool returns
`{ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments } }] }`, and results
are fed back as `{ role: 'tool', content: '<string>', tool_name: '<name>' }`. Confirm whether
`tool_name` is required or optional on the version in front of you, and confirm that tool calls
arrive correctly when `stream: true`. If streamed tool calls prove unreliable on this version,
fall back to non-streamed requests for turns that carry tools and stream only the final
text-producing turn. That fallback is acceptable and should be recorded rather than worked around.

### 8.2 `server/brain/index.js` — the loop

```
1. Load history for conversation_id (section 8.4)
2. Resolve relative times deterministically (section 8.5)
3. Select the tool subset (section 8.3)
4. Call ollama
5. If the reply has tool_calls:
     for each: validate args against the schema, run the handler, truncate the result,
     append a role:'tool' message
     goto 4
6. Otherwise: persist the assistant message, stream it out, return
```

Hard limits, all of them non-negotiable:

| Limit | Value | Reason |
| --- | --- | --- |
| Tool-call rounds per turn | 6 | a 7B that starts looping will loop forever |
| Identical repeated calls | 3, then abort the round with a tool-error message | same tool, same arguments, observed failure mode |
| Wall clock per turn | 90 s | down from Claude's 120 s; local should be faster, and a longer ceiling only hides a hang |
| Tool result size | 1,500 tokens, truncated with an explicit `[truncated, N more rows]` marker | a Drive listing or a busy calendar day will blow the context otherwise |
| Tools per request | 8 | section 8.3 |

When a limit trips, return a plain reply saying what happened. Never return a silent empty string,
and never let the loop return a reply that claims a tool ran when it did not.

Argument validation before dispatch is required, not optional. A 7B will emit `entry_id` as a
string where the schema says number, omit required fields, and occasionally invent a parameter
name. Validate against the JSON Schema, coerce obvious type mismatches (numeric strings to
numbers, `"true"` to boolean), and on a genuine failure return the validation error to the model
as the tool result so it can retry. That retry loop is what makes a small model usable.

### 8.3 Tool gating

Sending all 21 tool schemas costs roughly 1,400–1,900 tokens and measurably degrades small-model
tool selection. Both problems are solved the same way.

Add `server/brain/gating.js`. Groups, matching section 2:

| Group | Tools |
| --- | --- |
| `core` (always included) | `save_memory`, `list_memories`, `schedule_reminder`, `list_reminders` |
| `calendar` | `list_calendars`, `list_calendar_events` |
| `mail` | `draft_email` |
| `timeclock` | `get_timesheet`, `propose_timesheet_change` |
| `tasks` | `list_tasks`, `add_task`, `complete_task`, `reschedule_task`, `ask_supervisor` |
| `workspace` | `list_drive_files`, `read_doc`, `read_sheet`, `read_slides` |
| `misc` | `list_bookmarks`, `container_status`, `search_youtube` |

Selection is a deterministic keyword match over the user's message, not a model call. A model call
would double the latency to save tokens, which is the wrong trade. Keep the keyword table in one
place and make it easy to extend.

Rules:

- `core` is always sent.
- Add at most two matched groups.
- Never exceed 8 tool schemas in one request. If a match would exceed it, keep the
  highest-scoring group.
- Once a turn has called a tool from a group, that group stays available for the rest of the turn
  even if a later round would not have matched it. Dropping a tool mid-turn strands the model.
- If nothing matches, send `core` alone.

The `tasks` group has five tools and will regularly be the only match. That is fine and inside the
cap.

Rewrite every tool `description` while you are here. The current descriptions were written for
Sonnet reading a long system prompt. Under this design the description is where the guidance
lives, because that is what the model sees next to the schema. `complete_task` should say to call
`list_tasks` first to get the id. `list_calendar_events` should explain `scope` in one sentence
rather than three. `propose_timesheet_change` should state, in the description, that it proposes
and does not apply.

### 8.4 History and context budget

The `--resume` session id is gone, so Maverick stores its own history.

```sql
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,      -- 'user' | 'assistant' | 'tool'
  content         TEXT NOT NULL DEFAULT '',
  tool_calls      TEXT,               -- JSON, assistant turns that called tools
  tool_name       TEXT,               -- role='tool'
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
```

`conversations` gains `summary TEXT` and `summary_upto INTEGER`. `better-sqlite3` has no
`ADD COLUMN IF NOT EXISTS`, so guard both with a `PRAGMA table_info(conversations)` check in
`db.js` the way any additive migration there should be written.

Leave `cc_session_id` in place. It becomes dead but harmless, and dropping a column in SQLite is a
table rebuild for no benefit.

Budget for `num_ctx` 16384:

| Segment | Budget |
| --- | --- |
| System prompt | ≤ 450 tokens (section 8.6) |
| Tool schemas | ≤ 600 tokens (8 tools, capped by 8.3) |
| Rolling summary | ≤ 400 tokens |
| Recent messages | ≤ 6,000 tokens, last 8 turns, oldest dropped first |
| Tool results this turn | ≤ 6,000 tokens, each one capped at 1,500 |
| Reserved for output | 800 tokens |

When recent messages exceed their budget, fold the oldest into the rolling summary with a single
cheap ollama call, update `summary_upto`, and drop them. Do this after the reply is sent, not
before it, so summarisation never sits in the user's latency path.

### 8.5 Resolve time in Node, not in the model

The current system prompt asks the model to compute ISO-8601 UTC instants from phrases like
"tomorrow at 9" and "an hour later". Sonnet does this reliably. A 7B does not, and the two places
it matters most are reminders that fire at the wrong time and timesheet proposals that are simply
wrong.

Take the arithmetic away from the model.

1. Before the first ollama call, run the user's message through a date parser (`chrono-node` is
   the obvious pick) with a reference time of now in `TZ`.
2. Inject any hits as an explicit block:
   `Resolved times: "tomorrow at 9" = 2026-08-25T14:00:00Z; "in two hours" = 2026-08-24T21:30:00Z`
3. Say once in the system prompt: use these values verbatim, do not recompute them.
4. In the `schedule_reminder` and `propose_timesheet_change` handlers, validate that `fire_at` and
   `new_value` parse as ISO-8601 and fall inside a plausible window. On failure, return the
   resolved candidates as the tool error so the model's retry has the right answer in front of it.

For timeclock deltas specifically, the `propose_timesheet_change` handler should accept a relative
form (`"+3600s"`, `"-30m"`) alongside an absolute instant and do the arithmetic itself against the
`old_value` it already has. Offering the model an option it cannot get wrong beats validating an
option it can.

### 8.6 The system prompt

The current prompt is roughly 1,300 tokens of dense per-tool guidance. It was written for a model
that reads all of it. Rewrite it to under 450 tokens containing only:

- Who the assistant is, and the voice rule (crisp, certain, short, never chatty). Keep this
  verbatim from the current prompt; it is good and it is cheap.
- Current time, timezone, and the resolved-times block from 8.5.
- Three hard rules: call the tool rather than claiming you did; never invent data you could fetch;
  say when you could not do something.
- The spaces list from the `spaces` table, unchanged.

Everything else moves into tool descriptions per section 8.3. If a piece of guidance does not
belong to a specific tool and is not one of the four bullets above, it does not go in the prompt.

## 9. Phase 4 — streaming

Maverick currently blocks for the whole turn and then delivers a complete reply. Under Claude that
was a 3–8 second silence. Streaming is the single biggest perceived-responsiveness change
available, and it only becomes possible once the brain is local.

- `POST /api/chat` becomes an SSE endpoint emitting `token`, `tool_start`, `tool_end`, `done`, and
  `error` events. `done` carries the `pending` array that the JSON response carries today, since
  the timeclock confirm UI depends on it.
- Emit `tool_start` and `tool_end` and render them in the PWA. Multi-round tool turns are the slow
  case, and showing "checking your calendar" is the difference between "slow" and "broken".
- `POST /api/device/chat` and `POST /api/device/transcribe` keep their current JSON contracts
  unchanged. The Zepp OS `httpRequest` relay is not worth teaching to speak SSE, and the watch
  reply is short enough that streaming buys little.
- Keep a non-streaming `POST /api/chat` path behind an `Accept: application/json` header so any
  client that has not been updated keeps working.

## 10. Phase 5 — Whisper on the 3070

Hands-on at goose-desktop, and the goal is to change as little of Maverick as possible.

The existing `onerahmet/openai-whisper-asr-webservice` contract is
`POST /asr?task=transcribe&language=en&output=json&encode=true`, multipart field `audio_file`,
response `{"text": "..."}`. `server/routes/device.js` speaks exactly that. If the GPU service
serves the same contract, the only application change is `WHISPER_URL`.

Two ways to get there. Determine which applies before writing anything.

**Option A, preferred if WSL2 is already installed.** Run the same image with GPU support:

```
docker run -d --restart unless-stopped --gpus all -p 9000:9000 \
  -e ASR_MODEL=small -e ASR_ENGINE=faster_whisper \
  -v whisper-cache:/root/.cache \
  onerahmet/openai-whisper-asr-webservice:latest-gpu
```

Identical contract, no custom code, and `ASR_ENGINE=faster_whisper` is what keeps the memory
figure in section 4 honest. Requires WSL2 with the NVIDIA container toolkit, which shares the GPU
with the native Ollama install without conflict.

**Option B, if WSL2 is not present and standing it up is unwelcome.** A native Python service:
`faster-whisper` plus a small FastAPI wrapper that reimplements the same `/asr` route, run under
NSSM or Task Scheduler as a service listening on `0.0.0.0:9000`. `ctranslate2` ships Windows CUDA
wheels, so this needs no WSL. It is perhaps 60 lines, and the wrapper must reproduce the query
parameters and the `{"text": ...}` response exactly, since that is the whole point.

Either way:

- Model `small`, compute type `int8_float16`. Section 4 has no room for `medium`.
- Allow the Windows Firewall inbound rule for TCP 9000, scoped to the local subnet.
- Set `WHISPER_URL=http://192.168.68.76:9000` in Maverick's `.env`.
- Remove the `whisper` service and the `whisper-cache` volume from `compose.yml`. That reclaims
  gisiserver CPU that 60-odd other containers can use.

If goose-desktop is unreachable, dictation returns the existing `502 stt_failed` and the watch's
Talk page shows its error state. That is the correct degraded behaviour and it needs no new code.

## 11. Phase 6 — verification

A harness, not a click-through. Put it at `test/harness.js` and make it runnable against either
brain so Phase 0's baseline and the local build are directly comparable.

### 11.1 Tool-call regression

Thirty fixed prompts, at least three per tool group in section 8.3, each with an expected tool name
and expected argument shape. The harness asserts the call, not the prose.

Include the failure cases explicitly, because they are where a 7B breaks:

- "push my clock-out an hour later" → `get_timesheet` then `propose_timesheet_change` with
  `new_value` exactly one hour after the fetched `clock_out`
- "remind me Thursday at 7am" → `schedule_reminder` with the correct instant, checked against the
  section 8.5 resolver rather than against a hardcoded date
- "what's going on at work tomorrow" → `list_calendar_events` with `scope: 'resource'`
- "mark the projector task done" → `list_tasks` then `complete_task` with an id from the listing,
  never an invented one
- A prompt matching no tool group → a plain reply with no tool call at all

**Gate: 28 of 30 must pass before cutover.** Record which two fail and why.

### 11.2 Latency

Same five measurements as Phase 0, same conditions. Report time-to-first-token separately from
total turn time, because streaming means the two now diverge and only one of them is what the user
feels.

### 11.3 Safety rails

- `propose_timesheet_change` writes a `pending_changes` row and does not call the timeclock API
- Confirming in the UI applies it; the model is nowhere in that path
- `draft_email` creates a draft and no message is sent
- With `ENABLE_DOCKER_TOOL=false`, `container_status` refuses
- With integration tokens blank, those tools fail closed rather than erroring loudly

### 11.4 Availability

- Ollama stopped on goose-desktop → `/api/chat` returns 503 with a readable body, the PWA shows a
  brain-offline state, and the app does not hang for 90 seconds
- Ollama restarted → the circuit breaker recovers within one probe TTL with no restart of the
  maverick container
- Confirm the WoL timer from 6.2 fires, and does not fire repeatedly against an awake machine

## 12. Phase 7 — cutover and cleanup

### 12.1 Soak

Run the local brain as the only brain for **seven days** with the Claude path still present in the
image but unreachable, gated behind `BRAIN_BACKEND=local|claude` defaulting to `local`. The flag is
the rollback lever during the soak window and nothing else. Do not route traffic through it, do not
build features on it, and do not let it become a hybrid by accident.

Log every turn: tool calls made, rounds used, latency, and whether a limit from section 8.2
tripped. Read the log at the end of the week. It is the evidence for whether Phase 7 proceeds.

### 12.2 Removal

Once the soak passes, Claude leaves:

- Delete `server/claude.js` and the `BRAIN_BACKEND` flag
- Drop `npm install -g @anthropic-ai/claude-code` and the `git` apt dependency from the Dockerfile.
  Both exist only for the CLI. The image gets smaller and builds faster.
- Remove the `./claude-config:/home/node/.claude` bind mount from `compose.yml`
- Remove `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, and `MAVERICK_MODEL` from `.env` and
  `.env.example`
- Keep `server/mcp-server.js` and `mcp-config.json`. Neither runs in production any more, and both
  stay useful for debugging the registry from a dev machine.
- Update `CLAUDE.md` and `README.md`. Both currently describe the Claude Code brain as the
  architecture, and a stale architecture doc is worse than none.

Tag the commit before removal so the Claude path stays recoverable from git rather than from a
dead code path in the image.

**Archive, do not delete, anything you are unsure about.** Move it to `_archive/` in the repo.

## 13. Configuration

New and changed in `.env` and `.env.example`:

```ini
# --- local brain (goose-desktop, RTX 3070) ---
OLLAMA_URL=http://192.168.68.76:11434
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_NUM_CTX=16384
OLLAMA_TEMPERATURE=0.2
OLLAMA_NUM_PREDICT=800

# probe / breaker (mirrors promptsmith)
PROBE_TIMEOUT_MS=2000
PROBE_UP_TTL_MS=15000
PROBE_DOWN_TTL_MS=30000
GEN_TIMEOUT_MS=90000
QUEUE_MAX=4

# agent loop limits
BRAIN_MAX_ROUNDS=6
BRAIN_MAX_TOOLS_PER_CALL=8
BRAIN_TOOL_RESULT_TOKENS=1500

# --- STT now on the GPU ---
WHISPER_URL=http://192.168.68.76:9000

# --- removed in Phase 7 ---
# CLAUDE_CODE_OAUTH_TOKEN=
# CLAUDE_CONFIG_DIR=
# MAVERICK_MODEL=
```

`server/config.js` gains a `brain` block following the existing `timeclock`/`bookmarks` pattern,
including the `get enabled()` idiom so the shape stays consistent with what is already there.

## 14. What gets worse

Stating this plainly because a hard cutover was chosen with the trade understood, and because
whoever reads this in six months should not have to rediscover it.

**Reasoning quality drops.** `qwen2.5:7b` is not `claude-sonnet-4-6`. Multi-step turns are where
the gap shows: "check my timesheet, push the clock-out an hour, and remind me to tell Pam" is one
turn to Sonnet and is likely to lose a step locally. Section 8.5's deterministic time resolution
and section 8.3's tool gating are both there to narrow the gap, and neither closes it. Expect to
phrase requests more simply, and expect to notice.

**Availability now depends on a desktop.** Claude is a service with uptime commitments.
goose-desktop is a machine in the house that can sleep, be shut down, be unplugged, or be running a
game that wants all 8 GiB of VRAM. Section 6 mitigates this and does not eliminate it. When
goose-desktop is down, Maverick has no brain.

**Long conversations degrade.** `--resume` handed session management to the CLI. The rolling
summary in 8.4 is a cruder mechanism, and a twenty-turn conversation will lose detail that Claude
would have kept.

**The tool surface is now something to maintain.** Ollama's tool-calling behaviour changes between
versions, and the notes in 8.1 about verifying the message shape are not boilerplate. Pin the
Ollama version on goose-desktop and treat upgrades as changes that need the section 11.1 harness
re-run, not as routine patching.

**Timeclock proposals need a validation layer that did not exist before.** Payroll arithmetic from
a 7B is not trustworthy on its own. The confirm-in-UI rail already means no model writes to the
timeclock, and section 8.5's handler-side arithmetic is what keeps a wrong proposal from reaching
the confirm button in the first place. Do not treat either as optional because the other exists.

## 15. Open questions for the operator

Answer these before Phase 1. Each one changes what gets built.

1. **Is WSL2 with Docker present on goose-desktop?** Decides Option A or Option B in section 10.
2. **Does that machine get used for anything that wants the GPU?** Gaming, video encode, or Stable
   Diffusion would evict the model and blow the section 4 budget. If so, section 4 needs revisiting
   with a smaller model or a smaller context.
3. **Is the 3070 the 8 GB card or the 8 GB Ti?** Both are 8 GB, so the budget holds either way, but
   confirm it is not a 12 GB 3080 that was described loosely. Twelve gigabytes would allow `num_ctx`
   32768 and Whisper `medium`, and section 4 would be rewritten.
4. **Should the WoL timer notify over ntfy when it fires?** A wake attempt is useful signal that
   6.1 did not stick. Opaque status only, per the standing rule about ntfy.
5. **Does the watch need a "brain offline" state of its own?** Today it would show a generic error.
   Under a hard cutover this state becomes more likely, and a specific message is cheap.

## 16. Order of work

| Phase | Depends on | Access needed |
| --- | --- | --- |
| 0 — baseline | nothing | gisiserver |
| 1 — goose-desktop prep | 0 | physical, at the desktop |
| 2 — tool registry | 0 | gisiserver |
| 3 — agent loop | 1, 2 | gisiserver |
| 4 — streaming | 3 | gisiserver |
| 5 — Whisper on GPU | 1 | physical, at the desktop |
| 6 — verification | 3, 4, 5 | gisiserver |
| 7 — cutover and cleanup | 6, plus a 7-day soak | gisiserver |

Phases 2 and 5 are independent of each other and of Phase 3's start. Phase 1 blocks the most, so do
it in the same visit as Phase 5 if that visit is inconvenient to repeat.
