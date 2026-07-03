<div align="center">

# Maverick

**A premium, single-user personal-assistant OS.**
Talk or type. It scopes your day by role, surfaces the one thing that matters *right now*,
and acts on your calendar, tasks, mail, and timeclock — from the web or your wrist.

`Web PWA` · `Desktop layout` · `Amazfit watch companion`
Built on the **Aureo** design language — editorial serif, a single goldenrod accent on warm black.

</div>

---

> **Voice:** crisp and certain, never chatty.
> **Naming:** the product is **Maverick** (`BRAND_NAME`); the visual system is **Aureo**.
> Set `BRAND_NAME=Aureo` to flip the wordmark everywhere.

## What it does

- **Assistant** — chat + live dictation (Web Speech API), powered by the Claude Code CLI with a custom MCP tool server.
- **Spaces / roles** — scope the whole app to one context (Teaching, Field Science, Robotics, …).
- **Calendar** — unified read-only view across multiple connected Google accounts (personal + work).
- **Tasks** — surfaced from an external task manager when connected.
- **Mail** — the assistant **drafts** emails on your accounts; it **never sends**.
- **Timeclock** — read + *propose* adjustments; you confirm in the UI. No LLM in the write path.
- **Memories + reminders** — saved notes and push reminders via ntfy.
- **Watch** — glance at the reactive lead / next event / tasks, and dictate to Maverick from an Amazfit Active 2.

> Health / nutrition / finance / sleep modules render in the Aureo design with **placeholder data** until a
> real source is wired in — they're intentionally stubbed.

## Architecture

```
server/            Node/Express backend
  claude.js          spawns `claude -p` per turn; injects current time+TZ into the system prompt
  mcp-server.js      custom MCP tool server (memories, reminders, calendar, mail, timeclock, tasks…)
  google/            Google OAuth + read-only Calendar / draft-only Gmail wrappers
  integrations/      timeclock · bookmarks · charliework · docker — read-mostly, fail-closed when unset
  routes/            REST API for the PWA
public/            Installable PWA frontend (mobile-first, responsive desktop, service worker)
watch/             Zepp OS Mini Program for the Amazfit Active 2 (466×466 circular)
watch-face/        Companion Zepp OS watch face
compose.yml        Docker stack (app + self-hosted Whisper STT, on the `proxy` network)
Dockerfile         Node 22 + Claude Code CLI
.env.example       Configuration template — copy to .env
CLAUDE.md          Architecture + gotchas, for AI agents / future maintainers
```

**Brain.** Every chat turn spawns the Claude Code CLI (`claude -p`) with the MCP tool server attached.
Conversation continuity is a stored CC session id per conversation. The model is set by `MAVERICK_MODEL`.

**Auth.** Login is Google OAuth, restricted to the email(s) in `ALLOWED_GOOGLE_EMAILS` (identity only).
A separate offline-consent "connect account" flow grants read Calendar + draft Gmail per account; refresh
tokens are stored server-side. Both flows share one registered redirect URI, disambiguated by OAuth `state`.

**Safety rails.** Gmail is `gmail.compose` (drafts) — `messages.send` is never called. Timeclock writes go to
a pending-changes table and only apply on an explicit user confirm in the UI. Optional integrations fail closed
when their env vars are blank.

## Run

```bash
cp .env.example .env      # fill in your secrets
docker compose up -d --build
```

Then open the site, sign in with the allowed Google account, and connect Gmail/Calendar from
**Settings → Connected accounts** (`/connect/google?account=personal`).

The watch app builds separately with the Zepp OS **Zeus CLI** — see [`watch/README.md`](watch/README.md).

## Configuration

All configuration is environment-driven; see [`.env.example`](.env.example) for the full list. Highlights:

| Variable | Purpose |
| --- | --- |
| `BRAND_NAME` | Wordmark — `Maverick` (default) or `Aureo`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app (login + connected accounts). |
| `ALLOWED_GOOGLE_EMAILS` | Comma-separated allow-list for login. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code subscription auth for the brain. |
| `MAVERICK_MODEL` | Model id (default `claude-sonnet-4-6`). |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | Push reminders. |
| `AGENT_API_TOKEN`, `BOOKMARKS_AGENT_TOKEN`, `CHARLIEWORK_*` | Optional integrations (blank = disabled). |
| `DEVICE_TOKEN` | Pairs the watch to `POST /api/device/chat`. |

## Security & privacy

Single-user by design and gated to one Google email. **No secrets or personal data are committed** —
`.env`, `claude-config/`, `data/`, `_design/`, and `watch/config.js` are all gitignored, and secrets live
only in your local `.env`. Self-hosted Whisper handles watch dictation, so audio never leaves the server.

## License

See [`LICENSE`](LICENSE). This is a personal project shared for reference — no support or warranty implied.
