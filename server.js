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

const dbPool = require('./db');

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
const smugPeoplePhotoCountCache = new Map();
const smugPeoplePhotoCountInFlight = new Map();

const ROUTES = {
  '/api/music/bands': { label: 'Music-Bands', gidEnv: 'GID_MUSIC_BANDS' },
  '/api/music/shows': { label: 'Music-Shows', gidEnv: 'GID_MUSIC_SHOWS' },
  '/api/music/people': { label: 'Music-People', gidEnv: 'GID_MUSIC_PEOPLE', defaultGid: '2008484091' },
  '/api/music/venues': { label: 'Music-Venue', gidEnv: 'GID_MUSIC_VENUES' },
  '/api/wrestling/shows': { label: 'Wrestling-Shows', gidEnv: 'GID_WRESTLING_SHOWS' },
  '/api/wrestling/people': { label: 'Wrestling-People', gidEnv: 'GID_WRESTLING_PEOPLE' },
  '/api/wrestling/venues': { label: 'Wrestling-Venue', gidEnv: 'GID_WRESTLING_VENUES' },
  '/api/stats': { label: 'Stats', gidEnv: 'GID_STATS' }
};

async function applyDatabaseSchema() {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = await fs.promises.readFile(schemaPath, 'utf8');
    if (!schemaSql.trim()) {
      throw new Error('schema.sql is empty.');
    }

    await dbPool.query(schemaSql);
    console.log('PostgreSQL schema applied successfully.');
  } catch (err) {
    console.error('PostgreSQL schema apply failed:', err && err.message ? err.message : String(err));
  }
}

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

function normalizeSheetGid(gid) {
  const raw = String(gid || '').trim();
  if (!raw) return '';

  const match = raw.match(/[?&#]gid=([0-9]+)/i) || raw.match(/^gid=([0-9]+)$/i);
  if (match && match[1]) return match[1];

  return raw;
}

function getCsvUrl(gid) {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID environment variable.');
  const cleanGid = normalizeSheetGid(gid);
  if (!cleanGid) throw new Error('Missing tab GID environment variable.');
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}/export?format=csv&gid=${encodeURIComponent(cleanGid)}`;
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

function getSmugPageCount(json) {
  const resp = json && json.Response ? json.Response : json;
  const pages = resp && resp.Pages && typeof resp.Pages === 'object' ? resp.Pages : null;
  if (!pages) return null;

  const count = Number(pages.Count || pages.count);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function hasSmugNextPage(json) {
  const resp = json && json.Response ? json.Response : json;
  const pages = resp && resp.Pages && typeof resp.Pages === 'object' ? resp.Pages : null;
  return !!(pages && (pages.NextPage || pages.nextPage));
}

function getSmugSearchImages(json) {
  const resp = json && json.Response ? json.Response : json;
  const images = resp && (resp.Image || resp.Images || resp.AlbumImage || resp.AlbumImages || resp.image || resp.images);
  if (Array.isArray(images)) return images;
  return images && typeof images === 'object' ? [images] : [];
}

function getSmugImageCaption(image) {
  const direct = image && (image.Caption || image.CaptionText || image.caption || image.captionText);
  if (typeof direct === 'string') return direct.trim();

  const nested = image && image.Image && (image.Image.Caption || image.Image.CaptionText || image.Image.caption || image.Image.captionText);
  return typeof nested === 'string' ? nested.trim() : '';
}

function normalizePersonCaptionText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function captionMatchesPersonName(caption, personName) {
  const cleanCaption = normalizePersonCaptionText(caption);
  const cleanName = normalizePersonCaptionText(personName);
  if (!cleanCaption || !cleanName) return false;

  const captionParts = cleanCaption
    .replace(/[\uFF1B\u037E]/g, ';')
    .split(/\s*;\s*/g)
    .map((part) => normalizePersonCaptionText(part).toLowerCase())
    .filter(Boolean);
  if (captionParts.includes(cleanName.toLowerCase())) return true;

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(cleanName)}([^a-z0-9]|$)`, 'i').test(cleanCaption);
}

async function searchSmugCaptionPhotoCount(personName) {
  let photoCount = 0;
  let start = 1;
  const count = 200;
  const query = encodeURIComponent(normalizePersonCaptionText(personName));

  while (true) {
    const json = await fetchSmugJson(`/user/${encodeURIComponent(SMUG_NICKNAME)}!imagesearch?q=${query}&count=${count}&start=${start}&_accept=application/json&_expand=Image`);
    const images = getSmugSearchImages(json);
    if (!images.length) break;

    images.forEach((image) => {
      if (captionMatchesPersonName(getSmugImageCaption(image), personName)) photoCount += 1;
    });

    const pageCount = getSmugPageCount(json);
    if (!hasSmugNextPage(json) || pageCount == null || pageCount < count) break;
    start += pageCount;
  }

  return photoCount;
}

