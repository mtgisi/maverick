const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { ALLOWED_EMAILS, google } = require('./config');

passport.use(new GoogleStrategy({
  clientID: google.clientId,
  clientSecret: google.clientSecret,
  callbackURL: google.callbackUrl,
}, (accessToken, refreshToken, profile, done) => {
  const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
  if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(email)) {
    return done(null, false, { message: 'unauthorized_email' });
  }
  return done(null, { id: profile.id, email, name: profile.displayName });
}));

passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((u, done) => done(null, u));

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  // req.path is stripped of the mount prefix; use originalUrl to detect API calls
  if ((req.originalUrl || '').startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

module.exports = { passport, requireAuth };
