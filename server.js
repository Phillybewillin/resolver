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

// ─── Worker Proxy Wrapper ─────────────────────────────────────────────────────
// Alternative HLS proxy — always available, no password needed.
const WORKER_PROXY_BASE = 'https://mvbx.kuenastar141.workers.dev/proxy.php';

function wrapWithWorkerProxy(streamUrl) {
  if (!streamUrl) return null;
  const out = new URL(WORKER_PROXY_BASE);
  out.searchParams.set('url', streamUrl);
  return out.toString();
}

// ─── Addon Config ────────────────────────────────────────────────────────────
function buildWebStreamrConfig() {
  return encodeURIComponent(JSON.stringify({ multi: 'on' }));
}

const WEBSTREAMR_CONFIG = process.env.WEBSTREAMR_CONFIG || buildWebStreamrConfig();

// All addons use requiresImdbId: true — everything gets the tt-prefixed IMDB ID.
// Addons with supportsAnimeId: true also accept kitsu:{id} for detected anime.
const ADDONS = {
  webstreamrmbg: {
    base: `https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club/${WEBSTREAMR_CONFIG}`,
    name: 'WebStreamrMBG',
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
    requiresImdbId: true,
  },
  cinescrape: {
    base: 'https://bc48e59c61df-cinescrape-docker.baby-beamup.club',
    name: 'Cinescrape',
    timeout: 30000,
    requiresImdbId: true,
  },
  muvibox: {
    base: 'https://mvtmdb.netlify.app',
    name: 'Muvibox',
    timeout: 15000,
    requiresImdbId: true,
  },
  flixstreams: {
    base: 'https://flixnest.app/flix-streams',
    name: 'FlixStreams',
    timeout: 30000,
    requiresImdbId: true,
    supportsAnimeId: true,  // accepts kitsu:{id} for anime content
  },
  murphystreams: {
    base: 'https://badboysxs-morpheus.hf.space/bWIsbm0sZGYsaGgsa2gsa20sYXcsaG0',
    name: 'MurphyStreams',
    timeout: 30000,
    wakeBeforeFetch: true,
    requiresImdbId: true,
  },
  streamvix: {
    base: 'https://streamvix.hayd.uk',
    name: 'StreamVix',
    timeout: 20000,
    requiresImdbId: true,  // standardised to tt prefix
  },
  hdhub: {
    base: 'https://hdhub.thevolecitor.qzz.io',
    name: 'HdHub',
    timeout: 10000,
    requiresImdbId: true,  // standardised to tt prefix
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
// Maps themoviedb_id / imdb_id → kitsu_id, mal_id, etc.
// Cached for 24 h; stale cache is returned on fetch failure so streams still work.
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
// Returns { addonId, wyzieId, isAnime, kitsuId }
// addonId / wyzieId are the IMDB tt-ID when resolved, or tmdb:{id} fallback.
// isAnime is true when content is Animation genre + Japanese origin.
// kitsuId is the Kitsu numeric ID for anime (null if not found).
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
  // Single TMDB call: details + external IDs in one request.
  const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    const data = await res.json();

    const imdbId = data.external_ids?.imdb_id || data.imdb_id || null;

    // ── Anime detection ──────────────────────────────────────────────────────
    // Animation genre (id 16) + Japanese origin.
    const isAnimation = (data.genres || []).some(g => g.id === 16);
    const isJapanese  = type === 'tv'
      ? (data.origin_country || []).includes('JP')
      : (data.production_countries || []).some(c => c.iso_3166_1 === 'JP');
    const isAnime = isAnimation && isJapanese;

    // ── Kitsu ID (anime only) ─────────────────────────────────────────────────
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
          console.log(`Anime detected: ${data.name || data.title} — kitsu:${kitsuId}`);
        } else {
          console.log(`Anime detected: ${data.name || data.title} — no Kitsu entry found`);
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

    console.warn(`⚠  TMDB returned no imdb_id for ${tmdbType}/${tmdbId}`);
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

// ─── .zip URL Fix ─────────────────────────────────────────────────────────────
function stripZipExtension(url) {
  if (!url) return url;
  return url.replace(/\.zip(\?.*)?$/, (_, qs) => (qs || ''));
}

// ─── NoTorrent Locked Stream Filter ──────────────────────────────────────────
function isLockedNoTorrentStream(addonKey, stream) {
  if (addonKey !== 'notorrent') return false;
  return `${stream.name || ''} ${stream.title || ''}`.includes('🔒');
}

// ─── YukiStreams Dummy Stream Filter ──────────────────────────────────────────
// YukiStreams returns placeholder streams that play a 5-second "no streams"
// loop. These are identified by known dummy URL patterns and title strings.
// Add more patterns here as they're discovered.
const YUKI_DUMMY_PATTERNS = [
  /no.?streams?.?found/i,
  /not.?available/i,
  /coming.?soon/i,
  /placeholder/i,
];
const YUKI_DUMMY_URL_PATTERNS = [
  /loop/i,
  /dummy/i,
  /placeholder/i,
  /error/i,
];

function isYukiDummyStream(addonKey, stream) {
  if (addonKey !== 'yukistreams') return false;
  const text = `${stream.name || ''} ${stream.title || ''}`;
  if (YUKI_DUMMY_PATTERNS.some(p => p.test(text))) return true;
  if (stream.url && YUKI_DUMMY_URL_PATTERNS.some(p => p.test(stream.url))) return true;
  return false;
}

// ─── Wake Ping ───────────────────────────────────────────────────────────────
async function wakePing(base) {
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 5000);
    await fetch(`${base}/`, { signal: controller.signal });
    clearTimeout(to);
  } catch (_) {}
}

