require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const WYZIE_API_KEY = process.env.WYZIE_API_KEY;
const MEDIAFLOW_PROXY_URL = (process.env.MEDIAFLOW_PROXY_URL || '').replace(/\/$/, '');
const MEDIAFLOW_PASSWORD = process.env.MEDIAFLOW_API_PASSWORD;

// ─── MediaFlow Proxy Wrapper ──────────────────────────────────────────────────
function wrapWithProxy(streamUrl) {
  if (!streamUrl || !MEDIAFLOW_PROXY_URL) return streamUrl;
  const isHls    = streamUrl.includes('.m3u8');
  const endpoint = isHls ? 'proxy/hls/manifest.m3u8' : 'proxy/stream';
  const out      = new URL(`${MEDIAFLOW_PROXY_URL}/${endpoint}`);
  out.searchParams.set('d', streamUrl);
  if (MEDIAFLOW_PASSWORD) out.searchParams.set('api_password', MEDIAFLOW_PASSWORD);
  return out.toString();
}

// ─── Addon Config ────────────────────────────────────────────────────────────
function buildWebStreamrConfig() {
  return encodeURIComponent(JSON.stringify({ multi: 'on' }));
}

const WEBSTREAMR_CONFIG = process.env.WEBSTREAMR_CONFIG || buildWebStreamrConfig();

const ADDONS = {
  webstreamrmbg: {
    base: `https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club/${WEBSTREAMR_CONFIG}`,
    name: 'WebStreamrMBG',
    // FIX: bumped from 20 s → 30 s; 504s on some shows mean the upstream just
    // needs more time. Combined with the 504 retry below this recovers most cases.
    timeout: 30000,
    requiresImdbId: true,
  },
  nebulastreams: {
    base: 'https://nebulastreams.onrender.com',
    name: 'NebulaStreams',
    timeout: 25000,
    wakeBeforeFetch: true,
    requiresImdbId: true,
  },
  yukistreams: {
    base: 'https://stremio.yukistreams.xyz/p.2jVe6a-WVvyK4J0a',
    name: 'YukiStreams',
    timeout: 15000,
    requiresImdbId: true,  // was passing addonId before — now uses wyzieId (tt prefix)
  },
  cinescrape: {
    base: 'https://bc48e59c61df-cinescrape-docker.baby-beamup.club',
    name: 'Cinescrape',
    timeout: 20000,
    requiresImdbId: true,  // idPrefixes: ["tt"]
  },
  muvibox: {
    base: 'https://mvtmdb.netlify.app',
    name: 'Muvibox',
    timeout: 15000,
    requiresImdbId: true,  // tt prefix performs best per user preference
  },
  murphystreams: {
    base: 'https://badboysxs-morpheus.hf.space/bWIsbm0sZGYsaGgsa2gsa20sYXcsaG0',
    name: 'MurphyStreams',
    timeout: 20000,
    wakeBeforeFetch: true,
    requiresImdbId: true,
  },
  streamvix: { base: 'https://streamvix.hayd.uk',         name: 'StreamVix', timeout: 20000 },
  hdhub:     { base: 'https://hdhub.thevolecitor.qzz.io', name: 'HdHub',     timeout: 8000 },
};

const WYZIE_BASE = 'https://sub.wyzie.io';

// ─── Hostname Patch ──────────────────────────────────────────────────────────
function fixHostname(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('.')) {
      parsed.hostname = `${parsed.hostname}.baby-beamup.club`;
      return parsed.toString();
    }
  } catch (_) {}
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
function stripZipExtension(url) {
  if (!url) return url;
  return url.replace(/\.zip(\?.*)?$/, (_, qs) => (qs || ''));
}

// ─── NoTorrent Locked Stream Filter ──────────────────────────────────────────
function isLockedNoTorrentStream(addonKey, stream) {
  if (addonKey !== 'notorrent') return false;
  const text = `${stream.name || ''} ${stream.title || ''}`;
  return text.includes('🔒');
}

// ─── Wake Ping ───────────────────────────────────────────────────────────────
async function wakePing(base) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(`${base}/`, { signal: controller.signal });
    clearTimeout(timeout);
  } catch (_) {}
}

