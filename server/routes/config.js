const express = require('express');
const cfg = require('../config');
const oauth = require('../google/oauth');
const timeclock = require('../integrations/timeclock');
const charliework = require('../integrations/charliework');
const goosework = require('../integrations/goosework');
const bookmarks = require('../integrations/bookmarks');
const containers = require('../integrations/containers');

const router = express.Router();

function initials(name = '', email = '') {
  const n = (name || '').trim();
  if (n) return n.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  return (email[0] || 'M').toUpperCase();
}

// GET /api/config -> brand, signed-in user, feature flags, connected accounts
router.get('/', (req, res) => {
  const u = req.user || {};
  res.json({
    brand: cfg.BRAND_NAME,
    tagline: cfg.TAGLINE,
    tz: cfg.TZ,
    user: { name: u.name || '', email: u.email || '', initials: initials(u.name, u.email) },
    features: {
      timeclock: timeclock.enabled(),
      tasks: charliework.enabled() || goosework.enabled(),
      mail: cfg.mailRead,
      bookmarks: bookmarks.enabled(),
      containers: containers.enabled(),
      youtube: cfg.keyApisEnabled,
      maps: cfg.keyApisEnabled,
    },
    googleAccounts: oauth.listAccounts().map(a => ({ email: a.email, label: a.label })),
    // Sleep/nutrition/finance tiles are hardcoded sample numbers. Off by default: fiction in
    // the home grid crowds out the three real tiles and makes the screen less trustworthy.
    showDemoTiles: String(process.env.SHOW_DEMO_TILES || '').toLowerCase() === 'true',
  });
});

module.exports = router;
