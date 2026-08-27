// Central config + brand. One place to flip the wordmark or read feature flags.
const BRAND_NAME = process.env.BRAND_NAME || 'Maverick';

module.exports = {
  BRAND_NAME,
  TAGLINE: process.env.TAGLINE || 'Your day, balanced for you.',
  // Whose assistant this is. Blank = the assistant addresses the signed-in user generically ("you").
  OWNER_NAME: process.env.OWNER_NAME || '',
  TZ: process.env.TZ || 'America/Chicago',
  MODEL: process.env.MAVERICK_MODEL || 'claude-haiku-4-5',
  PORT: process.env.PORT || 3000,

  // Accent palette for spaces (used to seed defaults + auto-assign a color to new spaces).
  SPACE_PALETTE: ['#e6a92c', '#9ca980', '#c2906a', '#6fa195', '#7e93b0', '#a98aa0', '#cf9f5a', '#8f9bb0', '#a3a392'],

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

  // Calendar summaries (substring, case-insensitive) to always treat as "work"/resource calendars,
  // regardless of ownership. Comma-separated in WORK_CALENDARS. Kept in .env (out of the repo).
  workCalendars: (process.env.WORK_CALENDARS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

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
    get enabled() { return !!(this.url && this.token); },
  },
  // --- local brain (ollama on goose-desktop, RTX 3070) ---
  // BRAIN_BACKEND is the rollback lever for the soak window and nothing else: 'local' runs
  // the agent loop against ollama, 'claude' falls back to the Claude Code CLI. Do not build
  // features on it and do not let it become a hybrid by accident (LOCAL-BRAIN-SPEC 12.1).
  brain: {
    backend: (process.env.BRAIN_BACKEND || 'local').toLowerCase(),
    url: process.env.OLLAMA_URL || 'http://192.168.68.76:11434',
    model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    numCtx: Number(process.env.OLLAMA_NUM_CTX || 8192),
    temperature: Number(process.env.OLLAMA_TEMPERATURE || 0.2),  // tool calling wants low, not zero
    topP: Number(process.env.OLLAMA_TOP_P || 0.9),
    numPredict: Number(process.env.OLLAMA_NUM_PREDICT || 800),

    probeTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 2000),
    probeUpTtlMs: Number(process.env.PROBE_UP_TTL_MS || 15000),
    probeDownTtlMs: Number(process.env.PROBE_DOWN_TTL_MS || 30000),
    genTimeoutMs: Number(process.env.GEN_TIMEOUT_MS || 90000),
    queueMax: Number(process.env.QUEUE_MAX || 4),

    maxRounds: Number(process.env.BRAIN_MAX_ROUNDS || 6),
    maxToolsPerCall: Number(process.env.BRAIN_MAX_TOOLS_PER_CALL || 8),
    toolResultTokens: Number(process.env.BRAIN_TOOL_RESULT_TOKENS || 1500),
    turnTimeoutMs: Number(process.env.BRAIN_TURN_TIMEOUT_MS || 90000),
    historyTurns: Number(process.env.BRAIN_HISTORY_TURNS || 8),
    get isLocal() { return this.backend === 'local'; },
  },

  // Text-to-speech for the hands-free conversation mode. Reuses cranium's Kokoro service
  // (OpenAI-compatible /v1/audio/speech) rather than standing up a second TTS container.
  tts: {
    url: process.env.TTS_URL || 'http://cranium-tts:8880',
    voice: process.env.TTS_VOICE || 'af_heart',
    format: process.env.TTS_FORMAT || 'mp3',
    speed: Number(process.env.TTS_SPEED || 1.0),
    get enabled() { return String(process.env.TTS_ENABLED || 'true').toLowerCase() === 'true' && !!this.url; },
  },

  dockerTool: String(process.env.ENABLE_DOCKER_TOOL || '').toLowerCase() === 'true',
  deviceToken: process.env.DEVICE_TOKEN || '',
  whisperUrl: process.env.WHISPER_URL || 'http://maverick-whisper:9000',
};
