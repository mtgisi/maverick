# Maverick — personal assistant OS

Mobile-first personal-assistant web app + watch companion, at `maverick.matthewgisi.com`,
Google-SSO gated to a single email. Brand/visual language = **Aureo** (dark editorial, goldenrod
on warm black). Product name = **Maverick** (set via `BRAND_NAME`, default "Maverick").

**Generic / reusable**: nothing is hardcoded to one owner. `OWNER_NAME` (blank = generic "you")
names the assistant's owner in the system prompt. **Spaces are user-defined** — a `spaces` table
(CRUD at `/api/spaces`) seeded on first run from `DEFAULT_SPACES`; the UI, chip filters, colors,
demo data, and the agent's memory-tagging all read that table dynamically. No topics are baked in.

Successor to the `jarvis` POC — same architecture (Claude Code CLI brain + MCP tools), broader scope.
**It does NOT touch jarvis or any other app's files** — it duplicates the pattern into its own stack
so it can be deleted cleanly. Optional integrations (timeclock, bookmarks, charliework, docker) are
read-mostly clients gated by env vars; they fail closed when unset.

## Stack
- Node/Express, SQLite (`better-sqlite3`), `public/` PWA frontend. Port 3000 (Caddy-proxied).
- **Brain = Claude Code CLI** (`claude -p`, subscription auth via shared `CLAUDE_CODE_OAUTH_TOKEN`,
  shared with cranium/jarvis — safe, static token) + custom **MCP tool server** (`server/mcp-server.js`).
- Model = `MAVERICK_MODEL` (default `claude-haiku-4-5`, cheap).
- Container `maverick` on `proxy` net; Caddy block sends `X-Forwarded-Proto https` for secure cookies.

## How a turn works
`POST /api/chat {conversation_id, message}` → `server/claude.js` spawns
`claude -p --mcp-config mcp-config.json --allowedTools mcp__maverick --resume <session>`.
Current time+TZ injected into the system prompt every call (so Haiku reliably calls time-relative tools).
Conversation continuity = stored CC `session_id` per conversation.

## MCP tools (`server/mcp-server.js`)
- `save_memory` / `list_memories` — maverick SQLite.
- `schedule_reminder` / `list_reminders` — ntfy push at fire_at (30s poller in index.js).
- `get_timesheet` / `propose_timesheet_change` — timeclock agent API; **propose-only**, confirmed in UI.
- `list_calendar_events` — Google Calendar across connected accounts (read).
- `draft_email` — creates a **Gmail draft** (never sends) on a connected account.
- `list_tasks` / `add_task` — charliework task manager (if `CHARLIEWORK_API_URL` set).
- `list_bookmarks` — Powermark (if `BOOKMARKS_AGENT_TOKEN` set).
- `container_status` — read-only `docker ps` summary (only if `ENABLE_DOCKER_TOOL=true` + socket mounted).
- `log_health` / `health_today` / `undo_health_log` - daily health log. Plain statements and "undo that" are
  parsed in code (`services/health-parse.js`) because qwen2.5:7b claims writes it never made; a guard in
  `brain/index.js` replaces any remaining false "logged". Read-only share for the accountability Discord bot on
  an internal-only network: see `docs/HEALTH-SHARE.md`.

## Auth
- **Login** = Google OAuth (`passport-google-oauth20`), callback `/auth/callback`, restricted by
  `ALLOWED_GOOGLE_EMAILS`. Identity only (profile/email).
- **Connect account** (for Gmail/Calendar APIs) = separate offline-consent flow, ALSO through
  `/auth/callback` (only one redirect URI is registered) distinguished by OAuth `state=connect:<label>`.
  Stores refresh tokens per Google account in the `google_accounts` table. See `server/google/`.
- `requireAuth` checks `req.originalUrl` (not `req.path` — `app.use('/api',...)` strips the prefix).

## Google API backend (`server/google/`)
- `oauth.js` — builds connect URLs, handles the connect callback, stores/refreshes tokens.
- `client.js` — googleapis wrappers: `listEvents`, `createDraft` (draft-only by design). Auto-refresh.
- Scopes: `userinfo.email/profile`, `calendar.events.readonly` + `calendar.readonly`,
  `gmail.compose` (drafts). We deliberately never call `messages.send`.
- Wire-up: complete the per-account consent at `/connect/google?account=personal|work` once logged in.

## Watch (Amazfit Active 2 · Zepp OS)
`watch/` is a Zepp OS Mini Program (466×466 circular, touch-first; physical buttons = system nav).
5 pages: Now (reactive lead) · Next event · Quick log · Tasks · Talk. Dictation posts to
`POST /api/device/chat` with header `X-Device-Token: $DEVICE_TOKEN`. Build/preview with Zeus CLI
(`zeus dev` / `zeus preview`). See `watch/README.md`.

## Deploy
```
cd /gisiserver/infra/docker/maverick && docker compose up -d --build
docker compose logs -f --tail 50
```
Caddyfile edits: validate + **restart** caddy (single-file mount can no-op a reload).

## Git
Own private repo `mtgisi/maverick`. Local commits are fine to push (authorized for THIS repo only).
`.env`, `/data`, `/claude-config`, `_design/`, `*.zip` are gitignored.

## Notes / gotchas (inherited from jarvis)
- ntfy header values must be latin1 — no emoji in Title/Tags headers (emoji goes in the body).
- ntfy is deny-all per-topic; reminders use topic `NTFY_TOPIC` (currently `jarvis`; make a `maverick`
  topic + ACL later). Phone must be subscribed to that topic.
- Confirm-before-apply for any timeclock write: the agent only writes `pending_changes`; the real
  PATCH happens on user Confirm in the UI (no LLM in the write path).
- PII: keep it out of committed code (it's gated by env). Brand strings are safe/public.