// ─── Fetch Streams from a Single Addon ───────────────────────────────────────
// ids: { addonId, wyzieId, isAnime, kitsuId }
async function fetchAddonStreams(addonKey, ids, type, season, episode) {
  const addon = ADDONS[addonKey];

  // Pick the best ID for this addon:
  //   supportsAnimeId + anime content → kitsu:{id}
  //   everything else                 → tt-prefixed wyzieId
  let streamId;
  if (addon.supportsAnimeId && ids.isAnime && ids.kitsuId) {
    streamId = `kitsu:${ids.kitsuId}`;
  } else {
    streamId = ids.wyzieId;
  }

  // Guard: skip if we need a real IMDB/Kitsu ID but don't have one.
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
          console.warn(`${addon.name} got ${res.status}, retrying (attempt ${attempt + 1})…`);
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
      if (!s.url.startsWith('http://') && !s.url.startsWith('https://')) return false;
      if (isLockedNoTorrentStream(addonKey, s)) return false;
      if (isYukiDummyStream(addonKey, s)) return false;
      return true;
    })
    .flatMap((s) => {
      const qualityText = `${s.name || ''} ${s.title || ''}`;
      const rawUrl      = fixHostname(stripZipExtension(s.url));
      const streamType  = inferStreamType(rawUrl);
      const baseLabel   = `${addon.name} • ${s.title || s.name || 'Unknown'}`;
      const quality     = parseQuality(qualityText);
      const isHls       = streamType === 'hls';

      const entries = [];

      // 1 — Unproxied (always included)
      entries.push({
        url:     rawUrl,
        type:    streamType,
        label:   `${baseLabel} • Unproxied`,
        quality,
        addon:   addonKey,
      });

      // 2 — MediaFlow proxy (HLS only, requires MEDIAFLOW_PROXY_URL)
      if (isHls && MEDIAFLOW_PROXY_URL) {
        entries.push({
          url:     wrapWithProxy(rawUrl),
          type:    streamType,
          label:   `${baseLabel} • Proxy M`,
          quality,
          addon:   addonKey,
        });
      }

      // 3 — Worker proxy (HLS only, always available)
      if (isHls) {
        entries.push({
          url:     wrapWithWorkerProxy(rawUrl),
          type:    streamType,
          label:   `${baseLabel} • Proxy W`,
          quality,
          addon:   addonKey,
        });
      }

      return entries;
    });
}

