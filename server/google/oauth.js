// Google account connection for the Gmail/Calendar APIs.
//
// Login (identity) is handled by passport in ../auth.js. THIS module handles the separate
// "connect an account for API access" flow that requests offline access + Gmail/Calendar scopes
// and stores refresh tokens. Because only ONE redirect URI is registered with Google
// (/auth/callback), both flows share that callback and are told apart by the OAuth `state`:
// connect flows use state = "connect:<label>".

const { google } = require('googleapis');
const db = require('../db');
const cfg = require('../config');

// Drafts only (gmail.compose) — we deliberately never request send-only behavior beyond drafting,
// and never call messages.send. Calendar is read.
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const STATE_PREFIX = 'connect:';

function oauthClient() {
  return new google.auth.OAuth2(cfg.google.clientId, cfg.google.clientSecret, cfg.google.callbackUrl);
}

// Build the consent URL for connecting an account under a label (e.g. 'personal' | 'work').
function buildConnectUrl(label = 'personal') {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',                 // force a refresh_token even on re-consent
    include_granted_scopes: true,
    scope: SCOPES,
    state: STATE_PREFIX + label,
  });
}

function isConnectState(state) {
  return typeof state === 'string' && state.startsWith(STATE_PREFIX);
}

// Handle the connect callback: exchange code, identify the account, persist tokens.
async function handleConnectCallback(code, state) {
  const label = (state || '').slice(STATE_PREFIX.length) || 'personal';
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data: info } = await oauth2.userinfo.get();
  const email = (info.email || '').toLowerCase();
  if (!email) throw new Error('could not determine account email');

  // Preserve an existing refresh_token if Google didn't return a new one.
  const existing = db.prepare('SELECT refresh_token FROM google_accounts WHERE email=?').get(email);
  const refresh = tokens.refresh_token || (existing && existing.refresh_token) || null;

  db.prepare(`INSERT INTO google_accounts (email, label, refresh_token, access_token, expiry, scope, updated_at)
              VALUES (?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(email) DO UPDATE SET
                label=excluded.label, refresh_token=COALESCE(excluded.refresh_token, google_accounts.refresh_token),
                access_token=excluded.access_token, expiry=excluded.expiry, scope=excluded.scope,
                updated_at=datetime('now')`)
    .run(email, label, refresh, tokens.access_token || null, tokens.expiry_date || null, (tokens.scope || SCOPES.join(' ')));

  return { email, label };
}

function listAccounts() {
  return db.prepare('SELECT email, label, scope, updated_at FROM google_accounts ORDER BY created_at ASC').all();
}

function removeAccount(email) {
  db.prepare('DELETE FROM google_accounts WHERE email=?').run((email || '').toLowerCase());
}

// Return an authenticated OAuth2 client for a given account (by email or label).
// Resolves 'personal'/'work'/label, or falls back to the first connected account.
function resolveAccountRow(accountHint) {
  if (accountHint) {
    const h = accountHint.toLowerCase();
    return db.prepare('SELECT * FROM google_accounts WHERE lower(email)=? OR lower(label)=? ORDER BY created_at ASC LIMIT 1').get(h, h);
  }
  return db.prepare('SELECT * FROM google_accounts ORDER BY created_at ASC LIMIT 1').get();
}

function clientFor(accountHint) {
  const row = resolveAccountRow(accountHint);
  if (!row || !row.refresh_token) return null;
  const client = oauthClient();
  client.setCredentials({
    refresh_token: row.refresh_token,
    access_token: row.access_token || undefined,
    expiry_date: row.expiry || undefined,
  });
  // Persist refreshed access tokens so we don't re-mint every call.
  client.on('tokens', t => {
    try {
      db.prepare('UPDATE google_accounts SET access_token=COALESCE(?, access_token), expiry=COALESCE(?, expiry), updated_at=datetime(\'now\') WHERE email=?')
        .run(t.access_token || null, t.expiry_date || null, row.email);
    } catch (_) {}
  });
  return { client, account: { email: row.email, label: row.label } };
}

// All connected clients (for cross-account aggregation, e.g. unified calendar).
function allClients() {
  return listAccounts().map(a => clientFor(a.email)).filter(Boolean);
}

module.exports = {
  SCOPES, buildConnectUrl, isConnectState, handleConnectCallback,
  listAccounts, removeAccount, clientFor, allClients,
};
