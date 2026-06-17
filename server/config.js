// Central config + brand. One place to flip the wordmark or read feature flags.
const BRAND_NAME = process.env.BRAND_NAME || 'Maverick';

module.exports = {
  BRAND_NAME,
  TAGLINE: 'Your day, balanced for you.',
  TZ: process.env.TZ || 'America/Chicago',
  MODEL: process.env.MAVERICK_MODEL || 'claude-haiku-4-5',
  PORT: process.env.PORT || 3000,

  ALLOWED_EMAILS: (process.env.ALLOWED_GOOGLE_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL,
  },
  // Key-based Google APIs (YouTube Data, Maps). NOT used for OAuth user-data APIs.
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  get keyApisEnabled() { return !!this.googleApiKey; },

  timeclock: {
    url: process.env.TIMECLOCK_URL || '',
    token: process.env.AGENT_API_TOKEN || '',
    get enabled() { return !!(this.url && this.token); },
  },
  bookmarks: {
    url: process.env.BOOKMARKS_URL || '',
    token: process.env.BOOKMARKS_AGENT_TOKEN || '',
    get enabled() { return !!(this.url && this.token); },
  },
  charliework: {
    url: process.env.CHARLIEWORK_API_URL || '',
    token: process.env.CHARLIEWORK_API_TOKEN || '',
    get enabled() { return !!this.url; },
  },
  dockerTool: String(process.env.ENABLE_DOCKER_TOOL || '').toLowerCase() === 'true',
  deviceToken: process.env.DEVICE_TOKEN || '',
};
