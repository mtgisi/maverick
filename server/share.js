// Read-only health share for the accountability Discord bot.
//
// This is a SECOND Express app on its own listener, not a route on the main one. The main
// app on :3000 is what Caddy publishes to the internet; this one never appears there, so
// there is no public URL to probe and no way for a bug in the main app's auth ordering to
// expose it. Four layers, each sufficient to stop a different attacker:
//
//   1. Bind address. Listens ONLY on maverick's address on the `maverick-share` docker
//      network (internal: true, no egress, no published port). Containers on the shared
//      `proxy` network and the LAN cannot open a socket to it at all.
//   2. Bearer token, compared as SHA-256 digests in constant time. Only the digest is in
//      maverick's env.
//   3. One verb, one route, an allowlisted payload (health.sharedView). It cannot write,
//      and it cannot return anything except the day's health numbers: no calendar, mail,
//      memories, notes, or chat, because none of those modules are reachable from here.
//   4. Dates bounded to tracking start .. today, plus a request-rate ceiling.
//
// Traffic between the two containers crosses a kernel bridge on this host and never a wire,
// which is why this is plain HTTP. See docs/HEALTH-SHARE.md.

const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const health = require('./services/health');

const RATE_PER_MIN = 60;
const HISTORY_DAYS = 400;

function tokenOk(header) {
  const want = cfg.share.tokenSha256;
  if (!/^[0-9a-f]{64}$/.test(want)) return false;
  const m = /^Bearer\s+(\S+)$/.exec(header || '');
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1]).digest();
  return crypto.timingSafeEqual(got, Buffer.from(want, 'hex'));
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // Fixed-window rate limit. One client exists; anything near this ceiling is a loop or
  // someone who should not be here.
  let windowStart = Date.now(), count = 0;
  app.use((req, res, next) => {
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; count = 0; }
    if (++count > RATE_PER_MIN) return res.status(429).json({ error: 'rate_limited' });
    next();
  });

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!tokenOk(req.get('Authorization'))) {
      console.warn(`[share] 401 ${req.method} ${req.path} from ${req.socket.remoteAddress}`);
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // GET /api/day/YYYY-MM-DD  (the bot's default source_path)
  app.get('/api/day/:date', (req, res) => {
    const day = req.params.date;
    const today = health.dayInTZ();
    if (!health.isDay(day)) return res.status(400).json({ error: 'bad_date' });
    if (day > today || day < health.addDays(today, -HISTORY_DAYS)) return res.status(404).json({ error: 'out_of_range' });
    // Before the first-ever entry there is no data, which is different from a day of misses.
    if (!health.trackingStarted(day)) return res.status(404).json({ error: 'no_data' });
    res.json(health.sharedView(day, { shareWeight: cfg.share.shareWeight }));
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

function start() {
  const { bind, port, tokenSha256 } = cfg.share;
  if (!bind) { console.log('[share] SHARE_BIND unset: health share API disabled'); return null; }
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) {
    console.error('[share] SHARE_TOKEN_SHA256 missing or not a sha256 hex digest: health share API disabled');
    return null;
  }
  // Never 0.0.0.0. Refusing to fall back is the point: if the share network is missing, the
  // API is off, not exposed on every interface.
  if (bind === '0.0.0.0' || bind === '::') {
    console.error('[share] refusing to bind the share API to all interfaces');
    return null;
  }
  const server = buildApp().listen(port, bind, () => console.log(`[share] health share API on ${bind}:${port}`));
  server.on('error', e => console.error(`[share] could not listen on ${bind}:${port}: ${e.message} (API disabled)`));
  return server;
}

module.exports = { start, buildApp, tokenOk };
