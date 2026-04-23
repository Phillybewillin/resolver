require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const WYZIE_API_KEY = process.env.WYZIE_API_KEY;

// ─── Addon Config ────────────────────────────────────────────────────────────
// NOTE: isProxy has been removed entirely — streams are returned as-is.
const ADDONS = {
  webstreamrmbg: {
    base: 'https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club',
    fallbackBase: 'https://newman21-webstreamer-mbg.hf.space',
    name: 'WebStreamrMBG',
  },
  nebulastreams: {
    base: 'https://nebulastreams.onrender.com',
    name: 'NebulaStreams',
  },
  swordwatch: {
    base: 'https://sword-watch.vercel.app',
    name: 'SwordWatch',
  },
  streamvix: { base: 'https://streamvix.hayd.uk', name: 'StreamVix' },
  hdhub:     { base: 'https://hdhub.thevolecitor.qzz.io', name: 'HdHub' },
  cloudnestra: {
    base: 'https://cloudnestra.com',
    fallbackBase: 'https://www.cloudnestra.com',
    name: 'Cloudnestra',
  },
  vidsrc_xyz: { base: 'https://vidsrc.xyz',  name: 'VidSrc.xyz' },
  vidsrc_to:  { base: 'https://vidsrc.to',   name: 'VidSrc.to'  },
  vidsrc_me:  { base: 'https://vidsrc.me',   name: 'VidSrc.me'  },
  vidsrc_pro: { base: 'https://vidsrc.pro',  name: 'VidSrc.pro' },
};

const WYZIE_BASE = 'https://sub.wyzie.io';

// ─── Hostname Patch ──────────────────────────────────────────────────────────
// Some addons return stream URLs with a bare hostname missing ".baby-beamup.club".
function fixHostname(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('.')) {
      parsed.hostname = `${parsed.hostname}.baby-beamup.club`;
      return parsed.toString();
    }
  } catch (_) {
    // Malformed URL — return as-is.
  }
  return url;
}

// ─── TMDB → IMDB Resolution Cache ───────────────────────────────────────────
const idCache = new Map();