// ─── Subtitles ────────────────────────────────────────────────────────────────
async function fetchSubtitles(wyzieId, type, season, episode) {
  if (!String(wyzieId).startsWith('tt')) {
    console.warn(`⚠  Wyzie lookup using raw ID "${wyzieId}" — expect empty results`);
  }
  if (!WYZIE_API_KEY) {
    console.warn('⚠  WYZIE_API_KEY not set — get a free key at https://sub.wyzie.io/redeem');
    return [];
  }

  let url = `${WYZIE_BASE}/search?id=${encodeURIComponent(wyzieId)}&key=${WYZIE_API_KEY}`;
  if (type === 'tv') url += `&season=${season}&episode=${episode}`;

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(to);
    if (!res.ok) throw new Error(`Wyzie HTTP ${res.status}: ${res.statusText}`);

    const raw  = await res.json();
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];

    const WEB_FORMATS = new Set(['srt', 'vtt']);
    const compatible  = list.filter(sub => WEB_FORMATS.has((sub.format || '').toLowerCase()));

    if (compatible.length === 0) return [];

    const seenNonEn  = new Set();
    const seenEnKeys = new Set();
    const unique     = [];

    for (const sub of compatible) {
      const lang = (sub.language || sub.lang || '').toLowerCase();
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
      unique.push({ url: sub.url, lang: sub.language || sub.lang || '', display, format: sub.format || 'srt', isHI });
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
    throw new Error(`Wyzie: ${err.message}`);
  }
}

// ─── Big File Detection ──────────────────────────────────────────────────────
function isBigFile(label) {
  const match = label.match(/(\d+(?:\.\d+)?)\s*GB/i);
  return match ? parseFloat(match[1]) >= 5 : false;
}

// ─── Addon Sort Weight ───────────────────────────────────────────────────────
const ADDON_ORDER = {
  webstreamrmbg: 0,
  nebulastreams:  1,
  yukistreams:    2,
  cinescrape:     3,
  muvibox:        4,
  flixstreams:    5,
  murphystreams:  6,
  streamvix:      7,
  hdhub:          8,
};

// ─── Sort + Deduplicate + Filter ─────────────────────────────────────────────
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
    // Key on raw url so proxied variants of the same stream don't both appear.
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// Drop 4K — TV max is 1080p; keeping 4K streams wastes bandwidth and UI space.
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
    // ids = { addonId, wyzieId, isAnime, kitsuId }

    if (ids.isAnime) {
      console.log(`Anime content — kitsuId: ${ids.kitsuId ?? 'none'} — FlixStreams will use ${ids.kitsuId ? `kitsu:${ids.kitsuId}` : ids.wyzieId}`);
    }

    const [
      webstreamrmbgR,
      nebulastreamR,
      yukistreamsR,
      cinescrapeR,
      muviboxR,
      flixstreamsR,
      murphystreamsR,
      streamvixR,
      hdhubR,
      subtitlesR,
    ] = await Promise.allSettled([
      fetchAddonStreams('webstreamrmbg', ids, type, season, episode),
      fetchAddonStreams('nebulastreams',  ids, type, season, episode),
      fetchAddonStreams('yukistreams',    ids, type, season, episode),
      fetchAddonStreams('cinescrape',     ids, type, season, episode),
      fetchAddonStreams('muvibox',        ids, type, season, episode),
      fetchAddonStreams('flixstreams',    ids, type, season, episode),
      fetchAddonStreams('murphystreams',  ids, type, season, episode),
      fetchAddonStreams('streamvix',      ids, type, season, episode),
      fetchAddonStreams('hdhub',          ids, type, season, episode),
      fetchSubtitles(ids.wyzieId, type, season, episode),
    ]);

    const streams = r => r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];

    const allSources = filter4K(deduplicate(sortSources([
      ...streams(webstreamrmbgR),
      ...streams(nebulastreamR),
      ...streams(yukistreamsR),
      ...streams(cinescrapeR),
      ...streams(muviboxR),
      ...streams(flixstreamsR),
      ...streams(murphystreamsR),
      ...streams(streamvixR),
      ...streams(hdhubR),
    ])));

    const subtitles = subtitlesR.status === 'fulfilled' ? subtitlesR.value : [];

    const addonResults = {
      WebStreamrMBG: webstreamrmbgR,
      NebulaStreams:  nebulastreamR,
      YukiStreams:    yukistreamsR,
      Cinescrape:     cinescrapeR,
      Muvibox:        muviboxR,
      FlixStreams:    flixstreamsR,
      MurphyStreams:  murphystreamsR,
      StreamVix:      streamvixR,
      HdHub:          hdhubR,
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
  console.log(`TMDB key  : ${TMDB_API_KEY  ? '✓ set' : '⚠  not set — ID resolution + anime detection disabled'}`);
  console.log(`WebStreamrMBG config: ${WEBSTREAMR_CONFIG}`);
  // Pre-warm the anime list on startup so the first anime request isn't slow.
  getAnimeList().catch(() => {});
});
