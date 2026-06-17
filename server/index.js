const path = require('path');
const express = require('express');
const session = require('express-session');
const { passport, requireAuth } = require('./auth');
const db = require('./db');
const ntfy = require('./ntfy');
const cfg = require('./config');
const goauth = require('./google/oauth');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET required in production');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000,
  },
}));
app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => { console.log(`[req] ${req.method} ${req.originalUrl} authed=${req.isAuthenticated && req.isAuthenticated()}`); next(); });

app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- Device API (watch) — token-auth, NOT behind the Google session gate ---
app.use('/api/device', require('./routes/device'));

// --- Login (Google identity) ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// Shared callback: the "connect an account" flow (state=connect:*) is handled here BEFORE passport,
// since only one redirect URI is registered with Google.
app.get('/auth/callback', (req, res, next) => {
  if (goauth.isConnectState(req.query.state)) {
    return goauth.handleConnectCallback(req.query.code, req.query.state)
      .then(({ label }) => res.redirect('/?connected=' + encodeURIComponent(label)))
      .catch(err => { console.error('[connect]', err.message); res.redirect('/?connect_error=1'); });
  }
  return next();
}, passport.authenticate('google', { failureRedirect: '/login?error=1' }), (req, res) => res.redirect('/'));

app.get('/auth/logout', (req, res, next) => req.logout(err => err ? next(err) : res.redirect('/login')));

// --- Connect a Google account for Gmail/Calendar (requires being logged in) ---
app.get('/connect/google', requireAuth, (req, res) => {
  const account = (req.query.account || 'personal').toString();
  res.redirect(goauth.buildConnectUrl(account));
});
app.post('/connect/google/disconnect', requireAuth, (req, res) => {
  goauth.removeAccount((req.body && req.body.email) || '');
  res.json({ success: true });
});

app.get('/login', (req, res) => {
  const brand = cfg.BRAND_NAME;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${brand} — Sign in</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Hanken+Grotesk:wght@400;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:radial-gradient(120% 60% at 50% 0%,#1b160e 0%,#0f0c07 60%);color:#f4eee2;font-family:'Hanken Grotesk',system-ui,sans-serif;display:grid;place-items:center;height:100vh}
    .b{text-align:center;padding:48px 40px}
    .logo{width:72px;height:72px;border-radius:50%;margin:0 auto 22px;background:radial-gradient(circle at 35% 30%,#f3c45a,#e6a92c 55%,#b9831a);box-shadow:0 0 60px -10px rgba(230,169,44,.6)}
    h1{font-family:'Instrument Serif',serif;font-size:46px;font-weight:400;letter-spacing:-.01em}
    .d{color:#a39b8b;font-size:14px;margin:6px 0 30px}
    a{display:inline-flex;align-items:center;gap:10px;background:#e6a92c;color:#141109;padding:12px 24px;border-radius:11px;text-decoration:none;font-weight:700;font-size:14px}
  </style>
  <div class="b"><div class="logo"></div><h1>${brand}</h1><div class="d">${cfg.TAGLINE}</div>
  <a href="/auth/google">Sign in with Google</a></div>`);
});

// --- Protected API ---
app.use('/api', requireAuth);
app.use('/api/config', require('./routes/config'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/memories', require('./routes/memories'));
app.use('/api/timesheet', require('./routes/timesheet'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/mail', require('./routes/mail'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/bookmarks', require('./routes/bookmarks'));
app.use('/api/spaces', require('./routes/spaces'));
app.use('/api/notes', require('./routes/notes'));
app.get('/api/reminders', (req, res) =>
  res.json(db.prepare("SELECT id, text, fire_at, sent FROM reminders WHERE sent=0 ORDER BY fire_at ASC LIMIT 100").all()));

// --- App shell (protected) + static PWA assets (manifest/sw/icons public) ---
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.use(express.static(path.join(__dirname, '../public')));

// --- Reminder poller — every 30s, fire any due reminders via ntfy ---
setInterval(async () => {
  const due = db.prepare("SELECT id, text FROM reminders WHERE sent=0 AND fire_at <= ?").all(new Date().toISOString());
  for (const r of due) {
    try {
      await ntfy.push(r.text, { title: cfg.BRAND_NAME + ' Reminder', priority: 'high', tags: 'alarm_clock' });
      db.prepare('UPDATE reminders SET sent=1 WHERE id=?').run(r.id);
      console.log(`[reminder] fired #${r.id}: ${r.text}`);
    } catch (e) {
      console.warn(`[reminder] push failed #${r.id}: ${e.message}`);
    }
  }
}, 30000);

app.listen(cfg.PORT, () => console.log(`[${cfg.BRAND_NAME.toLowerCase()}] listening on ${cfg.PORT} (ntfy topic: ${ntfy.NTFY_TOPIC})`));