async function resolveId(tmdbId, type) {
  const cacheKey = `${type}:${tmdbId}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);

  if (!TMDB_API_KEY) {
    console.warn('⚠  No TMDB_API_KEY — subtitles will likely be empty (Wyzie needs an IMDB ID)');
    const fallback = { addonId: `tmdb:${tmdbId}`, wyzieId: tmdbId };
    idCache.set(cacheKey, fallback);
    return fallback;
  }

  const tmdbType = type === 'tv' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    const data = await res.json();

    if (data.imdb_id) {
      const result = { addonId: data.imdb_id, wyzieId: data.imdb_id };
      idCache.set(cacheKey, result);
      return result;
    }

    console.warn(`⚠  TMDB returned no imdb_id for ${tmdbType}/${tmdbId}`);
  } catch (err) {
    console.error('TMDB resolution failed:', err.message);
  }

  const fallback = { addonId: `tmdb:${tmdbId}`, wyzieId: tmdbId };
  idCache.set(cacheKey, fallback);
  return fallback;
}

// ─── Quality Parsing ─────────────────────────────────────────────────────────
// 4K is intentionally de-prioritised (user preference).
const QUALITY_ORDER = { '1080p': 0, '720p': 1, '480p': 2, 'auto': 3, '4k': 4 };

function parseQuality(text) {
  if (!text) return 'auto';
  const t = text.toLowerCase();
  if (/\b2160p\b/.test(t) || /\b4k\b/.test(t)) return '4k';
  if (/\b1080p\b/.test(t)) return '1080p';
  if (/\b720p\b/.test(t)) return '720p';
  if (/\b480p\b/.test(t)) return '480p';
  return 'auto';
}

function inferStreamType(url) {
  if (!url) return 'other';
  if (url.includes('.m3u8')) return 'hls';
  if (url.includes('.mp4'))  return 'mp4';
  return 'other';
}

// ─── .zip URL Fix ─────────────────────────────────────────────────────────────
// Some addons (e.g. HdHub) append .zip to what is actually an .mkv/.mp4 URL.
// Strip the trailing .zip so the browser/player receives the real file extension.
function stripZipExtension(url) {
  if (!url) return url;
  return url.replace(/\.zip(\?.*)?$/, (_, qs) => (qs || ''));
}

// ─── NoTorrent Locked Stream Filter ──────────────────────────────────────────
// NoTorrent returns placeholder "locked" streams (🔒 in the title) that require
// a premium account and all resolve to the same dummy URL — useless to everyone.
function isLockedNoTorrentStream(addonKey, stream) {
  if (addonKey !== 'notorrent') return false;
  const text = `${stream.name || ''} ${stream.title || ''}`;
  return text.includes('🔒');
}

// ─── Fetch Streams from a Single Addon ───────────────────────────────────────
async function fetchAddonStreams(addonKey, addonId, type, season, episode) {
  const addon = ADDONS[addonKey];
  const idPart      = type === 'tv' ? `${addonId}:${season}:${episode}` : addonId;
  const contentType = type === 'tv' ? 'series' : 'movie';

  async function tryBase(base) {
    const url = `${base}/stream/${contentType}/${idPart}.json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.streams || !Array.isArray(data.streams)) return [];
      return data.streams;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  let rawStreams;

  try {
    rawStreams = await tryBase(addon.base);
  } catch (primaryErr) {
    if (addon.fallbackBase) {
      console.warn(`${addon.name} primary failed (${primaryErr.message}), trying fallback…`);
      try {
        rawStreams = await tryBase(addon.fallbackBase);
      } catch (fallbackErr) {
        console.error(`${addon.name} fallback also failed:`, fallbackErr.message);
        throw fallbackErr; // bubble up so caller gets the real message
      }
    } else {
      throw primaryErr; // bubble up so caller gets the real message
    }
  }

  return rawStreams
    // Drop streams with no URL, or NoTorrent locked/placeholder entries.
    .filter((s) => s.url && !isLockedNoTorrentStream(addonKey, s))
    .map((s) => {
      const qualityText = `${s.name || ''} ${s.title || ''}`;
      // Strip trailing .zip so e.g. "file.mkv.zip" is treated as "file.mkv"
      const rawUrl      = fixHostname(stripZipExtension(s.url));
      const streamType  = inferStreamType(rawUrl);

      // Streams are returned as-is — no proxying.
      return {
        url:     rawUrl,
        type:    streamType,
        label:   `${addon.name} • ${s.title || s.name || 'Unknown'}`,
        quality: parseQuality(qualityText),
        addon:   addonKey,
      };
    });
}

