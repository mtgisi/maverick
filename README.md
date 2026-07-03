<div align="center">

# Maverick

**A single-user personal-assistant OS.**
Talk or type to it. It scopes your day by role, surfaces the one thing that matters *right now*,
and acts on your calendar, tasks, mail, and timeclock from either the web or your wrist.

`Web PWA` · `Desktop layout` · `Amazfit watch companion`
Built on the Aureo design language: editorial serif, one goldenrod accent on warm black.

</div>

---

> **Naming.** The product is **Maverick** (`BRAND_NAME`) and the visual system is **Aureo**.
> `BRAND_NAME` sets the wordmark, so a fork can carry whatever name you give it.
> **Voice.** The assistant stays crisp and certain, never chatty.

## What it does

- **Assistant.** Chat and live dictation (Web Speech API), driven by the Claude Code CLI behind a custom MCP tool server.
- **Spaces.** Define your own contexts (Work, Personal, a side project) and scope the whole app to one. You add, rename, recolor, and remove them in the app, and the assistant tags what it saves by space.
- **Calendar.** A unified read-only view across several connected Google accounts, personal and work.
- **Tasks.** Pulled from an external task manager when one is connected.
- **Mail.** The assistant drafts email on your accounts and never sends.
- **Timeclock.** It reads your hours and proposes adjustments. You confirm each one in the UI, and no model sits in the write path.
- **Memories and reminders.** Saved notes, plus push reminders over ntfy.
- **Watch.** Glance at the current lead, the next event, and your tasks, or dictate to Maverick from an Amazfit Active 2.

> Health, nutrition, finance, and sleep modules render in the Aureo design with **placeholder data**
> until you wire a real source in. They are stubbed on purpose.

## Architecture

```
server/            Node/Express backend
  claude.js          spawns `claude -p` per turn; injects current time+TZ into the system prompt
  mcp-server.js      custom MCP tool server (memories, reminders, calendar, mail, timeclock, tasks…)
  google/            Google OAuth + read-only Calendar / draft-only Gmail wrappers
  integrations/      timeclock · bookmarks · charliework · docker: read-mostly, fail-closed when unset
  routes/            REST API for the PWA
public/            Installable PWA frontend (mobile-first, responsive desktop, service worker)
watch/             Zepp OS Mini Program for the Amazfit Active 2 (466×466 circular)
watch-face/        Companion Zepp OS watch face
compose.yml        Docker stack (app + self-hosted Whisper STT, on the `proxy` network)
Dockerfile         Node 22 + Claude Code CLI
.env.example       Configuration template; copy to .env
CLAUDE.md          Architecture and gotchas, for AI agents and future maintainers
```

**Brain.** Every chat turn spawns the Claude Code CLI (`claude -p`) with the MCP tool server attached.
Continuity comes from a stored CC session id per conversation, and `MAVERICK_MODEL` picks the model.

**Auth.** Login is Google OAuth, restricted to the email(s) in `ALLOWED_GOOGLE_EMAILS`, and covers identity
only. A separate offline-consent flow connects Gmail and Calendar per account and stores refresh tokens
server-side. Both flows share one registered redirect URI and are told apart by the OAuth `state` value.

**Safety rails.** Gmail access is limited to `gmail.compose`, which drafts but never sends. Timeclock edits
land in a pending-changes table and apply only when you confirm them in the UI. Optional integrations fail
closed whenever their env vars are blank.

## Run

```bash
cp .env.example .env      # fill in your secrets
docker compose up -d --build
```

Open the site, sign in with an allowed Google account, then connect Gmail and Calendar under
**Settings → Connected accounts** (`/connect/google?account=personal`).

The watch app builds separately with the Zepp OS **Zeus CLI**. See [`watch/README.md`](watch/README.md).

## Configuration

Everything is environment-driven. The full list lives in [`.env.example`](.env.example); the ones worth knowing:

| Variable | Purpose |
| --- | --- |
| `BRAND_NAME` | Wordmark. `Maverick` by default, or any name you set. |
| `OWNER_NAME` | Whose assistant this is. Blank makes it address you generically as "you". |
| `DEFAULT_SPACES` | Comma-separated starter spaces, seeded on first run. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app for login and connected accounts. |
| `ALLOWED_GOOGLE_EMAILS` | Comma-separated allow-list for login. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code subscription auth for the brain. |
| `MAVERICK_MODEL` | Model id (default `claude-sonnet-4-6`). |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | Push reminders. |
| `AGENT_API_TOKEN`, `BOOKMARKS_AGENT_TOKEN`, `CHARLIEWORK_*` | Optional integrations; blank disables them. |
| `DEVICE_TOKEN` | Pairs the watch to `POST /api/device/chat`. |

## Security and privacy

Maverick is single-user by design and gated to one Google email. No secrets or personal data are committed:
`.env`, `claude-config/`, `data/`, `_design/`, and `watch/config.js` are all gitignored, and secrets stay in
your local `.env`. Watch dictation runs through a self-hosted Whisper instance, so audio never leaves the server.

## License

MIT. See [`LICENSE`](LICENSE). This is a personal project shared for reference, with no support or warranty implied.