async function fetchMusicPersonPhotoCount(personName, forceRefresh) {
  if (!SMUG_API_KEY) return null;

  const cleanName = normalizePersonCaptionText(personName);
  if (!cleanName) return null;

  const cacheKey = cleanName.toLowerCase();
  const hit = smugPeoplePhotoCountCache.get(cacheKey);
  if (!forceRefresh && hit && Date.now() - hit.fetchedAt < SMUG_TOTAL_PHOTOS_CACHE_TTL_MS) {
    return hit.photoCount;
  }

  if (smugPeoplePhotoCountInFlight.has(cacheKey)) {
    return smugPeoplePhotoCountInFlight.get(cacheKey);
  }

  const run = (async () => {
    try {
      const photoCount = await searchSmugCaptionPhotoCount(cleanName);
      smugPeoplePhotoCountCache.set(cacheKey, { photoCount, fetchedAt: Date.now() });
      return photoCount;
    } catch (err) {
      console.warn(`Music-People SmugMug photoCount failed for ${cleanName}:`, err && err.message ? err.message : String(err));
      smugPeoplePhotoCountCache.set(cacheKey, { photoCount: null, fetchedAt: Date.now() });
      return null;
    } finally {
      smugPeoplePhotoCountInFlight.delete(cacheKey);
    }
  })();

  smugPeoplePhotoCountInFlight.set(cacheKey, run);
  return run;
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

function createMusicBandsStats() {
  return {
    photosTotal: 0,
    bandsTotal: 0,
    bandsLocal: 0,
    photosLocal: 0,
    bandsRegional: 0,
    photosRegional: 0,
    bandsNational: 0,
    photosNational: 0,
    bandsInternational: 0,
    photosInternational: 0,
    photosLocalPct: '0.000%',
    photosRegionalPct: '0.000%',
    photosNationalPct: '0.000%',
    photosInternationalPct: '0.000%',
    bandsComplete: 0,
    bandsPartial: 0,
    bandsNone: 0,
    photosDone: 0,
    photosDonePct: '0.00%',
    photosEditing: 0,
    photosEditingPct: '0.00%',
    photosNone: 0,
    photosNonePct: '0.00%'
  };
}

function getMusicBandsStatsKeys(region) {
  const clean = String(region || '').trim().toLowerCase();
  if (clean === 'local') return { bands: 'bandsLocal', photos: 'photosLocal' };
  if (clean === 'regional') return { bands: 'bandsRegional', photos: 'photosRegional' };
  if (clean === 'national') return { bands: 'bandsNational', photos: 'photosNational' };
  if (clean === 'international') return { bands: 'bandsInternational', photos: 'photosInternational' };
  return null;
}

function addMusicBandsStats(stats, row, item) {
  addMusicBandsSetStats(stats, row);

  const keys = getMusicBandsStatsKeys(row && row.region);
  if (!keys) return;

  stats[keys.bands] += 1;

  const totalPhotos = Number(item && item.stats && item.stats.totalPhotos);
  if (Number.isFinite(totalPhotos) && totalPhotos > 0) {
    stats[keys.photos] += totalPhotos;
    stats.photosTotal += totalPhotos;
  }
}

function getSetCountNumber(value) {
  const clean = String(value || '').replace(/,/g, '').trim();
  if (!clean) return null;

  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

function addMusicBandsSetStats(stats, row) {
  const totalSets = getSetCountNumber(row && row.total_sets);
  const archivedSets = getSetCountNumber(row && (row.archived_sets || row.archive_sets || row.sets_archive));

  if (totalSets == null || archivedSets == null || totalSets <= 0 || archivedSets <= 0) {
    stats.bandsNone += 1;
  } else if (totalSets === archivedSets) {
    stats.bandsComplete += 1;
  } else {
    stats.bandsPartial += 1;
  }
}

function getPositiveNumber(value) {
  const number = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getRankByValue(values) {
  const uniqueValues = Array.from(new Set(values.filter((value) => value != null))).sort((a, b) => b - a);
  const ranks = new Map();
  uniqueValues.forEach((value, idx) => {
    ranks.set(value, String(idx + 1));
  });
  return ranks;
}

function orderMusicBandStats(stats, photoRank, setRank) {
  const source = stats && typeof stats === 'object' ? stats : {};
  const ordered = {};

  ['region', 'location', 'state', 'totalPhotos'].forEach((key) => {
    if (source[key] != null) ordered[key] = source[key];
  });
  if (photoRank) ordered.photoRank = photoRank;
  ['archived_sets', 'total_sets'].forEach((key) => {
    if (source[key] != null) ordered[key] = source[key];
  });
  if (setRank) ordered.setRank = setRank;
  if (source.country != null) ordered.country = source.country;

  return ordered;
}

function addMusicBandItemRanks(items) {
  const itemList = items
    .map((entry) => entry && entry.item)
    .filter((item) => item && item.stats && typeof item.stats === 'object');
  const photoValues = itemList.map((item) => getPositiveNumber(item.stats.totalPhotos));
  const setValues = itemList.map((item) => getPositiveNumber(item.stats.total_sets));
  const photoRanks = getRankByValue(photoValues);
  const setRanks = getRankByValue(setValues);

  itemList.forEach((item) => {
    const totalPhotos = getPositiveNumber(item.stats.totalPhotos);
    const totalSets = getPositiveNumber(item.stats.total_sets);
    item.stats = orderMusicBandStats(
      item.stats,
      totalPhotos == null ? '' : photoRanks.get(totalPhotos),
      totalSets == null ? '' : setRanks.get(totalSets)
    );
  });
}

function formatMusicBandsPhotoPct(value, total) {
  if (!Number.isFinite(total) || total <= 0) return '0.000%';
  return `${((value / total) * 100).toFixed(3)}%`;
}

function finalizeMusicBandsStats(stats) {
  stats.bandsTotal = stats.bandsLocal + stats.bandsRegional + stats.bandsNational + stats.bandsInternational;
  stats.photosLocalPct = formatMusicBandsPhotoPct(stats.photosLocal, stats.photosTotal);
  stats.photosRegionalPct = formatMusicBandsPhotoPct(stats.photosRegional, stats.photosTotal);
  stats.photosNationalPct = formatMusicBandsPhotoPct(stats.photosNational, stats.photosTotal);
  stats.photosInternationalPct = formatMusicBandsPhotoPct(stats.photosInternational, stats.photosTotal);
  return stats;
}

function normalizeStatsLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseStatsSheetNumber(value) {
  const clean = String(value || '').replace(/,/g, '').trim();
  if (!clean) return 0;

  const number = Number(clean);
  return Number.isFinite(number) ? number : 0;
}

function parseStatsSheetPercent(value) {
  const clean = String(value || '').trim();
  return clean || '0.00%';
}

function applyStatsSheetRow(stats, cells) {
  const label = normalizeStatsLabel(cells[0]);
  const count = parseStatsSheetNumber(cells[1]);
  const pct = parseStatsSheetPercent(cells[2]);

  if (label === 'onsite') {
    stats.photosDone = count;
    stats.photosDonePct = pct;
  } else if (label === 'inprogress') {
    stats.photosEditing = count;
    stats.photosEditingPct = pct;
  } else if (label === 'notedited') {
    stats.photosNone = count;
    stats.photosNonePct = pct;
  }
}

async function fetchStatsSheetCsv(forceRefresh) {
  const gid = normalizeSheetGid(process.env.GID_STATS || '835637138');
  const cacheKey = `stats-sheet-csv:${gid}`;
  const hit = cache.get(cacheKey);

  if (!forceRefresh && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.csvText;
  }

  const res = await fetch(getCsvUrl(gid), { headers: { Accept: 'text/csv,text/plain,*/*' } });
  const csvText = await res.text();

  if (!res.ok) {
    const snippet = csvText.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`Stats sheet returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }

  cache.set(cacheKey, { csvText, fetchedAt: Date.now() });
  return csvText;
}

async function addStatsSheetPhotoProgress(stats, forceRefresh) {
  try {
    const csvText = await fetchStatsSheetCsv(forceRefresh);
    const lines = String(csvText || '').replace(/^\uFEFF/, '').split(/\r?\n/);

    lines.forEach((line) => {
      if (!String(line || '').trim()) return;
      applyStatsSheetRow(stats, parseCsvLine(line));
    });
  } catch (err) {
    console.warn('Music-Bands Stats sheet photo progress failed:', err && err.message ? err.message : String(err));
  }

  return stats;
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

function splitMusicSemicolonList(value) {
  return String(value || '')
    .replace(/[\uFF1B\u037E]/g, ';')
    .split(/\s*;\s*/g)
    .map((part) => String(part || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function splitMusicRoleList(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const parts = splitMusicSemicolonList(raw);
  if (parts.length > 1 || raw.includes(';')) return parts;

  return raw
    .split(/\s*,\s*/g)
    .map((part) => String(part || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function formatMusicInstrument(value) {
  const parts = splitMusicSemicolonList(value);
  return parts.length ? parts.join(', ') : String(value || '').trim();
}

function normalizeMusicLookupKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getMusicPersonBandValues(row) {
  return splitMusicSemicolonList(row.band || row.bands);
}

function addMusicPersonRole(list, personName, role) {
  const name = String(personName || '').trim().replace(/\s+/g, ' ');
  if (!name) return;

  const key = normalizeMusicLookupKey(name);
  let person = list.find((entry) => normalizeMusicLookupKey(entry.name) === key);
  if (!person) {
    person = { name };
    list.push(person);
  }

  const roles = new Map();
  splitMusicRoleList(person.role).forEach((part) => roles.set(normalizeMusicLookupKey(part), part));
  splitMusicRoleList(role).forEach((part) => roles.set(normalizeMusicLookupKey(part), part));

  const roleText = Array.from(roles.values()).join(', ');
  if (roleText) person.role = roleText;
}

function buildMusicPeopleBandPersonnelLookup(rows) {
  const lookup = new Map();

  rows.forEach((row) => {
    const personName = getMusicPersonName(row);
    if (!personName) return;

    const role = formatMusicInstrument(row.instrument);
    getMusicPersonBandValues(row).forEach((bandName) => {
      const bandKey = normalizeMusicLookupKey(bandName);
      if (!bandKey) return;
      if (!lookup.has(bandKey)) lookup.set(bandKey, []);
      addMusicPersonRole(lookup.get(bandKey), personName, role);
    });
  });

  return lookup;
}

function getMusicPeopleMembersForBand(bandName, peoplePersonnelLookup) {
  if (!peoplePersonnelLookup || typeof peoplePersonnelLookup.get !== 'function') return [];
  const members = peoplePersonnelLookup.get(normalizeMusicLookupKey(bandName));
  return Array.isArray(members) ? members.map((member) => ({ ...member })) : [];
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

async function buildMusicBandItem(row, forceRefresh, peoplePersonnelLookup) {
  const band = getMusicBandName(row);
  const bandId = String(row.band_id || '').trim();
  const personnel = {};
  const peopleMembers = getMusicPeopleMembersForBand(band, peoplePersonnelLookup);
  const members = peopleMembers.length ? peopleMembers : parsePersonnelString(row.members);
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

async function groupMusicBandsByLetter(rows, forceRefresh, peoplePersonnelLookup) {
  const groups = new Map();
  const stats = createMusicBandsStats();
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
    item: await buildMusicBandItem(row, forceRefresh, peoplePersonnelLookup)
  }));
  addMusicBandItemRanks(items);

  for (const { row, item } of items) {
    const letter = getMusicBandLetter(row);
    if (!hasJsonFields(item)) continue;
    addMusicBandsStats(stats, row, item);
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(item);
  }

  const data = {};
  for (const letter of ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']) {
    if (groups.has(letter)) data[letter] = groups.get(letter);
  }

  return { data, stats: finalizeMusicBandsStats(stats) };
}

async function buildMusicBandsResponse(payload, forceRefresh) {
  const generated = new Date();
  let peoplePersonnelLookup = new Map();
  try {
    const peoplePayload = await fetchCsvForRoute('/api/music/people', ROUTES['/api/music/people'], forceRefresh);
    peoplePersonnelLookup = buildMusicPeopleBandPersonnelLookup(peoplePayload.rows);
  } catch (err) {
    console.warn('Music-Bands People personnel lookup failed:', err && err.message ? err.message : String(err));
  }
  const bands = await groupMusicBandsByLetter(payload.rows, forceRefresh, peoplePersonnelLookup);
  await addStatsSheetPhotoProgress(bands.stats, forceRefresh);
  const source = { name: payload.source };
  if (hasJsonFields(bands.data)) source.data = bands.data;

  return {
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    stats: bands.stats,
    route: payload.route,
    source
  };
}

function isMusicShowBandKey(key) {
  const match = String(key || '').match(/^band_?(\d+)$/);
  if (!match) return false;

  const slot = Number(match[1]);
  return Number.isInteger(slot) && slot >= 1 && slot <= 20;
}

function isMusicShowGpsKey(key) {
  const clean = String(key || '').trim().toLowerCase();
  return clean === 'gps' ||
    clean.startsWith('gps_') ||
    ['latitude', 'longitude', 'lat', 'lng', 'lon', 'coordinates', 'coords'].includes(clean);
}

function getMusicShowBandValue(row, slot) {
  return String(row[`band_${slot}`] || row[`band${slot}`] || '').trim();
}

function buildMusicShowBands(row) {
  const bands = [];

  for (let slot = 1; slot <= 20; slot++) {
    const band = getMusicShowBandValue(row, slot);
    if (band) bands.push({ slot, band });
  }

  return bands;
}

function buildMusicShowItem(row) {
  const item = {};

  Object.entries(row || {}).forEach(([key, value]) => {
    if (isMusicShowBandKey(key)) return;
    if (isMusicShowGpsKey(key)) return;
    const clean = String(value || '').trim();
    if (!clean) return;
    item[key] = clean;
  });

  const bands = buildMusicShowBands(row);
  if (bands.length) item.bands = bands;

  return item;
}

function getMusicShowDateValue(row) {
  const dateKeys = ['show_date', 'date', 'event_date', 'showdate', 'eventdate'];

  for (const key of dateKeys) {
    const value = String(row[key] || '').trim();
    if (value) return value;
  }

  return '';
}

function getMusicShowDateTime(row) {
  const value = getMusicShowDateValue(row);
  if (!value) return null;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function sortMusicShowRowsByDate(rows, newestFirst = false) {
  return rows
    .map((row, index) => ({ row, index, dateTime: getMusicShowDateTime(row) }))
    .sort((a, b) => {
      if (a.dateTime == null && b.dateTime == null) return a.index - b.index;
      if (a.dateTime == null) return 1;
      if (b.dateTime == null) return -1;
      return (newestFirst ? b.dateTime - a.dateTime : a.dateTime - b.dateTime) || a.index - b.index;
    })
    .map((entry) => entry.row);
}

function getMusicShowBandViewKey(band) {
  return String(band || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function addMusicShowBandViewCounts(data) {
  const counts = new Map();

  data.forEach((show) => {
    if (!Array.isArray(show.bands)) return;

    show.bands.forEach((entry) => {
      const key = getMusicShowBandViewKey(entry.band);
      if (!key) return;

      const bandViewCount = (counts.get(key) || 0) + 1;
      counts.set(key, bandViewCount);
      entry.bandViewCount = bandViewCount;
    });
  });

  return data;
}

function buildMusicShowsStats(data) {
  return {
    showsTotal: data.length,
    bandsTotal: data.reduce((total, show) => total + (Array.isArray(show.bands) ? show.bands.length : 0), 0)
  };
}

function buildMusicShowsResponse(payload) {
  const generated = new Date();
  const data = sortMusicShowRowsByDate(payload.rows)
    .map(buildMusicShowItem)
    .filter(hasJsonFields);
  addMusicShowBandViewCounts(data);
  const newestFirstData = sortMusicShowRowsByDate(data, true);
  const source = { name: payload.source };
  if (newestFirstData.length) source.data = newestFirstData;

  return {
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    stats: buildMusicShowsStats(newestFirstData),
    route: payload.route,
    source
  };
}

function getMusicPersonName(row) {
  return String(row.name || '').trim();
}

function getMusicPersonLetterFromName(name) {
  const firstChar = String(name || '').trim().charAt(0).toUpperCase();
  return firstChar >= 'A' && firstChar <= 'Z' ? firstChar : '#';
}

function getMusicPersonLetter(row) {
  return getMusicPersonLetterFromName(getMusicPersonName(row));
}

function addMusicPersonGroupValue(values, value) {
  splitMusicSemicolonList(value).forEach((part) => {
    const key = normalizeMusicLookupKey(part);
    if (key && !values.has(key)) values.set(key, part);
  });
}

function addMusicPersonRelationship(group, bandName, instrument) {
  const band = String(bandName || '').trim().replace(/\s+/g, ' ');
  if (!band) return;

  const bandKey = normalizeMusicLookupKey(band);
  if (!group.relationships.has(bandKey)) {
    group.relationships.set(bandKey, { band, instruments: new Map() });
  }

  const relationship = group.relationships.get(bandKey);
  splitMusicRoleList(instrument).forEach((part) => {
    const key = normalizeMusicLookupKey(part);
    if (key && !relationship.instruments.has(key)) relationship.instruments.set(key, part);
  });
}

function buildMusicPersonGroups(rows) {
  const groups = new Map();

  rows.forEach((row) => {
    const name = getMusicPersonName(row);
    if (!name) return;

    const key = normalizeMusicLookupKey(name);
    if (!groups.has(key)) {
      groups.set(key, {
        name,
        categories: new Map(),
        aliases: new Map(),
        instruments: new Map(),
        relationships: new Map()
      });
    }

    const group = groups.get(key);
    addMusicPersonGroupValue(group.categories, row.category);
    addMusicPersonGroupValue(group.aliases, row.aliases);

    const instrument = formatMusicInstrument(row.instrument);
    const bands = getMusicPersonBandValues(row);
    if (bands.length) {
      bands.forEach((bandName) => addMusicPersonRelationship(group, bandName, instrument));
    } else {
      addMusicPersonGroupValue(group.instruments, instrument);
    }
  });

  return Array.from(groups.values());
}

function buildMusicPersonRelationshipItem(relationship) {
  const item = { band: relationship.band };
  const instrument = Array.from(relationship.instruments.values()).join(', ');
  if (instrument) item.instrument = instrument;
  return item;
}

function buildMusicPersonBaseItem(group) {
  const item = { name: group.name };
  const category = Array.from(group.categories.values()).join(', ');
  const aliases = Array.from(group.aliases.values()).join(', ');
  const bands = Array.from(group.relationships.values()).map(buildMusicPersonRelationshipItem);
  const instrument = Array.from(group.instruments.values()).join(', ');

  if (category) item.category = category;
  if (aliases) item.aliases = aliases;
  if (bands.length) item.bands = bands;
  if (!bands.length && instrument) item.instrument = instrument;

  return item;
}

async function buildMusicPersonItem(group, forceRefresh) {
  const item = buildMusicPersonBaseItem(group);
  if (!item.name) return item;

  const photoCount = await fetchMusicPersonPhotoCount(item.name, forceRefresh);
  if (photoCount != null) item.photoCount = photoCount;

  return item;
}

function hasMusicPersonPhotoCount(item) {
  return item && Object.prototype.hasOwnProperty.call(item, 'photoCount');
}

async function groupMusicPeopleByLetter(rows, forceRefresh) {
  const groups = new Map();
  const sortedPeople = buildMusicPersonGroups(rows).sort((a, b) => {
    const aLetter = getMusicPersonLetterFromName(a.name);
    const bLetter = getMusicPersonLetterFromName(b.name);

    return aLetter.localeCompare(bLetter, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  const items = await mapWithConcurrency(sortedPeople, 2, async (person) => ({
    person,
    item: await buildMusicPersonItem(person, forceRefresh)
  }));
  let peopleTotal = 0;

  items.forEach(({ person, item }) => {
    if (!hasJsonFields(item)) return;
    if (!hasMusicPersonPhotoCount(item)) return;
    peopleTotal += 1;

    const letter = getMusicPersonLetterFromName(person.name);
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(item);
  });

  const data = {};
  for (const letter of ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']) {
    if (groups.has(letter)) data[letter] = groups.get(letter);
  }

  return { data, peopleTotal };
}

async function buildMusicPeopleResponse(payload, forceRefresh) {
  const generated = new Date();
  const people = await groupMusicPeopleByLetter(payload.rows, forceRefresh);
  const source = { name: payload.source };
  if (hasJsonFields(people.data)) source.data = people.data;

  return {
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    stats: {
      peopleTotal: people.peopleTotal
    },
    route: payload.route,
    source
  };
}

async function fetchCsvForRoute(routePath, cfg, forceRefresh) {
  const gid = normalizeSheetGid(process.env[cfg.gidEnv] || cfg.defaultGid);
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

function toDbText(value) {
  const clean = String(value || '').trim();
  return clean || null;
}

function toDbInteger(value) {
  const clean = String(value || '').replace(/,/g, '').trim();
  if (!clean) return 0;

  const number = Number(clean);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function normalizeImportHeaderKey(key) {
  return String(key || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\uFEFF\u200B-\u200D\u2060]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const MUSIC_BAND_IMPORT_HEADER_ALIASES = {
  band: 'band',
  name: 'band',
  band_name: 'band',
  band_id: 'band_id',
  bandid: 'band_id',
  smug_folder: 'smug_folder',
  smugfolder: 'smug_folder',
  slug_folder: 'slug_folder',
  slugfolder: 'slug_folder',
  logo_url: 'logo_url',
  logourl: 'logo_url',
  region: 'region',
  location: 'location',
  state: 'state',
  country: 'country',
  members: 'members',
  past_members: 'past_members',
  pastmembers: 'past_members',
  tags: 'tags',
  status: 'status',
  notes: 'notes',
  archived_sets: 'archived_sets',
  archivedsets: 'archived_sets',
  sets_archive: 'sets_archive',
  setsarchive: 'sets_archive',
  total_sets: 'total_sets',
  totalsets: 'total_sets'
};

function normalizeMusicBandImportRow(row) {
  const out = {};

  Object.entries(row || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeImportHeaderKey(key);
    const compactKey = normalizedKey.replace(/_/g, '');
    const canonicalKey = MUSIC_BAND_IMPORT_HEADER_ALIASES[normalizedKey] ||
      MUSIC_BAND_IMPORT_HEADER_ALIASES[compactKey] ||
      normalizedKey;
    out[canonicalKey] = value;
  });

  return out;
}

function logMusicBandImportDebug(payload, rows) {
  console.log('Music-Bands import detected headers:', payload.normalizedHeaders || []);
  console.log('Music-Bands import first parsed row keys:', rows[0] ? Object.keys(rows[0]) : []);
}

function slugifyMusicBandId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseMusicBandImportPersonnel(value) {
  return String(value || '')
    .split(';')
    .map((entry) => {
      const clean = String(entry || '').trim();
      if (!clean) return null;

      const pipeIdx = clean.indexOf('|');
      const name = String(pipeIdx === -1 ? clean : clean.slice(0, pipeIdx)).trim();
      const role = String(pipeIdx === -1 ? '' : clean.slice(pipeIdx + 1)).trim();
      return name ? { name, role } : null;
    })
    .filter(Boolean);
}

function stringifyDbJson(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

async function buildMusicBandDbRow(row, forceRefresh) {
  const band = toDbText(getMusicBandName(row));
  const providedBandId = toDbText(row.band_id);
  const generatedBandId = providedBandId ? null : slugifyMusicBandId(band);
  const totalPhotos = await fetchMusicBandTotalPhotos(row, forceRefresh);
  const general = compactJsonFields({
    name: band,
    smug_folder: row.smug_folder || row.slug_folder,
    logo_url: row.logo_url,
    status: row.status,
    tags: row.tags,
    notes: row.notes
  });
  const personnel = {};
  const members = parseMusicBandImportPersonnel(row.members);
  const pastMembers = parseMusicBandImportPersonnel(row.past_members);
  const stats = compactJsonFields({
    region: row.region,
    location: row.location,
    state: row.state,
    totalPhotos,
    archived_sets: row.archived_sets || row.sets_archive,
    total_sets: row.total_sets,
    country: row.country
  });

  if (members.length) personnel.members = members;
  if (pastMembers.length) personnel.past_members = pastMembers;

  return {
    band_id: providedBandId || generatedBandId || null,
    generatedBandId: !!generatedBandId,
    band,
    smug_folder: toDbText(row.smug_folder || row.slug_folder),
    logo_url: toDbText(row.logo_url),
    region: toDbText(row.region),
    location: toDbText(row.location),
    state: toDbText(row.state),
    country: toDbText(row.country),
    members: toDbText(row.members),
    past_members: toDbText(row.past_members),
    tags: toDbText(row.tags),
    status: toDbText(row.status),
    notes: toDbText(row.notes),
    archived_sets: toDbInteger(row.archived_sets || row.sets_archive),
    total_sets: toDbInteger(row.total_sets),
    general,
    personnel,
    stats,
    raw_sheet: compactJsonFields(row)
  };
}

async function upsertMusicBandDbRow(client, item) {
  await client.query(`
    INSERT INTO music_bands (
      band_id,
      band,
      smug_folder,
      logo_url,
      region,
      location,
      state,
      country,
      members,
      past_members,
      tags,
      status,
      notes,
      archived_sets,
      total_sets,
      general,
      personnel,
      stats,
      raw_sheet
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb
    )
    ON CONFLICT (band_id) DO UPDATE SET
      band = EXCLUDED.band,
      smug_folder = EXCLUDED.smug_folder,
      logo_url = EXCLUDED.logo_url,
      region = EXCLUDED.region,
      location = EXCLUDED.location,
      state = EXCLUDED.state,
      country = EXCLUDED.country,
      members = EXCLUDED.members,
      past_members = EXCLUDED.past_members,
      tags = EXCLUDED.tags,
      status = EXCLUDED.status,
      notes = EXCLUDED.notes,
      archived_sets = EXCLUDED.archived_sets,
      total_sets = EXCLUDED.total_sets,
      general = EXCLUDED.general,
      personnel = EXCLUDED.personnel,
      stats = EXCLUDED.stats,
      raw_sheet = EXCLUDED.raw_sheet,
      updated_at = NOW()
  `, [
    item.band_id,
    item.band,
    item.smug_folder,
    item.logo_url,
    item.region,
    item.location,
    item.state,
    item.country,
    item.members,
    item.past_members,
    item.tags,
    item.status,
    item.notes,
    item.archived_sets,
    item.total_sets,
    stringifyDbJson(item.general),
    stringifyDbJson(item.personnel),
    stringifyDbJson(item.stats),
    stringifyDbJson(item.raw_sheet)
  ]);
}

async function importMusicBandsToDatabase(forceRefresh) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('Missing DATABASE_URL environment variable.');
  }

  const payload = await fetchCsvForRoute('/api/music/bands', ROUTES['/api/music/bands'], forceRefresh);
  const rows = payload.rows.map(normalizeMusicBandImportRow);
  logMusicBandImportDebug(payload, rows);
  const items = await mapWithConcurrency(rows, 4, async (row) => ({
    row,
    item: await buildMusicBandDbRow(row, forceRefresh)
  }));
  addMusicBandItemRanks(items);
  const client = await dbPool.connect();
  const result = {
    ok: true,
    route: '/admin/import/music/bands',
    source: 'Music-Bands',
    table: 'music_bands',
    rowsRead: rows.length,
    upserted: 0,
    skipped: 0,
    skippedMissingBand: 0,
    skippedMissingBandId: 0,
    generatedBandIds: 0
  };

  try {
    await client.query('BEGIN');

    for (const { item } of items) {
      if (!item.band) {
        result.skipped += 1;
        result.skippedMissingBand += 1;
        continue;
      }

      if (item.generatedBandId) result.generatedBandIds += 1;

      await upsertMusicBandDbRow(client, item);
      result.upserted += 1;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const MUSIC_SHOW_IMPORT_HEADER_ALIASES = {
  name: 'name',
  show_name: 'name',
  showname: 'name',
  venue: 'venue',
  city: 'city',
  state: 'state',
  date: 'date',
  show_date: 'date',
  showdate: 'date',
  poster: 'poster',
  poster_url: 'poster',
  posterurl: 'poster',
  notes: 'notes',
  camera_1: 'camera_1',
  camera1: 'camera_1',
  camera_2: 'camera_2',
  camera2: 'camera_2'
};

function normalizeMusicShowImportRow(row) {
  const out = {};

  Object.entries(row || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeImportHeaderKey(key);
    const bandMatch = normalizedKey.match(/^band_?([0-9]+)$/);
    if (bandMatch) {
      out[`band_${Number(bandMatch[1])}`] = value;
      return;
    }

    const compactKey = normalizedKey.replace(/_/g, '');
    const canonicalKey = MUSIC_SHOW_IMPORT_HEADER_ALIASES[normalizedKey] ||
      MUSIC_SHOW_IMPORT_HEADER_ALIASES[compactKey] ||
      normalizedKey;
    out[canonicalKey] = value;
  });

  return out;
}

function parseMusicShowDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let year;
  let month;
  let day;
  const slashMatch = raw.match(/^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2}|[0-9]{4})$/);
  const isoMatch = raw.match(/^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$/);

  if (slashMatch) {
    month = Number(slashMatch[1]);
    day = Number(slashMatch[2]);
    year = Number(slashMatch[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
  } else if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    year = parsed.getFullYear();
    month = parsed.getMonth() + 1;
    day = parsed.getDate();
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  const iso = [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-');

  return {
    iso,
    time: date.getTime()
  };
}

function hasMusicShowImportData(row) {
  if (['name', 'venue', 'city', 'state', 'date', 'poster', 'notes', 'camera_1', 'camera_2'].some((key) => toDbText(row[key]))) {
    return true;
  }

  return buildMusicShowBands(row).length > 0;
}

function sortMusicShowImportRows(rows) {
  return rows
    .map((row, index) => {
      const parsedDate = parseMusicShowDate(row.date);
      return { row, index, dateTime: parsedDate ? parsedDate.time : null };
    })
    .sort((a, b) => {
      if (a.dateTime == null && b.dateTime == null) return a.index - b.index;
      if (a.dateTime == null) return 1;
      if (b.dateTime == null) return -1;
      return a.dateTime - b.dateTime || a.index - b.index;
    })
    .map((entry) => entry.row);
}

function buildMusicShowImportBands(row, bandCounts) {
  const bands = [];

  for (let slot = 1; slot <= 20; slot++) {
    const band = getMusicShowBandValue(row, slot);
    if (!band) continue;

    const key = getMusicShowBandViewKey(band);
    const bandViewCount = (bandCounts.get(key) || 0) + 1;
    bandCounts.set(key, bandViewCount);
    bands.push({ slot, band, bandViewCount });
  }

  return bands;
}

function buildMusicShowDbRow(row, showId, bandCounts) {
  const parsedDate = parseMusicShowDate(row.date);
  const bands = buildMusicShowImportBands(row, bandCounts);

  return {
    show_id: showId,
    name: toDbText(row.name),
    venue: toDbText(row.venue),
    city: toDbText(row.city),
    state: toDbText(row.state),
    date: toDbText(row.date),
    show_date: parsedDate ? parsedDate.iso : null,
    poster: toDbText(row.poster),
    notes: toDbText(row.notes),
    camera_1: toDbText(row.camera_1),
    camera_2: toDbText(row.camera_2),
    bands,
    stats: {
      bandCount: bands.length
    },
    raw_sheet: compactJsonFields(row)
  };
}

async function upsertMusicShowDbRow(client, item) {
  await client.query(`
    INSERT INTO music_shows (
      show_id,
      name,
      venue,
      city,
      state,
      date,
      show_date,
      poster,
      notes,
      camera_1,
      camera_2,
      bands,
      stats,
      raw_sheet
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12::jsonb, $13::jsonb, $14::jsonb
    )
    ON CONFLICT (show_id) DO UPDATE SET
      name = EXCLUDED.name,
      venue = EXCLUDED.venue,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      date = EXCLUDED.date,
      show_date = EXCLUDED.show_date,
      poster = EXCLUDED.poster,
      notes = EXCLUDED.notes,
      camera_1 = EXCLUDED.camera_1,
      camera_2 = EXCLUDED.camera_2,
      bands = EXCLUDED.bands,
      stats = EXCLUDED.stats,
      raw_sheet = EXCLUDED.raw_sheet,
      updated_at = NOW()
  `, [
    item.show_id,
    item.name,
    item.venue,
    item.city,
    item.state,
    item.date,
    item.show_date,
    item.poster,
    item.notes,
    item.camera_1,
    item.camera_2,
    stringifyDbJson(item.bands),
    stringifyDbJson(item.stats),
    stringifyDbJson(item.raw_sheet)
  ]);
}

async function importMusicShowsToDatabase(forceRefresh) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('Missing DATABASE_URL environment variable.');
  }

  const payload = await fetchCsvForRoute('/api/music/shows', ROUTES['/api/music/shows'], forceRefresh);
  const rows = sortMusicShowImportRows(
    payload.rows
      .map(normalizeMusicShowImportRow)
      .filter(hasMusicShowImportData)
  );
  const bandCounts = new Map();
  const items = rows.map((row, index) => buildMusicShowDbRow(row, index + 1, bandCounts));
  const client = await dbPool.connect();
  const result = {
    ok: true,
    route: '/admin/import/music/shows',
    source: 'Music-Shows',
    table: 'music_shows',
    rowsRead: payload.rows.length,
    importedRows: items.length,
    upserted: 0,
    skipped: payload.rows.length - items.length,
    bandsTotal: items.reduce((total, item) => total + item.bands.length, 0)
  };

  try {
    await client.query('BEGIN');

    for (const item of items) {
      await upsertMusicShowDbRow(client, item);
      result.upserted += 1;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const MUSIC_PERSON_IMPORT_HEADER_ALIASES = {
  name: 'name',
  person: 'name',
  category: 'category',
  aliases: 'aliases',
  alias: 'aliases',
  bands: 'bands',
  band: 'bands',
  instrument: 'instrument',
  instruments: 'instrument',
  association: 'association',
  associations: 'association'
};

function normalizeMusicPersonImportRow(row) {
  const out = {};

  Object.entries(row || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeImportHeaderKey(key);
    const compactKey = normalizedKey.replace(/_/g, '');
    const canonicalKey = MUSIC_PERSON_IMPORT_HEADER_ALIASES[normalizedKey] ||
      MUSIC_PERSON_IMPORT_HEADER_ALIASES[compactKey] ||
      normalizedKey;
    out[canonicalKey] = value;
  });

  return out;
}

function splitMusicDelimitedList(value) {
  return String(value || '')
    .replace(/[\uFF1B\u037E]/g, ';')
    .split(/\s*[;,]\s*/g)
    .map((part) => String(part || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function addMusicPersonMapValue(map, value) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  const key = normalizeMusicLookupKey(clean);
  if (key && !map.has(key)) map.set(key, clean);
}

function formatMusicPersonDbInstrument(value) {
  return splitMusicDelimitedList(value).join(', ');
}

function addMusicPersonDbBand(group, bandName, instrument) {
  const band = String(bandName || '').trim().replace(/\s+/g, ' ');
  if (!band) return;

  const cleanInstrument = formatMusicPersonDbInstrument(instrument);
  const key = `${normalizeMusicLookupKey(band)}|${normalizeMusicLookupKey(cleanInstrument)}`;
  if (group.bandPairs.has(key)) return;

  const item = { band };
  if (cleanInstrument) item.instrument = cleanInstrument;
  group.bandPairs.set(key, item);
}

function buildMusicPersonDbGroups(rows) {
  const groups = new Map();
  let skippedMissingName = 0;

  rows.forEach((row) => {
    const name = String(row.name || '').trim().replace(/\s+/g, ' ');
    if (!name) {
      skippedMissingName += 1;
      return;
    }

    const key = normalizeMusicLookupKey(name);
    if (!groups.has(key)) {
      groups.set(key, {
        name,
        categories: new Map(),
        aliases: new Map(),
        associations: new Map(),
        bandPairs: new Map(),
        rawRows: []
      });
    }

    const group = groups.get(key);
    if (!group.name || group.name === group.name.toLowerCase()) group.name = name;
    addMusicPersonMapValue(group.categories, row.category);
    splitMusicDelimitedList(row.aliases).forEach((alias) => addMusicPersonMapValue(group.aliases, alias));
    splitMusicDelimitedList(row.association).forEach((association) => addMusicPersonMapValue(group.associations, association));

    const bands = splitMusicDelimitedList(row.bands);
    bands.forEach((bandName) => addMusicPersonDbBand(group, bandName, row.instrument));
    group.rawRows.push(compactJsonFields(row));
  });

  return { groups: Array.from(groups.values()), skippedMissingName };
}

function buildMusicPersonDbRows(rows) {
  const grouped = buildMusicPersonDbGroups(rows);
  const people = grouped.groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const items = people.map((person, index) => {
    const aliases = Array.from(person.aliases.values());
    const bands = Array.from(person.bandPairs.values()).sort((a, b) => {
      return a.band.localeCompare(b.band, undefined, { numeric: true, sensitivity: 'base' }) ||
        String(a.instrument || '').localeCompare(String(b.instrument || ''), undefined, { numeric: true, sensitivity: 'base' });
    });
    const associations = Array.from(person.associations.values());

    return {
      person_id: index + 1,
      name: person.name,
      category: Array.from(person.categories.values()).join(', ') || null,
      aliases,
      bands,
      associations,
      stats: {
        bandCount: bands.length,
        aliasCount: aliases.length,
        associationCount: associations.length
      },
      raw_sheet: { rows: person.rawRows }
    };
  });

  return { items, skippedMissingName: grouped.skippedMissingName };
}

async function upsertMusicPersonDbRow(client, item) {
  await client.query(`
    INSERT INTO music_people (
      person_id,
      name,
      category,
      aliases,
      bands,
      associations,
      stats,
      raw_sheet
    )
    VALUES (
      $1, $2, $3, $4::jsonb,
      $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb
    )
    ON CONFLICT (person_id) DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      aliases = EXCLUDED.aliases,
      bands = EXCLUDED.bands,
      associations = EXCLUDED.associations,
      stats = EXCLUDED.stats,
      raw_sheet = EXCLUDED.raw_sheet,
      updated_at = NOW()
  `, [
    item.person_id,
    item.name,
    item.category,
    stringifyDbJson(item.aliases),
    stringifyDbJson(item.bands),
    stringifyDbJson(item.associations),
    stringifyDbJson(item.stats),
    stringifyDbJson(item.raw_sheet)
  ]);
}

async function importMusicPeopleToDatabase(forceRefresh) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('Missing DATABASE_URL environment variable.');
  }

  const payload = await fetchCsvForRoute('/api/music/people', ROUTES['/api/music/people'], forceRefresh);
  const rows = payload.rows.map(normalizeMusicPersonImportRow);
  const built = buildMusicPersonDbRows(rows);
  const client = await dbPool.connect();
  const result = {
    ok: true,
    route: '/admin/import/music/people',
    source: 'Music-People',
    table: 'music_people',
    rowsRead: payload.rows.length,
    peopleTotal: built.items.length,
    upserted: 0,
    skipped: built.skippedMissingName,
    skippedMissingName: built.skippedMissingName,
    duplicatesCombined: Math.max(0, rows.length - built.skippedMissingName - built.items.length)
  };

  try {
    await client.query('BEGIN');

    for (const item of built.items) {
      await upsertMusicPersonDbRow(client, item);
      result.upserted += 1;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const MUSIC_VENUE_IMPORT_HEADER_ALIASES = {
  venue: 'venue',
  name: 'venue',
  city: 'city',
  state: 'state',
  gps_lat: 'gps_lat',
  gpslat: 'gps_lat',
  latitude: 'gps_lat',
  lat: 'gps_lat',
  gps_lng: 'gps_lng',
  gpslng: 'gps_lng',
  gps_lon: 'gps_lng',
  gpslon: 'gps_lng',
  longitude: 'gps_lng',
  lng: 'gps_lng',
  lon: 'gps_lng',
  logo: 'logo',
  logo_url: 'logo',
  logourl: 'logo',
  description: 'description',
  notes: 'notes',
  status: 'status'
};

function normalizeMusicVenueImportRow(row) {
  const out = {};

  Object.entries(row || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeImportHeaderKey(key);
    const compactKey = normalizedKey.replace(/_/g, '');
    const canonicalKey = MUSIC_VENUE_IMPORT_HEADER_ALIASES[normalizedKey] ||
      MUSIC_VENUE_IMPORT_HEADER_ALIASES[compactKey] ||
      normalizedKey;
    out[canonicalKey] = value;
  });

  return out;
}

function cleanMusicVenueText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function getMusicVenueGroupKey(row) {
  return [
    normalizeMusicLookupKey(row.venue),
    normalizeMusicLookupKey(row.city),
    normalizeMusicLookupKey(row.state)
  ].join('|');
}

function setMusicVenueGroupValue(group, key, value) {
  const clean = cleanMusicVenueText(value);
  if (clean && !group[key]) group[key] = clean;
}

function buildMusicVenueDbGroups(rows) {
  const groups = new Map();
  let skippedMissingVenue = 0;

  rows.forEach((row) => {
    const venue = cleanMusicVenueText(row.venue);
    if (!venue) {
      skippedMissingVenue += 1;
      return;
    }

    const key = getMusicVenueGroupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        venue: '',
        city: '',
        state: '',
        gps_lat: '',
        gps_lng: '',
        logo: '',
        description: '',
        notes: '',
        status: '',
        rawRows: []
      });
    }

    const group = groups.get(key);
    setMusicVenueGroupValue(group, 'venue', row.venue);
    setMusicVenueGroupValue(group, 'city', row.city);
    setMusicVenueGroupValue(group, 'state', row.state);
    setMusicVenueGroupValue(group, 'gps_lat', row.gps_lat);
    setMusicVenueGroupValue(group, 'gps_lng', row.gps_lng);
    setMusicVenueGroupValue(group, 'logo', row.logo);
    setMusicVenueGroupValue(group, 'description', row.description);
    setMusicVenueGroupValue(group, 'notes', row.notes);
    setMusicVenueGroupValue(group, 'status', row.status);
    group.rawRows.push(compactJsonFields(row));
  });

  return { groups: Array.from(groups.values()), skippedMissingVenue };
}

function getMusicVenueShowCountKey(venue, city, state) {
  return [
    normalizeMusicLookupKey(venue),
    normalizeMusicLookupKey(city),
    normalizeMusicLookupKey(state)
  ].join('|');
}

async function getMusicVenueShowCountMaps(client) {
  const exact = new Map();
  const venueOnly = new Map();

  try {
    const result = await client.query(`
      SELECT
        lower(trim(coalesce(venue, ''))) AS venue_key,
        lower(trim(coalesce(city, ''))) AS city_key,
        lower(trim(coalesce(state, ''))) AS state_key,
        count(*)::int AS show_count
      FROM music_shows
      WHERE trim(coalesce(venue, '')) <> ''
      GROUP BY 1, 2, 3
    `);

    result.rows.forEach((row) => {
      const count = toIntegerCount(row.show_count);
      const venueKey = normalizeMusicLookupKey(row.venue_key);
      const exactKey = [venueKey, normalizeMusicLookupKey(row.city_key), normalizeMusicLookupKey(row.state_key)].join('|');
      exact.set(exactKey, (exact.get(exactKey) || 0) + count);
      venueOnly.set(venueKey, (venueOnly.get(venueKey) || 0) + count);
    });
  } catch (err) {
    console.warn('Music-Venues showCount lookup skipped:', err && err.message ? err.message : String(err));
  }

  return { exact, venueOnly };
}

function getMusicVenueShowCount(venue, showCounts) {
  const exactKey = getMusicVenueShowCountKey(venue.venue, venue.city, venue.state);
  const venueKey = normalizeMusicLookupKey(venue.venue);
  if (showCounts.exact.has(exactKey)) return showCounts.exact.get(exactKey);
  return showCounts.venueOnly.get(venueKey) || 0;
}

function buildMusicVenueDbRows(rows, showCounts) {
  const grouped = buildMusicVenueDbGroups(rows);
  const venues = grouped.groups.sort((a, b) => {
    return a.venue.localeCompare(b.venue, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.city.localeCompare(b.city, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.state.localeCompare(b.state, undefined, { numeric: true, sensitivity: 'base' });
  });
  const items = venues.map((venue, index) => {
    const showCount = getMusicVenueShowCount(venue, showCounts);

    return {
      venue_id: index + 1,
      venue: venue.venue,
      city: venue.city || null,
      state: venue.state || null,
      gps_lat: venue.gps_lat || null,
      gps_lng: venue.gps_lng || null,
      logo: venue.logo || null,
      description: venue.description || null,
      notes: venue.notes || null,
      status: venue.status || null,
      location: {
        gps_lat: venue.gps_lat || '',
        gps_lng: venue.gps_lng || ''
      },
      media: {
        logo: venue.logo || ''
      },
      stats: {
        showCount
      },
      raw_sheet: { rows: venue.rawRows }
    };
  });

  return { items, skippedMissingVenue: grouped.skippedMissingVenue };
}

async function upsertMusicVenueDbRow(client, item) {
  await client.query(`
    INSERT INTO music_venues (
      venue_id,
      venue,
      city,
      state,
      gps_lat,
      gps_lng,
      logo,
      description,
      notes,
      status,
      location,
      media,
      stats,
      raw_sheet
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11::jsonb, $12::jsonb,
      $13::jsonb, $14::jsonb
    )
    ON CONFLICT (venue_id) DO UPDATE SET
      venue = EXCLUDED.venue,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      gps_lat = EXCLUDED.gps_lat,
      gps_lng = EXCLUDED.gps_lng,
      logo = EXCLUDED.logo,
      description = EXCLUDED.description,
      notes = EXCLUDED.notes,
      status = EXCLUDED.status,
      location = EXCLUDED.location,
      media = EXCLUDED.media,
      stats = EXCLUDED.stats,
      raw_sheet = EXCLUDED.raw_sheet,
      updated_at = NOW()
  `, [
    item.venue_id,
    item.venue,
    item.city,
    item.state,
    item.gps_lat,
    item.gps_lng,
    item.logo,
    item.description,
    item.notes,
    item.status,
    stringifyDbJson(item.location),
    stringifyDbJson(item.media),
    stringifyDbJson(item.stats),
    stringifyDbJson(item.raw_sheet)
  ]);
}

async function importMusicVenuesToDatabase(forceRefresh) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('Missing DATABASE_URL environment variable.');
  }

  const payload = await fetchCsvForRoute('/api/music/venues', ROUTES['/api/music/venues'], forceRefresh);
  const rows = payload.rows.map(normalizeMusicVenueImportRow);
  const client = await dbPool.connect();

  try {
    const showCounts = await getMusicVenueShowCountMaps(client);
    const built = buildMusicVenueDbRows(rows, showCounts);
    const result = {
      ok: true,
      route: '/admin/import/music/venues',
      source: 'Music-Venue',
      table: 'music_venues',
      rowsRead: payload.rows.length,
      venuesTotal: built.items.length,
      upserted: 0,
      skipped: built.skippedMissingVenue,
      skippedMissingVenue: built.skippedMissingVenue,
      duplicatesCombined: Math.max(0, rows.length - built.skippedMissingVenue - built.items.length)
    };

    await client.query('BEGIN');

    for (const item of built.items) {
      await upsertMusicVenueDbRow(client, item);
      result.upserted += 1;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const WRESTLING_MATCHES_SHEET_CONFIG = {
  label: 'Wrestling-Matches',
  gidEnv: 'GID_WRESTLING_MATCHES'
};

const WRESTLING_MATCH_IMPORT_HEADER_ALIASES = {
  promotion: 'promotion',
  show_name: 'show_name',
  showname: 'show_name',
  date: 'date',
  show_date: 'date',
  showdate: 'date',
  venue: 'venue',
  city: 'city',
  state: 'state',
  poster: 'poster',
  poster_url: 'poster',
  posterurl: 'poster',
  camera_1: 'camera_1',
  camera1: 'camera_1',
  camera_2: 'camera_2',
  camera2: 'camera_2',
  match_order: 'match_order',
  matchorder: 'match_order',
  order: 'match_order',
  match_url: 'match_url',
  matchurl: 'match_url',
  url: 'match_url',
  match_type: 'match_type',
  matchtype: 'match_type',
  stipulation: 'stipulation',
  title: 'title',
  side_1: 'side_1',
  side1: 'side_1',
  side_2: 'side_2',
  side2: 'side_2',
  participants: 'participants',
  participant: 'participants',
  winner: 'winner',
  referees: 'referees',
  referee: 'referees',
  notes: 'notes'
};

function normalizeWrestlingMatchImportRow(row) {
  const out = {};

  Object.entries(row || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeImportHeaderKey(key);
    const compactKey = normalizedKey.replace(/_/g, '');
    const canonicalKey = WRESTLING_MATCH_IMPORT_HEADER_ALIASES[normalizedKey] ||
      WRESTLING_MATCH_IMPORT_HEADER_ALIASES[compactKey] ||
      normalizedKey;
    out[canonicalKey] = value;
  });

  return out;
}

function splitWrestlingSemicolonList(value) {
  return String(value || '')
    .split(/\s*;\s*/g)
    .map((part) => String(part || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function toNullableInteger(value) {
  const clean = String(value || '').replace(/,/g, '').trim();
  if (!clean) return null;

  const number = Number(clean);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function getWrestlingMatchOrderSortValue(match) {
  return Number.isFinite(match.match_order) ? match.match_order : Number.MAX_SAFE_INTEGER;
}

function hasWrestlingMatchRowData(row) {
  return [
    'match_order',
    'match_url',
    'match_type',
    'stipulation',
    'title',
    'side_1',
    'side_2',
    'participants',
    'winner',
    'referees',
    'notes'
  ].some((key) => toDbText(row[key]));
}

function getWrestlingShowGroupKey(row) {
  const parsedDate = parseMusicShowDate(row.date);
  const dateKey = parsedDate ? parsedDate.iso : cleanMusicVenueText(row.date).toLowerCase();

  return [
    normalizeMusicLookupKey(row.promotion),
    normalizeMusicLookupKey(row.show_name),
    dateKey
  ].join('|');
}

function buildWrestlingShowKey(show) {
  const parsedDate = parseMusicShowDate(show.date);
  const dateKey = parsedDate ? parsedDate.iso : cleanMusicVenueText(show.date);
  return slugifyMusicBandId([show.promotion, show.show_name, dateKey].filter(Boolean).join(' '));
}

function setWrestlingShowGroupValue(group, key, value) {
  const clean = cleanMusicVenueText(value);
  if (clean && !group[key]) group[key] = clean;
}

function buildWrestlingShowGroups(rows) {
  const groups = new Map();
  let skippedEmptyMatch = 0;
  let skippedMissingShow = 0;

  rows.forEach((row, index) => {
    if (!hasWrestlingMatchRowData(row)) {
      skippedEmptyMatch += 1;
      return;
    }

    if (!toDbText(row.promotion) || !toDbText(row.show_name) || !toDbText(row.date)) {
      skippedMissingShow += 1;
      return;
    }

    const key = getWrestlingShowGroupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        promotion: '',
        show_name: '',
        date: '',
        venue: '',
        city: '',
        state: '',
        poster: '',
        camera_1: '',
        camera_2: '',
        matchRows: [],
        rawRows: []
      });
    }

    const group = groups.get(key);
    setWrestlingShowGroupValue(group, 'promotion', row.promotion);
    setWrestlingShowGroupValue(group, 'show_name', row.show_name);
    setWrestlingShowGroupValue(group, 'date', row.date);
    setWrestlingShowGroupValue(group, 'venue', row.venue);
    setWrestlingShowGroupValue(group, 'city', row.city);
    setWrestlingShowGroupValue(group, 'state', row.state);
    setWrestlingShowGroupValue(group, 'poster', row.poster);
    setWrestlingShowGroupValue(group, 'camera_1', row.camera_1);
    setWrestlingShowGroupValue(group, 'camera_2', row.camera_2);
    group.matchRows.push({ row, index });
    group.rawRows.push(compactJsonFields(row));
  });

  return { groups: Array.from(groups.values()), skippedEmptyMatch, skippedMissingShow };
}

function buildWrestlingMatchDbItem(entry) {
  const row = entry.row;

  return {
    match_order: toNullableInteger(row.match_order),
    match_url: toDbText(row.match_url) || '',
    match_type: toDbText(row.match_type) || '',
    stipulation: toDbText(row.stipulation) || '',
    title: toDbText(row.title) || '',
    side_1: splitWrestlingSemicolonList(row.side_1),
    side_2: splitWrestlingSemicolonList(row.side_2),
    participants: splitWrestlingSemicolonList(row.participants),
    winner: toDbText(row.winner) || '',
    referees: splitWrestlingSemicolonList(row.referees),
    notes: toDbText(row.notes) || ''
  };
}

function sortWrestlingShowGroups(groups) {
  return groups
    .map((show, index) => {
      const parsedDate = parseMusicShowDate(show.date);
      return { show, index, dateTime: parsedDate ? parsedDate.time : null };
    })
    .sort((a, b) => {
      if (a.dateTime == null && b.dateTime == null) return a.index - b.index;
      if (a.dateTime == null) return 1;
      if (b.dateTime == null) return -1;
      return a.dateTime - b.dateTime || a.index - b.index;
    })
    .map((entry) => entry.show);
}

function buildWrestlingShowDbRows(rows) {
  const grouped = buildWrestlingShowGroups(rows);
  const shows = sortWrestlingShowGroups(grouped.groups);
  const items = shows.map((show, index) => {
    const parsedDate = parseMusicShowDate(show.date);
    const matches = show.matchRows
      .map(buildWrestlingMatchDbItem)
      .sort((a, b) => getWrestlingMatchOrderSortValue(a) - getWrestlingMatchOrderSortValue(b));
    const participants = new Map();
    matches.forEach((match) => {
      match.participants.forEach((participant) => {
        const key = normalizeMusicLookupKey(participant);
        if (key && !participants.has(key)) participants.set(key, participant);
      });
    });

    return {
      show_id: index + 1,
      show_key: buildWrestlingShowKey(show),
      promotion: toDbText(show.promotion),
      show_name: toDbText(show.show_name),
      date: toDbText(show.date),
      show_date: parsedDate ? parsedDate.iso : null,
      venue: toDbText(show.venue),
      city: toDbText(show.city),
      state: toDbText(show.state),
      poster: toDbText(show.poster),
      camera_1: toDbText(show.camera_1),
      camera_2: toDbText(show.camera_2),
      matches,
      stats: {
        matchCount: matches.length,
        participantCount: participants.size
      },
      raw_sheet: show.rawRows
    };
  });

  return {
    items,
    skippedEmptyMatch: grouped.skippedEmptyMatch,
    skippedMissingShow: grouped.skippedMissingShow
  };
}

async function upsertWrestlingShowDbRow(client, item) {
  await client.query(`
    INSERT INTO wrestling_shows (
      show_id,
      show_key,
      promotion,
      show_name,
      date,
      show_date,
      venue,
      city,
      state,
      poster,
      camera_1,
      camera_2,
      matches,
      stats,
      raw_sheet
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13::jsonb, $14::jsonb, $15::jsonb
    )
    ON CONFLICT (show_id) DO UPDATE SET
      show_key = EXCLUDED.show_key,
      promotion = EXCLUDED.promotion,
      show_name = EXCLUDED.show_name,
      date = EXCLUDED.date,
      show_date = EXCLUDED.show_date,
      venue = EXCLUDED.venue,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      poster = EXCLUDED.poster,
      camera_1 = EXCLUDED.camera_1,
      camera_2 = EXCLUDED.camera_2,
      matches = EXCLUDED.matches,
      stats = EXCLUDED.stats,
      raw_sheet = EXCLUDED.raw_sheet,
      updated_at = NOW()
  `, [
    item.show_id,
    item.show_key,
    item.promotion,
    item.show_name,
    item.date,
    item.show_date,
    item.venue,
    item.city,
    item.state,
    item.poster,
    item.camera_1,
    item.camera_2,
    stringifyDbJson(item.matches),
    stringifyDbJson(item.stats),
    stringifyDbJson(item.raw_sheet)
  ]);
}

async function importWrestlingShowsToDatabase(forceRefresh) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('Missing DATABASE_URL environment variable.');
  }

  const payload = await fetchCsvForRoute('/admin/import/wrestling/shows', WRESTLING_MATCHES_SHEET_CONFIG, forceRefresh);
  const rows = payload.rows.map(normalizeWrestlingMatchImportRow);
  const built = buildWrestlingShowDbRows(rows);
  const client = await dbPool.connect();
  const result = {
    ok: true,
    route: '/admin/import/wrestling/shows',
    source: 'Wrestling-Matches',
    table: 'wrestling_shows',
    rowsRead: payload.rows.length,
    importedRows: built.items.length,
    upserted: 0,
    skipped: built.skippedEmptyMatch + built.skippedMissingShow,
    skippedEmptyMatch: built.skippedEmptyMatch,
    skippedMissingShow: built.skippedMissingShow,
    matchesTotal: built.items.reduce((total, item) => total + item.matches.length, 0)
  };

  try {
    await client.query('BEGIN');

    for (const item of built.items) {
      await upsertWrestlingShowDbRow(client, item);
      result.upserted += 1;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const WRESTLING_PEOPLE_SHEET_CONFIG = {
  label: 'Wrestling-People',
  gidEnv: 'GID_WRESTLING_PEOPLE'
};

const WRESTLING_PERSON_IMPORT_HEADER_ALIASES = {
  name: 'name',
  wrestler: 'name',
  category: 'category',
  aliases: 'aliases',
  alias: 'aliases',
  teams: 'teams',
  team: 'teams',
  notes: 'notes',
  note: 'notes'
};

function normalizeWrestlingPersonImportRow(row) {
  const out = {};

  Object.entries(row || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeImportHeaderKey(key);
    const compactKey = normalizedKey.replace(/_/g, '');
    const canonicalKey = WRESTLING_PERSON_IMPORT_HEADER_ALIASES[normalizedKey] ||
      WRESTLING_PERSON_IMPORT_HEADER_ALIASES[compactKey] ||
      normalizedKey;
    out[canonicalKey] = value;
  });

  return out;
}

function addWrestlingPersonArrayValues(map, values) {
  values.forEach((value) => {
    const clean = cleanMusicVenueText(value);
    const key = normalizeMusicLookupKey(clean);
    if (key && !map.has(key)) map.set(key, clean);
  });
}

function buildWrestlingPersonDbRows(rows) {
  const groups = new Map();
  let skippedMissingName = 0;

  rows.forEach((row) => {
    const name = cleanMusicVenueText(row.name);
    if (!name) {
      skippedMissingName += 1;
      return;
    }

    const slug = slugifyMusicBandId(name);
    if (!slug) {
      skippedMissingName += 1;
      return;
    }

    if (!groups.has(slug)) {
      groups.set(slug, {
        slug,
        name,
        category: '',
        aliases: new Map(),
        teams: new Map(),
        notes: ''
      });
    }

    const group = groups.get(slug);
    if (!group.name || group.name === group.name.toLowerCase()) group.name = name;
    if (!group.category) group.category = cleanMusicVenueText(row.category);
    if (!group.notes) group.notes = String(row.notes || '').trim();
    addWrestlingPersonArrayValues(group.aliases, splitWrestlingSemicolonList(row.aliases));
    addWrestlingPersonArrayValues(group.teams, splitWrestlingSemicolonList(row.teams));
  });

  const items = Array.from(groups.values())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .map((person) => ({
      slug: person.slug,
      name: person.name,
      category: person.category || null,
      aliases: Array.from(person.aliases.values()),
      teams: Array.from(person.teams.values()),
      notes: person.notes || null
    }));

  return { items, skippedMissingName };
}

async function upsertWrestlingPersonDbRow(client, item) {
  await client.query(`
    INSERT INTO wrestling_people (
      slug,
      name,
      category,
      aliases,
      teams,
      notes
    )
    VALUES ($1, $2, $3, $4::text[], $5::text[], $6)
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      aliases = EXCLUDED.aliases,
      teams = EXCLUDED.teams,
      notes = EXCLUDED.notes,
      updated_at = NOW()
  `, [
    item.slug,
    item.name,
    item.category,
    item.aliases,
    item.teams,
    item.notes
  ]);
}

async function importWrestlingPeopleToDatabase(forceRefresh) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('Missing DATABASE_URL environment variable.');
  }
  if (!normalizeSheetGid(process.env.GID_WRESTLING_PEOPLE)) {
    throw new Error('Missing GID_WRESTLING_PEOPLE environment variable.');
  }

  const payload = await fetchCsvForRoute('/api/wrestling/people/import', WRESTLING_PEOPLE_SHEET_CONFIG, forceRefresh);
  const rows = payload.rows.map(normalizeWrestlingPersonImportRow);
  const built = buildWrestlingPersonDbRows(rows);
  const client = await dbPool.connect();
  const generated = new Date();
  const result = {
    ok: true,
    route: '/api/wrestling/people/import',
    source: 'Wrestling-People',
    table: 'wrestling_people',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    rowsRead: payload.rows.length,
    imported: built.items.length,
    upserted: 0,
    skipped: built.skippedMissingName,
    skippedMissingName: built.skippedMissingName
  };

  try {
    await client.query('BEGIN');

    for (const item of built.items) {
      await upsertWrestlingPersonDbRow(client, item);
      result.upserted += 1;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const WRESTLING_VENUES_SHEET_CONFIG = {
  label: 'Wrestling-Venue',
  gidEnv: 'GID_WRESTLING_VENUES'
};

const WRESTLING_VENUE_IMPORT_HEADER_ALIASES = {
  venue_id: 'venue_id',
  venueid: 'venue_id',
  venue_name: 'venue_name',
  venuename: 'venue_name',
  venue: 'venue_name',
  name: 'venue_name',
  city: 'city',
  state: 'state',
  country: 'country',
  region: 'region',
  venue_type: 'venue_type',
  venuetype: 'venue_type',
  type: 'venue_type',
  status: 'status',
  latitude: 'latitude',
  lat: 'latitude',
  gps_lat: 'latitude',
  gpslat: 'latitude',
  longitude: 'longitude',
  lng: 'longitude',
  lon: 'longitude',
  gps_lng: 'longitude',
  gpslng: 'longitude',
  notes: 'notes',
  note: 'notes'
};

function normalizeWrestlingVenueImportRow(row) {
  const out = {};

  Object.entries(row || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeImportHeaderKey(key);
    const compactKey = normalizedKey.replace(/_/g, '');
    const canonicalKey = WRESTLING_VENUE_IMPORT_HEADER_ALIASES[normalizedKey] ||
      WRESTLING_VENUE_IMPORT_HEADER_ALIASES[compactKey] ||
      normalizedKey;
    out[canonicalKey] = value;
  });

  return out;
}

function toNullableNumber(value) {
  const clean = String(value || '').replace(/,/g, '').trim();
  if (!clean) return null;

  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

function createEmptyWrestlingVenueGeo() {
  return {
    formatted_address: null,
    county: null,
    timezone: null,
    postal_code: null,
    google_maps_url: null,
    apple_maps_url: null,
    osm_url: null,
    geohash: null,
    elevation: null,
    venue_image: null,
    nearby_airports: [],
    weather_region: null
  };
}

function buildWrestlingVenueFallbackId(row) {
  return slugifyMusicBandId([
    row.venue_name,
    row.city,
    row.state,
    row.country
  ].filter(Boolean).join(' '));
}

function buildWrestlingVenueDbRows(rows) {
  const items = [];
  const seen = new Set();
  let skippedMissingVenue = 0;
  let generatedVenueIds = 0;

  rows.forEach((row) => {
    const venueName = cleanMusicVenueText(row.venue_name);
    if (!venueName) {
      skippedMissingVenue += 1;
      return;
    }

    const providedVenueId = cleanMusicVenueText(row.venue_id);
    const generatedVenueId = providedVenueId ? '' : buildWrestlingVenueFallbackId({ ...row, venue_name: venueName });
    const venueId = providedVenueId || generatedVenueId;
    if (!venueId || seen.has(venueId)) return;
    if (generatedVenueId) generatedVenueIds += 1;
    seen.add(venueId);

    items.push({
      venue_id: venueId,
      venue_name: venueName,
      city: toDbText(row.city),
      state: toDbText(row.state),
      country: toDbText(row.country),
      region: toDbText(row.region),
      venue_type: toDbText(row.venue_type),
      status: toDbText(row.status),
      latitude: toNullableNumber(row.latitude),
      longitude: toNullableNumber(row.longitude),
      notes: toDbText(row.notes),
      geo: createEmptyWrestlingVenueGeo(),
      raw_sheet: compactJsonFields(row)
    });
  });

  items.sort((a, b) => {
    return a.venue_name.localeCompare(b.venue_name, undefined, { numeric: true, sensitivity: 'base' }) ||
      String(a.city || '').localeCompare(String(b.city || ''), undefined, { numeric: true, sensitivity: 'base' }) ||
      String(a.state || '').localeCompare(String(b.state || ''), undefined, { numeric: true, sensitivity: 'base' });
  });

  return { items, skippedMissingVenue, generatedVenueIds };
}

async function upsertWrestlingVenueDbRow(client, item) {
  await client.query(`
    INSERT INTO wrestling_venues (
      venue_id,
      venue_name,
      city,
      state,
      country,
      region,
      venue_type,
      status,
      latitude,
      longitude,
      notes,
      geo,
      raw_sheet
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12::jsonb, $13::jsonb
    )
    ON CONFLICT (venue_id) DO UPDATE SET
      venue_name = EXCLUDED.venue_name,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      country = EXCLUDED.country,
      region = EXCLUDED.region,
      venue_type = EXCLUDED.venue_type,
      status = EXCLUDED.status,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      notes = EXCLUDED.notes,
      geo = EXCLUDED.geo,
      raw_sheet = EXCLUDED.raw_sheet,
      updated_at = NOW()
  `, [
    item.venue_id,
    item.venue_name,
    item.city,
    item.state,
    item.country,
    item.region,
    item.venue_type,
    item.status,
    item.latitude,
    item.longitude,
    item.notes,
    stringifyDbJson(item.geo),
    stringifyDbJson(item.raw_sheet)
  ]);
}

async function importWrestlingVenuesToDatabase(forceRefresh) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('Missing DATABASE_URL environment variable.');
  }
  if (!normalizeSheetGid(process.env.GID_WRESTLING_VENUES)) {
    throw new Error('Missing GID_WRESTLING_VENUES environment variable.');
  }

  const payload = await fetchCsvForRoute('/admin/import/wrestling/venues', WRESTLING_VENUES_SHEET_CONFIG, forceRefresh);
  const rows = payload.rows.map(normalizeWrestlingVenueImportRow);
  const built = buildWrestlingVenueDbRows(rows);
  const client = await dbPool.connect();
  const result = {
    ok: true,
    route: '/admin/import/wrestling/venues',
    source: 'Wrestling-Venue',
    table: 'wrestling_venues',
    rowsRead: payload.rows.length,
    importedRows: built.items.length,
    upserted: 0,
    skipped: built.skippedMissingVenue,
    skippedMissingVenue: built.skippedMissingVenue,
    generatedVenueIds: built.generatedVenueIds
  };

  try {
    await client.query('BEGIN');

    for (const item of built.items) {
      await upsertWrestlingVenueDbRow(client, item);
      result.upserted += 1;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function buildMusicBandDbApiItem(row) {
  return {
    band: row.band,
    band_id: row.band_id,
    general: row.general && typeof row.general === 'object' ? row.general : {},
    personnel: row.personnel && typeof row.personnel === 'object' ? row.personnel : {},
    stats: row.stats && typeof row.stats === 'object' ? row.stats : {}
  };
}

function getPositiveLimit(value) {
  const limit = Number(String(value || '').trim());
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

function getClampedLimit(value) {
  const limit = Number(String(value || '').trim());
  if (!Number.isInteger(limit)) return 50;
  return Math.min(100, Math.max(1, limit));
}

function getPageNumber(value) {
  const page = Number(String(value || '').trim());
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function buildMusicBandsDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const region = String(query.region || '').trim();
  const status = String(query.status || '').trim();
  const sortFields = {
    band: 'band',
    band_id: 'band_id',
    region: 'region',
    status: 'status',
    created_at: 'created_at',
    updated_at: 'updated_at'
  };
  const requestedSort = String(query.sort || 'band').trim().toLowerCase();
  const sortField = sortFields[requestedSort] ? requestedSort : 'band';
  const dir = String(query.dir || 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    where.push(`(
      band ILIKE $${idx}
      OR band_id ILIKE $${idx}
      OR coalesce(smug_folder, '') ILIKE $${idx}
      OR coalesce(region, '') ILIKE $${idx}
      OR coalesce(location, '') ILIKE $${idx}
      OR coalesce(state, '') ILIKE $${idx}
      OR coalesce(country, '') ILIKE $${idx}
      OR coalesce(tags, '') ILIKE $${idx}
      OR coalesce(status, '') ILIKE $${idx}
      OR coalesce(notes, '') ILIKE $${idx}
      OR coalesce(members, '') ILIKE $${idx}
      OR coalesce(past_members, '') ILIKE $${idx}
      OR general::text ILIKE $${idx}
      OR personnel::text ILIKE $${idx}
      OR stats::text ILIKE $${idx}
    )`);
    filters.search = search;
  }

  if (region) {
    values.push(region.toLowerCase());
    where.push(`region_key = $${values.length}`);
    filters.region = region;
  }

  if (status) {
    values.push(status.toLowerCase());
    where.push(`(status_key = $${values.length} OR completion_status = $${values.length})`);
    filters.status = status;
  }

  return {
    values,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    filters,
    sort: {
      field: sortField,
      dir
    },
    orderBySql: `${sortFields[sortField]} ${dir.toUpperCase()}, band ASC`
  };
}

const MUSIC_BANDS_DB_BASE_SQL = `
  WITH band_rows AS (
    SELECT
      *,
      lower(trim(coalesce(region, ''))) AS region_key,
      lower(trim(coalesce(status, ''))) AS status_key,
      coalesce(total_sets, 0) AS total_set_count,
      coalesce(archived_sets, 0) AS archived_set_count
    FROM music_bands
  ),
  filtered_bands AS (
    SELECT
      *,
      CASE
        WHEN status_key IN ('complete', 'completed') THEN 'complete'
        WHEN status_key = 'partial' THEN 'partial'
        WHEN status_key IN ('none', 'no', 'missing') THEN 'none'
        WHEN total_set_count > 0 AND archived_set_count > 0 AND total_set_count = archived_set_count THEN 'complete'
        WHEN total_set_count > 0 AND archived_set_count > 0 AND total_set_count <> archived_set_count THEN 'partial'
        ELSE 'none'
      END AS completion_status
    FROM band_rows
  )
`;

async function handleMusicBandsDbRequest(req, res, routePath) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const options = buildMusicBandsDbQueryOptions(req.query);
    const countResult = await dbPool.query(
      `${MUSIC_BANDS_DB_BASE_SQL}
       SELECT count(*)::int AS total FROM filtered_bands ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `${MUSIC_BANDS_DB_BASE_SQL}
       SELECT band, band_id, general, personnel, stats
       FROM filtered_bands
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );

    res.json({
      ok: true,
      route: routePath,
      source: 'PostgreSQL:music_bands',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: result.rows.length,
      total,
      page,
      limit,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      filters: options.filters,
      sort: options.sort,
      data: result.rows.map(buildMusicBandDbApiItem)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: routePath,
      source: 'PostgreSQL:music_bands',
      error: err && err.message ? err.message : String(err)
    });
  }
}

function toIntegerCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

async function getMusicBandsDbStats() {
  const result = await dbPool.query(`
    WITH band_rows AS (
      SELECT
        lower(trim(coalesce(region, ''))) AS region_key,
        lower(trim(coalesce(status, ''))) AS status_key,
        coalesce(total_sets, 0) AS total_set_count,
        coalesce(archived_sets, 0) AS archived_set_count,
        CASE
          WHEN coalesce(stats->>'totalPhotos', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (stats->>'totalPhotos')::numeric
          ELSE 0
        END AS photo_count
      FROM music_bands
    ),
    normalized AS (
      SELECT
        *,
        CASE
          WHEN status_key IN ('complete', 'completed') THEN 'complete'
          WHEN status_key = 'partial' THEN 'partial'
          WHEN status_key IN ('none', 'no', 'missing') THEN 'none'
          WHEN total_set_count > 0 AND archived_set_count > 0 AND total_set_count = archived_set_count THEN 'complete'
          WHEN total_set_count > 0 AND archived_set_count > 0 AND total_set_count <> archived_set_count THEN 'partial'
          ELSE 'none'
        END AS completion_status
      FROM band_rows
    )
    SELECT
      count(*)::int AS bands_total,
      count(*) FILTER (WHERE region_key = 'local')::int AS bands_local,
      count(*) FILTER (WHERE region_key = 'regional')::int AS bands_regional,
      count(*) FILTER (WHERE region_key = 'national')::int AS bands_national,
      count(*) FILTER (WHERE region_key = 'international')::int AS bands_international,
      count(*) FILTER (WHERE completion_status = 'complete')::int AS bands_complete,
      count(*) FILTER (WHERE completion_status = 'partial')::int AS bands_partial,
      count(*) FILTER (WHERE completion_status = 'none')::int AS bands_none,
      coalesce(sum(photo_count), 0)::int AS photos_total,
      coalesce(sum(photo_count) FILTER (WHERE region_key = 'local'), 0)::int AS photos_local,
      coalesce(sum(photo_count) FILTER (WHERE region_key = 'regional'), 0)::int AS photos_regional,
      coalesce(sum(photo_count) FILTER (WHERE region_key = 'national'), 0)::int AS photos_national,
      coalesce(sum(photo_count) FILTER (WHERE region_key = 'international'), 0)::int AS photos_international
    FROM normalized
  `);

  return result.rows && result.rows[0] ? result.rows[0] : {};
}

async function buildMusicBandsDbStatsResponse(forceRefresh) {
  const generated = new Date();
  const dbStats = await getMusicBandsDbStats();
  const progressStats = createMusicBandsStats();
  await addStatsSheetPhotoProgress(progressStats, forceRefresh);

  const photosTotal = toIntegerCount(dbStats.photos_total);
  const photosLocal = toIntegerCount(dbStats.photos_local);
  const photosRegional = toIntegerCount(dbStats.photos_regional);
  const photosNational = toIntegerCount(dbStats.photos_national);
  const photosInternational = toIntegerCount(dbStats.photos_international);

  return {
    ok: true,
    route: '/api/music/bands/stats',
    source: 'PostgreSQL:music_bands',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    bandTotals: {
      bandsTotal: toIntegerCount(dbStats.bands_total),
      bandsLocal: toIntegerCount(dbStats.bands_local),
      bandsRegional: toIntegerCount(dbStats.bands_regional),
      bandsNational: toIntegerCount(dbStats.bands_national),
      bandsInternational: toIntegerCount(dbStats.bands_international),
      bandsComplete: toIntegerCount(dbStats.bands_complete),
      bandsPartial: toIntegerCount(dbStats.bands_partial),
      bandsNone: toIntegerCount(dbStats.bands_none)
    },
    photoTotals: {
      photosTotal,
      photosLocal,
      photosRegional,
      photosNational,
      photosInternational,
      photosDone: progressStats.photosDone,
      photosEditing: progressStats.photosEditing,
      photosNone: progressStats.photosNone
    },
    percentages: {
      photosLocalPct: formatMusicBandsPhotoPct(photosLocal, photosTotal),
      photosRegionalPct: formatMusicBandsPhotoPct(photosRegional, photosTotal),
      photosNationalPct: formatMusicBandsPhotoPct(photosNational, photosTotal),
      photosInternationalPct: formatMusicBandsPhotoPct(photosInternational, photosTotal),
      photosDonePct: progressStats.photosDonePct,
      photosEditingPct: progressStats.photosEditingPct,
      photosNonePct: progressStats.photosNonePct
    }
  };
}

function buildMusicShowDbApiItem(row) {
  return {
    show_id: toIntegerCount(row.show_id),
    name: row.name || '',
    venue: row.venue || '',
    city: row.city || '',
    state: row.state || '',
    date: row.date || '',
    poster: row.poster || '',
    notes: row.notes || '',
    camera_1: row.camera_1 || '',
    camera_2: row.camera_2 || '',
    bands: Array.isArray(row.bands) ? row.bands : [],
    stats: row.stats && typeof row.stats === 'object' ? row.stats : {}
  };
}

function buildMusicShowsDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const state = String(query.state || '').trim();
  const city = String(query.city || '').trim();
  const venue = String(query.venue || '').trim();
  const band = String(query.band || '').trim();
  const sortFields = {
    show_id: 'show_id',
    name: 'name',
    date: 'show_date',
    venue: 'venue',
    city: 'city',
    state: 'state',
    created_at: 'created_at',
    updated_at: 'updated_at'
  };
  const requestedSort = String(query.sort || 'date').trim().toLowerCase();
  const sortField = sortFields[requestedSort] ? requestedSort : 'date';
  const dir = String(query.dir || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
  const bandsArraySql = "CASE WHEN jsonb_typeof(bands) = 'array' THEN bands ELSE '[]'::jsonb END";

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    where.push(`(
      coalesce(name, '') ILIKE $${idx}
      OR coalesce(venue, '') ILIKE $${idx}
      OR coalesce(city, '') ILIKE $${idx}
      OR coalesce(state, '') ILIKE $${idx}
      OR coalesce(notes, '') ILIKE $${idx}
      OR coalesce(poster, '') ILIKE $${idx}
      OR bands::text ILIKE $${idx}
    )`);
    filters.search = search;
  }

  if (state) {
    values.push(state.toLowerCase());
    where.push(`lower(trim(coalesce(state, ''))) = $${values.length}`);
    filters.state = state;
  }

  if (city) {
    values.push(city.toLowerCase());
    where.push(`lower(trim(coalesce(city, ''))) = $${values.length}`);
    filters.city = city;
  }

  if (venue) {
    values.push(venue.toLowerCase());
    where.push(`lower(trim(coalesce(venue, ''))) = $${values.length}`);
    filters.venue = venue;
  }

  if (band) {
    values.push(band.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${bandsArraySql}) AS band_item
      WHERE lower(trim(coalesce(band_item->>'band', ''))) = $${values.length}
    )`);
    filters.band = band;
  }

  return {
    values,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    filters,
    sort: {
      field: sortField,
      dir
    },
    orderBySql: `${sortFields[sortField]} ${dir.toUpperCase()} NULLS LAST, show_id ${dir.toUpperCase()}`
  };
}

async function handleMusicShowsDbRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const options = buildMusicShowsDbQueryOptions(req.query);
    const countResult = await dbPool.query(
      `SELECT count(*)::int AS total FROM music_shows ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `SELECT show_id, name, venue, city, state, date, poster, notes, camera_1, camera_2, bands, stats
       FROM music_shows
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const data = result.rows.map(buildMusicShowDbApiItem);

    res.json({
      ok: true,
      route: '/api/music/shows/db',
      source: 'PostgreSQL:music_shows',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: data.length,
      total,
      page,
      limit,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      filters: options.filters,
      sort: options.sort,
      stats: {
        showsTotal: total,
        bandsTotal: data.reduce((sum, show) => sum + (Array.isArray(show.bands) ? show.bands.length : 0), 0)
      },
      data
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/music/shows/db',
      source: 'PostgreSQL:music_shows',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function buildMusicShowsDbStatsResponse() {
  const generated = new Date();
  const bandsArraySql = "CASE WHEN jsonb_typeof(bands) = 'array' THEN bands ELSE '[]'::jsonb END";
  const totalsQuery = dbPool.query(`
    SELECT
      count(*)::int AS shows_total,
      coalesce(sum(jsonb_array_length(${bandsArraySql})), 0)::int AS band_appearances_total
    FROM music_shows
  `);
  const uniqueBandsQuery = dbPool.query(`
    SELECT count(DISTINCT lower(trim(band_item->>'band')))::int AS unique_bands
    FROM music_shows
    CROSS JOIN LATERAL jsonb_array_elements(${bandsArraySql}) AS band_item
    WHERE trim(coalesce(band_item->>'band', '')) <> ''
  `);
  const byYearQuery = dbPool.query(`
    SELECT coalesce(to_char(show_date, 'YYYY'), 'Unknown') AS year, count(*)::int AS shows_total
    FROM music_shows
    GROUP BY 1
    ORDER BY 1 DESC
  `);
  const byStateQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(state), ''), 'Unknown') AS state, count(*)::int AS shows_total
    FROM music_shows
    GROUP BY 1
    ORDER BY shows_total DESC, state ASC
  `);
  const byCityQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(city), ''), 'Unknown') AS city, count(*)::int AS shows_total
    FROM music_shows
    GROUP BY 1
    ORDER BY shows_total DESC, city ASC
  `);
  const byVenueQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(venue), ''), 'Unknown') AS venue, count(*)::int AS shows_total
    FROM music_shows
    GROUP BY 1
    ORDER BY shows_total DESC, venue ASC
  `);
  const topBandsQuery = dbPool.query(`
    SELECT band_item->>'band' AS band, count(*)::int AS appearances
    FROM music_shows
    CROSS JOIN LATERAL jsonb_array_elements(${bandsArraySql}) AS band_item
    WHERE trim(coalesce(band_item->>'band', '')) <> ''
    GROUP BY 1
    ORDER BY appearances DESC, band ASC
    LIMIT 25
  `);
  const [totalsResult, uniqueBandsResult, byYearResult, byStateResult, byCityResult, byVenueResult, topBandsResult] = await Promise.all([
    totalsQuery,
    uniqueBandsQuery,
    byYearQuery,
    byStateQuery,
    byCityQuery,
    byVenueQuery,
    topBandsQuery
  ]);
  const totals = totalsResult.rows && totalsResult.rows[0] ? totalsResult.rows[0] : {};
  const uniqueBands = uniqueBandsResult.rows && uniqueBandsResult.rows[0] ? uniqueBandsResult.rows[0] : {};

  return {
    ok: true,
    route: '/api/music/shows/stats',
    source: 'PostgreSQL:music_shows',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    totals: {
      showsTotal: toIntegerCount(totals.shows_total),
      bandAppearancesTotal: toIntegerCount(totals.band_appearances_total),
      uniqueBands: toIntegerCount(uniqueBands.unique_bands)
    },
    byYear: byYearResult.rows.map((row) => ({ year: row.year, showsTotal: toIntegerCount(row.shows_total) })),
    byState: byStateResult.rows.map((row) => ({ state: row.state, showsTotal: toIntegerCount(row.shows_total) })),
    byCity: byCityResult.rows.map((row) => ({ city: row.city, showsTotal: toIntegerCount(row.shows_total) })),
    byVenue: byVenueResult.rows.map((row) => ({ venue: row.venue, showsTotal: toIntegerCount(row.shows_total) })),
    topBands: topBandsResult.rows.map((row) => ({ band: row.band, appearances: toIntegerCount(row.appearances) }))
  };
}

function buildWrestlingMatchDbApiItem(match) {
  if (!match || typeof match !== 'object') return { referees: [] };

  return {
    ...match,
    side_1: Array.isArray(match.side_1) ? match.side_1 : [],
    side_2: Array.isArray(match.side_2) ? match.side_2 : [],
    participants: Array.isArray(match.participants) ? match.participants : [],
    referees: Array.isArray(match.referees) ? match.referees : []
  };
}

function buildWrestlingShowDbApiItem(row) {
  return {
    show_id: toIntegerCount(row.show_id),
    show_key: row.show_key || '',
    promotion: row.promotion || '',
    show_name: row.show_name || '',
    date: row.date || '',
    venue: row.venue || '',
    city: row.city || '',
    state: row.state || '',
    poster: row.poster || '',
    camera_1: row.camera_1 || '',
    camera_2: row.camera_2 || '',
    matches: Array.isArray(row.matches) ? row.matches.map(buildWrestlingMatchDbApiItem) : [],
    stats: row.stats && typeof row.stats === 'object' ? row.stats : {}
  };
}

function getWrestlingMatchesArraySql() {
  return "CASE WHEN jsonb_typeof(matches) = 'array' THEN matches ELSE '[]'::jsonb END";
}

function getWrestlingParticipantsArraySql(matchAlias) {
  return `CASE WHEN jsonb_typeof(${matchAlias}->'participants') = 'array' THEN ${matchAlias}->'participants' ELSE '[]'::jsonb END`;
}

function getWrestlingRefereesArraySql(matchAlias) {
  return `CASE WHEN jsonb_typeof(${matchAlias}->'referees') = 'array' THEN ${matchAlias}->'referees' ELSE '[]'::jsonb END`;
}

function buildWrestlingShowsDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const promotion = String(query.promotion || '').trim();
  const state = String(query.state || '').trim();
  const city = String(query.city || '').trim();
  const venue = String(query.venue || '').trim();
  const participant = String(query.participant || '').trim();
  const winner = String(query.winner || '').trim();
  const referee = String(query.referee || '').trim();
  const sortFields = {
    show_id: 'show_id',
    show_key: 'show_key',
    promotion: 'promotion',
    show_name: 'show_name',
    date: 'show_date',
    venue: 'venue',
    city: 'city',
    state: 'state',
    created_at: 'created_at',
    updated_at: 'updated_at'
  };
  const requestedSort = String(query.sort || 'date').trim().toLowerCase();
  const sortField = sortFields[requestedSort] ? requestedSort : 'date';
  const dir = String(query.dir || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
  const matchesArraySql = getWrestlingMatchesArraySql();

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    where.push(`(
      coalesce(promotion, '') ILIKE $${idx}
      OR coalesce(show_name, '') ILIKE $${idx}
      OR coalesce(venue, '') ILIKE $${idx}
      OR coalesce(city, '') ILIKE $${idx}
      OR coalesce(state, '') ILIKE $${idx}
      OR coalesce(poster, '') ILIKE $${idx}
      OR matches::text ILIKE $${idx}
    )`);
    filters.search = search;
  }

  if (promotion) {
    values.push(promotion.toLowerCase());
    where.push(`lower(trim(coalesce(promotion, ''))) = $${values.length}`);
    filters.promotion = promotion;
  }

  if (state) {
    values.push(state.toLowerCase());
    where.push(`lower(trim(coalesce(state, ''))) = $${values.length}`);
    filters.state = state;
  }

  if (city) {
    values.push(city.toLowerCase());
    where.push(`lower(trim(coalesce(city, ''))) = $${values.length}`);
    filters.city = city;
  }

  if (venue) {
    values.push(venue.toLowerCase());
    where.push(`lower(trim(coalesce(venue, ''))) = $${values.length}`);
    filters.venue = venue;
  }

  if (participant) {
    values.push(participant.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${matchesArraySql}) AS match_item
      CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingParticipantsArraySql('match_item')}) AS participant_item(value)
      WHERE lower(trim(participant_item.value)) = $${values.length}
    )`);
    filters.participant = participant;
  }

  if (winner) {
    values.push(winner.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${matchesArraySql}) AS match_item
      WHERE lower(trim(coalesce(match_item->>'winner', ''))) = $${values.length}
    )`);
    filters.winner = winner;
  }

  if (referee) {
    values.push(referee.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${matchesArraySql}) AS match_item
      CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingRefereesArraySql('match_item')}) AS referee_item(value)
      WHERE lower(trim(referee_item.value)) = $${values.length}
    )`);
    filters.referee = referee;
  }

  return {
    values,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    filters,
    sort: {
      field: sortField,
      dir
    },
    orderBySql: `${sortFields[sortField]} ${dir.toUpperCase()} NULLS LAST, show_id ${dir.toUpperCase()}`
  };
}

async function handleWrestlingShowsDbRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const options = buildWrestlingShowsDbQueryOptions(req.query);
    const countResult = await dbPool.query(
      `SELECT count(*)::int AS total FROM wrestling_shows ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `SELECT show_id, show_key, promotion, show_name, date, venue, city, state, poster, camera_1, camera_2, matches, stats
       FROM wrestling_shows
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const data = result.rows.map(buildWrestlingShowDbApiItem);

    res.json({
      ok: true,
      route: '/api/wrestling/shows/db',
      source: 'PostgreSQL:wrestling_shows',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: data.length,
      total,
      page,
      limit,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      filters: options.filters,
      sort: options.sort,
      stats: {
        showsTotal: total,
        matchesTotal: data.reduce((sum, show) => sum + (Array.isArray(show.matches) ? show.matches.length : 0), 0)
      },
      data
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/wrestling/shows/db',
      source: 'PostgreSQL:wrestling_shows',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function buildWrestlingShowsDbStatsResponse() {
  const generated = new Date();
  const matchesArraySql = getWrestlingMatchesArraySql();
  const participantArraySql = getWrestlingParticipantsArraySql('match_item');
  const refereeArraySql = getWrestlingRefereesArraySql('match_item');
  const totalsQuery = dbPool.query(`
    WITH show_rows AS (
      SELECT ${matchesArraySql} AS match_items
      FROM wrestling_shows
    )
    SELECT
      count(*)::int AS shows_total,
      coalesce(sum(jsonb_array_length(match_items)), 0)::int AS matches_total
    FROM show_rows
  `);
  const uniqueParticipantsQuery = dbPool.query(`
    SELECT count(DISTINCT lower(trim(participant_item.value)))::int AS unique_participants
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    CROSS JOIN LATERAL jsonb_array_elements_text(${participantArraySql}) AS participant_item(value)
    WHERE trim(participant_item.value) <> ''
  `);
  const matchesWithRefereesQuery = dbPool.query(`
    SELECT count(*)::int AS matches_with_referees
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    WHERE jsonb_array_length(${refereeArraySql}) > 0
  `);
  const uniqueRefereesQuery = dbPool.query(`
    SELECT count(DISTINCT lower(trim(referee_item.value)))::int AS unique_referees
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    CROSS JOIN LATERAL jsonb_array_elements_text(${refereeArraySql}) AS referee_item(value)
    WHERE trim(referee_item.value) <> ''
  `);
  const byPromotionQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(promotion), ''), 'Unknown') AS promotion, count(*)::int AS shows_total
    FROM wrestling_shows
    GROUP BY 1
    ORDER BY shows_total DESC, promotion ASC
  `);
  const byYearQuery = dbPool.query(`
    SELECT coalesce(to_char(show_date, 'YYYY'), 'Unknown') AS year, count(*)::int AS shows_total
    FROM wrestling_shows
    GROUP BY 1
    ORDER BY 1 DESC
  `);
  const byStateQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(state), ''), 'Unknown') AS state, count(*)::int AS shows_total
    FROM wrestling_shows
    GROUP BY 1
    ORDER BY shows_total DESC, state ASC
  `);
  const byCityQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(city), ''), 'Unknown') AS city, count(*)::int AS shows_total
    FROM wrestling_shows
    GROUP BY 1
    ORDER BY shows_total DESC, city ASC
  `);
  const byVenueQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(venue), ''), 'Unknown') AS venue, count(*)::int AS shows_total
    FROM wrestling_shows
    GROUP BY 1
    ORDER BY shows_total DESC, venue ASC
  `);
  const topParticipantsQuery = dbPool.query(`
    SELECT participant_item.value AS participant, count(*)::int AS appearances
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    CROSS JOIN LATERAL jsonb_array_elements_text(${participantArraySql}) AS participant_item(value)
    WHERE trim(participant_item.value) <> ''
    GROUP BY 1
    ORDER BY appearances DESC, participant ASC
    LIMIT 25
  `);
  const topWinnersQuery = dbPool.query(`
    SELECT match_item->>'winner' AS winner, count(*)::int AS wins
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    WHERE trim(coalesce(match_item->>'winner', '')) <> ''
    GROUP BY 1
    ORDER BY wins DESC, winner ASC
    LIMIT 25
  `);
  const [
    totalsResult,
    uniqueParticipantsResult,
    matchesWithRefereesResult,
    uniqueRefereesResult,
    byPromotionResult,
    byYearResult,
    byStateResult,
    byCityResult,
    byVenueResult,
    topParticipantsResult,
    topWinnersResult
  ] = await Promise.all([
    totalsQuery,
    uniqueParticipantsQuery,
    matchesWithRefereesQuery,
    uniqueRefereesQuery,
    byPromotionQuery,
    byYearQuery,
    byStateQuery,
    byCityQuery,
    byVenueQuery,
    topParticipantsQuery,
    topWinnersQuery
  ]);
  const totals = totalsResult.rows && totalsResult.rows[0] ? totalsResult.rows[0] : {};
  const uniqueParticipants = uniqueParticipantsResult.rows && uniqueParticipantsResult.rows[0] ? uniqueParticipantsResult.rows[0] : {};
  const matchesWithReferees = matchesWithRefereesResult.rows && matchesWithRefereesResult.rows[0] ? matchesWithRefereesResult.rows[0] : {};
  const uniqueReferees = uniqueRefereesResult.rows && uniqueRefereesResult.rows[0] ? uniqueRefereesResult.rows[0] : {};

  return {
    ok: true,
    route: '/api/wrestling/shows/stats',
    source: 'PostgreSQL:wrestling_shows',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    totals: {
      showsTotal: toIntegerCount(totals.shows_total),
      matchesTotal: toIntegerCount(totals.matches_total),
      uniqueParticipants: toIntegerCount(uniqueParticipants.unique_participants),
      matchesWithReferees: toIntegerCount(matchesWithReferees.matches_with_referees),
      uniqueReferees: toIntegerCount(uniqueReferees.unique_referees)
    },
    byPromotion: byPromotionResult.rows.map((row) => ({ promotion: row.promotion, showsTotal: toIntegerCount(row.shows_total) })),
    byYear: byYearResult.rows.map((row) => ({ year: row.year, showsTotal: toIntegerCount(row.shows_total) })),
    byState: byStateResult.rows.map((row) => ({ state: row.state, showsTotal: toIntegerCount(row.shows_total) })),
    byCity: byCityResult.rows.map((row) => ({ city: row.city, showsTotal: toIntegerCount(row.shows_total) })),
    byVenue: byVenueResult.rows.map((row) => ({ venue: row.venue, showsTotal: toIntegerCount(row.shows_total) })),
    topParticipants: topParticipantsResult.rows.map((row) => ({ participant: row.participant, appearances: toIntegerCount(row.appearances) })),
    topWinners: topWinnersResult.rows.map((row) => ({ winner: row.winner, wins: toIntegerCount(row.wins) }))
  };
}