// ─── Fetch Streams from a Single Addon ───────────────────────────────────────
async function fetchAddonStreams(addonKey, addonId, type, season, episode) {
  const addon = ADDONS[addonKey];

  if (addon.requiresImdbId && !String(addonId).startsWith('tt')) {
    throw new Error(`skipped — no IMDB ID (got "${addonId}")`);
  }

  const idPart      = type === 'tv' ? `${addonId}:${season}:${episode}` : addonId;
  const contentType = type === 'tv' ? 'series' : 'movie';
  const addonTimeout = addon.timeout ?? 8000;

  async function tryBase(base, retries = 2) {
    if (addon.wakeBeforeFetch) wakePing(base);

    const url = `${base}/stream/${contentType}/${idPart}.json`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), addonTimeout);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        // FIX: added 504 to the transient-error retry set.
        // WebStreamrMBG occasionally 504s on first hit for certain shows;
        // a single retry after a short pause usually succeeds.
        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
          console.warn(`${addon.name} got ${res.status}, retrying (attempt ${attempt + 1})…`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.streams || !Array.isArray(data.streams)) return [];
        return data.streams;
      } catch (err) {
        clearTimeout(timeout);
        if (attempt < retries && err.name !== 'AbortError') {
          console.warn(`${addon.name} attempt ${attempt + 1} failed (${err.message}), retrying…`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw err;
      }
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
        throw fallbackErr;
      }
    } else {
      throw primaryErr;
    }
  }

  return rawStreams
    .filter((s) => {
      if (!s.url) return false;
      // Drop relative URLs (e.g. /login.php?action=logout leaking from HdHub)
      if (!s.url.startsWith('http://') && !s.url.startsWith('https://')) return false;
      if (isLockedNoTorrentStream(addonKey, s)) return false;
      return true;
    })
    .map((s) => {
      const qualityText = `${s.name || ''} ${s.title || ''}`;
      const rawUrl      = fixHostname(stripZipExtension(s.url));
      const streamType  = inferStreamType(rawUrl);

      const finalUrl = requiresProxy(streamType)
        ? wrapWithProxy(rawUrl)
        : rawUrl;

      return {
        url:     finalUrl,
        type:    streamType,
        label:   `${addon.name} • ${s.title || s.name || 'Unknown'}`,
        quality: parseQuality(qualityText),
        addon:   addonKey,
      };
    });
}

// ─── Domains that require proxying ───────────────────────────────────────────
function requiresProxy(streamType) {
  return streamType === 'hls' && !!MEDIAFLOW_PROXY_URL;
}

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
  const timeout = setTimeout(() => controller.abort(), 25000);

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
  yukistreams:    2,
  cinescrape:     3,
  muvibox:        4,
  murphystreams:  5,
  streamvix:      6,
  hdhub:          7,
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
      yukistreamsR,
      cinescrapeR,
      muviboxR,
      murphystreamsR,
      streamvixR,
      hdhubR,
      subtitlesR,
    ] = await Promise.allSettled([
      fetchAddonStreams('webstreamrmbg', wyzieId, type, season, episode),
      fetchAddonStreams('nebulastreams', wyzieId, type, season, episode),
      fetchAddonStreams('yukistreams',   wyzieId, type, season, episode),  // tt prefix fix
      fetchAddonStreams('cinescrape',    wyzieId, type, season, episode),
      fetchAddonStreams('muvibox',       wyzieId, type, season, episode),
      fetchAddonStreams('murphystreams', wyzieId, type, season, episode),
      fetchAddonStreams('streamvix',     addonId, type, season, episode),
      fetchAddonStreams('hdhub',         addonId, type, season, episode),
      fetchSubtitles(wyzieId, type, season, episode),
    ]);

    const streams = (r) =>
      r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];

    const allSources = deduplicate(sortSources([
      ...streams(webstreamrmbgR),
      ...streams(nebulastreamR),
      ...streams(yukistreamsR),
      ...streams(cinescrapeR),
      ...streams(muviboxR),
      ...streams(murphystreamsR),
      ...streams(streamvixR),
      ...streams(hdhubR),
    ]));

    const subtitles = subtitlesR.status === 'fulfilled' ? subtitlesR.value : [];

    const addonResults = {
      WebStreamrMBG: webstreamrmbgR,
      NebulaStreams:  nebulastreamR,
      YukiStreams:    yukistreamsR,
      Cinescrape:     cinescrapeR,
      Muvibox:        muviboxR,
      MurphyStreams:  murphystreamsR,
      StreamVix:      streamvixR,
      HdHub:          hdhubR,
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
  console.log(`WebStreamrMBG config: ${WEBSTREAMR_CONFIG}`);
});
