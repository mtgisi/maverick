# Baseline: maverick on the Claude Code brain

**Measured:** 2026-08-23 on gisiserver, against the live deployment.
**Harness:** `test/baseline.sh` (re-runnable against the local brain for the phase 6
comparison; same endpoint, same prompts, so the numbers stay comparable).
**Method:** whole turns through `POST /api/device/chat`. That is the same
`claude.run()` call the web chat makes, without the Google session gate. Fresh
`conversation_id` per run, so no `--resume` history growth is being measured.

Configuration under test: `MAVERICK_MODEL=claude-sonnet-4-6`, MCP stdio tool server,
`maverick-whisper` with `ASR_MODEL=base` on gisiserver CPU.

## 1. Turn latency

Five runs per prompt.

| Prompt | min | median | mean | max |
| --- | --- | --- | --- | --- |
| "what's on my calendar today" | 11.48 s | 15.55 s | 15.43 s | 17.68 s |
| "remind me to call the dentist tomorrow at 9" | 11.77 s | 12.92 s | 13.77 s | 15.63 s |
| "save a note: the boiler filter is 16x25x1" | 12.05 s | 12.33 s | 13.25 s | 15.88 s |

**This is the headline number and it is worse than expected.** LOCAL-BRAIN-SPEC section 9
assumed the current blocking turn was "a 3 to 8 second silence". It is 12 to 18 seconds,
roughly double, and the floor across every prompt is about 11.5 s. A single-tool turn that
saves one note costs 12 seconds.

The floor matters more than the spread. Even the cheapest possible turn pays Node startup,
CLI startup, MCP subprocess spawn, and a round trip to Anthropic before any token exists.
No amount of prompt tuning moves an 11.5 s floor.

## 2. Voice turn latency

### STT segment alone

`POST /asr` directly against `maverick-whisper`, 5.3 s of 16 kHz mono WAV.

| Run | Time |
| --- | --- |
| 1 (cold, model load) | 12.52 s |
| 2 | 1.88 s |
| 3 | 1.63 s |
| 4 | 3.23 s |
| 5 | 1.54 s |

Warm CPU Whisper `base` runs 1.5 to 3.2 s for 5.3 s of audio. That is roughly 0.3x
realtime and it is **not** the bottleneck. Worth recording, because the plan moves this to
the GPU and the honest expected gain there is one to two seconds, not ten.

The 12.5 s cold run is a model load into an empty cache. It recurs after any container
restart, so the first dictation after a redeploy is always slow.

### Full voice turn

`POST /api/device/transcribe`, same audio, STT plus brain end to end.

| Run | Time |
| --- | --- |
| 1 | 22.71 s |
| 2 | 16.78 s |
| 3 | 20.45 s |

**16.8 to 22.7 seconds from end-of-speech to reply.** Subtracting warm STT, the brain is
15 to 20 s of that. Hands-free conversation is not possible at this latency; this is the
number that has to move for ask 1 and ask 4 to be worth building.

## 3. Memory

`docker stats` sampled at 1 s during a turn.

| State | Memory |
| --- | --- |
| Idle | 337.6 MiB |
| Peak during turn | 612.1 MiB |
| After turn | 337.6 MiB |

The ~275 MiB delta is the `claude` CLI Node process plus the MCP stdio subprocess, spawned
and torn down per turn. The cutover removes both, so the post-cutover container should sit
near the idle figure with a much smaller per-turn delta.

## 4. Targets

Derived from the above, not from the source spec's assumptions.

| Metric | Now | Target after cutover |
| --- | --- | --- |
| Time to first token, simple turn | n/a (no streaming) | < 1.5 s |
| Total turn, single tool | 12.3 s median | < 4 s |
| Total turn, multi-round tool | 15.6 s median | < 8 s |
| Full voice turn, end-of-speech to first audio | 16.8 s best | < 3 s |
| Peak container memory per turn | 612 MiB | < 420 MiB |

Time to first token and total turn diverge once streaming lands. Only the first is what a
conversation actually feels like, so both get reported separately from phase 5 onward.

## 5. Defects found while measuring

### 5.1 Both Google accounts have been dead since 2026-06-24

Every calendar run returned an authentication error rather than events:

```
{"connected":true,"calendars":[{"error":"calendars personal: invalid_grant"},
                               {"error":"calendars work: invalid_grant"}]}
```

`google_accounts` shows both rows last refreshed **2026-06-24**, two months ago. maverick
went live 2026-06-17. That is a seven-day gap, which is the exact signature of an OAuth
consent screen still in **Testing** publishing status: Google expires refresh tokens for
testing-mode apps after seven days.

Consequence: calendar, Drive, Docs, Sheets, Slides and Gmail drafting have all been failing
since June. The failures are soft (the tool returns an error string and the assistant
explains it), which is why it went unnoticed.

Fix is two parts, and doing only the second means it breaks again in a week:

1. In Google Cloud Console, move the OAuth consent screen to **In production**.
2. Reconnect both accounts at `/connect/google?account=personal` and `?account=work`.

### 5.2 `gmail.readonly` is already granted

Correction to `docs/OVERHAUL-PLAN.md` section 9, which assumed mail scanning needed a new
scope and a re-consent. Both accounts already carry:

```
gmail.readonly  gmail.compose  calendar.readonly  calendar.events.readonly
drive.readonly  documents.readonly  spreadsheets.readonly  presentations.readonly
```

The scope is present; the code simply never uses it. `server/google/client.js` implements
`listEvents` and `createDraft` only. So phase 11 is additive code against an existing grant,
not a consent flow. It still gates behind `MAIL_READ_ENABLED=false` by default.

## 6. Reproducing

```bash
cd /gisiserver/infra/docker/maverick
export BASE="http://$(docker inspect maverick --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):3000"
export DEVICE_TOKEN=$(grep -m1 '^DEVICE_TOKEN=' .env | cut -d= -f2-)
./test/baseline.sh 5
```

The prompt set is fixed. Changing a prompt invalidates the comparison against this file.

**The write prompts create real rows.** This run produced 8 reminders and 5 memories, all
of which were deleted afterward by id. Any re-run must do the same, or the reminder poller
will fire the pushes.