function buildWrestlingPersonDbApiItem(row) {
  return {
    id: toIntegerCount(row.id),
    slug: row.slug || '',
    name: row.name || '',
    category: row.category || '',
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    teams: Array.isArray(row.teams) ? row.teams : [],
    notes: row.notes || ''
  };
}

function getPostgresTextArraySql(columnName) {
  return `coalesce(${columnName}, '{}'::text[])`;
}

function buildWrestlingPeopleDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const category = String(query.category || '').trim();
  const team = String(query.team || '').trim();
  const sortOptions = {
    name_asc: {
      key: 'name_asc',
      orderBySql: 'name ASC NULLS LAST, id ASC'
    },
    name_desc: {
      key: 'name_desc',
      orderBySql: 'name DESC NULLS LAST, id DESC'
    },
    newest: {
      key: 'newest',
      orderBySql: 'created_at DESC NULLS LAST, id DESC'
    },
    oldest: {
      key: 'oldest',
      orderBySql: 'created_at ASC NULLS LAST, id ASC'
    }
  };
  const requestedSort = String(query.sort || 'name_asc').trim().toLowerCase();
  const sort = sortOptions[requestedSort] || sortOptions.name_asc;

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    where.push(`(
      coalesce(name, '') ILIKE $${idx}
      OR coalesce(category, '') ILIKE $${idx}
      OR array_to_string(${getPostgresTextArraySql('aliases')}, ' ') ILIKE $${idx}
      OR array_to_string(${getPostgresTextArraySql('teams')}, ' ') ILIKE $${idx}
      OR coalesce(notes, '') ILIKE $${idx}
    )`);
    filters.search = search;
  }

  if (category) {
    values.push(category.toLowerCase());
    where.push(`lower(trim(coalesce(category, ''))) = $${values.length}`);
    filters.category = category;
  }

  if (team) {
    values.push(team.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM unnest(${getPostgresTextArraySql('teams')}) AS team_item(value)
      WHERE lower(trim(team_item.value)) = $${values.length}
    )`);
    filters.team = team;
  }

  return {
    values,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    filters,
    sort: sort.key,
    orderBySql: sort.orderBySql
  };
}

async function handleWrestlingPeopleDbRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const options = buildWrestlingPeopleDbQueryOptions(req.query);
    const countResult = await dbPool.query(
      `SELECT count(*)::int AS total FROM wrestling_people ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `SELECT id, slug, name, category, aliases, teams, notes
       FROM wrestling_people
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );

    res.json({
      ok: true,
      source: 'db',
      type: 'wrestling_people',
      route: '/api/wrestling/people',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1 && totalPages > 0
      },
      filters: options.filters,
      sort: options.sort,
      data: result.rows.map(buildWrestlingPersonDbApiItem)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      source: 'db',
      type: 'wrestling_people',
      route: '/api/wrestling/people',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function buildWrestlingPeopleDbStatsResponse() {
  const generated = new Date();
  const totalsQuery = dbPool.query(`
    SELECT
      count(*)::int AS total_people,
      count(*) FILTER (WHERE coalesce(array_length(aliases, 1), 0) > 0)::int AS with_aliases,
      count(*) FILTER (WHERE coalesce(array_length(teams, 1), 0) > 0)::int AS with_teams
    FROM wrestling_people
  `);
  const categoriesQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(category), ''), 'Unknown') AS category, count(*)::int AS count
    FROM wrestling_people
    GROUP BY 1
    ORDER BY count DESC, category ASC
  `);
  const uniqueTeamsQuery = dbPool.query(`
    SELECT count(DISTINCT lower(trim(team_item.value)))::int AS unique_teams
    FROM wrestling_people
    CROSS JOIN LATERAL unnest(${getPostgresTextArraySql('teams')}) AS team_item(value)
    WHERE trim(team_item.value) <> ''
  `);
  const [totalsResult, categoriesResult, uniqueTeamsResult] = await Promise.all([
    totalsQuery,
    categoriesQuery,
    uniqueTeamsQuery
  ]);
  const totals = totalsResult.rows && totalsResult.rows[0] ? totalsResult.rows[0] : {};
  const uniqueTeams = uniqueTeamsResult.rows && uniqueTeamsResult.rows[0] ? uniqueTeamsResult.rows[0] : {};

  return {
    ok: true,
    source: 'db',
    type: 'wrestling_people',
    route: '/api/wrestling/people/stats',
    totalPeople: toIntegerCount(totals.total_people),
    categories: categoriesResult.rows.map((row) => ({
      category: row.category,
      count: toIntegerCount(row.count)
    })),
    withAliases: toIntegerCount(totals.with_aliases),
    withTeams: toIntegerCount(totals.with_teams),
    uniqueTeams: toIntegerCount(uniqueTeams.unique_teams),
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated)
  };
}

