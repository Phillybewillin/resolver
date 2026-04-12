require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MEDIAFLOW_PROXY_URL = (process.env.MEDIAFLOW_PROXY_URL || 'https://phillybewillin-unhided.hf.space').replace(/\/$/, '');
const MEDIAFLOW_PASSWORD = process.env.MEDIAFLOW_API_PASSWORD;
const WYZIE_API_KEY = process.env.WYZIE_API_KEY;

// ─── Addon Config ────────────────────────────────────────────────────────────
// isProxy: true  →  HLS (.m3u8) stream URLs from this addon get routed through
//                   MediaFlow before being returned to the client.
//                   Non-HLS streams are returned as-is even for proxy addons.
// fallbackBase   →  tried automatically if the primary base times out or 404s.
const ADDONS = {
  webstreamrmbg: {
    base: 'https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club',
    fallbackBase: 'https://newman21-webstreamer-mbg.hf.space',
    name: 'WebStreamrMBG',
  },
  nebulastreams: { base: 'https://florence-direct-rocks-info.trycloudflare.com', name: 'NebulaStreams' },
  notorrent: { base: 'https://addon.notorrent2.workers.dev', name: 'NoTorrent' },
  streamvix: { base: 'https://streamvix.hayd.uk', name: 'StreamVix' },
  hdhub: { base: 'https://hdhub.thevolecitor.qzz.io', name: 'HdHub', isProxy: true },

  // ── Proxy-required addons ────────────────────────────────────────────────
  cloudnestra: {
    base: 'https://cloudnestra.com',
    fallbackBase: 'https://www.cloudnestra.com',
    name: 'Cloudnestra',
    isProxy: true,
  },
  vidsrc_xyz: { base: 'https://vidsrc.xyz', name: 'VidSrc.xyz', isProxy: true },
  vidsrc_to: { base: 'https://vidsrc.to', name: 'VidSrc.to', isProxy: true },
  vidsrc_me: { base: 'https://vidsrc.me', name: 'VidSrc.me', isProxy: true },
  vidsrc_pro: { base: 'https://vidsrc.pro', name: 'VidSrc.pro', isProxy: true },
};

const WYZIE_BASE = 'https://sub.wyzie.io';

// ─── Hostname Patch ──────────────────────────────────────────────────────────
// Some addons return stream URLs with a bare hostname that is missing the
// ".baby-beamup.club" suffix — e.g.:
//   https://87d6a6ef6b58-webstreamrmbg/extract/?index=0&url=…
// This function detects those (no dot in hostname) and appends the suffix so
// the URL becomes valid before any further processing.
function fixHostname(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    // A real public hostname always contains at least one dot.
    // If there is none, assume .baby-beamup.club is missing.
    if (!parsed.hostname.includes('.')) {
      parsed.hostname = `${parsed.hostname}.baby-beamup.club`;
      return parsed.toString();
    }
  } catch (_) {
    // Malformed URL — return as-is and let the caller decide.
  }
  return url;
}

// ─── MediaFlow Proxy Wrapper ─────────────────────────────────────────────────
// Routes a stream URL through your self-hosted MediaFlow instance.
//   .m3u8  →  /proxy/hls    (re-proxies every segment inside the manifest)
//   other  →  /proxy/stream (single-file HTTP proxy)
// The api_password param is appended only when the env var is set.
function wrapWithProxy(streamUrl) {
  if (!streamUrl || !MEDIAFLOW_PROXY_URL) return streamUrl;
  const endpoint = streamUrl.includes('.m3u8') ? 'proxy/hls' : 'proxy/stream';
  const out = new URL(`${MEDIAFLOW_PROXY_URL}/${endpoint}`);
  out.searchParams.set('d', streamUrl);
  if (MEDIAFLOW_PASSWORD) out.searchParams.set('api_password', MEDIAFLOW_PASSWORD);
  return out.toString();
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
  if (url.includes('.mp4')) return 'mp4';
  return 'other';
}