// ─── Fetch Subtitles from Wyzie ──────────────────────────────────────────────
async function fetchSubtitles(wyzieId, type, season, episode) {
  if (!String(wyzieId).startsWith('tt')) {
    console.warn(`⚠  Wyzie lookup using raw ID "${wyzieId}" — expect empty results without an IMDB ID`);
  }

  if (!WYZIE_API_KEY) {
    console.warn('⚠  WYZIE_API_KEY not set — get a free key at https://sub.wyzie.io/redeem');
    return [];
  }

  let url = `${WYZIE_BASE}/search?id=${encodeURIComponent(wyzieId)}&key=${WYZIE_API_KEY}`;
  if (type === 'tv') url += `&season=${season}&episode=${episode}`;

  // 12 s — longer than the addon fetches since Wyzie can be slow, and this
  // runs in parallel with them so it doesn't add to total wall-clock time.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Wyzie HTTP ${res.status}: ${res.statusText}`);

    const raw  = await res.json();
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.results)
        ? raw.results
        : [];

    // Keep only srt and vtt — the only formats that work on web.
    const WEB_FORMATS = new Set(['srt', 'vtt']);
    const compatible  = list.filter((sub) =>
      WEB_FORMATS.has((sub.format || '').toLowerCase())
    );

    if (compatible.length === 0) {
      console.warn(`Wyzie returned no web-compatible subtitles (srt/vtt) for id=${wyzieId}`);
      return [];
    }

    const seenNonEn  = new Set();
    const seenEnKeys = new Set();
    const unique     = [];

    for (const sub of compatible) {
      const lang    = (sub.language || sub.lang || '').toLowerCase();
      if (!lang) continue;

      const isHI    = !!(sub.isHearingImpaired || sub.isHI);
      const display = sub.display || sub.language || sub.lang || '';

      if (lang.startsWith('en')) {
        const key = `${lang}|${isHI}|${display.toLowerCase()}`;
        if (seenEnKeys.has(key)) continue;
        seenEnKeys.add(key);
      } else {
        if (seenNonEn.has(lang)) continue;
        seenNonEn.add(lang);
      }

      unique.push({
        url:     sub.url,
        lang:    sub.language || sub.lang || '',
        display,
        format:  sub.format || 'srt',
        isHI,
      });
    }

    unique.sort((a, b) => {
      const aEn = a.lang.toLowerCase().startsWith('en') ? 0 : 1;
      const bEn = b.lang.toLowerCase().startsWith('en') ? 0 : 1;
      if (aEn !== bEn) return aEn - bEn;
      if (aEn === 0 && bEn === 0) {
        if (a.isHI !== b.isHI) return a.isHI ? 1 : -1;
      }
      return (a.display || '').localeCompare(b.display || '');
    });

    return unique.slice(0, 20);
  } catch (err) {
    clearTimeout(timeout);
    console.error('Wyzie fetch failed:', err.message);
    // Surface a meaningful error string so it appears in the API response.
    throw new Error(`Wyzie: ${err.message}`);
  }
}

// ─── Big File Detection ──────────────────────────────────────────────────────
function isBigFile(label) {
  const match = label.match(/(\d+(?:\.\d+)?)\s*GB/i);
  if (!match) return false;
  return parseFloat(match[1]) >= 5;
}

// ─── Addon Sort Weight ───────────────────────────────────────────────────────
const ADDON_ORDER = {
  webstreamrmbg: 0,
  nebulastreams:  1,
  swordwatch:     2,
  streamvix:      3,
  hdhub:          4,
  cloudnestra:   10,
  vidsrc_xyz:    11,
  vidsrc_to:     12,
  vidsrc_me:     13,
  vidsrc_pro:    14,
};

// ─── Sort Merged Sources ─────────────────────────────────────────────────────
function sortSources(sources) {
  return sources.sort((a, b) => {
    const aBig = isBigFile(a.label) ? 1 : 0;
    const bBig = isBigFile(b.label) ? 1 : 0;
    if (aBig !== bBig) return aBig - bBig;

    const qa = QUALITY_ORDER[a.quality] ?? 3;
    const qb = QUALITY_ORDER[b.quality] ?? 3;
    if (qa !== qb) return qa - qb;

    return (ADDON_ORDER[a.addon] ?? 5) - (ADDON_ORDER[b.addon] ?? 5);
  });
}

// ─── Deduplication ───────────────────────────────────────────────────────────
// Drop sources with an identical URL that have already appeared in the list.
function deduplicate(sources) {
  const seen = new Set();
  return sources.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok:        true,
    timestamp: Date.now(),
    wyzieKey:  WYZIE_API_KEY ? '✓ set' : '✗ not set — subtitles will always be empty (get free key at https://sub.wyzie.io/redeem)',
  });
});

