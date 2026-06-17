# Maverick

A premium personal-assistant OS — mobile-first web app, desktop layout, and an Amazfit watch
companion. Talk or type to it; it scopes your day by **role/space**, surfaces the one thing that
matters *right now*, and can act on your calendar, tasks, mail (drafts), and timeclock.

Built on the **Aureo** design language: editorial serif moments, a single goldenrod accent on warm
black, quiet sage for "all good". Voice: crisp and certain, never chatty.

> Product name is **Maverick** (`BRAND_NAME`); the visual system is Aureo. Set `BRAND_NAME=Aureo`
> to use the original wordmark.

## What's here

```
server/            Node/Express backend (Claude Code brain + MCP tools, Google APIs, integrations)
public/            Installable PWA frontend (mobile-first, responsive desktop, service worker)
watch/             Zepp OS Mini Program for the Amazfit Active 2 (466×466 circular)
compose.yml        Docker stack (container `maverick` on the `proxy` network)
Dockerfile         Node 22 + Claude Code CLI
.env.example       Configuration template (copy to .env)
CLAUDE.md          Architecture + gotchas for AI agents / future me
```

## Features (current)

- **Assistant** — chat + live dictation (Web Speech API), powered by Claude Code with MCP tools.
- **Spaces / roles** — scope the whole app to a context (Teaching, Field Science, Robotics, …).
- **Calendar** — unified view across connected Google accounts (personal + work).
- **Tasks** — surfaced from the charliework task manager (when connected).
- **Mail** — the assistant **drafts** emails on your accounts (never sends).
- **Timeclock** — read + *propose* adjustments; you confirm in the UI (no LLM in the write path).
- **Memories + reminders** — saved notes and ntfy push reminders.
- **Watch** — glance at the reactive lead / next event / tasks, and dictate to Maverick on the wrist.

Health / nutrition / finance / sleep modules render in the Aureo design with placeholder data until
a real data source is connected — they're intentionally stubbed.

## Run

```bash
cp .env.example .env      # fill in secrets
docker compose up -d --build
```

Then visit the site, sign in with the allowed Google account, and connect Gmail/Calendar from
Settings → Connected accounts (`/connect/google?account=personal`).

## Privacy

Single-user by design and gated to one Google email. Secrets live only in `.env` (gitignored).
No personal data is committed to this repo.