function buildWrestlingVenueDbApiItem(row) {
  const geo = {
    ...createEmptyWrestlingVenueGeo(),
    ...(row.geo && typeof row.geo === 'object' ? row.geo : {})
  };
  if (!Array.isArray(geo.nearby_airports)) geo.nearby_airports = [];

  return {
    venue_id: row.venue_id || '',
    venue_name: row.venue_name || '',
    city: row.city || '',
    state: row.state || '',
    country: row.country || '',
    region: row.region || '',
    venue_type: row.venue_type || '',
    status: row.status || '',
    latitude: toNullableNumber(row.latitude),
    longitude: toNullableNumber(row.longitude),
    notes: row.notes || '',
    geo
  };
}

function buildWrestlingVenuesDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const city = String(query.city || '').trim();
  const state = String(query.state || '').trim();
  const country = String(query.country || '').trim();
  const region = String(query.region || '').trim();
  const venueType = String(query.venue_type || '').trim();
  const status = String(query.status || '').trim();
  const requestedSort = String(query.sort || 'name_asc').trim().toLowerCase();
  const requestedDir = String(query.dir || 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
  const sortTokens = {
    name_asc: { field: 'venue_name', dir: 'asc', key: 'name_asc' },
    name_desc: { field: 'venue_name', dir: 'desc', key: 'name_desc' },
    city_asc: { field: 'city', dir: 'asc', key: 'city_asc' },
    state_asc: { field: 'state', dir: 'asc', key: 'state_asc' }
  };
  const sortFields = {
    name: 'venue_name',
    venue_name: 'venue_name',
    city: 'city',
    state: 'state'
  };
  const tokenSort = sortTokens[requestedSort];
  const fieldSort = sortFields[requestedSort]
    ? { field: sortFields[requestedSort], dir: requestedDir, key: `${requestedSort}_${requestedDir}` }
    : null;
  const sort = tokenSort || fieldSort || sortTokens.name_asc;

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    where.push(`(
      coalesce(venue_name, '') ILIKE $${idx}
      OR coalesce(city, '') ILIKE $${idx}
      OR coalesce(state, '') ILIKE $${idx}
      OR coalesce(country, '') ILIKE $${idx}
      OR coalesce(region, '') ILIKE $${idx}
      OR coalesce(venue_type, '') ILIKE $${idx}
      OR coalesce(status, '') ILIKE $${idx}
      OR coalesce(notes, '') ILIKE $${idx}
    )`);
    filters.search = search;
  }

  if (city) {
    values.push(city.toLowerCase());
    where.push(`lower(trim(coalesce(city, ''))) = $${values.length}`);
    filters.city = city;
  }

  if (state) {
    values.push(state.toLowerCase());
    where.push(`lower(trim(coalesce(state, ''))) = $${values.length}`);
    filters.state = state;
  }

  if (country) {
    values.push(country.toLowerCase());
    where.push(`lower(trim(coalesce(country, ''))) = $${values.length}`);
    filters.country = country;
  }

  if (region) {
    values.push(region.toLowerCase());
    where.push(`lower(trim(coalesce(region, ''))) = $${values.length}`);
    filters.region = region;
  }

  if (venueType) {
    values.push(venueType.toLowerCase());
    where.push(`lower(trim(coalesce(venue_type, ''))) = $${values.length}`);
    filters.venue_type = venueType;
  }

  if (status) {
    values.push(status.toLowerCase());
    where.push(`lower(trim(coalesce(status, ''))) = $${values.length}`);
    filters.status = status;
  }

  return {
    values,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    filters,
    sort: {
      field: sort.field,
      dir: sort.dir,
      key: sort.key
    },
    orderBySql: `${sort.field} ${sort.dir.toUpperCase()} NULLS LAST, venue_name ASC, city ASC, state ASC`
  };
}

async function handleWrestlingVenuesDbRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const options = buildWrestlingVenuesDbQueryOptions(req.query);
    const countResult = await dbPool.query(
      `SELECT count(*)::int AS total FROM wrestling_venues ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `SELECT venue_id, venue_name, city, state, country, region, venue_type, status, latitude, longitude, notes, geo
       FROM wrestling_venues
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const items = result.rows.map(buildWrestlingVenueDbApiItem);

    res.json({
      ok: true,
      route: '/api/wrestling/venues/db',
      source: 'db',
      section: 'wrestling',
      type: 'venues',
      count: items.length,
      page,
      limit,
      total,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      filters: options.filters,
      sort: options.sort,
      items
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/wrestling/venues/db',
      source: 'db',
      section: 'wrestling',
      type: 'venues',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function buildWrestlingVenuesDbStatsResponse() {
  const generated = new Date();
  const totalsQuery = dbPool.query(`
    SELECT
      count(*)::int AS total_venues,
      count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int AS with_gps,
      count(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL)::int AS without_gps
    FROM wrestling_venues
  `);
  const byStatusQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(status), ''), 'Unknown') AS status, count(*)::int AS count
    FROM wrestling_venues
    GROUP BY 1
    ORDER BY count DESC, status ASC
  `);
  const byStateQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(state), ''), 'Unknown') AS state, count(*)::int AS count
    FROM wrestling_venues
    GROUP BY 1
    ORDER BY count DESC, state ASC
  `);
  const byCityQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(city), ''), 'Unknown') AS city, count(*)::int AS count
    FROM wrestling_venues
    GROUP BY 1
    ORDER BY count DESC, city ASC
  `);
  const byRegionQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(region), ''), 'Unknown') AS region, count(*)::int AS count
    FROM wrestling_venues
    GROUP BY 1
    ORDER BY count DESC, region ASC
  `);
  const byVenueTypeQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(venue_type), ''), 'Unknown') AS venue_type, count(*)::int AS count
    FROM wrestling_venues
    GROUP BY 1
    ORDER BY count DESC, venue_type ASC
  `);
  const [totalsResult, byStatusResult, byStateResult, byCityResult, byRegionResult, byVenueTypeResult] = await Promise.all([
    totalsQuery,
    byStatusQuery,
    byStateQuery,
    byCityQuery,
    byRegionQuery,
    byVenueTypeQuery
  ]);
  const totals = totalsResult.rows && totalsResult.rows[0] ? totalsResult.rows[0] : {};

  return {
    ok: true,
    route: '/api/wrestling/venues/stats',
    source: 'db',
    section: 'wrestling',
    type: 'venues',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    total_venues: toIntegerCount(totals.total_venues),
    by_status: byStatusResult.rows.map((row) => ({ status: row.status, count: toIntegerCount(row.count) })),
    by_state: byStateResult.rows.map((row) => ({ state: row.state, count: toIntegerCount(row.count) })),
    by_city: byCityResult.rows.map((row) => ({ city: row.city, count: toIntegerCount(row.count) })),
    by_region: byRegionResult.rows.map((row) => ({ region: row.region, count: toIntegerCount(row.count) })),
    by_venue_type: byVenueTypeResult.rows.map((row) => ({ venue_type: row.venue_type, count: toIntegerCount(row.count) })),
    with_gps: toIntegerCount(totals.with_gps),
    without_gps: toIntegerCount(totals.without_gps)
  };
}

function buildMusicPersonDbApiItem(row) {
  return {
    person_id: toIntegerCount(row.person_id),
    name: row.name || '',
    category: row.category || '',
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    bands: Array.isArray(row.bands) ? row.bands : [],
    associations: Array.isArray(row.associations) ? row.associations : [],
    stats: row.stats && typeof row.stats === 'object' ? row.stats : {}
  };
}

function buildMusicPeopleDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const category = String(query.category || '').trim();
  const band = String(query.band || '').trim();
  const instrument = String(query.instrument || '').trim();
  const association = String(query.association || '').trim();
  const sortFields = {
    person_id: 'person_id',
    name: 'name',
    category: 'category',
    created_at: 'created_at',
    updated_at: 'updated_at'
  };
  const requestedSort = String(query.sort || 'name').trim().toLowerCase();
  const sortField = sortFields[requestedSort] ? requestedSort : 'name';
  const dir = String(query.dir || 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
  const bandsArraySql = "CASE WHEN jsonb_typeof(bands) = 'array' THEN bands ELSE '[]'::jsonb END";
  const aliasesArraySql = "CASE WHEN jsonb_typeof(aliases) = 'array' THEN aliases ELSE '[]'::jsonb END";
  const associationsArraySql = "CASE WHEN jsonb_typeof(associations) = 'array' THEN associations ELSE '[]'::jsonb END";

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    where.push(`(
      name ILIKE $${idx}
      OR coalesce(category, '') ILIKE $${idx}
      OR aliases::text ILIKE $${idx}
      OR bands::text ILIKE $${idx}
      OR associations::text ILIKE $${idx}
      OR raw_sheet::text ILIKE $${idx}
    )`);
    filters.search = search;
  }

  if (category) {
    values.push(category.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM regexp_split_to_table(coalesce(category, ''), '\\s*,\\s*') AS category_item(value)
      WHERE lower(trim(value)) = $${values.length}
    )`);
    filters.category = category;
  }

  if (band) {
    values.push(band.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${bandsArraySql}) AS band_item
      WHERE lower(trim(coalesce(band_item->>'band', ''))) = $${values.length}
    )`);
    filters.band = band;
  }

  if (instrument) {
    values.push(`%${instrument.toLowerCase()}%`);
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${bandsArraySql}) AS band_item
      WHERE lower(coalesce(band_item->>'instrument', '')) LIKE $${values.length}
    )`);
    filters.instrument = instrument;
  }

  if (association) {
    values.push(association.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(${associationsArraySql}) AS association_item
      WHERE lower(trim(association_item)) = $${values.length}
    )`);
    filters.association = association;
  }

  return {
    values,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    filters,
    sort: {
      field: sortField,
      dir
    },
    orderBySql: `${sortFields[sortField]} ${dir.toUpperCase()} NULLS LAST, name ASC`,
    bandsArraySql,
    aliasesArraySql,
    associationsArraySql
  };
}

async function handleMusicPeopleDbRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const options = buildMusicPeopleDbQueryOptions(req.query);
    const countResult = await dbPool.query(
      `SELECT count(*)::int AS total FROM music_people ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `SELECT person_id, name, category, aliases, bands, associations, stats
       FROM music_people
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const data = result.rows.map(buildMusicPersonDbApiItem);

    res.json({
      ok: true,
      route: '/api/music/people/db',
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: data.length,
      total,
      page,
      limit,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      filters: options.filters,
      sort: options.sort,
      stats: {
        peopleTotal: total
      },
      data
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/music/people/db',
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function buildMusicPeopleDbStatsResponse() {
  const generated = new Date();
  const bandsArraySql = "CASE WHEN jsonb_typeof(bands) = 'array' THEN bands ELSE '[]'::jsonb END";
  const totalsQuery = dbPool.query(`
    WITH category_items AS (
      SELECT person_id, lower(trim(value)) AS category
      FROM music_people
      CROSS JOIN LATERAL regexp_split_to_table(coalesce(category, ''), '\\s*,\\s*') AS category_item(value)
      WHERE trim(value) <> ''
    )
    SELECT
      (SELECT count(*)::int FROM music_people) AS total_people,
      (SELECT count(DISTINCT person_id)::int FROM category_items WHERE category IN ('performer', 'performers')) AS total_performers,
      (SELECT count(DISTINCT person_id)::int FROM category_items WHERE category IN ('friend', 'friends')) AS total_friends,
      (SELECT count(DISTINCT category)::int FROM category_items) AS total_categories
  `);
  const uniqueBandsQuery = dbPool.query(`
    SELECT count(DISTINCT lower(trim(band_item->>'band')))::int AS unique_bands
    FROM music_people
    CROSS JOIN LATERAL jsonb_array_elements(${bandsArraySql}) AS band_item
    WHERE trim(coalesce(band_item->>'band', '')) <> ''
  `);
  const topBandsQuery = dbPool.query(`
    SELECT band_item->>'band' AS band, count(DISTINCT person_id)::int AS people_count
    FROM music_people
    CROSS JOIN LATERAL jsonb_array_elements(${bandsArraySql}) AS band_item
    WHERE trim(coalesce(band_item->>'band', '')) <> ''
    GROUP BY 1
    ORDER BY people_count DESC, band ASC
    LIMIT 25
  `);
  const topInstrumentsQuery = dbPool.query(`
    SELECT instrument, count(DISTINCT person_id)::int AS people_count
    FROM music_people
    CROSS JOIN LATERAL jsonb_array_elements(${bandsArraySql}) AS band_item
    CROSS JOIN LATERAL regexp_split_to_table(coalesce(band_item->>'instrument', ''), '\\s*,\\s*') AS instrument_item(instrument)
    WHERE trim(instrument) <> ''
    GROUP BY 1
    ORDER BY people_count DESC, instrument ASC
    LIMIT 25
  `);
  const peopleByCategoryQuery = dbPool.query(`
    SELECT category_name AS category, count(DISTINCT person_id)::int AS people_count
    FROM music_people
    CROSS JOIN LATERAL regexp_split_to_table(coalesce(category, ''), '\\s*,\\s*') AS category_item(category_name)
    WHERE trim(category_name) <> ''
    GROUP BY 1
    ORDER BY people_count DESC, category ASC
  `);
  const [totalsResult, uniqueBandsResult, topBandsResult, topInstrumentsResult, peopleByCategoryResult] = await Promise.all([
    totalsQuery,
    uniqueBandsQuery,
    topBandsQuery,
    topInstrumentsQuery,
    peopleByCategoryQuery
  ]);
  const totals = totalsResult.rows && totalsResult.rows[0] ? totalsResult.rows[0] : {};
  const uniqueBands = uniqueBandsResult.rows && uniqueBandsResult.rows[0] ? uniqueBandsResult.rows[0] : {};

  return {
    ok: true,
    route: '/api/music/people/stats',
    source: {
      type: 'postgres',
      table: 'music_people'
    },
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    totals: {
      peopleTotal: toIntegerCount(totals.total_people),
      performersTotal: toIntegerCount(totals.total_performers),
      friendsTotal: toIntegerCount(totals.total_friends),
      categoriesTotal: toIntegerCount(totals.total_categories),
      uniqueBands: toIntegerCount(uniqueBands.unique_bands)
    },
    topBands: topBandsResult.rows.map((row) => ({ band: row.band, peopleCount: toIntegerCount(row.people_count) })),
    topInstruments: topInstrumentsResult.rows.map((row) => ({ instrument: row.instrument, peopleCount: toIntegerCount(row.people_count) })),
    peopleByCategory: peopleByCategoryResult.rows.map((row) => ({ category: row.category, peopleCount: toIntegerCount(row.people_count) }))
  };
}

function buildMusicVenueDbApiItem(row) {
  const location = row.location && typeof row.location === 'object' ? row.location : {};
  const media = row.media && typeof row.media === 'object' ? row.media : {};
  const stats = row.stats && typeof row.stats === 'object' ? { ...row.stats } : {};
  stats.showCount = toIntegerCount(stats.showCount);

  return {
    venue_id: row.venue_id,
    venue: row.venue || '',
    city: row.city || '',
    state: row.state || '',
    location: {
      gps_lat: String(location.gps_lat || row.gps_lat || ''),
      gps_lng: String(location.gps_lng || row.gps_lng || '')
    },
    media: {
      logo: String(media.logo || row.logo || '')
    },
    description: row.description || '',
    notes: row.notes || '',
    status: row.status || '',
    stats
  };
}

function buildMusicVenuesDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const city = String(query.city || '').trim();
  const state = String(query.state || '').trim();
  const status = String(query.status || '').trim();
  const sortFields = {
    venue_id: 'venue_id',
    venue: 'venue',
    city: 'city',
    state: 'state',
    status: 'status',
    created_at: 'created_at',
    updated_at: 'updated_at'
  };
  const requestedSort = String(query.sort || 'venue').trim().toLowerCase();
  const sortField = sortFields[requestedSort] ? requestedSort : 'venue';
  const dir = String(query.dir || 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    where.push(`(
      venue ILIKE $${idx}
      OR coalesce(city, '') ILIKE $${idx}
      OR coalesce(state, '') ILIKE $${idx}
      OR coalesce(status, '') ILIKE $${idx}
      OR coalesce(description, '') ILIKE $${idx}
      OR coalesce(notes, '') ILIKE $${idx}
      OR coalesce(logo, '') ILIKE $${idx}
      OR location::text ILIKE $${idx}
      OR media::text ILIKE $${idx}
      OR stats::text ILIKE $${idx}
      OR raw_sheet::text ILIKE $${idx}
    )`);
    filters.search = search;
  }

  if (city) {
    values.push(city.toLowerCase());
    where.push(`lower(trim(coalesce(city, ''))) = $${values.length}`);
    filters.city = city;
  }

  if (state) {
    values.push(state.toLowerCase());
    where.push(`lower(trim(coalesce(state, ''))) = $${values.length}`);
    filters.state = state;
  }

  if (status) {
    values.push(status.toLowerCase());
    where.push(`lower(trim(coalesce(status, ''))) = $${values.length}`);
    filters.status = status;
  }

  return {
    values,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    filters,
    sort: {
      field: sortField,
      dir
    },
    orderBySql: `${sortFields[sortField]} ${dir.toUpperCase()} NULLS LAST, venue ASC, city ASC, state ASC`
  };
}

async function handleMusicVenuesDbRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const options = buildMusicVenuesDbQueryOptions(req.query);
    const countResult = await dbPool.query(
      `SELECT count(*)::int AS total FROM music_venues ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `SELECT venue_id, venue, city, state, gps_lat, gps_lng, logo, description, notes, status, location, media, stats
       FROM music_venues
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const data = result.rows.map(buildMusicVenueDbApiItem);

    res.json({
      ok: true,
      route: '/api/music/venues/db',
      source: {
        type: 'postgres',
        table: 'music_venues'
      },
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: data.length,
      total,
      page,
      limit,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      filters: options.filters,
      sort: options.sort,
      stats: {
        venuesTotal: total
      },
      data
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/music/venues/db',
      source: {
        type: 'postgres',
        table: 'music_venues'
      },
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function buildMusicVenuesDbStatsResponse() {
  const generated = new Date();
  const totalsQuery = dbPool.query(`
    SELECT
      count(*)::int AS total_venues,
      count(*) FILTER (
        WHERE trim(coalesce(gps_lat, '')) <> ''
          AND trim(coalesce(gps_lng, '')) <> ''
      )::int AS venues_with_gps,
      count(*) FILTER (
        WHERE trim(coalesce(gps_lat, '')) = ''
          OR trim(coalesce(gps_lng, '')) = ''
      )::int AS venues_missing_gps,
      count(*) FILTER (WHERE trim(coalesce(logo, '')) <> '')::int AS venues_with_logo,
      count(*) FILTER (WHERE trim(coalesce(logo, '')) = '')::int AS venues_missing_logo
    FROM music_venues
  `);
  const byStateQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(state), ''), 'Unknown') AS state, count(*)::int AS venue_count
    FROM music_venues
    GROUP BY 1
    ORDER BY venue_count DESC, state ASC
  `);
  const byCityQuery = dbPool.query(`
    SELECT
      coalesce(nullif(trim(city), ''), 'Unknown') AS city,
      coalesce(nullif(trim(state), ''), 'Unknown') AS state,
      count(*)::int AS venue_count
    FROM music_venues
    GROUP BY 1, 2
    ORDER BY venue_count DESC, city ASC, state ASC
  `);
  const byStatusQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(status), ''), 'Unknown') AS status, count(*)::int AS venue_count
    FROM music_venues
    GROUP BY 1
    ORDER BY venue_count DESC, status ASC
  `);
  const [totalsResult, byStateResult, byCityResult, byStatusResult] = await Promise.all([
    totalsQuery,
    byStateQuery,
    byCityQuery,
    byStatusQuery
  ]);
  const totals = totalsResult.rows && totalsResult.rows[0] ? totalsResult.rows[0] : {};

  return {
    ok: true,
    route: '/api/music/venues/stats',
    source: {
      type: 'postgres',
      table: 'music_venues'
    },
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    totals: {
      venuesTotal: toIntegerCount(totals.total_venues),
      venuesWithGps: toIntegerCount(totals.venues_with_gps),
      venuesMissingGps: toIntegerCount(totals.venues_missing_gps),
      venuesWithLogo: toIntegerCount(totals.venues_with_logo),
      venuesMissingLogo: toIntegerCount(totals.venues_missing_logo)
    },
    venuesByState: byStateResult.rows.map((row) => ({ state: row.state, venueCount: toIntegerCount(row.venue_count) })),
    venuesByCity: byCityResult.rows.map((row) => ({ city: row.city, state: row.state, venueCount: toIntegerCount(row.venue_count) })),
    venuesByStatus: byStatusResult.rows.map((row) => ({ status: row.status, venueCount: toIntegerCount(row.venue_count) }))
  };
}

function getImportLogRowsWritten(result) {
  if (!result || typeof result !== 'object') return 0;
  if (result.upserted != null) return toIntegerCount(result.upserted);
  if (result.importedRows != null) return toIntegerCount(result.importedRows);
  if (result.rowsInserted != null) return toIntegerCount(result.rowsInserted);
  return 0;
}

async function writeSystemImportLog(entry) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) return;

    await dbPool.query(`
      INSERT INTO system_import_logs (
        area,
        route,
        status,
        rows_read,
        rows_inserted,
        rows_updated,
        error_message,
        started_at,
        finished_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      entry.area,
      entry.route,
      entry.status,
      toIntegerCount(entry.rows_read),
      toIntegerCount(entry.rows_inserted),
      toIntegerCount(entry.rows_updated),
      entry.error_message || null,
      entry.started_at,
      entry.finished_at
    ]);
  } catch (err) {
    console.warn('Import log write failed:', err && err.message ? err.message : String(err));
  }
}

