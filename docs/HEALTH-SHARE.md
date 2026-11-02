# Health log and the accountability-bot share

Added 2026-11-02. Maverick keeps a daily health log, and a read-only API hands one day's
totals to the accountability Discord bot (`/gisiserver/infra/docker/accountability-bot`),
which posts them to a close-friends server.

## Logging

Three ways in, all writing `health_entries` through `server/services/health.js`:

- **Chat or voice**: tools `log_health`, `health_today`, `undo_health_log` (group `health`).
  "Log 650 calories and 40 grams of protein", "I lifted for 45 minutes", "slept 7 hours",
  "undo that".
- **PWA**: Home, then the Health card. A form, today's entries with delete, and a line
  showing exactly what the bot receives.
- **REST** (Google session): `GET /api/health/day/:day`, `POST /api/health/log`,
  `DELETE /api/health/entries/:id`.

Roll-up: calories, protein and water **add**; steps, sleep and weight **replace** (last
entry wins); a workout or habit logged once counts as done. Totals are computed in code and
returned in tool results; the model never adds numbers itself. Entries are soft-deleted.
Writes are limited to today and the previous 14 days; implausible values (6,500 kcal in
one entry, 40 h sleep) are refused.

## The share API

| | |
|---|---|
| Listener | `server/share.js`, a separate Express app, `172.28.0.2:3001` |
| Network | `maverick-share` (`172.28.0.0/29`, `internal: true`): maverick and the bot only |
| Route | `GET /api/day/YYYY-MM-DD`, plus `GET /healthz`. Nothing else is mounted |
| Auth | `Authorization: Bearer <token>`. maverick's `.env` holds only `SHARE_TOKEN_SHA256` |
| Plaintext token | `share-token.secret` in this repo dir (0600, gitignored). Goes in the bot's `.env` as `SOURCE_TOKEN` |

Why each layer exists:

1. **Not on the internet.** Caddy proxies `:3000` only. The share listener binds to the
   share-network address and refuses `0.0.0.0`, so containers on `proxy` and machines on
   the LAN cannot open a socket to it. If the network is missing, the API is off rather
   than exposed.
2. **Token.** Compared as SHA-256 digests with `timingSafeEqual`. Header only; a token in
   a query string is rejected, so it never lands in a log line.
3. **Allowlisted payload.** `health.sharedView()` builds the response field by field.
   Entry sources, timestamps and ids never leave. Raw body weight leaves only with
   `HEALTH_SHARE_WEIGHT=true`; by default friends see "weigh-in logged", not the number.
   Adding a field to the summary does not add it to the share.
4. **Bounded.** Read-only, 60 requests a minute, dates from the first-ever entry to today.
   A day before tracking began returns 404, so the bot shows "no data" rather than a row
   of failures.

**On encryption.** The bot and maverick run on the same host, so a request crosses a
kernel bridge and never a physical network. TLS would protect a wire that does not exist.
If the bot ever moves off gisiserver, this stops being true: put the API behind TLS
(Caddy with a client certificate, or WireGuard) before moving it. The exposure that does
exist is **Discord**: anything the bot posts is stored by Discord and readable by everyone
in that server. The allowlist in `sharedView()` is the control for what reaches it.

### Payload

```json
{
  "date": "2026-11-02",
  "updated_at": "2026-11-02 18:42:57",
  "workout":   { "completed": true, "sessions": 1, "minutes": 45, "activities": ["lifting"] },
  "nutrition": { "calories": 1750, "protein_g": 40, "water_oz": null },
  "activity":  { "steps": 9100 },
  "sleep":     { "hours": null },
  "weighin":   { "logged": true },
  "habits":    { "meditate": true }
}
```

`null` means not logged, which is not the same as zero. `workout.completed` and
`weighin.logged` are `false` when nothing was logged, because with manual logging no entry
means it did not happen. In the bot's `metrics.yml`, a habit maps as
`source_field: habits.meditate`.

## Wiring the bot

Bot `.env`:

```
SOURCE_MODE=pull                 # or leave auto; pull wins when configured
SOURCE_BASE_URL=http://172.28.0.2:3001
SOURCE_TOKEN=<contents of maverick/share-token.secret>
```

Bot `compose.yml`, alongside whatever network gives it internet access for Discord:

```yaml
    networks:
      - default
      - maverick-share
networks:
  maverick-share:
    external: true
```

Rotate the token: write a new random value to `share-token.secret`, put its SHA-256 in
maverick's `SHARE_TOKEN_SHA256`, `docker compose up -d maverick`, update the bot's
`SOURCE_TOKEN`, restart the bot.

## Tests

`docker exec maverick node /app/test/health.test.js`: roll-up rules, limits, undo,
gating, and the share API over HTTP (auth, payload allowlist, 404s, no write verbs, refusal
to bind `0.0.0.0`).
