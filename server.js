require('dotenv').config()
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const WYZIE_API_KEY = process.env.WYZIE_API_KEY || 'wyzie-31quwwdy6ny9brfw6s2z0y3dc6satp5q';

// ─── Addon Config ────────────────────────────────────────────────────────────
const ADDONS = {
  pengu: {
    base: 'https://pengu.uk/%7B%22auth_token%22%3A%22HPlQJiXq5kVlkfrX5yZUKmrt0G0ojVIxMVYV053gzVA%22%7D',
    name: 'Pengu',
    timeout: 30000,
    requiresImdbId: true,
  },
  hdhub: {
    base: 'https://hdhub.thevolecitor.qzz.io/eyJ0b3Jib3giOiJ1bnNldCIsInF1YWxpdGllcyI6IjIxNjBwLDEwODBwLDcyMHAiLCJzb3J0IjoiZGVzYyIsImNhdGFsb2dzIjoiIn0',
    name: 'HdHub',
    timeout: 10000,
    requiresImdbId: true,
  },
  dexter: {
    base: 'https://dexter.q-1208.fun',
    name: 'Dexter',
    timeout: 20000,
    requiresImdbId: true,
  },
  hyper: {
    base: 'https://hyper.stravo.site/local:en',
    name: 'Hyper',
    timeout: 20000,
    requiresImdbId: true,
  },
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

// ─── Anime List Cache (Fribb) ─────────────────────────────────────────────────
let animeListCache     = null;
let animeListCacheTime = 0;
const ANIME_LIST_TTL   = 24 * 60 * 60 * 1000;

async function getAnimeList() {
  if (animeListCache && Date.now() - animeListCacheTime < ANIME_LIST_TTL) {
    return animeListCache;
  }
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json',
      { signal: controller.signal }
    );
    clearTimeout(to);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    animeListCache     = await res.json();
    animeListCacheTime = Date.now();
    console.log(`Fribb anime-list loaded (${animeListCache.length} entries)`);
    return animeListCache;
  } catch (err) {
    clearTimeout(to);
    console.warn('Fribb anime-list fetch failed:', err.message);
    return animeListCache || [];
  }
}

// ─── TMDB → IMDB Resolution + Anime Detection ────────────────────────────────
const idCache = new Map();