// ─── Fetch Streams from a Single Addon ───────────────────────────────────────
// Handles the fallbackBase retry transparently so callers don't need to know.
async function fetchAddonStreams(addonKey, addonId, type, season, episode) {
  const addon = ADDONS[addonKey];
  const idPart = type === 'tv' ? `${addonId}:${season}:${episode}` : addonId;
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
        return null;
      }
    } else {
      console.error(`${addon.name} fetch failed:`, primaryErr.message);
      return null;
    }
  }

  return rawStreams
    // ── FIX 1: drop streams that have no URL ────────────────────────────────
    .filter((s) => s.url)
    .map((s) => {
      const qualityText = `${s.name || ''} ${s.title || ''}`;

      // ── FIX 3: patch any URL whose hostname is missing .baby-beamup.club ──
      const rawUrl = fixHostname(s.url);

      // Derive type once and reuse — avoids checking the URL string twice.
      const streamType = inferStreamType(rawUrl);

      // ── FIX 2: only proxy HLS streams, even for isProxy addons ─────────────
      //    mp4 / other stream types are returned directly to the client.
      const streamUrl = (addon.isProxy && streamType === 'hls') ? wrapWithProxy(rawUrl) : rawUrl;

      return {
        url: streamUrl,
        type: streamType,
        label: `${addon.name} • ${s.title || s.name || 'Unknown'}`,
        quality: parseQuality(qualityText),
        addon: addonKey,
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Wyzie HTTP ${res.status}: ${res.statusText} `);

    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.results) ? raw.results : []);

    // Drop formats that don't work on web — keep only srt and vtt.
    // SRT gets converted client-side; VTT works natively with <track>.
    const WEB_FORMATS = new Set(['srt', 'vtt']);
    const compatible = list.filter((sub) =>
      WEB_FORMATS.has((sub.format || '').toLowerCase())
    );

    if (compatible.length === 0) {
      console.warn(`Wyzie returned no web-compatible subtitles (srt/vtt) for id=${wyzieId}`);
      return [];
    }

    // For English: keep ALL variants (regular, SDH, HI, CC) — they cover
    // different portions of the audio so more is better.
    // For every other language: deduplicate to the first (highest-ranked) hit.
    const seenNonEn = new Set();
    const seenEnKeys = new Set(); // de-dupe exact (lang+isHI+display) combos
    const unique = [];

    for (const sub of compatible) {
      const lang = (sub.language || sub.lang || '').toLowerCase();
      if (!lang) continue;

      const isHI = !!(sub.isHearingImpaired || sub.isHI);
      const display = sub.display || sub.language || sub.lang || '';

      if (lang.startsWith('en')) {
        // Unique key: language + HI flag + display label
        const key = `${lang}|${isHI}|${display.toLowerCase()}`;
        if (seenEnKeys.has(key)) continue;
        seenEnKeys.add(key);
      } else {
        if (seenNonEn.has(lang)) continue;
        seenNonEn.add(lang);
      }

      unique.push({
        url: sub.url,
        lang: sub.language || sub.lang || '',
        display,
        format: sub.format || 'srt',
        isHI,
      });
    }

    // Sort: English first (regular before SDH/HI), then alphabetical by display
    unique.sort((a, b) => {
      const aEn = a.lang.toLowerCase().startsWith('en') ? 0 : 1;
      const bEn = b.lang.toLowerCase().startsWith('en') ? 0 : 1;
      if (aEn !== bEn) return aEn - bEn;
      // Within English: non-HI before HI
      if (aEn === 0 && bEn === 0) {
        if (a.isHI !== b.isHI) return a.isHI ? 1 : -1;
      }
      return (a.display || '').localeCompare(b.display || '');
    });

    return unique.slice(0, 20);
  } catch (err) {
    clearTimeout(timeout);
    console.error('Wyzie fetch failed:', err.message);
    return [];
  }
}

// ─── Big File Detection ──────────────────────────────────────────────────────
// Catches "13.46GB" (WebStreamrMBG) and "💾 13.46 GB" label formats.
function isBigFile(label) {
  const match = label.match(/(\d+(?:\.\d+)?)\s*GB/i);
  if (!match) return false;
  return parseFloat(match[1]) >= 5;
}

// ─── Addon Sort Weight ───────────────────────────────────────────────────────
const ADDON_ORDER = {
  webstreamrmbg: 0,
  nebulastreams: 1,
  notorrent: 2,
  streamvix: 3,
  hdhub: 4,
  cloudnestra: 10,
  vidsrc_xyz: 11,
  vidsrc_to: 12,
  vidsrc_me: 13,
  vidsrc_pro: 14,
};

// ─── Sort Merged Sources ─────────────────────────────────────────────────────
// Order: 1080p → 720p → 480p → auto → 4k  (direct-play)
//        cloudnestra → vidsrc variants     (proxy, same quality buckets)
//        big files ≥ 5 GB                  (absolute bottom)
function sortSources(sources) {
  return sources.sort((a, b) => {
    const aBig = isBigFile(a.label) ? 1 : 0;
    const bBig = isBigFile(b.label) ? 1 : 0;
    if (aBig !== bBig) return aBig - bBig;

    const aProxy = ADDONS[a.addon]?.isProxy ? 1 : 0;
    const bProxy = ADDONS[b.addon]?.isProxy ? 1 : 0;
    if (aProxy !== bProxy) return aProxy - bProxy;

    const qa = QUALITY_ORDER[a.quality] ?? 3;
    const qb = QUALITY_ORDER[b.quality] ?? 3;
    if (qa !== qb) return qa - qb;

    return (ADDON_ORDER[a.addon] ?? 5) - (ADDON_ORDER[b.addon] ?? 5);
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    timestamp: Date.now(),
    mediaflowProxy: MEDIAFLOW_PROXY_URL,
    mediaflowPassword: MEDIAFLOW_PASSWORD ? '✓ set' : '✗ not set',
    wyzieKey: WYZIE_API_KEY ? '✓ set' : '✗ not set — subtitles will be empty',
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
      webstreamrmbgR, nebulastreamR, notorrentR, streamvixR, hdhubR,
      cloudnestraR,
      vidsrcXyzR, vidsrcToR, vidsrcMeR, vidsrcProR,
      subtitlesR,
    ] = await Promise.allSettled([
      fetchAddonStreams('webstreamrmbg', addonId, type, season, episode),
      // NebulaStreams only accepts tt-prefixed IMDB IDs — use wyzieId
      fetchAddonStreams('nebulastreams', wyzieId, type, season, episode),
      fetchAddonStreams('notorrent', addonId, type, season, episode),
      fetchAddonStreams('streamvix', addonId, type, season, episode),
      fetchAddonStreams('hdhub', addonId, type, season, episode),
      fetchAddonStreams('cloudnestra', addonId, type, season, episode),
      fetchAddonStreams('vidsrc_xyz', addonId, type, season, episode),
      fetchAddonStreams('vidsrc_to', addonId, type, season, episode),
      fetchAddonStreams('vidsrc_me', addonId, type, season, episode),
      fetchAddonStreams('vidsrc_pro', addonId, type, season, episode),
      fetchSubtitles(wyzieId, type, season, episode),
    ]);

    const streams = (r) =>
      r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];

    const allSources = sortSources([
      ...streams(webstreamrmbgR),
      ...streams(nebulastreamR),
      ...streams(notorrentR),
      ...streams(streamvixR),
      ...streams(hdhubR),
      ...streams(cloudnestraR),
      ...streams(vidsrcXyzR),
      ...streams(vidsrcToR),
      ...streams(vidsrcMeR),
      ...streams(vidsrcProR),
    ]);

    const subtitles = subtitlesR.status === 'fulfilled' ? subtitlesR.value : [];

    const addonResults = {
      WebStreamrMBG: webstreamrmbgR,
      NebulaStreams: nebulastreamR,
      NoTorrent: notorrentR,
      StreamVix: streamvixR,
      HdHub: hdhubR,
      Cloudnestra: cloudnestraR,
      'VidSrc.xyz': vidsrcXyzR,
      'VidSrc.to': vidsrcToR,
      'VidSrc.me': vidsrcMeR,
      'VidSrc.pro': vidsrcProR,
    };

    const errors = Object.entries(addonResults)
      .filter(([, r]) => r.status === 'rejected' || r.value === null)
      .map(([name]) => `${name} failed`);

    if (allSources.length === 0 && errors.length > 0) errors.push('No streams available');

    res.json({
      resolvedId: addonId,
      sources: allSources,
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
  console.log(`MediaFlow proxy : ${MEDIAFLOW_PROXY_URL}`);
  console.log(`MediaFlow pass  : ${MEDIAFLOW_PASSWORD ? '✓ set' : '⚠  not set — proxy endpoints will reject requests'}`);
  console.log(`Wyzie key       : ${WYZIE_API_KEY ? '✓ set' : '⚠  not set — subtitles will always be empty (get free key at https://sub.wyzie.io/redeem)'}`);
  if (!TMDB_API_KEY) {
    console.warn('⚠  TMDB_API_KEY not set — ID resolution will use fallback (subtitles will likely be empty)');
  }
});
