'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const text = fs.readFileSync(envPath, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const clean = String(line || '').trim();
    if (!clean || clean.startsWith('#')) return;

    const eqIdx = clean.indexOf('=');
    if (eqIdx === -1) return;

    const key = clean.slice(0, eqIdx).trim();
    let value = clean.slice(eqIdx + 1).trim();
    if (!key || process.env[key] != null) return;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
}

loadLocalEnv();

const app = express();
const PORT = process.env.PORT || 3000;

const SHEET_ID = String(process.env.GOOGLE_SHEET_ID || '').trim();
const CACHE_TTL_MS = Math.max(15_000, Number(process.env.SHEET_CACHE_TTL_MS || 1000 * 60 * 5));
const SMUG_API_KEY = String(process.env.SMUG_API_KEY || '').trim();
const SMUG_NICKNAME = String(process.env.SMUG_NICKNAME || 'vmpix').trim();
const SMUG_TOTAL_PHOTOS_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.SMUG_TOTAL_PHOTOS_CACHE_TTL_MS || 1000 * 60 * 60 * 12) || 1000 * 60 * 60 * 12
);
const cache = new Map();
const smugTotalPhotosCache = new Map();
const smugTotalPhotosInFlight = new Map();

const ROUTES = {
  '/api/music/bands': { label: 'Music-Bands', gidEnv: 'GID_MUSIC_BANDS' },
  '/api/music/shows': { label: 'Music-Shows', gidEnv: 'GID_MUSIC_SHOWS' },
  '/api/music/people': { label: 'Music-People', gidEnv: 'GID_MUSIC_PEOPLE' },
  '/api/music/venues': { label: 'Music-Venue', gidEnv: 'GID_MUSIC_VENUES' },
  '/api/wrestling/shows': { label: 'Wrestling-Shows', gidEnv: 'GID_WRESTLING_SHOWS' },
  '/api/wrestling/people': { label: 'Wrestling-People', gidEnv: 'GID_WRESTLING_PEOPLE' },
  '/api/wrestling/venues': { label: 'Wrestling-Venue', gidEnv: 'GID_WRESTLING_VENUES' },
  '/api/stats': { label: 'Stats', gidEnv: 'GID_STATS' }
};

function allowCors(req, res, next) {
  const origin = req.headers.origin || '';
  const allowList = String(process.env.CORS_ALLOW_ORIGINS || '')
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (origin && allowList.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') return res.status(204).send('');
  return next();
}

app.use(allowCors);

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }

  out.push(cur);
  return out;
}

function normalizeKey(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsv(csvText) {
  const raw = String(csvText || '').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((line) => String(line || '').trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };

  const originalHeaders = parseCsvLine(lines[0]).map((h) => String(h || '').trim());
  const headers = originalHeaders.map(normalizeKey);

  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const obj = {};
    headers.forEach((key, idx) => {
      if (!key) return;
      obj[key] = String(cells[idx] ?? '').trim();
    });
    return obj;
  });

  return { headers: originalHeaders, normalizedHeaders: headers, rows };
}

function getCsvUrl(gid) {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID environment variable.');
  if (!String(gid || '').trim()) throw new Error('Missing tab GID environment variable.');
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}/export?format=csv&gid=${encodeURIComponent(String(gid).trim())}`;
}

function formatEasternGeneratedTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);
}

function buildSmugApiUrl(endpoint) {
  const joiner = String(endpoint || '').includes('?') ? '&' : '?';
  return `https://api.smugmug.com/api/v2${endpoint}${joiner}APIKey=${encodeURIComponent(SMUG_API_KEY)}`;
}