async function runLoggedImport(req, res, config) {
  const startedAt = new Date();
  const area = config.area || 'music';

  try {
    const forceRefresh = req.query.refresh === '1';
    const result = await config.importer(forceRefresh);
    await writeSystemImportLog({
      area,
      route: config.route,
      status: 'success',
      rows_read: result && result.rowsRead,
      rows_inserted: getImportLogRowsWritten(result),
      rows_updated: 0,
      started_at: startedAt,
      finished_at: new Date()
    });
    res.json(result);
  } catch (err) {
    await writeSystemImportLog({
      area,
      route: config.route,
      status: 'error',
      rows_read: 0,
      rows_inserted: 0,
      rows_updated: 0,
      error_message: err && err.message ? err.message : String(err),
      started_at: startedAt,
      finished_at: new Date()
    });
    res.status(500).json({
      ok: false,
      route: config.route,
      source: config.source,
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function runLoggedMusicImport(req, res, config) {
  return runLoggedImport(req, res, { ...config, area: 'music' });
}

const MUSIC_STATUS_TABLES = ['music_bands', 'music_shows', 'music_people', 'music_venues'];
const MUSIC_STATUS_IMPORT_ROUTES = {
  '/admin/import/music/bands': 'bandsLastImport',
  '/admin/import/music/shows': 'showsLastImport',
  '/admin/import/music/people': 'peopleLastImport',
  '/admin/import/music/venues': 'venuesLastImport'
};

function formatStatusTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

async function getExistingPublicTables(tableNames) {
  const result = await dbPool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name = ANY($1::text[])
  `, [tableNames]);

  return new Set(result.rows.map((row) => row.table_name));
}

async function getMusicStatusTableCount(tableName, exists, warnings) {
  if (!exists) return 0;

  try {
    const result = await dbPool.query(`SELECT count(*)::int AS count FROM ${tableName}`);
    return toIntegerCount(result.rows && result.rows[0] && result.rows[0].count);
  } catch (err) {
    warnings.push(`Unable to count ${tableName}: ${err && err.message ? err.message : String(err)}`);
    return 0;
  }
}

async function getMusicStatusQualityCount(tableName, exists, sql, warnings) {
  if (!exists) return 0;

  try {
    const result = await dbPool.query(sql);
    return toIntegerCount(result.rows && result.rows[0] && result.rows[0].count);
  } catch (err) {
    warnings.push(`Unable to check ${tableName}: ${err && err.message ? err.message : String(err)}`);
    return 0;
  }
}

async function getMusicStatusLastImports(logTableExists, warnings) {
  const imports = {
    bandsLastImport: '',
    showsLastImport: '',
    peopleLastImport: '',
    venuesLastImport: ''
  };

  if (!logTableExists) {
    warnings.push('Missing table: system_import_logs');
    return imports;
  }

  try {
    const routes = Object.keys(MUSIC_STATUS_IMPORT_ROUTES);
    const result = await dbPool.query(`
      SELECT DISTINCT ON (route)
        route,
        coalesce(finished_at, created_at) AS import_time
      FROM system_import_logs
      WHERE area = $1
        AND route = ANY($2::text[])
      ORDER BY route, coalesce(finished_at, created_at) DESC
    `, ['music', routes]);

    result.rows.forEach((row) => {
      const key = MUSIC_STATUS_IMPORT_ROUTES[row.route];
      if (key) imports[key] = formatStatusTimestamp(row.import_time);
    });
  } catch (err) {
    warnings.push(`Unable to read import logs: ${err && err.message ? err.message : String(err)}`);
  }

  return imports;
}

async function buildMusicStatusResponse() {
  const generated = new Date();
  const warnings = [];
  const response = {
    ok: true,
    route: '/api/status/music',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    database: {
      connected: false
    },
    tables: {
      music_bands: false,
      music_shows: false,
      music_people: false,
      music_venues: false
    },
    counts: {
      bands: 0,
      shows: 0,
      people: 0,
      venues: 0
    },
    imports: {
      bandsLastImport: '',
      showsLastImport: '',
      peopleLastImport: '',
      venuesLastImport: ''
    },
    warnings,
    dataQuality: {
      venuesMissingGps: 0,
      venuesMissingLogo: 0,
      showsMissingPoster: 0,
      peopleMissingBands: 0,
      bandsMissingStatus: 0
    }
  };

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Missing DATABASE_URL environment variable.');
    return response;
  }

  try {
    await dbPool.query('SELECT 1');
    response.database.connected = true;
  } catch (err) {
    warnings.push(`Database disconnected: ${err && err.message ? err.message : String(err)}`);
    return response;
  }

  const allStatusTables = MUSIC_STATUS_TABLES.concat(['system_import_logs']);
  let existingTables;
  try {
    existingTables = await getExistingPublicTables(allStatusTables);
  } catch (err) {
    warnings.push(`Unable to inspect database tables: ${err && err.message ? err.message : String(err)}`);
    return response;
  }

  MUSIC_STATUS_TABLES.forEach((tableName) => {
    response.tables[tableName] = existingTables.has(tableName);
    if (!response.tables[tableName]) warnings.push(`Missing table: ${tableName}`);
  });

  const [
    bandsCount,
    showsCount,
    peopleCount,
    venuesCount,
    venuesMissingGps,
    venuesMissingLogo,
    showsMissingPoster,
    peopleMissingBands,
    bandsMissingStatus,
    imports
  ] = await Promise.all([
    getMusicStatusTableCount('music_bands', response.tables.music_bands, warnings),
    getMusicStatusTableCount('music_shows', response.tables.music_shows, warnings),
    getMusicStatusTableCount('music_people', response.tables.music_people, warnings),
    getMusicStatusTableCount('music_venues', response.tables.music_venues, warnings),
    getMusicStatusQualityCount(
      'music_venues',
      response.tables.music_venues,
      `SELECT count(*)::int AS count FROM music_venues WHERE trim(coalesce(gps_lat, '')) = '' OR trim(coalesce(gps_lng, '')) = ''`,
      warnings
    ),
    getMusicStatusQualityCount(
      'music_venues',
      response.tables.music_venues,
      `SELECT count(*)::int AS count FROM music_venues WHERE trim(coalesce(logo, '')) = ''`,
      warnings
    ),
    getMusicStatusQualityCount(
      'music_shows',
      response.tables.music_shows,
      `SELECT count(*)::int AS count FROM music_shows WHERE trim(coalesce(poster, '')) = ''`,
      warnings
    ),
    getMusicStatusQualityCount(
      'music_people',
      response.tables.music_people,
      `SELECT count(*)::int AS count
       FROM music_people
       WHERE CASE
         WHEN jsonb_typeof(bands) = 'array' THEN jsonb_array_length(bands)
         ELSE 0
       END = 0`,
      warnings
    ),
    getMusicStatusQualityCount(
      'music_bands',
      response.tables.music_bands,
      `SELECT count(*)::int AS count FROM music_bands WHERE trim(coalesce(status, '')) = ''`,
      warnings
    ),
    getMusicStatusLastImports(existingTables.has('system_import_logs'), warnings)
  ]);

  response.counts = {
    bands: bandsCount,
    shows: showsCount,
    people: peopleCount,
    venues: venuesCount
  };
  response.imports = imports;
  response.dataQuality = {
    venuesMissingGps,
    venuesMissingLogo,
    showsMissingPoster,
    peopleMissingBands,
    bandsMissingStatus
  };

  if (venuesMissingGps > 0) warnings.push(`${venuesMissingGps} venues missing GPS.`);
  if (venuesMissingLogo > 0) warnings.push(`${venuesMissingLogo} venues missing logo.`);
  if (showsMissingPoster > 0) warnings.push(`${showsMissingPoster} shows missing poster.`);
  if (peopleMissingBands > 0) warnings.push(`${peopleMissingBands} people missing bands.`);
  if (bandsMissingStatus > 0) warnings.push(`${bandsMissingStatus} bands missing status.`);

  return response;
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

app.get('/health/db', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const result = await dbPool.query('SELECT NOW()');
    const row = result.rows && result.rows[0] ? result.rows[0] : {};
    res.json({
      ok: true,
      database: 'connected',
      time: row.now
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      database: 'disconnected',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/health/tables', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const result = await dbPool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    res.json({
      ok: true,
      tables: result.rows.map((row) => row.table_name)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      tables: [],
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/admin/import/music/bands', async (req, res) => {
  return runLoggedMusicImport(req, res, {
    route: '/admin/import/music/bands',
    source: 'Music-Bands',
    importer: importMusicBandsToDatabase
  });
});

app.get('/admin/import/music/shows', async (req, res) => {
  return runLoggedMusicImport(req, res, {
    route: '/admin/import/music/shows',
    source: 'Music-Shows',
    importer: importMusicShowsToDatabase
  });
});

app.get('/admin/import/music/people', async (req, res) => {
  return runLoggedMusicImport(req, res, {
    route: '/admin/import/music/people',
    source: 'Music-People',
    importer: importMusicPeopleToDatabase
  });
});

app.get('/admin/import/music/venues', async (req, res) => {
  return runLoggedMusicImport(req, res, {
    route: '/admin/import/music/venues',
    source: 'Music-Venue',
    importer: importMusicVenuesToDatabase
  });
});

app.get('/admin/import/wrestling/shows', async (req, res) => {
  return runLoggedImport(req, res, {
    area: 'wrestling',
    route: '/admin/import/wrestling/shows',
    source: 'Wrestling-Matches',
    importer: importWrestlingShowsToDatabase
  });
});

app.get('/admin/import/wrestling/people', async (req, res) => {
  return runLoggedImport(req, res, {
    area: 'wrestling',
    route: '/admin/import/wrestling/people',
    source: 'Wrestling-People',
    importer: importWrestlingPeopleToDatabase
  });
});

app.get('/admin/import/wrestling/venues', async (req, res) => {
  return runLoggedImport(req, res, {
    area: 'wrestling',
    route: '/admin/import/wrestling/venues',
    source: 'Wrestling-Venue',
    importer: importWrestlingVenuesToDatabase
  });
});

app.get('/api/wrestling/people/import', async (req, res) => {
  return runLoggedImport(req, res, {
    area: 'wrestling',
    route: '/api/wrestling/people/import',
    source: 'Wrestling-People',
    importer: importWrestlingPeopleToDatabase
  });
});

app.get('/api/status/music', async (req, res) => {
  try {
    res.json(await buildMusicStatusResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/status/music',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/music/bands/db', async (req, res) => {
  return handleMusicBandsDbRequest(req, res, '/api/music/bands/db');
});

app.get('/api/v3/music/bands/db', async (req, res) => {
  return handleMusicBandsDbRequest(req, res, '/api/v3/music/bands/db');
});

app.get('/api/music/bands/stats', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    res.json(await buildMusicBandsDbStatsResponse(req.query.refresh === '1'));
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/music/bands/stats',
      source: 'PostgreSQL:music_bands',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/music/shows/db', async (req, res) => {
  return handleMusicShowsDbRequest(req, res);
});

app.get('/api/music/shows/stats', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    res.json(await buildMusicShowsDbStatsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/music/shows/stats',
      source: 'PostgreSQL:music_shows',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/wrestling/shows/db', async (req, res) => {
  return handleWrestlingShowsDbRequest(req, res);
});

app.get('/api/wrestling/shows/stats', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    res.json(await buildWrestlingShowsDbStatsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/wrestling/shows/stats',
      source: 'PostgreSQL:wrestling_shows',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/wrestling/people', async (req, res) => {
  return handleWrestlingPeopleDbRequest(req, res);
});

app.get('/api/wrestling/people/db', async (req, res) => {
  return handleWrestlingPeopleDbRequest(req, res);
});

app.get('/api/wrestling/people/stats', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    res.json(await buildWrestlingPeopleDbStatsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      source: 'db',
      type: 'wrestling_people',
      route: '/api/wrestling/people/stats',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/wrestling/venues/db', async (req, res) => {
  return handleWrestlingVenuesDbRequest(req, res);
});

app.get('/api/wrestling/venues/stats', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    res.json(await buildWrestlingVenuesDbStatsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/wrestling/venues/stats',
      source: 'db',
      section: 'wrestling',
      type: 'venues',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/music/people/db', async (req, res) => {
  return handleMusicPeopleDbRequest(req, res);
});

app.get('/api/music/people/stats', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    res.json(await buildMusicPeopleDbStatsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/music/people/stats',
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/music/venues/db', async (req, res) => {
  return handleMusicVenuesDbRequest(req, res);
});

app.get('/api/music/venues/stats', async (req, res) => {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    res.json(await buildMusicVenuesDbStatsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/music/venues/stats',
      source: {
        type: 'postgres',
        table: 'music_venues'
      },
      error: err && err.message ? err.message : String(err)
    });
  }
});

for (const [routePath, cfg] of Object.entries(ROUTES)) {
  app.get(routePath, async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === '1';
      const payload = await fetchCsvForRoute(routePath, cfg, forceRefresh);
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=60');
      if (routePath === '/api/music/bands') {
        return res.json(await buildMusicBandsResponse(payload, forceRefresh));
      }
      if (routePath === '/api/music/shows') {
        return res.json(buildMusicShowsResponse(payload));
      }
      if (routePath === '/api/music/people') {
        return res.json(await buildMusicPeopleResponse(payload, forceRefresh));
      }
      return res.json(payload);
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

async function startServer() {
  await applyDatabaseSchema();
  app.listen(PORT, () => {
    console.log(`VMPix V3 Data API listening on ${PORT}`);
  });
}

startServer();
