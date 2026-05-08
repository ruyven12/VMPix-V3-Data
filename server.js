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
  try {
    const forceRefresh = req.query.refresh === '1';
    const result = await importMusicBandsToDatabase(forceRefresh);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/admin/import/music/bands',
      source: 'Music-Bands',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/admin/import/music/shows', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const result = await importMusicShowsToDatabase(forceRefresh);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/admin/import/music/shows',
      source: 'Music-Shows',
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