async function fetchSmugJson(endpoint) {
  const res = await fetch(buildSmugApiUrl(endpoint), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'VMPix-V3-Data/1.0'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`SmugMug returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }

  return res.json();
}

function getSmugAlbums(json) {
  const resp = json && json.Response ? json.Response : json;
  const albums = resp && (resp.Album || resp.Albums || resp.album || resp.albums);
  if (Array.isArray(albums)) return albums;
  return albums && typeof albums === 'object' ? [albums] : [];
}

function getSmugAlbumImageCount(album) {
  const keys = ['ImageCount', 'imageCount', 'image_count', 'PhotoCount', 'photoCount', 'photo_count', 'TotalPhotos', 'totalPhotos', 'TotalImages', 'totalImages'];
  for (const key of keys) {
    const count = Number(album && album[key]);
    if (Number.isFinite(count) && count >= 0) return count;
  }

  const stats = album && album.Stats && typeof album.Stats === 'object' ? album.Stats : null;
  if (stats) return getSmugAlbumImageCount(stats);
  return null;
}

function getSmugAlbumKey(album) {
  const keys = ['AlbumKey', 'albumKey', 'Key', 'key'];
  for (const key of keys) {
    const value = String(album && album[key] || '').trim();
    if (value) return value;
  }

  const candidates = [
    album && album.Uri,
    album && album.URI,
    album && album.Url,
    album && album.URL,
    album && album.WebUri,
    album && album.Uris && album.Uris.Album && album.Uris.Album.Uri,
    album && album.Uris && album.Uris.Album && album.Uris.Album.URI
  ];

  for (const candidate of candidates) {
    const match = String(candidate || '').match(/\/album\/([^/?#]+)/i);
    if (match && match[1]) return match[1];
  }

  return '';
}

function getSmugAlbumImages(json) {
  const resp = json && json.Response ? json.Response : json;
  const images = resp && (resp.AlbumImage || resp.AlbumImages || resp.Images || resp.images);
  if (Array.isArray(images)) return images;
  return images && typeof images === 'object' ? [images] : [];
}

function getSmugPageTotal(json) {
  const resp = json && json.Response ? json.Response : json;
  const pages = resp && resp.Pages && typeof resp.Pages === 'object' ? resp.Pages : null;
  if (!pages) return null;

  const total = Number(pages.Total || pages.total);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function getMusicBandSmugTarget(row) {
  const region = String(row.region || '').trim().replace(/^\/+|\/+$/g, '');
  const folder = String(row.smug_folder || row.slug_folder || '').trim().replace(/^\/+|\/+$/g, '');
  if (!region || !folder) return null;
  return { region, folder };
}

function buildMusicBandAlbumsEndpoint(target) {
  const path = ['Music', 'Archives', 'Bands', target.region, target.folder]
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/folder/user/${encodeURIComponent(SMUG_NICKNAME)}/${path}!albums?_accept=application/json`;
}

async function getSmugAlbumTotalPhotos(album) {
  const directCount = getSmugAlbumImageCount(album);
  if (directCount != null) return directCount;

  const albumKey = getSmugAlbumKey(album);
  if (!albumKey) return null;

  try {
    const json = await fetchSmugJson(`/album/${encodeURIComponent(albumKey)}!images?count=1&start=1&_accept=application/json`);
    const pageTotal = getSmugPageTotal(json);
    if (pageTotal != null) return pageTotal;
    return getSmugAlbumImages(json).length;
  } catch (err) {
    console.warn(`Music-Bands SmugMug album count failed for ${albumKey}:`, err && err.message ? err.message : String(err));
    return null;
  }
}

async function sumSmugAlbumImageCounts(albums) {
  let total = 0;
  let sawCount = false;
  const counts = await mapWithConcurrency(albums, 3, getSmugAlbumTotalPhotos);

  for (const count of counts) {
    if (count == null) continue;
    sawCount = true;
    total += count;
  }

  return sawCount ? total : null;
}

async function fetchMusicBandTotalPhotos(row, forceRefresh) {
  if (!SMUG_API_KEY) return null;

  const target = getMusicBandSmugTarget(row);
  if (!target) return null;

  const cacheKey = `${target.region}/${target.folder}`;
  const hit = smugTotalPhotosCache.get(cacheKey);
  if (!forceRefresh && hit && Date.now() - hit.fetchedAt < SMUG_TOTAL_PHOTOS_CACHE_TTL_MS) {
    return hit.totalPhotos;
  }

  if (smugTotalPhotosInFlight.has(cacheKey)) {
    return smugTotalPhotosInFlight.get(cacheKey);
  }

  const run = (async () => {
    try {
      const json = await fetchSmugJson(buildMusicBandAlbumsEndpoint(target));
      const total = await sumSmugAlbumImageCounts(getSmugAlbums(json));
      const totalPhotos = total > 0 ? String(total) : null;
      smugTotalPhotosCache.set(cacheKey, { totalPhotos, fetchedAt: Date.now() });
      return totalPhotos;
    } catch (err) {
      console.warn(`Music-Bands SmugMug totalPhotos failed for ${cacheKey}:`, err && err.message ? err.message : String(err));
      smugTotalPhotosCache.set(cacheKey, { totalPhotos: null, fetchedAt: Date.now() });
      return null;
    } finally {
      smugTotalPhotosInFlight.delete(cacheKey);
    }
  })();

  smugTotalPhotosInFlight.set(cacheKey, run);
  return run;
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(list[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(1, limit), list.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function compactJsonFields(fields) {
  const out = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    if (value == null) return;
    const clean = String(value).trim();
    if (!clean) return;
    out[key] = clean;
  });
  return out;
}

function hasJsonFields(value) {
  return value && typeof value === 'object' && Object.keys(value).length > 0;
}

function parsePersonnelString(value) {
  const text = String(value || '').trim();
  if (!text) return [];

  const grouped = new Map();
  text.split(';').forEach((entry) => {
    const [name, role] = entry.split('|').map((part) => String(part || '').trim());
    if (!name) return;

    const key = name.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, { name, roles: [] });
    if (role && !grouped.get(key).roles.includes(role)) grouped.get(key).roles.push(role);
  });

  return Array.from(grouped.values()).map((item) => {
    const person = { name: item.name };
    const role = item.roles.join(', ');
    if (role) person.role = role;
    return person;
  });
}

function getMusicBandName(row) {
  const keys = ['band', 'name', 'band_name', 'artist', 'artist_name', 'performer', 'act', 'title'];
  for (const key of keys) {
    const value = String(row[key] || '').trim();
    if (value) return value;
  }

  return String(Object.values(row).find((value) => String(value || '').trim()) || '').trim();
}

function getMusicBandLetter(row) {
  const firstChar = getMusicBandName(row).charAt(0).toUpperCase();
  return firstChar >= 'A' && firstChar <= 'Z' ? firstChar : '#';
}

async function buildMusicBandItem(row, forceRefresh) {
  const band = getMusicBandName(row);
  const bandId = String(row.band_id || '').trim();
  const personnel = {};
  const members = parsePersonnelString(row.members);
  const pastMembers = parsePersonnelString(row.past_members);
  const totalPhotos = await fetchMusicBandTotalPhotos(row, forceRefresh);
  const general = compactJsonFields({
    name: band,
    smug_folder: row.smug_folder || row.slug_folder,
    logo_url: row.logo_url,
    status: row.status,
    tags: row.tags,
    notes: row.notes
  });
  const stats = compactJsonFields({
    region: row.region,
    location: row.location,
    state: row.state,
    totalPhotos,
    archived_sets: row.archived_sets || row.sets_archive,
    total_sets: row.total_sets,
    country: row.country
  });
  const item = {};

  if (members.length) personnel.members = members;
  if (pastMembers.length) personnel.past_members = pastMembers;

  if (band) item.band = band;
  if (bandId) item.band_id = bandId;
  if (hasJsonFields(general)) item.general = general;
  if (hasJsonFields(personnel)) item.personnel = personnel;
  if (hasJsonFields(stats)) item.stats = stats;

  return item;
}

async function groupMusicBandsByLetter(rows, forceRefresh) {
  const groups = new Map();
  const sortedRows = rows.slice().sort((a, b) => {
    const aLetter = getMusicBandLetter(a);
    const bLetter = getMusicBandLetter(b);
    const aBandId = String(a.band_id || '').trim();
    const bBandId = String(b.band_id || '').trim();

    return aLetter.localeCompare(bLetter, undefined, { numeric: true, sensitivity: 'base' }) ||
      aBandId.localeCompare(bBandId, undefined, { numeric: true, sensitivity: 'base' }) ||
      getMusicBandName(a).localeCompare(getMusicBandName(b), undefined, { numeric: true, sensitivity: 'base' });
  });

  const items = await mapWithConcurrency(sortedRows, 4, async (row) => ({
    row,
    item: await buildMusicBandItem(row, forceRefresh)
  }));

  for (const { row, item } of items) {
    const letter = getMusicBandLetter(row);
    if (!hasJsonFields(item)) continue;
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(item);
  }

  const data = {};
  for (const letter of ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']) {
    if (groups.has(letter)) data[letter] = groups.get(letter);
  }

  return data;
}

async function buildMusicBandsResponse(payload, forceRefresh) {
  const generated = new Date();
  const data = await groupMusicBandsByLetter(payload.rows, forceRefresh);
  const source = { name: payload.source };
  if (hasJsonFields(data)) source.data = data;

  return {
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    count: payload.count,
    route: payload.route,
    source
  };
}

async function fetchCsvForRoute(routePath, cfg, forceRefresh) {
  const gid = String(process.env[cfg.gidEnv] || '').trim();
  const cacheKey = `${routePath}:${gid}`;
  const hit = cache.get(cacheKey);

  if (!forceRefresh && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.payload;
  }

  const url = getCsvUrl(gid);
  const res = await fetch(url, { headers: { Accept: 'text/csv,text/plain,*/*' } });
  const text = await res.text();

  if (!res.ok) {
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`Google Sheets returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }

  const parsed = parseCsv(text);
  const payload = {
    ok: true,
    source: cfg.label,
    route: routePath,
    gid,
    count: parsed.rows.length,
    headers: parsed.headers,
    normalizedHeaders: parsed.normalizedHeaders,
    rows: parsed.rows,
    fetchedAt: new Date().toISOString()
  };

  cache.set(cacheKey, { payload, fetchedAt: Date.now() });
  return payload;
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'vmpix-v3-data',
    time: new Date().toISOString(),
    sheetConfigured: !!SHEET_ID,
    routes: Object.keys(ROUTES)
  });
});

for (const [routePath, cfg] of Object.entries(ROUTES)) {
  app.get(routePath, async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === '1';
      const payload = await fetchCsvForRoute(routePath, cfg, forceRefresh);
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=60');
      res.json(routePath === '/api/music/bands' ? await buildMusicBandsResponse(payload, forceRefresh) : payload);
    } catch (err) {
      res.status(500).json({
        ok: false,
        route: routePath,
        source: cfg.label,
        error: err && err.message ? err.message : String(err)
      });
    }
  });
}

app.get('/', (req, res) => {
  res.type('text/plain').send([
    'VMPix V3 Data API',
    '',
    'Health: /health',
    '',
    ...Object.keys(ROUTES)
  ].join('\n'));
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found', path: req.path });
});

app.listen(PORT, () => {
  console.log(`VMPix V3 Data API listening on ${PORT}`);
});
