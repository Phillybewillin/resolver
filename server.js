require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// ─── Addon Config ────────────────────────────────────────────────────────────
const ADDONS = {
  nuvio: { base: 'https://nuviostreams.hayd.uk', name: 'NuvioStreams' },
  webstreamr: { base: 'https://webstreamr.hayd.uk', name: 'WebStreamr' },
};

const WYZIE_BASE = 'https://sub.wyzie.ru';

// ─── TMDB → IMDB Resolution Cache ───────────────────────────────────────────
const idCache = new Map();

async function resolveId(tmdbId, type) {
  const cacheKey = `${type}:${tmdbId}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);

  if (!TMDB_API_KEY) {
    const fallback = `tmdb:${tmdbId}`;
    idCache.set(cacheKey, { addonId: fallback, wyzieId: tmdbId });
    return { addonId: fallback, wyzieId: tmdbId };
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
  } catch (err) {
    console.error('TMDB resolution failed:', err.message);
  }

  // Fallback: use tmdb:xxx for addons and raw number for Wyzie
  const fallback = { addonId: `tmdb:${tmdbId}`, wyzieId: tmdbId };
  idCache.set(cacheKey, fallback);
  return fallback;
}

// ─── Quality Parsing ─────────────────────────────────────────────────────────
const QUALITY_ORDER = { '4k': 0, '1080p': 1, '720p': 2, '480p': 3, auto: 4 };

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
async function fetchAddonStreams(addonKey, addonId, type, season, episode) {
  const addon = ADDONS[addonKey];
  const idPart =
    type === 'tv' ? `${addonId}:${season}:${episode}` : addonId;
  const contentType = type === 'tv' ? 'series' : 'movie';
  const url = `${addon.base}/stream/${contentType}/${idPart}.json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`${addon.name} HTTP ${res.status}`);
    const data = await res.json();

    if (!data.streams || !Array.isArray(data.streams)) return [];

    return data.streams.map((s) => {
      const qualityText = `${s.name || ''} ${s.title || ''}`;
      return {
        url: s.url,
        type: inferStreamType(s.url),
        label: `${addon.name} • ${s.title || s.name || 'Unknown'}`,
        quality: parseQuality(qualityText),
        addon: addonKey,
      };
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error(`${addon.name} fetch failed:`, err.message);
    return null; // signal failure
  }
}

// ─── Fetch Subtitles from Wyzie ──────────────────────────────────────────────
async function fetchSubtitles(wyzieId, type, season, episode) {
  let url = `${WYZIE_BASE}/search?id=${wyzieId}&format=srt&encoding=utf-8`;
  if (type === 'tv') url += `&season=${season}&episode=${episode}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Wyzie HTTP ${res.status}`);
    const data = await res.json();

    if (!Array.isArray(data)) return [];

    // Deduplicate by lang code – keep first occurrence
    const seen = new Set();
    const unique = [];
    for (const sub of data) {
      const lang = (sub.lang || '').toLowerCase();
      if (seen.has(lang)) continue;
      seen.add(lang);
      unique.push({
        url: sub.url,
        lang: sub.lang || '',
        display: sub.display || sub.lang || '',
        format: sub.format || 'srt',
        isHI: !!sub.isHI,
      });
    }

    // Sort: English first, then alphabetical by display
    unique.sort((a, b) => {
      const aEn = a.lang.toLowerCase() === 'en' ? 0 : 1;
      const bEn = b.lang.toLowerCase() === 'en' ? 0 : 1;
      if (aEn !== bEn) return aEn - bEn;
      return (a.display || '').localeCompare(b.display || '');
    });

    return unique.slice(0, 20);
  } catch (err) {
    clearTimeout(timeout);
    console.error('Wyzie fetch failed:', err.message);
    return []; // silent failure
  }
}

// ─── Big File Detection ──────────────────────────────────────────────────────
function isBigFile(label) {
  // Match sizes like "26.33 GB" — anything ≥ 5 GB is considered a big raw file
  const match = label.match(/(\d+(?:\.\d+)?)\s*GB/i);
  if (!match) return false;
  return parseFloat(match[1]) >= 5;
}

// ─── Sort Merged Sources ─────────────────────────────────────────────────────
function sortSources(sources) {
  const addonOrder = { nuvio: 0, webstreamr: 1 };
  return sources.sort((a, b) => {
    // Big raw files always go to the bottom
    const aBig = isBigFile(a.label) ? 1 : 0;
    const bBig = isBigFile(b.label) ? 1 : 0;
    if (aBig !== bBig) return aBig - bBig;

    const qa = QUALITY_ORDER[a.quality] ?? 4;
    const qb = QUALITY_ORDER[b.quality] ?? 4;
    if (qa !== qb) return qa - qb;
    return (addonOrder[a.addon] ?? 2) - (addonOrder[b.addon] ?? 2);
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.get('/api/streams', async (req, res) => {
  const { tmdbId, type, season, episode } = req.query;

  // Validate input
  if (!tmdbId || !type) {
    return res.json({
      resolvedId: null,
      sources: [],
      subtitles: [],
      error: 'Missing required query params: tmdbId, type',
    });
  }

  if (type === 'tv' && (!season || !episode)) {
    return res.json({
      resolvedId: null,
      sources: [],
      subtitles: [],
      error: 'Missing required query params for TV: season, episode',
    });
  }

  try {
    // Phase 1: resolve TMDB → IMDB (cached after first call)
    const { addonId, wyzieId } = await resolveId(tmdbId, type);

    // Phase 2: fetch streams + subtitles in parallel
    const [nuvioResult, webstreamrResult, subtitlesResult] =
      await Promise.allSettled([
        fetchAddonStreams('nuvio', addonId, type, season, episode),
        fetchAddonStreams('webstreamr', addonId, type, season, episode),
        fetchSubtitles(wyzieId, type, season, episode),
      ]);

    // Collect sources
    const nuvioStreams =
      nuvioResult.status === 'fulfilled' && nuvioResult.value
        ? nuvioResult.value
        : [];
    const webstreamrStreams =
      webstreamrResult.status === 'fulfilled' && webstreamrResult.value
        ? webstreamrResult.value
        : [];

    const allSources = sortSources([...nuvioStreams, ...webstreamrStreams]);

    // Collect subtitles
    const subtitles =
      subtitlesResult.status === 'fulfilled' ? subtitlesResult.value : [];

    // Build error string
    const errors = [];
    if (
      nuvioResult.status === 'rejected' ||
      (nuvioResult.status === 'fulfilled' && nuvioResult.value === null)
    ) {
      errors.push('NuvioStreams failed');
    }
    if (
      webstreamrResult.status === 'rejected' ||
      (webstreamrResult.status === 'fulfilled' &&
        webstreamrResult.value === null)
    ) {
      errors.push('WebStreamr failed');
    }
    if (allSources.length === 0 && errors.length > 0) {
      errors.push('No streams available');
    }

    res.json({
      resolvedId: addonId,
      sources: allSources,
      subtitles,
      error: errors.length > 0 ? errors.join('; ') : null,
    });
  } catch (err) {
    console.error('Unhandled error in /api/streams:', err);
    res.json({
      resolvedId: null,
      sources: [],
      subtitles: [],
      error: err.message || 'Internal server error',
    });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Resolver listening on http://localhost:${PORT}`);
  if (!TMDB_API_KEY) {
    console.warn('⚠  TMDB_API_KEY is not set — ID resolution will use fallback');
  }
});