async function resolveId(tmdbId, type) {
  const cacheKey = `${type}:${tmdbId}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);

  if (!TMDB_API_KEY) {
    console.warn('⚠  No TMDB_API_KEY — subtitles will likely be empty');
    const fallback = { addonId: `tmdb:${tmdbId}`, wyzieId: tmdbId, isAnime: false, kitsuId: null };
    idCache.set(cacheKey, fallback);
    return fallback;
  }

  const tmdbType = type === 'tv' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    const data = await res.json();

    const imdbId = data.external_ids?.imdb_id || data.imdb_id || null;

    const isAnimation = (data.genres || []).some(g => g.id === 16);
    const isJapanese  = type === 'tv'
      ? (data.origin_country || []).includes('JP')
      : (data.production_countries || []).some(c => c.iso_3166_1 === 'JP');
    const isAnime = isAnimation && isJapanese;

    let kitsuId = null;
    if (isAnime) {
      try {
        const list  = await getAnimeList();
        const entry = list.find(a =>
          String(a.themoviedb_id) === String(tmdbId) ||
          (imdbId && a.imdb_id === imdbId)
        );
        if (entry?.kitsu_id) {
          kitsuId = entry.kitsu_id;
        }
      } catch (err) {
        console.warn('Kitsu ID lookup failed:', err.message);
      }
    }

    if (imdbId) {
      const result = { addonId: imdbId, wyzieId: imdbId, isAnime, kitsuId };
      idCache.set(cacheKey, result);
      return result;
    }
  } catch (err) {
    console.error('TMDB resolution failed:', err.message);
  }

  const fallback = { addonId: `tmdb:${tmdbId}`, wyzieId: tmdbId, isAnime: false, kitsuId: null };
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

function stripZipExtension(url) {
  if (!url) return url;
  return url.replace(/\.zip(\?.*)?$/, (_, qs) => (qs || ''));
}

function isLockedNoTorrentStream(addonKey, stream) {
  if (addonKey !== 'notorrent') return false;
  return `${stream.name || ''} ${stream.title || ''}`.includes('🔒');
}

async function wakePing(base) {
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 5000);
    await fetch(`${base}/`, { signal: controller.signal });
    clearTimeout(to);
  } catch (_) {}
}

// ─── Fetch Streams from a Single Addon ───────────────────────────────────────
async function fetchAddonStreams(addonKey, ids, type, season, episode) {
  const addon = ADDONS[addonKey];
  let streamId = ids.wyzieId;

  if (addon.requiresImdbId) {
    const valid = String(streamId).startsWith('tt') || String(streamId).startsWith('kitsu:');
    if (!valid) throw new Error(`skipped — no usable ID (got "${streamId}")`);
  }

  const idPart      = type === 'tv' ? `${streamId}:${season}:${episode}` : streamId;
  const contentType = type === 'tv' ? 'series' : 'movie';
  const addonTimeout = addon.timeout ?? 8000;

  async function tryBase(base, retries = 2) {
    if (addon.wakeBeforeFetch) wakePing(base);

    const url = `${base}/stream/${contentType}/${idPart}.json`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), addonTimeout);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(to);
        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.streams || !Array.isArray(data.streams)) return [];
        return data.streams;
      } catch (err) {
        clearTimeout(to);
        if (attempt < retries && err.name !== 'AbortError') {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw err;
      }
    }
  }

  let rawStreams = await tryBase(addon.base);

  return rawStreams
    .filter((s) => {
      if (!s.url) return false;
      if (!s.url.startsWith('http://') && !s.url.startsWith('https://')) return false;
      if (isLockedNoTorrentStream(addonKey, s)) return false;
      return true;
    })
    .map((s) => {
      const qualityText = `${s.name || ''} ${s.title || ''}`;
      const rawUrl      = fixHostname(stripZipExtension(s.url));
      const streamType  = inferStreamType(rawUrl);
      const baseLabel   = `${addon.name} • ${s.title || s.name || 'Unknown'}`;
      const quality     = parseQuality(qualityText);

      return {
        url:     rawUrl,
        type:    streamType,
        label:   baseLabel,
        quality,
        addon:   addonKey,
      };
    });
}

// ─── Subtitles ────────────────────────────────────────────────────────────────
// ─── Subtitles (Wyzie Direct API) ─────────────────────────────────────────────
async function fetchSubtitles(wyzieId, type, season, episode) {
  if (!WYZIE_API_KEY) {
    console.warn('⚠  WYZIE_API_KEY not set — subtitles will be empty');
    return [];
  }

  // Ensure wyzieId is clean (strip any accidental prefixes like "tmdb:")
  const cleanId = String(wyzieId).replace(/^(tmdb|kitsu):/, '');

  let url = `${WYZIE_BASE}/search?id=${encodeURIComponent(cleanId)}&format=srt,vtt,ass&key=${WYZIE_API_KEY}`;
  if (type === 'tv' && season && episode) {
    url += `&season=${season}&episode=${episode}`;
  }

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(to);
    
    // Check for specific API error codes from documentation
    if (res.status === 402) {
      console.error('Wyzie Error 402: Pro balance exhausted.');
      return [];
    }
    if (res.status === 429) {
      console.error('Wyzie Error 429: Free key daily cap of 1,000 requests exceeded.');
      return [];
    }
    if (res.status === 403) {
      console.error('Wyzie Error 403: Invalid API key or key on hold.');
      return [];
    }
    if (!res.ok) {
      throw new Error(`Wyzie HTTP ${res.status}: ${res.statusText}`);
    }

    const raw  = await res.json();
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];

    if (list.length === 0) return [];

    const seenNonEn  = new Set();
    const seenEnKeys = new Set();
    const unique     = [];

    for (const sub of list) {
      const lang = (sub.language || sub.lang || '').toLowerCase();
      if (!lang) continue;
      
      const isHI    = !!(sub.isHearingImpaired || sub.isHI);
      const display = sub.display || sub.language || sub.lang || '';
      
      // Ensure download URL automatically converts non-VTT formats to browser-safe VTT if requested, 
      // or preserve original URL as provided by Wyzie /c/... with encrypted tok parameter.
      let subUrl = sub.url;
      if (subUrl && !subUrl.includes('to=vtt') && (sub.format === 'ass' || sub.format === 'srt')) {
        subUrl += (subUrl.includes('?') ? '&' : '?') + 'to=vtt';
      }

      if (lang.startsWith('en')) {
        const key = `${lang}|${isHI}|${display.toLowerCase()}`;
        if (seenEnKeys.has(key)) continue;
        seenEnKeys.add(key);
      } else {
        if (seenNonEn.has(lang)) continue;
        seenNonEn.add(lang);
      }

      unique.push({ 
        url: subUrl, 
        lang: sub.language || sub.lang || '', 
        display, 
        format: 'vtt', // normalized for player compatibility
        isHI 
      });
    }

    unique.sort((a, b) => {
      const aEn = a.lang.toLowerCase().startsWith('en') ? 0 : 1;
      const bEn = b.lang.toLowerCase().startsWith('en') ? 0 : 1;
      if (aEn !== bEn) return aEn - bEn;
      if (aEn === 0 && bEn === 0 && a.isHI !== b.isHI) return a.isHI ? 1 : -1;
      return (a.display || '').localeCompare(b.display || '');
    });

    return unique.slice(0, 20);
  } catch (err) {
    clearTimeout(to);
    console.error('Wyzie fetch failed:', err.message);
    return [];
  }
}


// ─── Big File Detection & Sorting ────────────────────────────────────────────
function isBigFile(label) {
  const match = label.match(/(\d+(?:\.\d+)?)\s*GB/i);
  return match ? parseFloat(match[1]) >= 5 : false;
}

const ADDON_ORDER = {
  pengu:  0,
  hdhub:  1,
  dexter: 2,
  hyper:  3,
};

function sortSources(sources) {
  return sources.sort((a, b) => {
    const aBig = isBigFile(a.label) ? 1 : 0;
    const bBig = isBigFile(b.label) ? 1 : 0;
    if (aBig !== bBig) return aBig - bBig;
    const qa = QUALITY_ORDER[a.quality] ?? 3;
    const qb = QUALITY_ORDER[b.quality] ?? 3;
    if (qa !== qb) return qa - qb;
    return (ADDON_ORDER[a.addon] ?? 9) - (ADDON_ORDER[b.addon] ?? 9);
  });
}

function deduplicate(sources) {
  const seen = new Set();
  return sources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

function filter4K(sources) {
  return sources.filter(s => s.quality !== '4k');
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok:        true,
    timestamp: Date.now(),
    wyzieKey:  WYZIE_API_KEY ? '✓ set' : '✗ not set',
    tmdbKey:   TMDB_API_KEY  ? '✓ set' : '✗ not set',
  });
});

app.get('/api/streams', async (req, res) => {
  const { tmdbId, type, season, episode } = req.query;

  if (!tmdbId || !type) {
    return res.json({ resolvedId: null, sources: [], subtitles: [], error: 'Missing required query params: tmdbId, type' });
  }
  if (type === 'tv' && (!season || !episode)) {
    return res.json({ resolvedId: null, sources: [], subtitles: [], error: 'Missing required query params for TV: season, episode' });
  }

  try {
    const ids = await resolveId(tmdbId, type);

    const [
      penguR,
      hdhubR,
      dexterR,
      hyperR,
      subtitlesR,
    ] = await Promise.allSettled([
      fetchAddonStreams('pengu',  ids, type, season, episode),
      fetchAddonStreams('hdhub',  ids, type, season, episode),
      fetchAddonStreams('dexter', ids, type, season, episode),
      fetchAddonStreams('hyper',  ids, type, season, episode),
      fetchSubtitles(ids.wyzieId, type, season, episode),
    ]);

    const streams = r => r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];

    const allSources = filter4K(deduplicate(sortSources([
      ...streams(penguR),
      ...streams(hdhubR),
      ...streams(dexterR),
      ...streams(hyperR),
    ])));

    const subtitles = subtitlesR.status === 'fulfilled' ? subtitlesR.value : [];

    const addonResults = {
      Pengu:  penguR,
      HdHub:  hdhubR,
      Dexter: dexterR,
      Hyper:  hyperR,
    };

    const errors = Object.entries(addonResults)
      .filter(([, r]) => r.status === 'rejected' || r.value === null)
      .map(([name, r]) => {
        const msg = r.status === 'rejected' ? (r.reason?.message || 'unknown error') : 'returned null';
        return `${name}: ${msg}`;
      });

    if (subtitlesR.status === 'rejected') {
      errors.push(subtitlesR.reason?.message || 'Subtitles: unknown error');
    }
    if (allSources.length === 0 && errors.length > 0) {
      errors.push('No streams available');
    }

    res.json({
      resolvedId: ids.addonId,
      isAnime:    ids.isAnime,
      kitsuId:    ids.kitsuId,
      sources:    allSources,
      subtitles,
      error: errors.length > 0 ? errors.join('; ') : null,
    });
  } catch (err) {
    console.error('Unhandled error in /api/streams:', err);
    res.json({ resolvedId: null, sources: [], subtitles: [], error: err.message || 'Internal server error' });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Resolver listening on http://localhost:${PORT}`);
  console.log(`Wyzie key : ${WYZIE_API_KEY ? '✓ set' : '⚠  not set'}`);
  console.log(`TMDB key  : ${TMDB_API_KEY  ? '✓ set' : '⚠  not set'}`);
  getAnimeList().catch(() => {});
});

