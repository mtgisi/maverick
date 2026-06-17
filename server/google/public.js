// Key-based Google APIs (YouTube Data v3 + Maps). Uses GOOGLE_API_KEY, not OAuth.
// All fail closed when the key isn't configured (cfg.keyApisEnabled === false).
const cfg = require('../config');

// Search YouTube for videos matching a query.
async function searchYouTube({ query, max = 8 }) {
  if (!cfg.keyApisEnabled) return { enabled: false, results: [] };
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      q: query || '',
      maxResults: String(max),
      key: cfg.googleApiKey,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await res.json();
    if (data.error) return { enabled: true, error: data.error.message || 'youtube_error', results: [] };
    const results = (data.items || []).map(it => {
      const videoId = it.id && it.id.videoId;
      const sn = it.snippet || {};
      return {
        videoId,
        title: sn.title || '',
        channel: sn.channelTitle || '',
        publishedAt: sn.publishedAt || '',
        url: 'https://youtu.be/' + videoId,
      };
    });
    return { enabled: true, results };
  } catch (e) {
    return { enabled: true, error: e.message, results: [] };
  }
}

// Fetch details + stats for a single YouTube video.
async function youtubeVideo({ videoId }) {
  if (!cfg.keyApisEnabled) return { enabled: false, video: null };
  try {
    const params = new URLSearchParams({
      part: 'snippet,statistics',
      id: videoId || '',
      key: cfg.googleApiKey,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
    const data = await res.json();
    if (data.error) return { enabled: true, error: data.error.message || 'youtube_error', video: null };
    const it = (data.items || [])[0];
    if (!it) return { enabled: true, video: null };
    const sn = it.snippet || {};
    const st = it.statistics || {};
    return {
      enabled: true,
      video: {
        title: sn.title || '',
        channel: sn.channelTitle || '',
        views: st.viewCount || '0',
        likes: st.likeCount || '0',
        url: 'https://youtu.be/' + (videoId || ''),
      },
    };
  } catch (e) {
    return { enabled: true, error: e.message, video: null };
  }
}

// Build a Google Maps Embed iframe URL (no network call).
function mapsEmbedUrl({ query, mode = 'place' }) {
  if (!cfg.keyApisEnabled) return '';
  return `https://www.google.com/maps/embed/v1/${mode}?key=${cfg.googleApiKey}&q=${encodeURIComponent(query)}`;
}

// Build a Google Static Maps image URL (no network call).
function staticMapUrl({ center, zoom = 13, size = '600x300', markers }) {
  if (!cfg.keyApisEnabled) return '';
  const params = new URLSearchParams({
    center: center || '',
    zoom: String(zoom),
    size,
    key: cfg.googleApiKey,
  });
  if (markers) params.set('markers', markers);
  return `https://maps.googleapis.com/maps/api/staticmap?${params}`;
}

module.exports = { searchYouTube, youtubeVideo, mapsEmbedUrl, staticMapUrl };