app.get('/api/streams', async (req, res) => {
  const { tmdbId, type, season, episode } = req.query;

  if (!tmdbId || !type) {
    return res.json({
      resolvedId: null, sources: [], subtitles: [],
      error: 'Missing required query params: tmdbId, type',
    });
  }

  if (type === 'tv' && (!season || !episode)) {
    return res.json({
      resolvedId: null, sources: [], subtitles: [],
      error: 'Missing required query params for TV: season, episode',
    });
  }

  try {
    const { addonId, wyzieId } = await resolveId(tmdbId, type);

    const [
      webstreamrmbgR,
      nebulastreamR,
      swordwatchR,
      streamvixR,
      hdhubR,
      cloudnestraR,
      vidsrcXyzR,
      vidsrcToR,
      vidsrcMeR,
      vidsrcProR,
      subtitlesR,
    ] = await Promise.allSettled([
      fetchAddonStreams('webstreamrmbg', addonId,  type, season, episode),
      fetchAddonStreams('nebulastreams', wyzieId,  type, season, episode),
      fetchAddonStreams('swordwatch',    addonId,  type, season, episode),
      fetchAddonStreams('streamvix',     addonId,  type, season, episode),
      fetchAddonStreams('hdhub',         addonId,  type, season, episode),
      fetchAddonStreams('cloudnestra',   addonId,  type, season, episode),
      fetchAddonStreams('vidsrc_xyz',    addonId,  type, season, episode),
      fetchAddonStreams('vidsrc_to',     addonId,  type, season, episode),
      fetchAddonStreams('vidsrc_me',     addonId,  type, season, episode),
      fetchAddonStreams('vidsrc_pro',    addonId,  type, season, episode),
      fetchSubtitles(wyzieId, type, season, episode),
    ]);

    const streams = (r) =>
      r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];

    const allSources = deduplicate(sortSources([
      ...streams(webstreamrmbgR),
      ...streams(nebulastreamR),
      ...streams(swordwatchR),
      ...streams(streamvixR),
      ...streams(hdhubR),
      ...streams(cloudnestraR),
      ...streams(vidsrcXyzR),
      ...streams(vidsrcToR),
      ...streams(vidsrcMeR),
      ...streams(vidsrcProR),
    ]));

    const subtitles = subtitlesR.status === 'fulfilled' ? subtitlesR.value : [];

    // ── Build detailed error list ─────────────────────────────────────────
    const addonResults = {
      WebStreamrMBG: webstreamrmbgR,
      NebulaStreams:  nebulastreamR,
      SwordWatch:     swordwatchR,
      StreamVix:      streamvixR,
      HdHub:          hdhubR,
      Cloudnestra:    cloudnestraR,
      'VidSrc.xyz':   vidsrcXyzR,
      'VidSrc.to':    vidsrcToR,
      'VidSrc.me':    vidsrcMeR,
      'VidSrc.pro':   vidsrcProR,
    };

    const errors = Object.entries(addonResults)
      .filter(([, r]) => r.status === 'rejected' || r.value === null)
      .map(([name, r]) => {
        const msg = r.status === 'rejected'
          ? (r.reason?.message || 'unknown error')
          : 'returned null';
        return `${name}: ${msg}`;
      });

    if (subtitlesR.status === 'rejected') {
      errors.push(subtitlesR.reason?.message || 'Subtitles: unknown error');
    }

    if (allSources.length === 0 && errors.length > 0) {
      errors.push('No streams available');
    }

    res.json({
      resolvedId: addonId,
      sources:    allSources,
      subtitles,
      error: errors.length > 0 ? errors.join('; ') : null,
    });
  } catch (err) {
    console.error('Unhandled error in /api/streams:', err);
    res.json({
      resolvedId: null, sources: [], subtitles: [],
      error: err.message || 'Internal server error',
    });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Resolver listening on http://localhost:${PORT}`);
  console.log(`Wyzie key: ${WYZIE_API_KEY ? '✓ set' : '⚠  not set — subtitles will always be empty (get free key at https://sub.wyzie.io/redeem)'}`);
  if (!TMDB_API_KEY) {
    console.warn('⚠  TMDB_API_KEY not set — ID resolution will use fallback (subtitles will likely be empty)');
  }
});
