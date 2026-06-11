'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

function getIntegerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  const number = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

const SMUG_API_BASE_URL = 'https://api.smugmug.com/api/v2';
const SMUG_API_KEY = String(process.env.SMUG_API_KEY || '').trim();
const SMUG_NICKNAME_ENV = String(process.env.SMUG_NICKNAME || '').trim();
const SMUG_NICKNAME = SMUG_NICKNAME_ENV || 'vmpix';
const SMUG_USER_AGENT = String(process.env.SMUG_USER_AGENT || 'VMPix-V3-Data/1.0').trim();
const SMUG_REQUEST_RETRIES = getIntegerEnv('SMUG_REQUEST_RETRIES', 2, 0, 5);
const SMUG_RETRY_DELAY_MS = getIntegerEnv('SMUG_RETRY_DELAY_MS', 1500, 250, 10000);
const SMUG_REQUEST_CONCURRENCY = getIntegerEnv('SMUG_REQUEST_CONCURRENCY', 2, 1, 4);
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

// Admin/control route inventory for the future password-protected admin shell.
// Keep these route names stable; add new admin routes here when they become control-plane endpoints.
const ADMIN_ROUTE_INVENTORY = Object.freeze({
  apiAdmin: Object.freeze([
    '/api/admin/overview',
    '/api/admin/status',
    '/api/admin/status/imports',
    '/api/admin/diagnostics',
    '/api/admin/diagnostics/imports',
    '/api/admin/diagnostics/music',
    '/api/admin/diagnostics/music/bands',
    '/api/admin/diagnostics/music/shows',
    '/api/admin/diagnostics/music/people',
    '/api/admin/diagnostics/music/venues',
    '/api/admin/diagnostics/wrestling',
    '/api/admin/diagnostics/relationships',
    '/api/admin/diagnostics/music/relationships',
    '/api/admin/diagnostics/wrestling/relationships',
    '/api/admin/import-history',
    '/api/admin/import-history/music',
    '/api/admin/import-history/wrestling',
    '/api/admin/import-history/latest',
    '/api/admin/import-locks',
    '/api/admin/import-locks/music',
    '/api/admin/import-locks/wrestling',
    '/api/admin/relationships',
    '/api/admin/relationships/summary',
    '/api/admin/relationships/music',
    '/api/admin/relationships/wrestling',
    '/api/admin/stats/summary',
    '/api/admin/stats/rebuild',
    '/api/admin/stats/rebuild/music',
    '/api/admin/stats/rebuild/wrestling'
  ]),
  imports: Object.freeze([
    '/admin/import/music/bands',
    '/admin/import/music/shows',
    '/admin/import/music/people',
    '/admin/import/music/venues',
    '/admin/import/wrestling/shows',
    '/admin/import/wrestling/people',
    '/admin/import/wrestling/venues'
  ]),
  legacyImportAliases: Object.freeze([
    '/api/wrestling/people/import'
  ]),
  refreshRoutes: Object.freeze(
    Object.keys(ROUTES).map((routePath) => `${routePath}?refresh=1`)
  ),
  protectedPrefixes: Object.freeze([
    '/api/admin/*',
    '/admin/import/*',
    'public data routes with ?refresh=1'
  ])
});

function getAdminRouteInventory() {
  return {
    apiAdmin: Array.from(ADMIN_ROUTE_INVENTORY.apiAdmin),
    imports: Array.from(ADMIN_ROUTE_INVENTORY.imports),
    legacyImportAliases: Array.from(ADMIN_ROUTE_INVENTORY.legacyImportAliases),
    refreshRoutes: Array.from(ADMIN_ROUTE_INVENTORY.refreshRoutes),
    protectedPrefixes: Array.from(ADMIN_ROUTE_INVENTORY.protectedPrefixes)
  };
}

function getConfiguredAdminSecrets() {
  return [
    String(process.env.ADMIN_TOKEN || '').trim(),
    String(process.env.ADMIN_PASSWORD || '').trim()
  ].filter(Boolean);
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isRenderRuntime() {
  return [
    process.env.RENDER,
    process.env.RENDER_SERVICE_ID,
    process.env.RENDER_SERVICE_NAME,
    process.env.RENDER_EXTERNAL_URL,
    process.env.RENDER_INSTANCE_ID
  ].some((value) => String(value || '').trim());
}

function isProductionRuntime() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function shouldRequireAdminProtection() {
  if (isTruthyEnv(process.env.ADMIN_REQUIRE_TOKEN)) return true;
  if (isTruthyEnv(process.env.ADMIN_AUTH_BYPASS) && !isRenderRuntime() && !isProductionRuntime()) return false;
  return isRenderRuntime() || isProductionRuntime();
}

function getAdminProtectionStatus() {
  const configured = getConfiguredAdminSecrets().length > 0;
  const required = shouldRequireAdminProtection();
  const inventory = getAdminRouteInventory();

  return {
    enabled: configured || required,
    configured,
    required,
    mode: configured ? 'token' : (required ? 'missing_secret' : 'development_bypass'),
    requiredEnv: 'ADMIN_TOKEN or ADMIN_PASSWORD',
    protectedPrefixes: inventory.protectedPrefixes,
    protectedRoutes: inventory.apiAdmin.concat(inventory.imports, inventory.legacyImportAliases, inventory.refreshRoutes),
    acceptedTokenSources: [
      'x-admin-token',
      'Authorization: Bearer <token>',
      'token query parameter',
      'admin_token query parameter'
    ]
  };
}

function getRequestAdminTokens(req) {
  const tokens = [];
  const headerToken = String(req.get('x-admin-token') || '').trim();
  const authHeader = String(req.get('authorization') || '').trim();
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  // Query-token auth is only for manual browser testing; do not save it in public bookmarks.
  const queryToken = String((req.query && (req.query.token || req.query.admin_token)) || '').trim();

  if (headerToken) tokens.push(headerToken);
  if (bearerMatch && bearerMatch[1]) tokens.push(String(bearerMatch[1]).trim());
  if (queryToken) tokens.push(queryToken);

  return tokens.filter(Boolean);
}

let adminProtectionWarningLogged = false;

function adminTokenMatches(token, secrets) {
  const tokenBuffer = Buffer.from(String(token || ''), 'utf8');
  return secrets.some((secret) => {
    const secretBuffer = Buffer.from(String(secret || ''), 'utf8');
    return tokenBuffer.length === secretBuffer.length && crypto.timingSafeEqual(tokenBuffer, secretBuffer);
  });
}

function buildAdminAccessError(req, error, message) {
  const generated = new Date();
  return {
    ok: false,
    route: req.originalUrl ? String(req.originalUrl).split('?')[0] : req.path,
    error,
    message,
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    adminProtection: getAdminProtectionStatus()
  };
}

function requireAdminAccess(req, res, next) {
  const configuredSecrets = getConfiguredAdminSecrets();
  const protectionStatus = getAdminProtectionStatus();

  if (!configuredSecrets.length) {
    if (!protectionStatus.required) {
      if (!adminProtectionWarningLogged) {
        console.warn('Admin protection development bypass active. Set ADMIN_TOKEN or ADMIN_PASSWORD before exposing admin/control routes.');
        adminProtectionWarningLogged = true;
      }
      return next();
    }

    return res.status(503).json(buildAdminAccessError(
      req,
      'ADMIN_PROTECTION_NOT_CONFIGURED',
      'Set ADMIN_TOKEN or ADMIN_PASSWORD to enable admin/control routes.'
    ));
  }

  const requestTokens = getRequestAdminTokens(req);
  if (!requestTokens.length) {
    return res.status(401).json(buildAdminAccessError(
      req,
      'ADMIN_ACCESS_REQUIRED',
      'Missing admin token.'
    ));
  }

  if (adminTokenMatches(requestTokens[0], configuredSecrets) || requestTokens.slice(1).some((token) => adminTokenMatches(token, configuredSecrets))) {
    return next();
  }

  return res.status(401).json(buildAdminAccessError(
    req,
    'ADMIN_TOKEN_INVALID',
    'Invalid admin token.'
  ));
}

function requireRefreshAdminAccess(req, res, next) {
  const isProtectedRefresh = req.query &&
    req.query.refresh === '1' &&
    Object.prototype.hasOwnProperty.call(ROUTES, req.path);

  if (!isProtectedRefresh) return next();
  return requireAdminAccess(req, res, next);
}

async function applyDatabaseSchema() {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      console.warn('PostgreSQL schema apply skipped: DATABASE_URL is not configured.');
      return;
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

async function applyRuntimeDatabaseMigrations() {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    console.warn('Runtime database migrations skipped: DATABASE_URL is not configured.');
    return;
  }

  const result = await ensureSmugMusicSnapshotColumns();
  if (result && result.ok) {
    console.log(`Runtime migration applied: SmugMug music snapshot columns ensured (${result.columnsEnsured.length}).`);
  } else if (result && result.error) {
    console.warn(`Runtime migration warning: SmugMug music snapshot columns were not fully ensured: ${result.error}`);
  }
}
function isControlPlaneRequest(req) {
  if (!req || !req.path) return false;
  if (req.path.startsWith('/api/admin')) return true;
  if (req.path.startsWith('/admin/import')) return true;
  if (req.path === '/api/wrestling/people/import') return true;
  return !!(req.query && req.query.refresh === '1' && Object.prototype.hasOwnProperty.call(ROUTES, req.path));
}

function allowCors(req, res, next) {
  const origin = req.headers.origin || '';
  const allowList = String(process.env.CORS_ALLOW_ORIGINS || '')
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const controlPlaneRequest = isControlPlaneRequest(req);

  if (origin && allowList.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (origin && controlPlaneRequest && allowList.length) {
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-Requested-With, X-Admin-Token');

  if (req.method === 'OPTIONS') return res.status(204).send('');
  return next();
}

function getSmugMugConfigDiagnostics() {
  const missing = [];
  const warnings = [];

  if (!SMUG_API_KEY) missing.push('SMUG_API_KEY');
  if (!SMUG_NICKNAME_ENV) missing.push('SMUG_NICKNAME');
  if (!SMUG_USER_AGENT) warnings.push('SMUG_USER_AGENT is blank; using a descriptive user agent is recommended.');

  return {
    configured: missing.length === 0,
    missing,
    warnings,
    nickname: SMUG_NICKNAME,
    userAgent: SMUG_USER_AGENT,
    retries: SMUG_REQUEST_RETRIES,
    retryDelayMs: SMUG_RETRY_DELAY_MS,
    concurrency: SMUG_REQUEST_CONCURRENCY
  };
}

function getStartupEnvironmentWarnings() {
  const warnings = [];
  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('DATABASE_URL is not configured; PostgreSQL routes and schema apply will be unavailable.');
  }
  if (!SHEET_ID) warnings.push('GOOGLE_SHEET_ID is not configured; Google Sheets routes/imports will fail.');
  if (shouldRequireAdminProtection() && !getConfiguredAdminSecrets().length) {
    warnings.push('ADMIN_TOKEN or ADMIN_PASSWORD is required in Render/production; admin/control routes will return 503 until configured.');
  }
  if (!String(process.env.CORS_ALLOW_ORIGINS || '').trim()) {
    warnings.push('CORS_ALLOW_ORIGINS is blank; public non-credentialed routes will allow any origin.');
  }

  const smugConfig = getSmugMugConfigDiagnostics();
  if (!smugConfig.configured) {
    warnings.push(`SmugMug integration disabled; missing ${smugConfig.missing.join(', ')}.`);
  }
  smugConfig.warnings.forEach((warning) => warnings.push(`SmugMug: ${warning}`));

  return warnings;
}
function logStartupEnvironmentWarnings() {
  const warnings = getStartupEnvironmentWarnings();
  warnings.forEach((warning) => console.warn(`Startup warning: ${warning}`));
}

app.use(allowCors);
app.use(['/api/admin', '/admin/import', '/admin/smug', '/api/wrestling/people/import'], requireAdminAccess);
app.use(requireRefreshAdminAccess);

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

function normalizeSmugEndpoint(endpoint) {
  const clean = String(endpoint || '').trim();
  if (!clean) throw new Error('Missing SmugMug endpoint.');
  return clean.startsWith('/') ? clean : `/${clean}`;
}

function normalizeSmugEndpoint(endpoint) {
  const clean = String(endpoint || '').trim();
  if (!clean) throw new Error('Missing SmugMug endpoint.');
  return clean.startsWith('/') ? clean : `/${clean}`;
}

function buildSmugApiUrl(endpoint) {
  const cleanEndpoint = normalizeSmugEndpoint(endpoint);
  const url = new URL(`${SMUG_API_BASE_URL}${cleanEndpoint}`);
  url.searchParams.set('APIKey', SMUG_API_KEY);
  return url.toString();
}

function getSmugSafeEndpointLabel(endpoint) {
  try {
    const cleanEndpoint = normalizeSmugEndpoint(endpoint);
    const idx = cleanEndpoint.indexOf('?');
    return idx === -1 ? cleanEndpoint : cleanEndpoint.slice(0, idx);
  } catch (_) {
    return '/unknown';
  }
}

function isSmugRateLimitStatus(status) {
  return Number(status) === 429;
}

function isSmugMugConfigured() {
  return getSmugMugConfigDiagnostics().configured;
}

async function fetchSmugJson(endpoint, options = {}) {
  if (!isSmugMugConfigured()) {
    throw new Error('SmugMug integration is not configured. Set SMUG_API_KEY.');
  }

  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : SMUG_REQUEST_RETRIES;
  const retryDelayMs = Number.isInteger(options.retryDelayMs) ? Math.max(0, options.retryDelayMs) : SMUG_RETRY_DELAY_MS;
  const safeEndpoint = getSmugSafeEndpointLabel(endpoint);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(buildSmugApiUrl(endpoint), {
      headers: {
        Accept: 'application/json',
        'User-Agent': SMUG_USER_AGENT
      }
    });

    if (res.ok) return res.json();

    const text = await res.text();
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    lastError = new Error(`SmugMug returned HTTP ${res.status} (${safeEndpoint})${snippet ? `: ${snippet}` : ''}`);

    if (!isSmugRateLimitStatus(res.status) || attempt >= retries) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
  }

  throw lastError;
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

function buildMusicBandFolderPath(target) {
  return ['Music', 'Archives', 'Bands', target.region, target.folder]
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildMusicBandFolderEndpoint(target) {
  return `/folder/user/${encodeURIComponent(SMUG_NICKNAME)}/${buildMusicBandFolderPath(target)}?_accept=application/json`;
}
function buildMusicBandAlbumsEndpoint(target) {
  return `/folder/user/${encodeURIComponent(SMUG_NICKNAME)}/${buildMusicBandFolderPath(target)}!albums?_accept=application/json`;
}
function buildMusicBandParentAlbumsEndpoint(target) {
  const path = ['Music', 'Archives', 'Bands', target.region]
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
  const counts = await mapWithConcurrency(albums, SMUG_REQUEST_CONCURRENCY, getSmugAlbumTotalPhotos);

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
    photosNonePct: '0.00%',
    set_count: 0
  };
}

function getCanonicalNullableString(value) {
  const clean = String(value == null ? '' : value).trim();
  return clean || null;
}

function getCanonicalCount(value) {
  return toIntegerCount(value);
}

function getMusicStatsNumber(stats, keys) {
  const source = stats && typeof stats === 'object' ? stats : {};
  for (const key of keys) {
    if (source[key] != null && String(source[key]).trim() !== '') return getCanonicalCount(source[key]);
  }
  return 0;
}

function getMusicArrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function addMusicCanonicalAliases(target, aliases = {}) {
  if (!target || typeof target !== 'object') return target;

  const numericKeys = [
    'photo_count',
    'event_count',
    'show_count',
    'set_count',
    'band_count',
    'artist_count',
    'people_count',
    'member_count',
    'venue_count'
  ];

  numericKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(aliases, key)) {
      target[key] = getCanonicalCount(aliases[key]);
    }
  });

  ['gallery_id', 'album_id', 'cover_image_url'].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(aliases, key)) {
      target[key] = getCanonicalNullableString(aliases[key]);
    }
  });

  return target;
}

function addMusicStatsCanonicalAliases(stats, aliases = {}) {
  return addMusicCanonicalAliases(stats && typeof stats === 'object' ? stats : {}, aliases);
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

  if (totalSets != null && totalSets > 0) stats.set_count += totalSets;

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
  ordered.photo_count = getMusicStatsNumber(source, ['photo_count', 'totalPhotos', 'photoCount']);
  if (photoRank) ordered.photoRank = photoRank;
  ['archived_sets', 'total_sets'].forEach((key) => {
    if (source[key] != null) ordered[key] = source[key];
  });
  ordered.set_count = getMusicStatsNumber(source, ['set_count', 'total_sets', 'setCount']);
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
  addMusicStatsCanonicalAliases(stats, {
    photo_count: stats.photosTotal,
    band_count: stats.bandsTotal,
    artist_count: stats.bandsTotal,
    people_count: 0,
    event_count: 0,
    show_count: 0,
    venue_count: 0,
    set_count: stats.set_count
  });
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
  const galleryId = row.smug_folder || row.slug_folder;
  const coverImageUrl = row.logo_url;
  addMusicCanonicalAliases(general, {
    gallery_id: galleryId,
    album_id: null,
    cover_image_url: coverImageUrl
  });
  addMusicCanonicalAliases(stats, {
    photo_count: totalPhotos,
    set_count: row.total_sets,
    member_count: members.length
  });
  const item = {};

  if (members.length) personnel.members = members;
  if (pastMembers.length) personnel.past_members = pastMembers;

  if (band) item.band = band;
  if (bandId) item.band_id = bandId;
  addMusicCanonicalAliases(item, {
    photo_count: totalPhotos,
    set_count: row.total_sets,
    member_count: members.length
  });
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
  addMusicCanonicalAliases(item, {
    event_count: 1,
    show_count: 1,
    band_count: bands.length,
    artist_count: bands.length,
    photo_count: 0,
    set_count: 0,
    people_count: 0,
    venue_count: 0,
    gallery_id: row.gallery_id || row.gallery || row.smug_folder || row.smugmug_gallery,
    album_id: row.album_id || row.album || row.albumId || row.smugmug_album,
    cover_image_url: row.cover_image_url || row.poster || row.thumbnail || row.image || row.cover
  });

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
  const showsTotal = data.length;
  const bandsTotal = data.reduce((total, show) => total + (Array.isArray(show.bands) ? show.bands.length : 0), 0);
  return {
    showsTotal,
    bandsTotal,
    show_count: showsTotal,
    event_count: showsTotal,
    band_count: bandsTotal,
    artist_count: bandsTotal,
    photo_count: 0,
    set_count: 0,
    people_count: 0,
    venue_count: 0
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
  addMusicCanonicalAliases(item, {
    photo_count: photoCount,
    band_count: getMusicArrayCount(item.bands),
    artist_count: getMusicArrayCount(item.bands),
    people_count: 1,
    member_count: 0,
    event_count: 0,
    show_count: 0,
    set_count: 0,
    venue_count: 0,
    gallery_id: null,
    album_id: null,
    cover_image_url: null
  });

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
      peopleTotal: people.peopleTotal,
      people_count: people.peopleTotal,
      artist_count: people.peopleTotal,
      band_count: 0,
      photo_count: 0,
      event_count: 0,
      show_count: 0,
      set_count: 0,
      venue_count: 0
    },
    route: payload.route,
    source
  };
}

async function buildMusicPeoplePublicDbResponse() {
  if (!String(process.env.DATABASE_URL || '').trim()) return null;

  const generated = new Date();
  const totalResult = await dbPool.query('SELECT count(*)::int AS total FROM music_people');
  const total = toIntegerCount(totalResult.rows && totalResult.rows[0] && totalResult.rows[0].total);
  const result = await dbPool.query(`
    SELECT person_id, name, category, aliases, bands, associations, stats
    FROM music_people
    ORDER BY name ASC, person_id ASC
    LIMIT 1000
  `);
  const data = (result.rows || []).map(buildMusicPersonDbApiItem);

  return {
    ok: true,
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    route: '/api/music/people',
    source: {
      name: 'Music-People',
      type: 'postgres',
      table: 'music_people'
    },
    stats: {
      peopleTotal: total,
      people_count: total,
      artist_count: total,
      band_count: 0,
      photo_count: 0,
      event_count: 0,
      show_count: 0,
      set_count: 0,
      venue_count: 0
    },
    count: data.length,
    total,
    data
  };
}
function buildMusicVenueSheetItem(row) {
  const item = { ...(row || {}) };
  addMusicCanonicalAliases(item, {
    show_count: row && (row.show_count || row.showCount),
    event_count: row && (row.event_count || row.eventCount || row.show_count || row.showCount),
    venue_count: 1,
    photo_count: row && (row.photo_count || row.photoCount || row.totalPhotos),
    set_count: row && (row.set_count || row.setCount || row.total_sets),
    band_count: row && (row.band_count || row.bandCount),
    artist_count: row && (row.artist_count || row.artistCount),
    people_count: row && (row.people_count || row.peopleCount),
    member_count: row && (row.member_count || row.memberCount),
    gallery_id: row && (row.gallery_id || row.gallery || row.smug_folder || row.smugmug_gallery),
    album_id: row && (row.album_id || row.album || row.albumId || row.smugmug_album),
    cover_image_url: row && (row.cover_image_url || row.logo || row.thumbnail || row.image || row.cover)
  });
  return item;
}

function buildMusicVenuesResponse(payload) {
  const generated = new Date();
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  return {
    ...payload,
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    stats: {
      venuesTotal: rows.length,
      venue_count: rows.length,
      show_count: 0,
      event_count: 0,
      photo_count: 0,
      set_count: 0,
      band_count: 0,
      artist_count: 0,
      people_count: 0,
      member_count: 0
    },
    rows: rows.map(buildMusicVenueSheetItem)
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
  if (!isTruthyEnv(process.env.IMPORT_DEBUG)) return;
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
  venue_id: 'venue_id',
  venueid: 'venue_id',
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
  if (['name', 'venue_id', 'venue', 'city', 'state', 'date', 'poster', 'notes', 'camera_1', 'camera_2'].some((key) => toDbText(row[key]))) {
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
    venue_id: toDbText(row.venue_id),
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
      venue_id,
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
      $11, $12, $13::jsonb, $14::jsonb, $15::jsonb
    )
    ON CONFLICT (show_id) DO UPDATE SET
      name = EXCLUDED.name,
      venue_id = EXCLUDED.venue_id,
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
    item.venue_id,
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
  venue_id: 'venue_key',
  venueid: 'venue_key',
  venue: 'venue',
  name: 'venue',
  venue_name: 'venue',
  venuename: 'venue',
  city: 'city',
  state: 'state',
  country: 'country',
  region: 'region',
  gps_lat: 'latitude',
  gpslat: 'latitude',
  latitude: 'latitude',
  lat: 'latitude',
  gps_lng: 'longitude',
  gpslng: 'longitude',
  gps_lon: 'longitude',
  gpslon: 'longitude',
  longitude: 'longitude',
  lng: 'longitude',
  lon: 'longitude',
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
  const venueKey = cleanMusicVenueText(row.venue_key);
  if (venueKey) return normalizeMusicLookupKey(venueKey);

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
        venue_key: '',
        city: '',
        state: '',
        country: '',
        region: '',
        latitude: '',
        longitude: '',
        logo: '',
        description: '',
        notes: '',
        status: '',
        rawRows: []
      });
    }

    const group = groups.get(key);
    setMusicVenueGroupValue(group, 'venue_key', row.venue_key);
    setMusicVenueGroupValue(group, 'venue', row.venue);
    setMusicVenueGroupValue(group, 'city', row.city);
    setMusicVenueGroupValue(group, 'state', row.state);
    setMusicVenueGroupValue(group, 'country', row.country);
    setMusicVenueGroupValue(group, 'region', row.region);
    setMusicVenueGroupValue(group, 'latitude', row.latitude);
    setMusicVenueGroupValue(group, 'longitude', row.longitude);
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
  const byVenueId = new Map();
  const exact = new Map();
  const venueOnly = new Map();

  try {
    const venueIdResult = await client.query(`
      SELECT
        lower(trim(coalesce(venue_id, ''))) AS venue_id_key,
        count(*)::int AS show_count
      FROM music_shows
      WHERE trim(coalesce(venue_id, '')) <> ''
      GROUP BY 1
    `);

    venueIdResult.rows.forEach((row) => {
      const venueIdKey = normalizeMusicLookupKey(row.venue_id_key);
      if (venueIdKey) byVenueId.set(venueIdKey, toIntegerCount(row.show_count));
    });

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

  return { byVenueId, exact, venueOnly };
}

function getMusicVenueShowCount(venue, showCounts) {
  const venueIdKey = normalizeMusicLookupKey(venue.venue_key);
  if (venueIdKey && showCounts.byVenueId && showCounts.byVenueId.has(venueIdKey)) {
    return showCounts.byVenueId.get(venueIdKey);
  }

  const exactKey = getMusicVenueShowCountKey(venue.venue, venue.city, venue.state);
  const venueKey = normalizeMusicLookupKey(venue.venue);
  if (showCounts.exact.has(exactKey)) return showCounts.exact.get(exactKey);
  return showCounts.venueOnly.get(venueKey) || 0;
}

function buildMusicVenueFallbackKey(venue) {
  const slug = slugifyMusicBandId([
    venue.venue,
    venue.city,
    venue.state,
    venue.country
  ].filter(Boolean).join(' '));
  return slug ? `mv_${slug.replace(/-/g, '_')}` : '';
}

function buildMusicVenueDbRows(rows, showCounts, legacyVenueIdStart = 0) {
  const grouped = buildMusicVenueDbGroups(rows);
  const venues = grouped.groups.sort((a, b) => {
    return a.venue.localeCompare(b.venue, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.city.localeCompare(b.city, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.state.localeCompare(b.state, undefined, { numeric: true, sensitivity: 'base' });
  });
  const items = venues.map((venue, index) => {
    const showCount = getMusicVenueShowCount(venue, showCounts);
    const latitude = toNullableNumber(venue.latitude);
    const longitude = toNullableNumber(venue.longitude);
    const venueKey = cleanMusicVenueText(venue.venue_key) || buildMusicVenueFallbackKey(venue);
    const latitudeText = latitude == null ? '' : String(latitude);
    const longitudeText = longitude == null ? '' : String(longitude);

    return {
      venue_id: legacyVenueIdStart + index + 1,
      venue_key: venueKey,
      venue: venue.venue,
      city: venue.city || null,
      state: venue.state || null,
      country: venue.country || null,
      region: venue.region || null,
      gps_lat: latitudeText || null,
      gps_lng: longitudeText || null,
      logo: venue.logo || null,
      latitude,
      longitude,
      description: venue.description || null,
      notes: venue.notes || null,
      status: venue.status || null,
      geo: buildPhase1WrestlingVenueGeo(latitude, longitude),
      location: {
        gps_lat: latitudeText,
        gps_lng: longitudeText
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

async function getMusicVenueLegacyIdStart(client) {
  try {
    const result = await client.query('SELECT coalesce(max(venue_id), 0)::int AS max_venue_id FROM music_venues');
    const row = result.rows && result.rows[0] ? result.rows[0] : {};
    return toIntegerCount(row.max_venue_id);
  } catch (err) {
    console.warn('Music-Venues legacy id lookup skipped:', err && err.message ? err.message : String(err));
    return 0;
  }
}

async function attachMusicVenueKeyToLegacyRow(client, item) {
  if (!item.venue_key) return;

  await client.query(`
    UPDATE music_venues
    SET venue_key = $1
    WHERE venue_key IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM music_venues existing
        WHERE existing.venue_key = $1
      )
      AND lower(trim(coalesce(venue, ''))) = $2
      AND lower(trim(coalesce(city, ''))) = $3
      AND lower(trim(coalesce(state, ''))) = $4
  `, [
    item.venue_key,
    normalizeMusicLookupKey(item.venue),
    normalizeMusicLookupKey(item.city),
    normalizeMusicLookupKey(item.state)
  ]);
}

async function upsertMusicVenueDbRow(client, item) {
  await attachMusicVenueKeyToLegacyRow(client, item);

  await client.query(`
    INSERT INTO music_venues (
      venue_id,
      venue_key,
      venue,
      city,
      state,
      country,
      region,
      gps_lat,
      gps_lng,
      logo,
      latitude,
      longitude,
      description,
      notes,
      status,
      geo,
      location,
      media,
      stats,
      raw_sheet
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb
    )
    ON CONFLICT (venue_key) DO UPDATE SET
      venue = EXCLUDED.venue,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      country = EXCLUDED.country,
      region = EXCLUDED.region,
      gps_lat = EXCLUDED.gps_lat,
      gps_lng = EXCLUDED.gps_lng,
      logo = EXCLUDED.logo,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      description = EXCLUDED.description,
      notes = EXCLUDED.notes,
      status = EXCLUDED.status,
      geo = EXCLUDED.geo,
      location = EXCLUDED.location,
      media = EXCLUDED.media,
      stats = EXCLUDED.stats,
      raw_sheet = EXCLUDED.raw_sheet,
      updated_at = NOW()
  `, [
    item.venue_id,
    item.venue_key,
    item.venue,
    item.city,
    item.state,
    item.country,
    item.region,
    item.gps_lat,
    item.gps_lng,
    item.logo,
    item.latitude,
    item.longitude,
    item.description,
    item.notes,
    item.status,
    stringifyDbJson(item.geo),
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
    const legacyVenueIdStart = await getMusicVenueLegacyIdStart(client);
    const built = buildMusicVenueDbRows(rows, showCounts, legacyVenueIdStart);
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
  venue_id: 'venue_id',
  venueid: 'venue_id',
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
  extra_people: 'extra_people',
  extrapeople: 'extra_people',
  extra_person: 'extra_people',
  extraperson: 'extra_people',
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

function shouldSplitWrestlingWinnerCommaParts(parts) {
  return parts.length > 2 || parts.every((part) => {
    const clean = String(part || '').trim();
    return /\s/.test(clean) || /^[A-Z0-9.'-]+$/.test(clean);
  });
}

function splitWrestlingWinnerList(value) {
  if (Array.isArray(value)) return uniqueWrestlingPeopleList(value);

  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  if (!clean) return [];

  const hasSemicolon = clean.includes(';');
  const hasAnd = /\s+and\s+/i.test(clean);
  const normalized = clean.replace(/\s+and\s+/gi, ';');

  if (hasSemicolon || hasAnd) {
    return uniqueWrestlingPeopleList(normalized.split(/[;,]/g));
  }

  if (clean.includes(',')) {
    const commaParts = clean.split(',').map((part) => String(part || '').trim()).filter(Boolean);
    if (shouldSplitWrestlingWinnerCommaParts(commaParts)) {
      return uniqueWrestlingPeopleList(commaParts);
    }
  }

  return uniqueWrestlingPeopleList([clean]);
}

function uniqueWrestlingPeopleList(values) {
  const seen = new Set();
  const out = [];

  (values || []).forEach((value) => {
    const clean = String(value || '').trim().replace(/\s+/g, ' ');
    if (!clean) return;

    const key = clean.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    out.push(clean);
  });

  return out;
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
    'extra_people',
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
        venue_id: '',
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
    setWrestlingShowGroupValue(group, 'venue_id', row.venue_id);
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
  const participants = splitWrestlingSemicolonList(row.participants);
  const referees = splitWrestlingSemicolonList(row.referees);
  const extraPeople = splitWrestlingSemicolonList(row.extra_people);
  const winners = splitWrestlingWinnerList(row.winner);

  return {
    match_order: toNullableInteger(row.match_order),
    match_url: toDbText(row.match_url) || '',
    match_type: toDbText(row.match_type) || '',
    stipulation: toDbText(row.stipulation) || '',
    title: toDbText(row.title) || '',
    side_1: splitWrestlingSemicolonList(row.side_1),
    side_2: splitWrestlingSemicolonList(row.side_2),
    participants,
    extra_people: extraPeople,
    winner: winners,
    referees,
    tagged_people: uniqueWrestlingPeopleList(participants.concat(referees, extraPeople)),
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
      venue_id: toDbText(show.venue_id),
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
      venue_id,
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
      $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb
    )
    ON CONFLICT (show_id) DO UPDATE SET
      show_key = EXCLUDED.show_key,
      promotion = EXCLUDED.promotion,
      show_name = EXCLUDED.show_name,
      date = EXCLUDED.date,
      show_date = EXCLUDED.show_date,
      venue_id = EXCLUDED.venue_id,
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
    item.venue_id,
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
    venue_image: null
  };
}

function getValidWrestlingVenueCoordinates(latitude, longitude) {
  const lat = toNullableNumber(latitude);
  const lon = toNullableNumber(longitude);

  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return {
    lat,
    lon,
    latText: String(lat),
    lonText: String(lon)
  };
}

function encodeWrestlingVenueGeohash(latitude, longitude, precision = 6) {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  const bits = [16, 8, 4, 2, 1];
  let evenBit = true;
  let bit = 0;
  let ch = 0;
  let geohash = '';
  let latRange = [-90, 90];
  let lonRange = [-180, 180];

  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lonRange[0] + lonRange[1]) / 2;
      if (longitude >= mid) {
        ch += bits[bit];
        lonRange[0] = mid;
      } else {
        lonRange[1] = mid;
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (latitude >= mid) {
        ch += bits[bit];
        latRange[0] = mid;
      } else {
        latRange[1] = mid;
      }
    }

    evenBit = !evenBit;

    if (bit < 4) {
      bit += 1;
    } else {
      geohash += base32[ch];
      bit = 0;
      ch = 0;
    }
  }

  return geohash;
}

function buildPhase1WrestlingVenueGeo(latitude, longitude, existingGeo) {
  const geo = createEmptyWrestlingVenueGeo();
  const existing = existingGeo && typeof existingGeo === 'object' ? existingGeo : {};
  Object.keys(geo).forEach((key) => {
    if (existing[key] != null) geo[key] = existing[key];
  });

  const coords = getValidWrestlingVenueCoordinates(latitude, longitude);
  if (!coords) {
    geo.google_maps_url = null;
    geo.apple_maps_url = null;
    geo.osm_url = null;
    geo.geohash = null;
    return geo;
  }

  geo.google_maps_url = `https://www.google.com/maps?q=${coords.latText},${coords.lonText}`;
  geo.apple_maps_url = `https://maps.apple.com/?ll=${coords.latText},${coords.lonText}`;
  geo.osm_url = `https://www.openstreetmap.org/?mlat=${coords.latText}&mlon=${coords.lonText}#map=16/${coords.latText}/${coords.lonText}`;
  geo.geohash = encodeWrestlingVenueGeohash(coords.lat, coords.lon, 6);

  return geo;
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
    const latitude = toNullableNumber(row.latitude);
    const longitude = toNullableNumber(row.longitude);

    items.push({
      venue_id: venueId,
      venue_name: venueName,
      city: toDbText(row.city),
      state: toDbText(row.state),
      country: toDbText(row.country),
      region: toDbText(row.region),
      venue_type: toDbText(row.venue_type),
      status: toDbText(row.status),
      latitude,
      longitude,
      notes: toDbText(row.notes),
      geo: buildPhase1WrestlingVenueGeo(latitude, longitude),
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
  const general = row.general && typeof row.general === 'object' ? { ...row.general } : {};
  const personnel = row.personnel && typeof row.personnel === 'object' ? row.personnel : {};
  const stats = row.stats && typeof row.stats === 'object' ? { ...row.stats } : {};
  const members = Array.isArray(personnel.members) ? personnel.members : [];
  const galleryId = general.smug_folder || row.smug_folder;
  const coverImageUrl = general.cover_image_url || general.logo_url || row.logo_url;
  addMusicCanonicalAliases(general, {
    gallery_id: galleryId,
    album_id: null,
    cover_image_url: coverImageUrl
  });
  addMusicCanonicalAliases(stats, {
    photo_count: getMusicStatsNumber(stats, ['photo_count', 'totalPhotos', 'photoCount']),
    set_count: getMusicStatsNumber(stats, ['set_count', 'total_sets', 'setCount']),
    member_count: members.length
  });

  const item = {
    band: row.band,
    band_id: row.band_id,
    general,
    personnel,
    stats
  };
  addMusicCanonicalAliases(item, {
    photo_count: row.photo_count != null ? toIntegerCount(row.photo_count) : stats.photo_count,
    set_count: stats.set_count,
    member_count: members.length,
    gallery_id: galleryId,
    album_id: null,
    cover_image_url: coverImageUrl
  });
  return item;
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

function buildPaginationMeta(page, limit, total, count) {
  const safePage = getPageNumber(page);
  const safeLimit = getClampedLimit(limit);
  const safeTotal = toIntegerCount(total);
  const totalPages = safeTotal > 0 ? Math.ceil(safeTotal / safeLimit) : 0;

  return {
    page: safePage,
    limit: safeLimit,
    count: toIntegerCount(count),
    total: safeTotal,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1 && totalPages > 0
  };
}

function getSafeErrorMessage(err) {
  const message = err && err.message ? String(err.message) : String(err || 'Unknown error');
  return message || 'Unknown error';
}

function buildApiError(route, err, extra = {}) {
  const generated = extra.generated instanceof Date ? extra.generated : new Date();
  const error = extra.error || 'INTERNAL_ERROR';
  const message = extra.message || getSafeErrorMessage(err);
  const payload = {
    ok: false,
    route,
    error,
    message,
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated)
  };

  ['source', 'section', 'type', 'details'].forEach((key) => {
    if (extra[key] != null) payload[key] = extra[key];
  });

  return payload;
}

function buildListMeta({ route, source, pagination, filters, sort, warnings } = {}) {
  const meta = {};
  if (route) meta.route = route;
  if (source != null) meta.source = source;
  if (pagination) meta.pagination = pagination;
  if (filters) meta.filters = filters;
  if (sort) meta.sort = sort;
  meta.warnings = Array.isArray(warnings) ? warnings : [];
  return meta;
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
    const pagination = buildPaginationMeta(page, limit, total, result.rows.length);

    res.json({
      ok: true,
      route: routePath,
      source: 'PostgreSQL:music_bands',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: pagination.count,
      total,
      page,
      limit,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
      filters: options.filters,
      sort: options.sort,
      meta: buildListMeta({ route: routePath, source: 'PostgreSQL:music_bands', pagination, filters: options.filters, sort: options.sort }),
      data: result.rows.map(buildMusicBandDbApiItem)
    });
  } catch (err) {
    res.status(500).json(buildApiError(routePath, err, {
      source: 'PostgreSQL:music_bands',
      error: 'MUSIC_BANDS_DB_ERROR'
    }));
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
      coalesce(sum(photo_count) FILTER (WHERE region_key = 'international'), 0)::int AS photos_international,
      coalesce(sum(total_set_count), 0)::int AS sets_total
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
  const bandsTotal = toIntegerCount(dbStats.bands_total);
  const setCount = toIntegerCount(dbStats.sets_total);

  return {
    ok: true,
    route: '/api/music/bands/stats',
    source: 'PostgreSQL:music_bands',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    bandTotals: {
      bandsTotal,
      band_count: bandsTotal,
      artist_count: bandsTotal,
      people_count: 0,
      event_count: 0,
      show_count: 0,
      venue_count: 0,
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
      photo_count: photosTotal,
      set_count: setCount,
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

async function getMusicVenueDetailsMap(venueIds) {
  const keys = Array.from(new Set(
    (venueIds || [])
      .map(normalizeMusicLookupKey)
      .filter(Boolean)
  ));
  const venues = new Map();
  if (!keys.length) return venues;

  try {
    const result = await dbPool.query(`
      SELECT venue_id, venue_key, venue, city, state, country, region, gps_lat, gps_lng, logo, latitude, longitude, description, notes, status, geo, location, media, stats
      FROM music_venues
      WHERE lower(trim(coalesce(venue_key, ''))) = ANY($1::text[])
    `, [keys]);

    result.rows.forEach((row) => {
      venues.set(normalizeMusicLookupKey(row.venue_key), buildMusicVenueDbApiItem(row));
    });
  } catch (err) {
    console.warn('Music venue details lookup skipped:', err && err.message ? err.message : String(err));
  }

  return venues;
}

function isVenueLogoUrl(value) {
  const clean = String(value || '').trim();
  if (!clean) return false;

  const lower = clean.toLowerCase();
  let decoded = lower;
  try {
    decoded = decodeURIComponent(lower);
  } catch (_) {
    decoded = lower;
  }

  return decoded.includes('/music/venue-logos/') ||
    decoded.includes('/venue-logos/') ||
    decoded.includes('venue-logo') ||
    decoded.includes('venue_logo');
}

function isUsableShowImageUrl(value) {
  const clean = String(value || '').trim();
  if (!clean) return false;
  if (isVenueLogoUrl(clean)) return false;
  if (typeof isSmugMusicShowLogoSourceUrl === 'function' && isSmugMusicShowLogoSourceUrl(clean)) return false;
  if (typeof isLikelySmugImageUrl === 'function') return isLikelySmugImageUrl(clean);
  return /^https?:\/\//i.test(clean);
}

function getMusicShowCoverImageUrl(row) {
  const storedCover = row && row.cover_image_url;
  if (isUsableShowImageUrl(storedCover)) return String(storedCover).trim();

  const poster = row && row.poster;
  if (isUsableShowImageUrl(poster)) return String(poster).trim();

  return null;
}

function formatMusicShowSyncTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildMusicShowVenueDetailsSummary(venueDetails) {
  if (!venueDetails || typeof venueDetails !== 'object') return null;

  const logo = String((venueDetails.media && venueDetails.media.logo) || venueDetails.logo || '').trim();
  return {
    venue_id: venueDetails.venue_id || '',
    venue: venueDetails.venue || '',
    city: venueDetails.city || '',
    state: venueDetails.state || '',
    country: venueDetails.country || '',
    region: venueDetails.region || '',
    status: venueDetails.status || '',
    media: {
      logo
    }
  };
}


function buildMusicShowDbApiItem(row, venueDetailsMap) {
  const venueId = row.venue_id || '';
  const fullVenueDetails = venueId ? (venueDetailsMap.get(normalizeMusicLookupKey(venueId)) || null) : null;
  const venueDetails = buildMusicShowVenueDetailsSummary(fullVenueDetails);
  const bands = Array.isArray(row.bands) ? row.bands : [];
  const stats = row.stats && typeof row.stats === 'object' ? { ...row.stats } : {};
  addMusicCanonicalAliases(stats, {
    event_count: 1,
    show_count: 1,
    band_count: bands.length,
    artist_count: bands.length,
    venue_count: venueId ? 1 : 0,
    photo_count: row.photo_count != null ? toIntegerCount(row.photo_count) : getMusicStatsNumber(stats, ['photo_count', 'photoCount', 'totalPhotos']),
    set_count: getMusicStatsNumber(stats, ['set_count', 'setCount'])
  });

  const item = {
    show_id: toIntegerCount(row.show_id),
    name: row.name || '',
    date: row.date || '',
    venue_id: venueId,
    venue: venueDetails ? venueDetails.venue : (row.venue || ''),
    venue_details: venueDetails,
    city: row.city || (venueDetails ? venueDetails.city : ''),
    state: row.state || (venueDetails ? venueDetails.state : ''),
    poster: row.poster || '',
    cover_image_url: getMusicShowCoverImageUrl(row),
    notes: row.notes || '',
    camera_1: row.camera_1 || '',
    camera_2: row.camera_2 || '',
    bands,
    stats,
    gallery_id: getCanonicalNullableString(row.gallery_id || row.gallery || row.smug_folder || row.smugmug_gallery),
    album_id: getCanonicalNullableString(row.album_id || row.album || row.smugmug_album),
    smug_sync_status: getCanonicalNullableString(row.smug_sync_status),
    smug_last_synced_at: formatMusicShowSyncTimestamp(row.smug_last_synced_at),
    smug_sync_error: getCanonicalNullableString(row.smug_sync_error)
  };

  return item;
}

function buildMusicShowsDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const state = String(query.state || '').trim();
  const city = String(query.city || '').trim();
  const venueId = String(query.venue_id || '').trim();
  const venue = String(query.venue || '').trim();
  const band = String(query.band || '').trim();
  const sortFields = {
    show_id: 'show_id',
    name: 'name',
    date: 'show_date',
    venue_id: 'venue_id',
    venue: `coalesce((SELECT mv.venue FROM music_venues mv WHERE lower(trim(coalesce(mv.venue_key, ''))) = lower(trim(coalesce(music_shows.venue_id, ''))) LIMIT 1), venue)`,
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
      OR coalesce(venue_id, '') ILIKE $${idx}
      OR coalesce(venue, '') ILIKE $${idx}
      OR EXISTS (
        SELECT 1
        FROM music_venues mv
        WHERE lower(trim(coalesce(mv.venue_key, ''))) = lower(trim(coalesce(music_shows.venue_id, '')))
          AND coalesce(mv.venue, '') ILIKE $${idx}
      )
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

  if (venueId) {
    values.push(venueId.toLowerCase());
    where.push(`lower(trim(coalesce(venue_id, ''))) = $${values.length}`);
    filters.venue_id = venueId;
  }

  if (venue) {
    values.push(venue.toLowerCase());
    where.push(`(
      lower(trim(coalesce(venue, ''))) = $${values.length}
      OR EXISTS (
        SELECT 1
        FROM music_venues mv
        WHERE lower(trim(coalesce(mv.venue_key, ''))) = lower(trim(coalesce(music_shows.venue_id, '')))
          AND lower(trim(coalesce(mv.venue, ''))) = $${values.length}
      )
    )`);
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
      `SELECT show_id, name, venue_id, venue, city, state, date, poster, notes, camera_1, camera_2, bands, stats, gallery_id, album_id, cover_image_url, photo_count, smug_last_synced_at, smug_sync_status, smug_sync_error
       FROM music_shows
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const venueDetailsMap = await getMusicVenueDetailsMap(result.rows.map((row) => row.venue_id));
    const data = result.rows.map((row) => buildMusicShowDbApiItem(row, venueDetailsMap));
    const pagination = buildPaginationMeta(page, limit, total, data.length);

    const meta = buildListMeta({ route: '/api/music/shows/db', source: 'PostgreSQL:music_shows', pagination, filters: options.filters, sort: options.sort });
    meta.payload = {
      canonicalStats: 'data[].stats',
      flattenedStats: 'removed',
      venueDetailsShape: 'compact'
    };

    res.json({
      ok: true,
      route: '/api/music/shows/db',
      source: 'PostgreSQL:music_shows',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: pagination.count,
      total,
      page,
      limit,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
      filters: options.filters,
      sort: options.sort,
      meta,
      stats: {
        showsTotal: total,
        bandsTotal: data.reduce((sum, show) => sum + (Array.isArray(show.bands) ? show.bands.length : 0), 0),
        show_count: total,
        event_count: total,
        band_count: data.reduce((sum, show) => sum + (Array.isArray(show.bands) ? show.bands.length : 0), 0),
        artist_count: data.reduce((sum, show) => sum + (Array.isArray(show.bands) ? show.bands.length : 0), 0),
        people_count: 0,
        venue_count: 0,
        photo_count: 0,
        set_count: 0
      },
      data
    });
  } catch (err) {
    res.status(500).json(buildApiError('/api/music/shows/db', err, {
      source: 'PostgreSQL:music_shows',
      error: 'MUSIC_SHOWS_DB_ERROR'
    }));
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
    SELECT coalesce(nullif(trim(mv.venue), ''), nullif(trim(ms.venue), ''), 'Unknown') AS venue, count(*)::int AS shows_total
    FROM music_shows ms
    LEFT JOIN music_venues mv
      ON lower(trim(coalesce(mv.venue_key, ''))) = lower(trim(coalesce(ms.venue_id, '')))
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
      uniqueBands: toIntegerCount(uniqueBands.unique_bands),
      show_count: toIntegerCount(totals.shows_total),
      event_count: toIntegerCount(totals.shows_total),
      band_count: toIntegerCount(uniqueBands.unique_bands),
      artist_count: toIntegerCount(uniqueBands.unique_bands),
      people_count: 0,
      venue_count: 0,
      photo_count: 0,
      set_count: 0
    },
    byYear: byYearResult.rows.map((row) => ({ year: row.year, showsTotal: toIntegerCount(row.shows_total) })),
    byState: byStateResult.rows.map((row) => ({ state: row.state, showsTotal: toIntegerCount(row.shows_total) })),
    byCity: byCityResult.rows.map((row) => ({ city: row.city, showsTotal: toIntegerCount(row.shows_total) })),
    byVenue: byVenueResult.rows.map((row) => ({ venue: row.venue, showsTotal: toIntegerCount(row.shows_total) })),
    topBands: topBandsResult.rows.map((row) => ({ band: row.band, appearances: toIntegerCount(row.appearances) }))
  };
}

function buildWrestlingMatchDbApiItem(match) {
  if (!match || typeof match !== 'object') return { participants: [], extra_people: [], winner: [], referees: [], tagged_people: [] };
  const participants = Array.isArray(match.participants) ? match.participants : [];
  const extraPeople = Array.isArray(match.extra_people) ? match.extra_people : [];
  const winners = splitWrestlingWinnerList(match.winner);
  const referees = Array.isArray(match.referees) ? match.referees : [];

  return {
    ...match,
    side_1: Array.isArray(match.side_1) ? match.side_1 : [],
    side_2: Array.isArray(match.side_2) ? match.side_2 : [],
    participants,
    extra_people: extraPeople,
    winner: winners,
    referees,
    tagged_people: Array.isArray(match.tagged_people)
      ? match.tagged_people
      : uniqueWrestlingPeopleList(participants.concat(referees, extraPeople))
  };
}

async function getWrestlingVenueDetailsMap(venueIds) {
  const keys = Array.from(new Set(
    (venueIds || [])
      .map(normalizeMusicLookupKey)
      .filter(Boolean)
  ));
  const venues = new Map();
  if (!keys.length) return venues;

  try {
    const result = await dbPool.query(`
      SELECT venue_id, venue_name, city, state, country, region, venue_type, status, latitude, longitude, notes, geo
      FROM wrestling_venues
      WHERE lower(trim(coalesce(venue_id, ''))) = ANY($1::text[])
    `, [keys]);

    result.rows.forEach((row) => {
      venues.set(normalizeMusicLookupKey(row.venue_id), buildWrestlingVenueDbApiItem(row));
    });
  } catch (err) {
    console.warn('Wrestling venue details lookup skipped:', err && err.message ? err.message : String(err));
  }

  return venues;
}

function buildWrestlingShowDbApiItem(row, venueDetailsMap) {
  const venueId = row.venue_id || '';
  const venueDetails = venueId ? (venueDetailsMap.get(normalizeMusicLookupKey(venueId)) || null) : null;

  return {
    show_id: toIntegerCount(row.show_id),
    show_key: row.show_key || '',
    promotion: row.promotion || '',
    show_name: row.show_name || '',
    date: row.date || '',
    venue_id: venueId,
    venue: venueDetails ? venueDetails.venue_name : '',
    venue_details: venueDetails,
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

function getWrestlingWinnerArraySql(matchAlias) {
  return `CASE
    WHEN jsonb_typeof(${matchAlias}->'winner') = 'array' THEN ${matchAlias}->'winner'
    WHEN trim(coalesce(${matchAlias}->>'winner', '')) <> '' THEN to_jsonb(regexp_split_to_array(regexp_replace(${matchAlias}->>'winner', '\\s+and\\s+', ';', 'gi'), '\\s*;\\s*|\\s*,\\s*'))
    ELSE '[]'::jsonb
  END`;
}

function getWrestlingRefereesArraySql(matchAlias) {
  return `CASE WHEN jsonb_typeof(${matchAlias}->'referees') = 'array' THEN ${matchAlias}->'referees' ELSE '[]'::jsonb END`;
}

function getWrestlingExtraPeopleArraySql(matchAlias) {
  return `CASE WHEN jsonb_typeof(${matchAlias}->'extra_people') = 'array' THEN ${matchAlias}->'extra_people' ELSE '[]'::jsonb END`;
}

function getWrestlingTaggedPeopleArraySql(matchAlias) {
  return `CASE WHEN jsonb_typeof(${matchAlias}->'tagged_people') = 'array' THEN ${matchAlias}->'tagged_people' ELSE '[]'::jsonb END`;
}

function getWrestlingAllTaggedPeopleArraySql(matchAlias) {
  return `(${getWrestlingTaggedPeopleArraySql(matchAlias)} || ${getWrestlingParticipantsArraySql(matchAlias)} || ${getWrestlingRefereesArraySql(matchAlias)} || ${getWrestlingExtraPeopleArraySql(matchAlias)})`;
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
  const venueId = String(query.venue_id || '').trim();
  const participant = String(query.participant || '').trim();
  const winner = String(query.winner || '').trim();
  const referee = String(query.referee || '').trim();
  const person = String(query.person || '').trim();
  const taggedPerson = String(query.tagged_person || '').trim();
  const sortFields = {
    show_id: 'show_id',
    show_key: 'show_key',
    promotion: 'promotion',
    show_name: 'show_name',
    date: 'show_date',
    venue_id: 'venue_id',
    venue: `(SELECT wv.venue_name FROM wrestling_venues wv WHERE lower(trim(coalesce(wv.venue_id, ''))) = lower(trim(coalesce(wrestling_shows.venue_id, ''))) LIMIT 1)`,
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
      OR coalesce(venue_id, '') ILIKE $${idx}
      OR coalesce(venue, '') ILIKE $${idx}
      OR EXISTS (
        SELECT 1
        FROM wrestling_venues wv
        WHERE lower(trim(coalesce(wv.venue_id, ''))) = lower(trim(coalesce(wrestling_shows.venue_id, '')))
          AND coalesce(wv.venue_name, '') ILIKE $${idx}
      )
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
    where.push(`(
      lower(trim(coalesce(venue, ''))) = $${values.length}
      OR EXISTS (
        SELECT 1
        FROM wrestling_venues wv
        WHERE lower(trim(coalesce(wv.venue_id, ''))) = lower(trim(coalesce(wrestling_shows.venue_id, '')))
          AND lower(trim(coalesce(wv.venue_name, ''))) = $${values.length}
      )
    )`);
    filters.venue = venue;
  }

  if (venueId) {
    values.push(venueId.toLowerCase());
    where.push(`lower(trim(coalesce(venue_id, ''))) = $${values.length}`);
    filters.venue_id = venueId;
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
      CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingWinnerArraySql('match_item')}) AS winner_item(value)
      WHERE lower(trim(winner_item.value)) = $${values.length}
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

  if (person) {
    values.push(person.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${matchesArraySql}) AS match_item
      CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingAllTaggedPeopleArraySql('match_item')}) AS person_item(value)
      WHERE lower(trim(person_item.value)) = $${values.length}
    )`);
    filters.person = person;
  }

  if (taggedPerson) {
    values.push(taggedPerson.toLowerCase());
    where.push(`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${matchesArraySql}) AS match_item
      CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingAllTaggedPeopleArraySql('match_item')}) AS tagged_person_item(value)
      WHERE lower(trim(tagged_person_item.value)) = $${values.length}
    )`);
    filters.tagged_person = taggedPerson;
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
      `SELECT show_id, show_key, promotion, show_name, date, venue_id, venue, city, state, poster, camera_1, camera_2, matches, stats
       FROM wrestling_shows
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const venueDetailsMap = await getWrestlingVenueDetailsMap(result.rows.map((row) => row.venue_id));
    const data = result.rows.map((row) => buildWrestlingShowDbApiItem(row, venueDetailsMap));
    const pagination = buildPaginationMeta(page, limit, total, data.length);

    res.json({
      ok: true,
      route: '/api/wrestling/shows/db',
      source: 'PostgreSQL:wrestling_shows',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: pagination.count,
      total,
      page,
      limit,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
      filters: options.filters,
      sort: options.sort,
      meta: buildListMeta({ route: '/api/wrestling/shows/db', source: 'PostgreSQL:wrestling_shows', pagination, filters: options.filters, sort: options.sort }),
      stats: {
        showsTotal: total,
        matchesTotal: data.reduce((sum, show) => sum + (Array.isArray(show.matches) ? show.matches.length : 0), 0)
      },
      data
    });
  } catch (err) {
    res.status(500).json(buildApiError('/api/wrestling/shows/db', err, {
      source: 'PostgreSQL:wrestling_shows',
      error: 'WRESTLING_SHOWS_DB_ERROR'
    }));
  }
}

async function buildWrestlingShowsDbStatsResponse() {
  const generated = new Date();
  const matchesArraySql = getWrestlingMatchesArraySql();
  const participantArraySql = getWrestlingParticipantsArraySql('match_item');
  const winnerArraySql = getWrestlingWinnerArraySql('match_item');
  const refereeArraySql = getWrestlingRefereesArraySql('match_item');
  const extraPeopleArraySql = getWrestlingExtraPeopleArraySql('match_item');
  const taggedPeopleArraySql = getWrestlingAllTaggedPeopleArraySql('match_item');
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
  const matchesWithExtraPeopleQuery = dbPool.query(`
    SELECT count(*)::int AS matches_with_extra_people
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    WHERE jsonb_array_length(${extraPeopleArraySql}) > 0
  `);
  const uniqueExtraPeopleQuery = dbPool.query(`
    SELECT count(DISTINCT lower(trim(extra_people_item.value)))::int AS unique_extra_people
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    CROSS JOIN LATERAL jsonb_array_elements_text(${extraPeopleArraySql}) AS extra_people_item(value)
    WHERE trim(extra_people_item.value) <> ''
  `);
  const uniqueTaggedPeopleQuery = dbPool.query(`
    SELECT count(DISTINCT lower(trim(tagged_people_item.value)))::int AS unique_tagged_people
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    CROSS JOIN LATERAL jsonb_array_elements_text(${taggedPeopleArraySql}) AS tagged_people_item(value)
    WHERE trim(tagged_people_item.value) <> ''
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
    SELECT winner_item.value AS winner, count(*)::int AS wins
    FROM wrestling_shows
    CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item
    CROSS JOIN LATERAL jsonb_array_elements_text(${winnerArraySql}) AS winner_item(value)
    WHERE trim(winner_item.value) <> ''
    GROUP BY 1
    ORDER BY wins DESC, winner ASC
    LIMIT 25
  `);
  const venueLinkingQuery = dbPool.query(`
    WITH linked AS (
      SELECT
        nullif(trim(ws.venue_id), '') AS show_venue_id,
        wv.venue_id AS matched_venue_id
      FROM wrestling_shows ws
      LEFT JOIN wrestling_venues wv
        ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
    )
    SELECT
      count(*)::int AS total_records,
      count(show_venue_id)::int AS records_with_venue_id,
      count(*) FILTER (WHERE show_venue_id IS NULL)::int AS records_missing_venue_id,
      count(matched_venue_id)::int AS valid_venue_links,
      count(*) FILTER (WHERE show_venue_id IS NOT NULL AND matched_venue_id IS NULL)::int AS invalid_venue_links,
      coalesce(
        array_agg(DISTINCT show_venue_id) FILTER (WHERE show_venue_id IS NOT NULL AND matched_venue_id IS NULL),
        '{}'::text[]
      ) AS unmatched_venue_ids
    FROM linked
  `);
  const topVenuesByRecordCountQuery = dbPool.query(`
    SELECT
      coalesce(nullif(trim(ws.venue_id), ''), '') AS venue_id,
      coalesce(nullif(trim(wv.venue_name), ''), 'Unknown') AS venue,
      count(*)::int AS record_count
    FROM wrestling_shows ws
    LEFT JOIN wrestling_venues wv
      ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
    GROUP BY 1, 2
    ORDER BY record_count DESC, venue ASC
    LIMIT 25
  `);
  const topVenueIdsQuery = dbPool.query(`
    SELECT nullif(trim(venue_id), '') AS venue_id, count(*)::int AS record_count
    FROM wrestling_shows
    WHERE nullif(trim(venue_id), '') IS NOT NULL
    GROUP BY 1
    ORDER BY record_count DESC, venue_id ASC
    LIMIT 25
  `);
  const recordsByVenueStateQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(wv.state), ''), 'Unknown') AS state, count(*)::int AS record_count
    FROM wrestling_shows ws
    LEFT JOIN wrestling_venues wv
      ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
    GROUP BY 1
    ORDER BY record_count DESC, state ASC
  `);
  const recordsByVenueRegionQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(wv.region), ''), 'Unknown') AS region, count(*)::int AS record_count
    FROM wrestling_shows ws
    LEFT JOIN wrestling_venues wv
      ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
    GROUP BY 1
    ORDER BY record_count DESC, region ASC
  `);
  const [
    totalsResult,
    uniqueParticipantsResult,
    matchesWithRefereesResult,
    uniqueRefereesResult,
    matchesWithExtraPeopleResult,
    uniqueExtraPeopleResult,
    uniqueTaggedPeopleResult,
    byPromotionResult,
    byYearResult,
    byStateResult,
    byCityResult,
    byVenueResult,
    topParticipantsResult,
    topWinnersResult,
    venueLinkingResult,
    topVenuesByRecordCountResult,
    topVenueIdsResult,
    recordsByVenueStateResult,
    recordsByVenueRegionResult
  ] = await Promise.all([
    totalsQuery,
    uniqueParticipantsQuery,
    matchesWithRefereesQuery,
    uniqueRefereesQuery,
    matchesWithExtraPeopleQuery,
    uniqueExtraPeopleQuery,
    uniqueTaggedPeopleQuery,
    byPromotionQuery,
    byYearQuery,
    byStateQuery,
    byCityQuery,
    byVenueQuery,
    topParticipantsQuery,
    topWinnersQuery,
    venueLinkingQuery,
    topVenuesByRecordCountQuery,
    topVenueIdsQuery,
    recordsByVenueStateQuery,
    recordsByVenueRegionQuery
  ]);
  const totals = totalsResult.rows && totalsResult.rows[0] ? totalsResult.rows[0] : {};
  const uniqueParticipants = uniqueParticipantsResult.rows && uniqueParticipantsResult.rows[0] ? uniqueParticipantsResult.rows[0] : {};
  const matchesWithReferees = matchesWithRefereesResult.rows && matchesWithRefereesResult.rows[0] ? matchesWithRefereesResult.rows[0] : {};
  const uniqueReferees = uniqueRefereesResult.rows && uniqueRefereesResult.rows[0] ? uniqueRefereesResult.rows[0] : {};
  const matchesWithExtraPeople = matchesWithExtraPeopleResult.rows && matchesWithExtraPeopleResult.rows[0] ? matchesWithExtraPeopleResult.rows[0] : {};
  const uniqueExtraPeople = uniqueExtraPeopleResult.rows && uniqueExtraPeopleResult.rows[0] ? uniqueExtraPeopleResult.rows[0] : {};
  const uniqueTaggedPeople = uniqueTaggedPeopleResult.rows && uniqueTaggedPeopleResult.rows[0] ? uniqueTaggedPeopleResult.rows[0] : {};
  const venueLinking = venueLinkingResult.rows && venueLinkingResult.rows[0] ? venueLinkingResult.rows[0] : {};

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
      matchesWithExtraPeople: toIntegerCount(matchesWithExtraPeople.matches_with_extra_people),
      uniqueReferees: toIntegerCount(uniqueReferees.unique_referees),
      uniqueExtraPeople: toIntegerCount(uniqueExtraPeople.unique_extra_people),
      uniqueTaggedPeople: toIntegerCount(uniqueTaggedPeople.unique_tagged_people)
    },
    byPromotion: byPromotionResult.rows.map((row) => ({ promotion: row.promotion, showsTotal: toIntegerCount(row.shows_total) })),
    byYear: byYearResult.rows.map((row) => ({ year: row.year, showsTotal: toIntegerCount(row.shows_total) })),
    byState: byStateResult.rows.map((row) => ({ state: row.state, showsTotal: toIntegerCount(row.shows_total) })),
    byCity: byCityResult.rows.map((row) => ({ city: row.city, showsTotal: toIntegerCount(row.shows_total) })),
    byVenue: byVenueResult.rows.map((row) => ({ venue: row.venue, showsTotal: toIntegerCount(row.shows_total) })),
    topParticipants: topParticipantsResult.rows.map((row) => ({ participant: row.participant, appearances: toIntegerCount(row.appearances) })),
    topWinners: topWinnersResult.rows.map((row) => ({ winner: row.winner, wins: toIntegerCount(row.wins) })),
    venue_linking: {
      total_records: toIntegerCount(venueLinking.total_records),
      records_with_venue_id: toIntegerCount(venueLinking.records_with_venue_id),
      records_missing_venue_id: toIntegerCount(venueLinking.records_missing_venue_id),
      valid_venue_links: toIntegerCount(venueLinking.valid_venue_links),
      invalid_venue_links: toIntegerCount(venueLinking.invalid_venue_links),
      unmatched_venue_ids: Array.isArray(venueLinking.unmatched_venue_ids) ? venueLinking.unmatched_venue_ids : []
    },
    top_venues_by_record_count: topVenuesByRecordCountResult.rows.map((row) => ({
      venue_id: row.venue_id || '',
      venue: row.venue,
      record_count: toIntegerCount(row.record_count)
    })),
    top_venue_ids: topVenueIdsResult.rows.map((row) => ({
      venue_id: row.venue_id || '',
      record_count: toIntegerCount(row.record_count)
    })),
    records_by_venue_state: recordsByVenueStateResult.rows.map((row) => ({
      state: row.state,
      record_count: toIntegerCount(row.record_count)
    })),
    records_by_venue_region: recordsByVenueRegionResult.rows.map((row) => ({
      region: row.region,
      record_count: toIntegerCount(row.record_count)
    }))
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
    const data = result.rows.map(buildWrestlingPersonDbApiItem);
    const pagination = buildPaginationMeta(page, limit, total, data.length);

    res.json({
      ok: true,
      source: 'db',
      type: 'wrestling_people',
      route: '/api/wrestling/people',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total: pagination.total,
        totalPages: pagination.totalPages,
        hasNextPage: pagination.hasNextPage,
        hasPrevPage: pagination.hasPrevPage
      },
      count: pagination.count,
      total: pagination.total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: pagination.totalPages,
      filters: options.filters,
      sort: options.sort,
      meta: buildListMeta({ route: '/api/wrestling/people', source: 'db', pagination, filters: options.filters, sort: options.sort }),
      data
    });
  } catch (err) {
    res.status(500).json(buildApiError('/api/wrestling/people', err, {
      source: 'db',
      type: 'wrestling_people',
      error: 'WRESTLING_PEOPLE_DB_ERROR'
    }));
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
  const latitude = toNullableNumber(row.latitude);
  const longitude = toNullableNumber(row.longitude);
  const geo = buildPhase1WrestlingVenueGeo(latitude, longitude, row.geo);

  return {
    venue_id: row.venue_id || '',
    venue_name: row.venue_name || '',
    city: row.city || '',
    state: row.state || '',
    country: row.country || '',
    region: row.region || '',
    venue_type: row.venue_type || '',
    status: row.status || '',
    latitude,
    longitude,
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
    const pagination = buildPaginationMeta(page, limit, total, items.length);

    res.json({
      ok: true,
      route: '/api/wrestling/venues/db',
      source: 'db',
      section: 'wrestling',
      type: 'venues',
      count: pagination.count,
      page,
      limit,
      total,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      filters: options.filters,
      sort: options.sort,
      meta: buildListMeta({ route: '/api/wrestling/venues/db', source: 'db', pagination, filters: options.filters, sort: options.sort }),
      items
    });
  } catch (err) {
    res.status(500).json(buildApiError('/api/wrestling/venues/db', err, {
      source: 'db',
      section: 'wrestling',
      type: 'venues',
      error: 'WRESTLING_VENUES_DB_ERROR'
    }));
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
  const venueShowTotals = venueShowTotalsResult.rows && venueShowTotalsResult.rows[0] ? venueShowTotalsResult.rows[0] : {};

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
  const bands = Array.isArray(row.bands) ? row.bands : [];
  const stats = row.stats && typeof row.stats === 'object' ? { ...row.stats } : {};
  addMusicCanonicalAliases(stats, {
    photo_count: getMusicStatsNumber(stats, ['photo_count', 'photoCount']),
    band_count: bands.length,
    artist_count: bands.length,
    people_count: 1,
    member_count: 0,
    event_count: 0,
    show_count: 0,
    set_count: 0,
    venue_count: 0
  });
  const item = {
    person_id: toIntegerCount(row.person_id),
    name: row.name || '',
    category: row.category || '',
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    bands,
    associations: Array.isArray(row.associations) ? row.associations : [],
    stats
  };
  addMusicCanonicalAliases(item, {
    photo_count: stats.photo_count,
    band_count: bands.length,
    artist_count: bands.length,
    people_count: 1,
    member_count: 0,
    event_count: 0,
    show_count: 0,
    set_count: 0,
    venue_count: 0,
    gallery_id: null,
    album_id: null,
    cover_image_url: null
  });
  return item;
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
    const pagination = buildPaginationMeta(page, limit, total, data.length);

    res.json({
      ok: true,
      route: '/api/music/people/db',
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: pagination.count,
      total,
      page,
      limit,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
      filters: options.filters,
      sort: options.sort,
      meta: buildListMeta({ route: '/api/music/people/db', source: { type: 'postgres', table: 'music_people' }, pagination, filters: options.filters, sort: options.sort }),
      stats: {
        peopleTotal: total,
        people_count: total,
        artist_count: total,
        band_count: 0,
        member_count: 0,
        photo_count: 0,
        event_count: 0,
        show_count: 0,
        set_count: 0,
        venue_count: 0
      },
      data
    });
  } catch (err) {
    res.status(500).json(buildApiError('/api/music/people/db', err, {
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      error: 'MUSIC_PEOPLE_DB_ERROR'
    }));
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
      people_count: toIntegerCount(totals.total_people),
      performersTotal: toIntegerCount(totals.total_performers),
      artist_count: toIntegerCount(totals.total_performers),
      friendsTotal: toIntegerCount(totals.total_friends),
      categoriesTotal: toIntegerCount(totals.total_categories),
      uniqueBands: toIntegerCount(uniqueBands.unique_bands),
      band_count: toIntegerCount(uniqueBands.unique_bands),
      member_count: 0,
      photo_count: 0,
      event_count: 0,
      show_count: 0,
      set_count: 0,
      venue_count: 0
    },
    topBands: topBandsResult.rows.map((row) => ({ band: row.band, peopleCount: toIntegerCount(row.people_count) })),
    topInstruments: topInstrumentsResult.rows.map((row) => ({ instrument: row.instrument, peopleCount: toIntegerCount(row.people_count) })),
    peopleByCategory: peopleByCategoryResult.rows.map((row) => ({ category: row.category, peopleCount: toIntegerCount(row.people_count) }))
  };
}

function buildMusicVenueDbApiItem(row) {
  const latitude = row.latitude == null ? toNullableNumber(row.gps_lat) : toNullableNumber(row.latitude);
  const longitude = row.longitude == null ? toNullableNumber(row.gps_lng) : toNullableNumber(row.longitude);
  const geo = buildPhase1WrestlingVenueGeo(latitude, longitude, row.geo);
  const stats = row.stats && typeof row.stats === 'object' ? { ...row.stats } : {};
  stats.showCount = row.show_count == null ? toIntegerCount(stats.showCount) : toIntegerCount(row.show_count);
  addMusicCanonicalAliases(stats, {
    show_count: stats.showCount,
    event_count: stats.showCount,
    venue_count: 1,
    photo_count: 0,
    set_count: 0,
    band_count: 0,
    artist_count: 0,
    people_count: 0
  });
  const item = {
    venue_id: row.venue_key || (row.venue_id == null ? '' : String(row.venue_id)),
    venue: row.venue || '',
    city: row.city || '',
    state: row.state || '',
    country: row.country || '',
    region: row.region || '',
    logo: row.logo || '',
    latitude,
    longitude,
    status: row.status || '',
    notes: row.notes || '',
    geo,
    description: row.description || '',
    location: {
      gps_lat: latitude == null ? '' : String(latitude),
      gps_lng: longitude == null ? '' : String(longitude)
    },
    media: {
      logo: row.logo || '',
      cover_image_url: getCanonicalNullableString(row.logo)
    },
    stats
  };
  addMusicCanonicalAliases(item, {
    show_count: stats.showCount,
    event_count: stats.showCount,
    venue_count: 1,
    photo_count: 0,
    set_count: 0,
    band_count: 0,
    artist_count: 0,
    people_count: 0,
    gallery_id: null,
    album_id: null,
    cover_image_url: row.logo
  });
  return item;
}


const MUSIC_VENUE_GEOCODE_ROUTE = '/admin/enrich/music/venues/geocode';
const MUSIC_VENUE_GEOCODE_DEFAULT_LIMIT = 5;
const MUSIC_VENUE_GEOCODE_MAX_LIMIT = 25;
const MUSIC_VENUE_GEOCODE_DELAY_MS = 1100;

function getMusicVenueGeocodeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return MUSIC_VENUE_GEOCODE_DEFAULT_LIMIT;
  return Math.min(MUSIC_VENUE_GEOCODE_MAX_LIMIT, Math.max(1, Math.trunc(number)));
}

function isMissingGeoValue(value) {
  return value == null || String(value).trim() === '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMusicVenueGeocodeProvider() {
  return String(process.env.GEOCODE_PROVIDER || '').trim().toLowerCase();
}

function getMusicVenueGeocodeConfig() {
  const provider = getMusicVenueGeocodeProvider();
  const userAgent = String(process.env.GEOCODE_USER_AGENT || '').trim();

  if (!provider) {
    return {
      ok: false,
      provider: '',
      message: 'Geocode enrichment is unavailable. Set GEOCODE_PROVIDER=nominatim and GEOCODE_USER_AGENT.'
    };
  }

  if (provider !== 'nominatim') {
    return {
      ok: false,
      provider,
      message: `Unsupported GEOCODE_PROVIDER: ${provider}. Supported provider: nominatim.`
    };
  }

  if (!userAgent) {
    return {
      ok: false,
      provider,
      message: 'GEOCODE_USER_AGENT is required when GEOCODE_PROVIDER=nominatim.'
    };
  }

  return { ok: true, provider, userAgent };
}

function buildNominatimReverseUrl(latitude, longitude) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(latitude),
    lon: String(longitude),
    addressdetails: '1'
  });
  return `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;
}

async function fetchNominatimReverseGeocode(latitude, longitude, userAgent) {
  const res = await fetch(buildNominatimReverseUrl(latitude, longitude), {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent
    }
  });

  if (!res.ok) {
    const text = await res.text();
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`Nominatim returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }

  return res.json();
}

function getNominatimAddress(json) {
  return json && json.address && typeof json.address === 'object' ? json.address : {};
}

function getNominatimCounty(address) {
  return String(address.county || address.state_district || address.region || '').trim();
}

function buildMusicVenueGeocodeFields(json) {
  const address = getNominatimAddress(json);
  return {
    formatted_address: String((json && json.display_name) || '').trim(),
    county: getNominatimCounty(address),
    postal_code: String(address.postcode || '').trim(),
    country: String(address.country || '').trim()
  };
}

function mergeMissingMusicVenueGeo(existingGeo, geocodeFields) {
  const geo = createEmptyWrestlingVenueGeo();
  const existing = existingGeo && typeof existingGeo === 'object' && !Array.isArray(existingGeo) ? existingGeo : {};
  const filled = [];

  Object.keys(geo).forEach((key) => {
    if (existing[key] != null) geo[key] = existing[key];
  });

  ['formatted_address', 'county', 'postal_code'].forEach((key) => {
    const value = String(geocodeFields[key] || '').trim();
    if (value && isMissingGeoValue(geo[key])) {
      geo[key] = value;
      filled.push(`geo.${key}`);
    }
  });

  return { geo, filled };
}

function buildMusicVenueGeocodeResult(row, status, extra = {}) {
  return {
    venue_id: row.public_venue_id || row.venue_key || (row.venue_id == null ? '' : String(row.venue_id)),
    venue: row.venue || '',
    status,
    ...extra
  };
}

async function buildMusicVenueGeocodeCandidates(limit, refresh) {
  const result = await dbPool.query(`
    SELECT
      id,
      coalesce(venue_key, venue_id::text) AS public_venue_id,
      venue_id,
      venue_key,
      venue,
      country,
      latitude,
      longitude,
      gps_lat,
      gps_lng,
      geo
    FROM music_venues
    WHERE (
      (latitude IS NOT NULL AND longitude IS NOT NULL)
      OR (trim(coalesce(gps_lat, '')) <> '' AND trim(coalesce(gps_lng, '')) <> '')
    )
      AND (
        $1::boolean
        OR trim(coalesce(geo->>'formatted_address', '')) = ''
      )
    ORDER BY venue ASC, city ASC, state ASC, id ASC
    LIMIT $2
  `, [!!refresh, limit]);

  return result.rows || [];
}

async function runMusicVenueGeocodeEnrichment(query) {
  const generated = new Date();
  const limit = getMusicVenueGeocodeLimit(query && query.limit);
  const refresh = !!(query && (query.refresh === '1' || query.force === '1'));
  const config = getMusicVenueGeocodeConfig();
  const response = {
    ok: !!config.ok,
    route: MUSIC_VENUE_GEOCODE_ROUTE,
    provider: config.provider || '',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    limit,
    refresh,
    scanned: 0,
    enriched: 0,
    skipped: 0,
    failed: 0,
    results: []
  };

  if (!config.ok) {
    response.message = config.message;
    return response;
  }

  if (!String(process.env.DATABASE_URL || '').trim()) {
    response.ok = false;
    response.message = 'Missing DATABASE_URL environment variable.';
    return response;
  }

  const candidates = await buildMusicVenueGeocodeCandidates(limit, refresh);
  response.scanned = candidates.length;
  let calls = 0;

  for (const row of candidates) {
    const latitude = row.latitude == null ? toNullableNumber(row.gps_lat) : toNullableNumber(row.latitude);
    const longitude = row.longitude == null ? toNullableNumber(row.gps_lng) : toNullableNumber(row.longitude);
    const coords = getValidWrestlingVenueCoordinates(latitude, longitude);
    const existingGeo = row.geo && typeof row.geo === 'object' && !Array.isArray(row.geo) ? row.geo : {};

    if (!coords) {
      response.skipped += 1;
      response.results.push(buildMusicVenueGeocodeResult(row, 'skipped', { reason: 'missing_coordinates' }));
      continue;
    }

    if (!refresh && !isMissingGeoValue(existingGeo.formatted_address)) {
      response.skipped += 1;
      response.results.push(buildMusicVenueGeocodeResult(row, 'skipped', { reason: 'already_enriched' }));
      continue;
    }

    if (
      refresh &&
      !isMissingGeoValue(existingGeo.formatted_address) &&
      !isMissingGeoValue(existingGeo.county) &&
      !isMissingGeoValue(existingGeo.postal_code) &&
      !isMissingGeoValue(row.country)
    ) {
      response.skipped += 1;
      response.results.push(buildMusicVenueGeocodeResult(row, 'skipped', { reason: 'already_complete' }));
      continue;
    }

    try {
      if (calls > 0) await sleep(MUSIC_VENUE_GEOCODE_DELAY_MS);
      const geocodeJson = await fetchNominatimReverseGeocode(coords.lat, coords.lon, config.userAgent);
      calls += 1;
      const fields = buildMusicVenueGeocodeFields(geocodeJson);
      const merged = mergeMissingMusicVenueGeo(existingGeo, fields);
      const filled = Array.from(merged.filled);
      const country = String(row.country || '').trim();
      const countryFromProvider = String(fields.country || '').trim();

      if (!country && countryFromProvider) filled.push('country');

      if (!filled.length) {
        response.skipped += 1;
        response.results.push(buildMusicVenueGeocodeResult(row, 'skipped', { reason: 'no_missing_fields' }));
        continue;
      }

      await dbPool.query(`
        UPDATE music_venues
        SET geo = $1::jsonb,
            country = CASE
              WHEN trim(coalesce(country, '')) = '' AND trim($2::text) <> '' THEN $2
              ELSE country
            END,
            updated_at = NOW()
        WHERE id = $3
      `, [
        stringifyDbJson(merged.geo),
        countryFromProvider,
        row.id
      ]);

      response.enriched += 1;
      response.results.push(buildMusicVenueGeocodeResult(row, 'enriched', { filled }));
    } catch (err) {
      response.failed += 1;
      response.results.push(buildMusicVenueGeocodeResult(row, 'failed', {
        error: err && err.message ? err.message : String(err)
      }));
    }
  }

  return response;
}
function buildMusicVenuesDbQueryOptions(query) {
  const values = [];
  const where = [];
  const filters = {};
  const search = String(query.search || '').trim();
  const city = String(query.city || '').trim();
  const state = String(query.state || '').trim();
  const country = String(query.country || '').trim();
  const region = String(query.region || '').trim();
  const status = String(query.status || '').trim();
  const sortFields = {
    venue_id: 'coalesce(venue_key, venue_id::text)',
    venue_key: 'venue_key',
    venue: 'venue',
    city: 'city',
    state: 'state',
    country: 'country',
    region: 'region',
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
      OR coalesce(venue_key, '') ILIKE $${idx}
      OR coalesce(city, '') ILIKE $${idx}
      OR coalesce(state, '') ILIKE $${idx}
      OR coalesce(country, '') ILIKE $${idx}
      OR coalesce(region, '') ILIKE $${idx}
      OR coalesce(status, '') ILIKE $${idx}
      OR coalesce(description, '') ILIKE $${idx}
      OR coalesce(notes, '') ILIKE $${idx}
      OR coalesce(logo, '') ILIKE $${idx}
      OR geo::text ILIKE $${idx}
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
      `SELECT
         venue_id,
         venue_key,
         venue,
         city,
         state,
         country,
         region,
         gps_lat,
         gps_lng,
         logo,
         latitude,
         longitude,
         description,
         notes,
         status,
         geo,
         location,
         media,
         stats,
         (
           SELECT count(*)::int
           FROM music_shows ms
           WHERE (
             trim(coalesce(music_venues.venue_key, '')) <> ''
             AND lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(music_venues.venue_key, '')))
           )
           OR (
             trim(coalesce(ms.venue_id, '')) = ''
             AND trim(coalesce(ms.venue, '')) <> ''
             AND lower(trim(coalesce(ms.venue, ''))) = lower(trim(coalesce(music_venues.venue, '')))
           )
         ) AS show_count
       FROM music_venues
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const data = result.rows.map(buildMusicVenueDbApiItem);
    const pagination = buildPaginationMeta(page, limit, total, data.length);

    res.json({
      ok: true,
      route: '/api/music/venues/db',
      source: {
        type: 'postgres',
        table: 'music_venues'
      },
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: pagination.count,
      total,
      page,
      limit,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
      filters: options.filters,
      sort: options.sort,
      meta: buildListMeta({ route: '/api/music/venues/db', source: { type: 'postgres', table: 'music_venues' }, pagination, filters: options.filters, sort: options.sort }),
      stats: {
        venuesTotal: total
      },
      data
    });
  } catch (err) {
    res.status(500).json(buildApiError('/api/music/venues/db', err, {
      source: {
        type: 'postgres',
        table: 'music_venues'
      },
      error: 'MUSIC_VENUES_DB_ERROR'
    }));
  }
}

async function buildMusicVenuesDbStatsResponse() {
  const generated = new Date();
  const totalsQuery = dbPool.query(`
    SELECT
      count(*)::int AS total_venues,
      count(*) FILTER (
        WHERE (latitude IS NOT NULL OR trim(coalesce(gps_lat, '')) <> '')
          AND (longitude IS NOT NULL OR trim(coalesce(gps_lng, '')) <> '')
      )::int AS venues_with_gps,
      count(*) FILTER (
        WHERE (latitude IS NULL AND trim(coalesce(gps_lat, '')) = '')
          OR (longitude IS NULL AND trim(coalesce(gps_lng, '')) = '')
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
  const byRegionQuery = dbPool.query(`
    SELECT coalesce(nullif(trim(region), ''), 'Unknown') AS region, count(*)::int AS venue_count
    FROM music_venues
    GROUP BY 1
    ORDER BY venue_count DESC, region ASC
  `);
  const venueShowTotalsQuery = dbPool.query(`
    SELECT
      count(ms.show_id)::int AS show_venue_links,
      count(DISTINCT lower(trim(mv.venue_key)))::int AS venues_with_shows
    FROM music_venues mv
    JOIN music_shows ms
      ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
    WHERE trim(coalesce(ms.venue_id, '')) <> ''
      AND trim(coalesce(mv.venue_key, '')) <> ''
  `);
  const topVenueShowCountsQuery = dbPool.query(`
    SELECT
      coalesce(mv.venue_key, mv.venue_id::text) AS venue_id,
      mv.venue,
      mv.city,
      mv.state,
      count(ms.show_id)::int AS show_count
    FROM music_venues mv
    LEFT JOIN music_shows ms
      ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
     AND trim(coalesce(ms.venue_id, '')) <> ''
    GROUP BY mv.venue_key, mv.venue_id, mv.venue, mv.city, mv.state
    HAVING count(ms.show_id) > 0
    ORDER BY show_count DESC, mv.venue ASC
    LIMIT 25
  `);
  const [
    totalsResult,
    byStateResult,
    byCityResult,
    byStatusResult,
    byRegionResult,
    venueShowTotalsResult,
    topVenueShowCountsResult
  ] = await Promise.all([
    totalsQuery,
    byStateQuery,
    byCityQuery,
    byStatusQuery,
    byRegionQuery,
    venueShowTotalsQuery,
    topVenueShowCountsQuery
  ]);
  const totals = totalsResult.rows && totalsResult.rows[0] ? totalsResult.rows[0] : {};
  const venueShowTotals = venueShowTotalsResult.rows && venueShowTotalsResult.rows[0] ? venueShowTotalsResult.rows[0] : {};

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
      venue_count: toIntegerCount(totals.total_venues),
      show_count: toIntegerCount(venueShowTotals.show_venue_links),
      event_count: toIntegerCount(venueShowTotals.show_venue_links),
      photo_count: 0,
      set_count: 0,
      band_count: 0,
      artist_count: 0,
      people_count: 0,
      venuesWithGps: toIntegerCount(totals.venues_with_gps),
      venuesMissingGps: toIntegerCount(totals.venues_missing_gps),
      venuesWithLogo: toIntegerCount(totals.venues_with_logo),
      venuesMissingLogo: toIntegerCount(totals.venues_missing_logo),
      venuesWithShows: toIntegerCount(venueShowTotals.venues_with_shows),
      showVenueLinks: toIntegerCount(venueShowTotals.show_venue_links)
    },
    venuesByState: byStateResult.rows.map((row) => ({ state: row.state, venueCount: toIntegerCount(row.venue_count) })),
    venuesByCity: byCityResult.rows.map((row) => ({ city: row.city, state: row.state, venueCount: toIntegerCount(row.venue_count) })),
    venuesByStatus: byStatusResult.rows.map((row) => ({ status: row.status, venueCount: toIntegerCount(row.venue_count) })),
    venuesByRegion: byRegionResult.rows.map((row) => ({ region: row.region, venueCount: toIntegerCount(row.venue_count) })),
    topVenuesByShowCount: topVenueShowCountsResult.rows.map((row) => ({
      venue_id: row.venue_id || '',
      venue: row.venue || '',
      city: row.city || '',
      state: row.state || '',
      showCount: toIntegerCount(row.show_count),
      show_count: toIntegerCount(row.show_count),
      event_count: toIntegerCount(row.show_count),
      venue_count: 1,
      photo_count: 0,
      set_count: 0,
      band_count: 0,
      artist_count: 0,
      people_count: 0
    }))
  };
}

function getImportLogRowsWritten(result) {
  if (!result || typeof result !== 'object') return 0;
  if (result.upserted != null) return toIntegerCount(result.upserted);
  if (result.importedRows != null) return toIntegerCount(result.importedRows);
  if (result.rowsInserted != null) return toIntegerCount(result.rowsInserted);
  if (result.imported != null) return toIntegerCount(result.imported);
  return 0;
}

function getImportHistoryRowsFetched(result) {
  if (!result || typeof result !== 'object') return 0;
  if (result.rowsFetched != null) return toIntegerCount(result.rowsFetched);
  if (result.rowsRead != null) return toIntegerCount(result.rowsRead);
  if (result.fetchedRows != null) return toIntegerCount(result.fetchedRows);
  return 0;
}

function getNullableImportCount(result, keys) {
  if (!result || typeof result !== 'object') return null;
  for (const key of keys) {
    if (result[key] != null && result[key] !== '') return toIntegerCount(result[key]);
  }
  return null;
}

function getImportHistoryRowsSkipped(result) {
  if (!result || typeof result !== 'object') return 0;
  if (result.skipped != null) return toIntegerCount(result.skipped);
  return Object.keys(result).reduce((sum, key) => {
    if (!/^skipped/i.test(key)) return sum;
    const value = Number(result[key]);
    return Number.isFinite(value) ? sum + Math.max(0, Math.trunc(value)) : sum;
  }, 0);
}

function normalizeImportHistoryArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null).map((item) => String(item));
  if (value == null || value === '') return [];
  return [String(value)];
}

function getImportHistoryWarnings(result) {
  if (!result || typeof result !== 'object') return [];
  return normalizeImportHistoryArray(result.warnings || result.warning);
}

function getImportHistoryErrors(result) {
  if (!result || typeof result !== 'object') return [];
  return normalizeImportHistoryArray(result.errors || result.error);
}

function getImportHistoryCategory(config) {
  if (config.category) return String(config.category).trim();
  const routeParts = String(config.route || '').split('/').filter(Boolean);
  return routeParts[routeParts.length - 1] || 'unknown';
}

function buildImportHistoryMeta(config, req, result) {
  const meta = {
    route: config.route,
    refresh: !!(req && req.query && req.query.refresh === '1'),
    table: result && result.table ? result.table : null,
    source_type: 'google_sheets'
  };

  if (result && typeof result === 'object') {
    [
      'rowsRead',
      'rowsFetched',
      'upserted',
      'importedRows',
      'imported',
      'rowsInserted',
      'rowsUpdated',
      'skipped',
      'matchesTotal',
      'bandsTotal',
      'peopleTotal',
      'venuesTotal',
      'duplicatesCombined',
      'generatedBandIds',
      'generatedVenueIds'
    ].forEach((key) => {
      if (result[key] != null) meta[key] = result[key];
    });
  }

  Object.keys(meta).forEach((key) => {
    if (meta[key] == null) delete meta[key];
  });

  return meta;
}

let importHistoryTableEnsured = false;
let importLocksTableEnsured = false;
let statsSnapshotsTableEnsured = false;

async function ensureImportHistoryTable() {
  if (importHistoryTableEnsured) return true;
  if (!String(process.env.DATABASE_URL || '').trim()) return false;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS import_history (
      id SERIAL PRIMARY KEY,
      section TEXT NOT NULL,
      category TEXT NOT NULL,
      source TEXT,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      import_type TEXT,
      source_identifier TEXT,
      rows_fetched INTEGER DEFAULT 0,
      rows_imported INTEGER DEFAULT 0,
      rows_inserted INTEGER DEFAULT 0,
      rows_updated INTEGER DEFAULT 0,
      rows_skipped INTEGER DEFAULT 0,
      total_rows_after_import INTEGER,
      error_message TEXT,
      warnings JSONB DEFAULT '[]'::jsonb,
      errors JSONB DEFAULT '[]'::jsonb,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await dbPool.query(`ALTER TABLE IF EXISTS import_history ADD COLUMN IF NOT EXISTS import_type TEXT`);
  await dbPool.query(`ALTER TABLE IF EXISTS import_history ADD COLUMN IF NOT EXISTS source_identifier TEXT`);
  await dbPool.query(`ALTER TABLE IF EXISTS import_history ADD COLUMN IF NOT EXISTS rows_fetched INTEGER DEFAULT 0`);
  await dbPool.query(`ALTER TABLE IF EXISTS import_history ADD COLUMN IF NOT EXISTS rows_inserted INTEGER DEFAULT 0`);
  await dbPool.query(`ALTER TABLE IF EXISTS import_history ADD COLUMN IF NOT EXISTS rows_updated INTEGER DEFAULT 0`);
  await dbPool.query(`ALTER TABLE IF EXISTS import_history ADD COLUMN IF NOT EXISTS total_rows_after_import INTEGER`);
  await dbPool.query(`ALTER TABLE IF EXISTS import_history ADD COLUMN IF NOT EXISTS error_message TEXT`);
  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS import_history_section_category_started_at_idx
      ON import_history (section, category, started_at DESC)
  `);
  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS import_history_status_started_at_idx
      ON import_history (status, started_at DESC)
  `);

  importHistoryTableEnsured = true;
  return true;
}

async function ensureImportLocksTable() {
  if (importLocksTableEnsured) return true;
  if (!String(process.env.DATABASE_URL || '').trim()) return false;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS import_locks (
      id SERIAL PRIMARY KEY,
      section TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      owner TEXT,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS import_locks_section_category_status_expires_at_idx
      ON import_locks (section, category, status, expires_at DESC)
  `);

  importLocksTableEnsured = true;
  return true;
}

async function ensureStatsSnapshotsTable() {
  if (statsSnapshotsTableEnsured) return true;
  if (!String(process.env.DATABASE_URL || '').trim()) return false;

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS stats_snapshots (
      id SERIAL PRIMARY KEY,
      section TEXT NOT NULL,
      category TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await dbPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS stats_snapshots_section_category_snapshot_key_idx
      ON stats_snapshots (section, category, snapshot_key)
  `);
  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS stats_snapshots_section_generated_at_idx
      ON stats_snapshots (section, generated_at DESC)
  `);

  statsSnapshotsTableEnsured = true;
  return true;
}

function getImportLockOwner() {
  return String(
    process.env.RENDER_SERVICE_NAME ||
    process.env.RENDER_INSTANCE_ID ||
    process.env.HOSTNAME ||
    'vmpix-v3-data'
  ).trim();
}

function getImportLockTtlMs() {
  const ttl = Number(process.env.IMPORT_LOCK_TTL_MS);
  return Number.isFinite(ttl) && ttl > 0 ? Math.max(60_000, Math.trunc(ttl)) : 30 * 60 * 1000;
}

const IMPORT_STATUS_DATASETS = Object.freeze([
  { section: 'music', category: 'bands', source: 'Music-Bands', route: '/admin/import/music/bands', table: 'music_bands' },
  { section: 'music', category: 'shows', source: 'Music-Shows', route: '/admin/import/music/shows', table: 'music_shows' },
  { section: 'music', category: 'people', source: 'Music-People', route: '/admin/import/music/people', table: 'music_people' },
  { section: 'music', category: 'venues', source: 'Music-Venue', route: '/admin/import/music/venues', table: 'music_venues' },
  { section: 'wrestling', category: 'shows', source: 'Wrestling-Matches', route: '/admin/import/wrestling/shows', table: 'wrestling_shows' },
  { section: 'wrestling', category: 'people', source: 'Wrestling-People', route: '/admin/import/wrestling/people', table: 'wrestling_people' },
  { section: 'wrestling', category: 'venues', source: 'Wrestling-Venue', route: '/admin/import/wrestling/venues', table: 'wrestling_venues' }
]);

const IMPORT_STATUS_TABLE_ALLOWLIST = new Set(IMPORT_STATUS_DATASETS.map((dataset) => dataset.table));

function getImportDatasetKey(section, category) {
  return `${String(section || '').trim().toLowerCase()}:${String(category || '').trim().toLowerCase()}`;
}

function getImportStaleWarningHours() {
  const hours = Number(process.env.IMPORT_STALE_WARNING_HOURS);
  return Number.isFinite(hours) && hours > 0 ? Math.max(1, Math.trunc(hours)) : 168;
}

async function getImportTableTotalRows(tableName) {
  const cleanTable = String(tableName || '').trim();
  if (!IMPORT_STATUS_TABLE_ALLOWLIST.has(cleanTable)) return null;

  try {
    const existingTables = await getExistingPublicTables([cleanTable]);
    if (!existingTables.has(cleanTable)) return null;
    const result = await dbPool.query(`SELECT count(*)::int AS count FROM ${cleanTable}`);
    return toIntegerCount(result.rows && result.rows[0] && result.rows[0].count);
  } catch (err) {
    console.warn(`Import table count failed for ${cleanTable}:`, err && err.message ? err.message : String(err));
    return null;
  }
}

function buildImportLockApiItem(row) {
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const expired = expiresAt ? expiresAt.getTime() <= Date.now() : false;

  return {
    id: toIntegerCount(row.id),
    section: row.section || '',
    category: row.category || '',
    status: row.status || '',
    locked_at: formatStatusTimestamp(row.locked_at),
    expires_at: formatStatusTimestamp(row.expires_at),
    owner: row.owner || '',
    active: String(row.status || '').toLowerCase() === 'running' && !expired,
    expired,
    meta: row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {},
    created_at: formatStatusTimestamp(row.created_at)
  };
}

async function acquireImportLock({ section, category, owner, meta }) {
  let client;

  try {
    const ready = await ensureImportLocksTable();
    if (!ready) return { acquired: true, bypassed: true };

    client = await dbPool.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE import_locks IN EXCLUSIVE MODE');

    await client.query(`
      UPDATE import_locks
      SET status = 'expired',
          meta = coalesce(meta, '{}'::jsonb) || $1::jsonb
      WHERE status = 'running'
        AND expires_at <= NOW()
    `, [JSON.stringify({ expiredAt: new Date().toISOString() })]);

    const activeResult = await client.query(`
      SELECT id, section, category, status, locked_at, expires_at, owner, meta, created_at
      FROM import_locks
      WHERE lower(trim(coalesce(section, ''))) = $1
        AND lower(trim(coalesce(category, ''))) = $2
        AND status = 'running'
        AND expires_at > NOW()
      ORDER BY locked_at DESC, id DESC
      LIMIT 1
    `, [section.toLowerCase(), category.toLowerCase()]);

    if (activeResult.rows && activeResult.rows[0]) {
      await client.query('ROLLBACK');
      return {
        acquired: false,
        lock: buildImportLockApiItem(activeResult.rows[0])
      };
    }

    const ttlMs = getImportLockTtlMs();
    const result = await client.query(`
      INSERT INTO import_locks (
        section,
        category,
        status,
        expires_at,
        owner,
        meta
      )
      VALUES ($1, $2, 'running', NOW() + ($3::int * INTERVAL '1 millisecond'), $4, $5::jsonb)
      RETURNING id, section, category, status, locked_at, expires_at, owner, meta, created_at
    `, [
      section,
      category,
      ttlMs,
      owner || getImportLockOwner(),
      JSON.stringify(meta && typeof meta === 'object' ? meta : {})
    ]);
    await client.query('COMMIT');

    return {
      acquired: true,
      lock: result.rows && result.rows[0] ? buildImportLockApiItem(result.rows[0]) : null
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.warn('Import lock rollback failed:', rollbackErr && rollbackErr.message ? rollbackErr.message : String(rollbackErr));
      }
    }
    console.warn('Import lock acquire failed:', err && err.message ? err.message : String(err));
    return { acquired: true, bypassed: true };
  } finally {
    if (client) client.release();
  }
}

async function releaseImportLock(id, status, meta) {
  if (!id) return null;

  try {
    const ready = await ensureImportLocksTable();
    if (!ready) return null;

    const result = await dbPool.query(`
      UPDATE import_locks
      SET status = $2,
          meta = coalesce(meta, '{}'::jsonb) || $3::jsonb
      WHERE id = $1
      RETURNING id, section, category, status, locked_at, expires_at, owner, meta, created_at
    `, [
      id,
      status || 'completed',
      JSON.stringify(meta && typeof meta === 'object' ? meta : {})
    ]);

    return result.rows && result.rows[0] ? buildImportLockApiItem(result.rows[0]) : null;
  } catch (err) {
    console.warn('Import lock release failed:', err && err.message ? err.message : String(err));
    return null;
  }
}

async function startImportHistory({ section, category, source, importType, sourceIdentifier, meta }) {
  try {
    const ready = await ensureImportHistoryTable();
    if (!ready) return null;

    const result = await dbPool.query(`
      INSERT INTO import_history (
        section,
        category,
        source,
        status,
        import_type,
        source_identifier,
        meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, started_at
    `, [
      section,
      category,
      source || null,
      'running',
      importType || 'manual',
      sourceIdentifier || source || null,
      JSON.stringify(meta && typeof meta === 'object' ? meta : {})
    ]);

    return result.rows && result.rows[0] ? result.rows[0] : null;
  } catch (err) {
    console.warn('Import history start failed:', err && err.message ? err.message : String(err));
    return null;
  }
}

async function finishImportHistory(id, details) {
  if (!id) return null;

  try {
    const ready = await ensureImportHistoryTable();
    if (!ready) return null;

    const result = await dbPool.query(`
      UPDATE import_history
      SET
        status = $2,
        finished_at = NOW(),
        duration_ms = GREATEST(0, floor(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int),
        rows_fetched = $3,
        rows_imported = $4,
        rows_inserted = $5,
        rows_updated = $6,
        rows_skipped = $7,
        total_rows_after_import = $8,
        error_message = $9,
        warnings = $10::jsonb,
        errors = $11::jsonb,
        meta = coalesce(meta, '{}'::jsonb) || $12::jsonb
      WHERE id = $1
      RETURNING id, status, duration_ms, started_at, finished_at
    `, [
      id,
      details.status || 'success',
      toIntegerCount(details.rowsFetched),
      toIntegerCount(details.rowsImported),
      details.rowsInserted == null ? null : toIntegerCount(details.rowsInserted),
      details.rowsUpdated == null ? null : toIntegerCount(details.rowsUpdated),
      toIntegerCount(details.rowsSkipped),
      details.totalRowsAfterImport == null ? null : toIntegerCount(details.totalRowsAfterImport),
      details.errorMessage || null,
      JSON.stringify(normalizeImportHistoryArray(details.warnings)),
      JSON.stringify(normalizeImportHistoryArray(details.errors)),
      JSON.stringify(details.meta && typeof details.meta === 'object' ? details.meta : {})
    ]);

    return result.rows && result.rows[0] ? {
      id: result.rows[0].id,
      status: result.rows[0].status,
      duration_ms: toIntegerCount(result.rows[0].duration_ms)
    } : null;
  } catch (err) {
    console.warn('Import history finish failed:', err && err.message ? err.message : String(err));
    return null;
  }
}

function getImportSyncStatus(status) {
  const clean = String(status || '').trim().toLowerCase();
  if (clean === 'success') return 'healthy';
  if (clean === 'warning') return 'warning';
  if (clean === 'failed' || clean === 'error') return 'failed';
  return 'unknown';
}

function buildImportHistoryApiItem(row) {
  const meta = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
  const errors = Array.isArray(row.errors) ? row.errors : [];
  const errorMessage = row.error_message || errors[0] || '';

  return {
    id: toIntegerCount(row.id),
    dataset: `${row.section || ''}.${row.category || ''}`,
    section: row.section || '',
    category: row.category || '',
    source: row.source || '',
    source_identifier: row.source_identifier || '',
    import_type: row.import_type || '',
    status: row.status || '',
    sync_health: getImportSyncStatus(row.status),
    started_at: formatStatusTimestamp(row.started_at),
    startedAt: formatStatusTimestamp(row.started_at),
    finished_at: formatStatusTimestamp(row.finished_at),
    finishedAt: formatStatusTimestamp(row.finished_at),
    duration_ms: row.duration_ms == null ? null : toIntegerCount(row.duration_ms),
    duration: row.duration_ms == null ? null : `${toIntegerCount(row.duration_ms)}ms`,
    rows_fetched: toIntegerCount(row.rows_fetched),
    rows_imported: toIntegerCount(row.rows_imported),
    rows_inserted: row.rows_inserted == null ? null : toIntegerCount(row.rows_inserted),
    rows_updated: row.rows_updated == null ? null : toIntegerCount(row.rows_updated),
    rows_skipped: toIntegerCount(row.rows_skipped),
    total_rows_after_import: row.total_rows_after_import == null ? null : toIntegerCount(row.total_rows_after_import),
    refresh: !!meta.refresh,
    error_message: errorMessage,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    errors,
    meta,
    created_at: formatStatusTimestamp(row.created_at)
  };
}

function buildImportHistoryQueryOptions(query, fixedSection) {
  const values = [];
  const where = [];
  const filters = {};
  const section = fixedSection || String(query.section || '').trim();
  const category = String(query.category || '').trim();
  const status = String(query.status || '').trim();

  if (section) {
    values.push(section.toLowerCase());
    where.push(`lower(trim(coalesce(section, ''))) = $${values.length}`);
    filters.section = section;
  }

  if (category) {
    values.push(category.toLowerCase());
    where.push(`lower(trim(coalesce(category, ''))) = $${values.length}`);
    filters.category = category;
  }

  if (status) {
    values.push(status.toLowerCase());
    where.push(`lower(trim(coalesce(status, ''))) = $${values.length}`);
    filters.status = status;
  }

  return {
    values,
    filters,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : ''
  };
}

async function handleImportHistoryRequest(req, res, fixedSection) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    await ensureImportHistoryTable();

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const options = buildImportHistoryQueryOptions(req.query, fixedSection);
    const countResult = await dbPool.query(
      `SELECT count(*)::int AS total FROM import_history ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `SELECT
         id,
         section,
         category,
         source,
         status,
         started_at,
         finished_at,
         duration_ms,
         import_type,
         source_identifier,
         rows_fetched,
         rows_imported,
         rows_inserted,
         rows_updated,
         rows_skipped,
         total_rows_after_import,
         error_message,
         warnings,
         errors,
         meta,
         created_at
       FROM import_history
       ${options.whereSql}
       ORDER BY started_at DESC NULLS LAST, id DESC
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const pagination = buildPaginationMeta(page, limit, total, result.rows.length);

    res.json({
      ok: true,
      route: fixedSection ? `/api/admin/import-history/${fixedSection}` : '/api/admin/import-history',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      section: fixedSection || undefined,
      count: pagination.count,
      total,
      page,
      limit,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
      filters: options.filters,
      meta: buildListMeta({ route: fixedSection ? `/api/admin/import-history/${fixedSection}` : '/api/admin/import-history', source: 'postgres', pagination, filters: options.filters }),
      items: result.rows.map(buildImportHistoryApiItem)
    });
  } catch (err) {
    res.status(500).json(buildApiError(
      fixedSection ? `/api/admin/import-history/${fixedSection}` : '/api/admin/import-history',
      err,
      {
        source: 'postgres',
        section: fixedSection || 'admin',
        type: 'import-history',
        error: 'IMPORT_HISTORY_ERROR'
      }
    ));
  }
}

async function buildLatestImportHistoryItems(section) {
  const values = [];
  const where = [];

  if (section) {
    values.push(section.toLowerCase());
    where.push(`lower(trim(coalesce(section, ''))) = $${values.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await dbPool.query(
    `SELECT DISTINCT ON (section, category)
       id,
       section,
       category,
       source,
       status,
       started_at,
       finished_at,
       duration_ms,
       import_type,
       source_identifier,
       rows_fetched,
       rows_imported,
       rows_inserted,
       rows_updated,
       rows_skipped,
       total_rows_after_import,
       error_message,
       jsonb_array_length(CASE WHEN jsonb_typeof(warnings) = 'array' THEN warnings ELSE '[]'::jsonb END)::int AS warnings_count,
       jsonb_array_length(CASE WHEN jsonb_typeof(errors) = 'array' THEN errors ELSE '[]'::jsonb END)::int AS errors_count
     FROM import_history
     ${whereSql}
     ORDER BY section, category, started_at DESC NULLS LAST, id DESC`,
    values
  );

  return result.rows.map((row) => ({
    id: toIntegerCount(row.id),
    section: row.section || '',
    category: row.category || '',
    source: row.source || '',
    source_identifier: row.source_identifier || '',
    import_type: row.import_type || '',
    status: row.status || '',
    sync_health: getImportSyncStatus(row.status),
    started_at: formatStatusTimestamp(row.started_at),
    startedAt: formatStatusTimestamp(row.started_at),
    finished_at: formatStatusTimestamp(row.finished_at),
    finishedAt: formatStatusTimestamp(row.finished_at),
    duration_ms: row.duration_ms == null ? null : toIntegerCount(row.duration_ms),
    rows_fetched: toIntegerCount(row.rows_fetched),
    rows_imported: toIntegerCount(row.rows_imported),
    rows_inserted: row.rows_inserted == null ? null : toIntegerCount(row.rows_inserted),
    rows_updated: row.rows_updated == null ? null : toIntegerCount(row.rows_updated),
    rows_skipped: toIntegerCount(row.rows_skipped),
    total_rows_after_import: row.total_rows_after_import == null ? null : toIntegerCount(row.total_rows_after_import),
    error_message: row.error_message || '',
    warnings_count: toIntegerCount(row.warnings_count),
    errors_count: toIntegerCount(row.errors_count)
  }));
}

async function handleLatestImportHistoryRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    await ensureImportHistoryTable();
    const generated = new Date();
    res.json({
      ok: true,
      route: '/api/admin/import-history/latest',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      items: await buildLatestImportHistoryItems()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/admin/import-history/latest',
      error: err && err.message ? err.message : String(err)
    });
  }
}

function createEmptyImportHealth() {
  return {
    ok: true,
    latestImports: [],
    failingImportsLast24h: 0,
    warningImportsLast24h: 0,
    lastSuccessfulImportAt: null,
    lastFailedImportAt: null,
    latestFailureReason: null,
    staleWarnings: []
  };
}

async function buildImportHealth(section) {
  const health = createEmptyImportHealth();

  try {
    if (!String(process.env.DATABASE_URL || '').trim()) return health;

    const existingTables = await getExistingPublicTables(['import_history']);
    if (!existingTables.has('import_history')) return health;

    const values = [];
    const where = [];
    const sectionFilter = String(section || '').trim();
    if (sectionFilter) {
      values.push(sectionFilter.toLowerCase());
      where.push(`lower(trim(coalesce(section, ''))) = $${values.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const latestItems = await buildLatestImportHistoryItems(sectionFilter || null);
    const statusResult = await dbPool.query(
      `SELECT
         count(*) FILTER (
           WHERE lower(trim(coalesce(status, ''))) IN ('failed', 'error')
             AND started_at >= NOW() - INTERVAL '24 hours'
         )::int AS failing_imports_last_24h,
         count(*) FILTER (
           WHERE lower(trim(coalesce(status, ''))) = 'warning'
             AND started_at >= NOW() - INTERVAL '24 hours'
         )::int AS warning_imports_last_24h,
         max(finished_at) FILTER (WHERE lower(trim(coalesce(status, ''))) = 'success') AS last_successful_import_at,
         max(finished_at) FILTER (WHERE lower(trim(coalesce(status, ''))) IN ('failed', 'error')) AS last_failed_import_at
       FROM import_history
       ${whereSql}`,
      values
    );
    const status = statusResult.rows && statusResult.rows[0] ? statusResult.rows[0] : {};
    const failureResult = await dbPool.query(
      `SELECT error_message, errors
       FROM import_history
       ${whereSql ? `${whereSql} AND` : 'WHERE'} lower(trim(coalesce(status, ''))) IN ('failed', 'error')
       ORDER BY started_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      values
    );
    const failure = failureResult.rows && failureResult.rows[0] ? failureResult.rows[0] : {};
    const failureErrors = Array.isArray(failure.errors) ? failure.errors : [];

    health.latestImports = latestItems;
    health.failingImportsLast24h = toIntegerCount(status.failing_imports_last_24h);
    health.warningImportsLast24h = toIntegerCount(status.warning_imports_last_24h);
    health.lastSuccessfulImportAt = formatStatusTimestamp(status.last_successful_import_at) || null;
    health.lastFailedImportAt = formatStatusTimestamp(status.last_failed_import_at) || null;
    health.latestFailureReason = failure.error_message || failureErrors[0] || null;
    return health;
  } catch (err) {
    console.warn('Import health read failed:', err && err.message ? err.message : String(err));
    return health;
  }
}

function getImportHistoryStatusSelect() {
  return `
    id,
    section,
    category,
    source,
    status,
    started_at,
    finished_at,
    duration_ms,
    import_type,
    source_identifier,
    rows_fetched,
    rows_imported,
    rows_inserted,
    rows_updated,
    rows_skipped,
    total_rows_after_import,
    error_message,
    warnings,
    errors,
    meta,
    created_at
  `;
}

function buildImportStatusHistoryWhere(section) {
  const values = [];
  const where = [];
  const sectionFilter = String(section || '').trim().toLowerCase();

  if (sectionFilter) {
    values.push(sectionFilter);
    where.push(`lower(trim(coalesce(section, ''))) = $${values.length}`);
  }

  return {
    values,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : ''
  };
}

async function getDistinctImportHistoryItems(section, statusFilter) {
  const options = buildImportStatusHistoryWhere(section);
  const values = options.values.slice();
  const where = options.whereSql ? [options.whereSql.replace(/^WHERE\s+/i, '')] : [];

  if (Array.isArray(statusFilter) && statusFilter.length) {
    values.push(statusFilter.map((status) => String(status).trim().toLowerCase()).filter(Boolean));
    where.push(`lower(trim(coalesce(status, ''))) = ANY($${values.length}::text[])`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await dbPool.query(`
    SELECT DISTINCT ON (section, category)
      ${getImportHistoryStatusSelect()}
    FROM import_history
    ${whereSql}
    ORDER BY section, category, started_at DESC NULLS LAST, id DESC
  `, values);

  return result.rows.map(buildImportHistoryApiItem);
}

async function getRecentImportHistoryItems(section, limit = 25) {
  const options = buildImportStatusHistoryWhere(section);
  const values = options.values.concat([Math.min(100, Math.max(1, toIntegerCount(limit) || 25))]);
  const limitIdx = values.length;
  const result = await dbPool.query(`
    SELECT ${getImportHistoryStatusSelect()}
    FROM import_history
    ${options.whereSql}
    ORDER BY started_at DESC NULLS LAST, id DESC
    LIMIT $${limitIdx}
  `, values);

  return result.rows.map(buildImportHistoryApiItem);
}

function getImportStatusFromLatest(latest, stale) {
  if (!latest) return 'unknown';
  const health = getImportSyncStatus(latest.status);
  if (health === 'failed') return 'failed';
  if (health === 'warning' || stale) return 'warning';
  if (health === 'healthy') return 'healthy';
  return 'unknown';
}

function getImportItemTimeMs(item, key) {
  if (!item || !item[key]) return null;
  const time = new Date(item[key]).getTime();
  return Number.isNaN(time) ? null : time;
}

function getLatestImportFailureReason(item) {
  if (!item) return null;
  if (item.error_message) return item.error_message;
  if (Array.isArray(item.errors) && item.errors[0]) return item.errors[0];
  return null;
}

async function buildImportStatusReport(section) {
  const generated = new Date();
  const warnings = [];
  const errors = [];
  const requestedSection = String(section || '').trim().toLowerCase();
  const datasets = IMPORT_STATUS_DATASETS.filter((dataset) => !requestedSection || dataset.section === requestedSection);
  const staleWarningHours = getImportStaleWarningHours();
  const staleMs = staleWarningHours * 60 * 60 * 1000;
  const report = {
    ok: true,
    route: requestedSection ? `/api/admin/status/imports?section=${requestedSection}` : '/api/admin/status/imports',
    source: 'postgres',
    section: requestedSection || 'admin',
    type: 'import-status',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    database: {
      connected: false
    },
    summary: {
      overallStatus: 'unknown',
      datasetsTotal: datasets.length,
      healthy: 0,
      warning: 0,
      failed: 0,
      unknown: 0,
      stale: 0,
      lastImportAt: null,
      lastSuccessfulImportAt: null,
      lastFailedImportAt: null
    },
    stale: {
      thresholdHours: staleWarningHours,
      warnings: []
    },
    modules: {},
    rowCounts: {},
    recentHistory: [],
    warnings,
    errors
  };

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Missing DATABASE_URL environment variable.');
    return report;
  }

  try {
    await dbPool.query('SELECT 1');
    report.database.connected = true;
  } catch (err) {
    errors.push(`Database disconnected: ${err && err.message ? err.message : String(err)}`);
    report.summary.overallStatus = 'failed';
    return report;
  }

  await ensureImportHistoryTable();

  const tableNames = datasets.map((dataset) => dataset.table).concat(['import_history']);
  const existingTables = await getExistingPublicTables(tableNames);
  const latestItems = await getDistinctImportHistoryItems(requestedSection || null);
  const latestSuccessItems = await getDistinctImportHistoryItems(requestedSection || null, ['success', 'warning']);
  const latestFailureItems = await getDistinctImportHistoryItems(requestedSection || null, ['failed', 'error']);
  const latestByDataset = new Map(latestItems.map((item) => [getImportDatasetKey(item.section, item.category), item]));
  const successByDataset = new Map(latestSuccessItems.map((item) => [getImportDatasetKey(item.section, item.category), item]));
  const failureByDataset = new Map(latestFailureItems.map((item) => [getImportDatasetKey(item.section, item.category), item]));
  let lastImportMs = null;
  let lastSuccessMs = null;
  let lastFailureMs = null;

  for (const dataset of datasets) {
    const key = getImportDatasetKey(dataset.section, dataset.category);
    const tableExists = existingTables.has(dataset.table);
    const rowCount = tableExists ? await getImportTableTotalRows(dataset.table) : null;
    const latest = latestByDataset.get(key) || null;
    const latestSuccess = successByDataset.get(key) || null;
    const latestFailure = failureByDataset.get(key) || null;
    const successTimeMs = getImportItemTimeMs(latestSuccess, 'finishedAt') || getImportItemTimeMs(latestSuccess, 'startedAt');
    const latestTimeMs = getImportItemTimeMs(latest, 'finishedAt') || getImportItemTimeMs(latest, 'startedAt');
    const failureTimeMs = getImportItemTimeMs(latestFailure, 'finishedAt') || getImportItemTimeMs(latestFailure, 'startedAt');
    const stale = !latestSuccess || (successTimeMs != null && generated.getTime() - successTimeMs > staleMs);
    const status = getImportStatusFromLatest(latest, stale);
    const staleReason = !latestSuccess
      ? 'No successful import history found.'
      : (stale ? `Last successful import is older than ${staleWarningHours} hours.` : '');
    const item = {
      dataset: `${dataset.section}.${dataset.category}`,
      section: dataset.section,
      category: dataset.category,
      source: dataset.source,
      route: dataset.route,
      table: dataset.table,
      tableExists,
      rowCount,
      status,
      stale,
      staleReason,
      latestImport: latest,
      lastSuccessfulImportAt: latestSuccess ? latestSuccess.finishedAt || latestSuccess.startedAt || null : null,
      lastFailedImportAt: latestFailure ? latestFailure.finishedAt || latestFailure.startedAt || null : null,
      latestFailureReason: getLatestImportFailureReason(latestFailure)
    };

    if (!tableExists) {
      warnings.push(`Missing data table for import status: ${dataset.table}`);
    }
    if (stale) {
      report.stale.warnings.push({
        dataset: item.dataset,
        reason: staleReason
      });
    }

    report.modules[item.dataset] = item;
    report.rowCounts[item.dataset] = rowCount;
    report.summary[status] += 1;
    if (stale) report.summary.stale += 1;
    if (latestTimeMs != null) lastImportMs = lastImportMs == null ? latestTimeMs : Math.max(lastImportMs, latestTimeMs);
    if (successTimeMs != null) lastSuccessMs = lastSuccessMs == null ? successTimeMs : Math.max(lastSuccessMs, successTimeMs);
    if (failureTimeMs != null) lastFailureMs = lastFailureMs == null ? failureTimeMs : Math.max(lastFailureMs, failureTimeMs);
  }

  report.summary.lastImportAt = lastImportMs == null ? null : new Date(lastImportMs).toISOString();
  report.summary.lastSuccessfulImportAt = lastSuccessMs == null ? null : new Date(lastSuccessMs).toISOString();
  report.summary.lastFailedImportAt = lastFailureMs == null ? null : new Date(lastFailureMs).toISOString();
  report.summary.overallStatus = report.summary.failed > 0
    ? 'failed'
    : (report.summary.warning > 0 || report.summary.stale > 0 ? 'warning' : (report.summary.unknown > 0 ? 'unknown' : 'healthy'));
  report.recentHistory = await getRecentImportHistoryItems(requestedSection || null, 25);

  return report;
}

async function buildAdminStatusResponse() {
  const generated = new Date();
  const importStatus = await buildImportStatusReport();
  const importHealth = await buildImportHealth();
  const lockHealth = await buildLockHealth();
  const warnings = uniqueAdminWarnings((importStatus.warnings || []).concat(importStatus.stale && importStatus.stale.warnings
    ? importStatus.stale.warnings.map((item) => `${item.dataset}: ${item.reason}`)
    : []));
  const errors = Array.isArray(importStatus.errors) ? importStatus.errors : [];
  const overallStatus = errors.length > 0
    ? 'failed'
    : (importStatus.summary.overallStatus === 'failed' ? 'failed' : (warnings.length > 0 || importStatus.summary.overallStatus === 'warning' ? 'warning' : importStatus.summary.overallStatus));

  return buildAdminResponse({
    route: '/api/admin/status',
    generated,
    source: 'postgres',
    section: 'admin',
    type: 'status',
    backend: {
      service: 'VMPix-V3 Data',
      status: overallStatus
    },
    database: importStatus.database,
    summary: {
      overallStatus,
      imports: importStatus.summary,
      activeLocks: lockHealth.activeLocks,
      staleLocks: lockHealth.staleLocks
    },
    adminProtection: getAdminProtectionStatus(),
    importHealth,
    lockHealth,
    importStatus,
    rowCounts: importStatus.rowCounts,
    warnings,
    errors
  });
}

async function handleAdminStatusRequest(req, res) {
  try {
    res.json(await buildAdminStatusResponse());
  } catch (err) {
    res.status(500).json(buildAdminError('/api/admin/status', err, {
      source: 'postgres',
      section: 'admin',
      type: 'status'
    }));
  }
}

async function handleAdminImportStatusRequest(req, res, routeOverride) {
  try {
    const report = await buildImportStatusReport(req.query.section);
    report.route = routeOverride || report.route;
    res.json(report);
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: routeOverride || '/api/admin/status/imports',
      source: 'postgres',
      section: 'admin',
      type: 'import-status',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function handleImportDiagnosticsRequest(req, res) {
  try {
    const report = await buildImportStatusReport(req.query.section);
    report.route = '/api/admin/diagnostics/imports';
    report.type = 'import-diagnostics';
    report.diagnostics = {
      staleWarnings: report.stale.warnings,
      failedDatasets: Object.values(report.modules).filter((item) => item.status === 'failed'),
      unknownDatasets: Object.values(report.modules).filter((item) => item.status === 'unknown')
    };
    res.json(report);
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/admin/diagnostics/imports',
      source: 'postgres',
      section: 'admin',
      type: 'import-diagnostics',
      error: err && err.message ? err.message : String(err)
    });
  }
}

function createEmptyLockHealth() {
  return {
    ok: true,
    activeLocks: 0,
    staleLocks: 0,
    items: []
  };
}

function buildImportLockQueryOptions(query, fixedSection) {
  const values = [];
  const where = [];
  const filters = {};
  const section = fixedSection || String(query.section || '').trim();
  const category = String(query.category || '').trim();
  const status = String(query.status || '').trim();

  if (section) {
    values.push(section.toLowerCase());
    where.push(`lower(trim(coalesce(section, ''))) = $${values.length}`);
    filters.section = section;
  }

  if (category) {
    values.push(category.toLowerCase());
    where.push(`lower(trim(coalesce(category, ''))) = $${values.length}`);
    filters.category = category;
  }

  if (status) {
    values.push(status.toLowerCase());
    where.push(`lower(trim(coalesce(status, ''))) = $${values.length}`);
    filters.status = status;
  }

  return {
    values,
    filters,
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : ''
  };
}

async function handleImportLocksRequest(req, res, fixedSection) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    await ensureImportLocksTable();

    const generated = new Date();
    const limit = getClampedLimit(req.query.limit);
    const options = buildImportLockQueryOptions(req.query, fixedSection);
    const values = options.values.concat([limit]);
    const limitIdx = values.length;
    const result = await dbPool.query(
      `SELECT id, section, category, status, locked_at, expires_at, owner, meta, created_at
       FROM import_locks
       ${options.whereSql}
       ORDER BY
         CASE WHEN status = 'running' AND expires_at > NOW() THEN 0 ELSE 1 END,
         locked_at DESC,
         id DESC
       LIMIT $${limitIdx}`,
      values
    );

    res.json({
      ok: true,
      route: fixedSection ? `/api/admin/import-locks/${fixedSection}` : '/api/admin/import-locks',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: result.rows.length,
      filters: options.filters,
      items: result.rows.map(buildImportLockApiItem)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: fixedSection ? `/api/admin/import-locks/${fixedSection}` : '/api/admin/import-locks',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function buildLockHealth(section) {
  const health = createEmptyLockHealth();

  try {
    if (!String(process.env.DATABASE_URL || '').trim()) return health;

    const existingTables = await getExistingPublicTables(['import_locks']);
    if (!existingTables.has('import_locks')) return health;

    const values = [];
    const where = [];
    const sectionFilter = String(section || '').trim();
    if (sectionFilter) {
      values.push(sectionFilter.toLowerCase());
      where.push(`lower(trim(coalesce(section, ''))) = $${values.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await dbPool.query(
      `SELECT
         count(*) FILTER (WHERE status = 'running' AND expires_at > NOW())::int AS active_locks,
         count(*) FILTER (WHERE status = 'running' AND expires_at <= NOW())::int AS stale_locks
       FROM import_locks
       ${whereSql}`,
      values
    );
    const counts = countResult.rows && countResult.rows[0] ? countResult.rows[0] : {};
    const itemResult = await dbPool.query(
      `SELECT id, section, category, status, locked_at, expires_at, owner, meta, created_at
       FROM import_locks
       ${whereSql}
       ORDER BY
         CASE WHEN status = 'running' AND expires_at > NOW() THEN 0 ELSE 1 END,
         locked_at DESC,
         id DESC
       LIMIT 25`,
      values
    );

    health.activeLocks = toIntegerCount(counts.active_locks);
    health.staleLocks = toIntegerCount(counts.stale_locks);
    health.items = itemResult.rows.map(buildImportLockApiItem);
    return health;
  } catch (err) {
    console.warn('Import lock health read failed:', err && err.message ? err.message : String(err));
    return health;
  }
}

const RELATIONSHIP_TABLES = [
  'music_bands',
  'music_shows',
  'music_people',
  'music_venues',
  'wrestling_shows',
  'wrestling_people',
  'wrestling_venues'
];

function buildRelationshipItem({ section, type, severity, code, message, entity_id, entity_name, details }) {
  return {
    section,
    type,
    severity,
    code,
    message,
    entity_id: entity_id == null ? '' : String(entity_id),
    entity_name: entity_name == null ? '' : String(entity_name),
    details: details && typeof details === 'object' ? details : {}
  };
}

function summarizeRelationshipItems(items) {
  return (items || []).reduce((summary, item) => {
    const severity = String(item && item.severity || '').toLowerCase();
    if (severity === 'error') summary.errors += 1;
    else if (severity === 'warning') summary.warnings += 1;
    else summary.info += 1;
    return summary;
  }, { errors: 0, warnings: 0, info: 0 });
}

function getRelationshipOverallHealth(summary, unknown) {
  if (unknown) return 'unknown';
  if (toIntegerCount(summary.errors) > 0) return 'failed';
  if (toIntegerCount(summary.warnings) > 0) return 'warning';
  return 'healthy';
}

function getRelationshipLimit(value) {
  const limit = Number(String(value || '').trim());
  if (!Number.isInteger(limit)) return 100;
  return Math.min(100, Math.max(1, limit));
}

async function runRelationshipQuery(warnings, label, sql, params = []) {
  try {
    return await dbPool.query(sql, params);
  } catch (err) {
    warnings.push(`Unable to check ${label}: ${err && err.message ? err.message : String(err)}`);
    return { rows: [] };
  }
}

function relationshipHasTable(existingTables, tableName, warnings) {
  if (existingTables.has(tableName)) return true;
  warnings.push(`Missing table for relationship checks: ${tableName}`);
  return false;
}

function relationshipHasColumns(columnsByTable, tableName, columnNames, warnings) {
  return warnMissingDiagnosticColumns(columnsByTable, tableName, columnNames, warnings);
}

function buildRelationshipPeopleLookupSql(tableName, options = {}) {
  const unions = [
    `SELECT lower(trim(name)) AS lookup_key FROM ${tableName} WHERE trim(coalesce(name, '')) <> ''`
  ];

  if (options.aliases) {
    unions.push(`
      SELECT lower(trim(alias_item.value)) AS lookup_key
      FROM ${tableName}
      CROSS JOIN LATERAL unnest(coalesce(aliases, '{}'::text[])) AS alias_item(value)
      WHERE trim(alias_item.value) <> ''
    `);
  }

  if (options.teams) {
    unions.push(`
      SELECT lower(trim(team_item.value)) AS lookup_key
      FROM ${tableName}
      CROSS JOIN LATERAL unnest(coalesce(teams, '{}'::text[])) AS team_item(value)
      WHERE trim(team_item.value) <> ''
    `);
  }

  return unions.join(' UNION ');
}

async function addMusicRelationshipIssues(items, warnings, existingTables, columnsByTable) {
  if (
    relationshipHasTable(existingTables, 'music_shows', warnings) &&
    relationshipHasColumns(columnsByTable, 'music_shows', ['venue_id'], warnings)
  ) {
    const missingVenueIdResult = await runRelationshipQuery(
      warnings,
      'music shows missing venue_id',
      `SELECT show_id, name, date, venue
       FROM music_shows
       WHERE trim(coalesce(venue_id::text, '')) = ''
       ORDER BY show_id ASC
       LIMIT 1000`
    );
    diagnosticRows(missingVenueIdResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'shows',
        severity: 'error',
        code: 'MISSING_VENUE_ID',
        message: 'Music show is missing venue_id.',
        entity_id: row.show_id,
        entity_name: row.name,
        details: { date: row.date || '', venue: row.venue || '' }
      }));
    });
  }

  if (
    existingTables.has('music_shows') &&
    existingTables.has('music_venues') &&
    relationshipHasColumns(columnsByTable, 'music_shows', ['venue_id'], warnings) &&
    relationshipHasColumns(columnsByTable, 'music_venues', ['venue_key'], warnings)
  ) {
    const invalidVenueIdResult = await runRelationshipQuery(
      warnings,
      'music shows with invalid venue_id',
      `SELECT ms.show_id, ms.name, ms.date, ms.venue_id, ms.venue
       FROM music_shows ms
       LEFT JOIN music_venues mv
         ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
       WHERE trim(coalesce(ms.venue_id::text, '')) <> ''
         AND mv.venue_key IS NULL
       ORDER BY ms.show_id ASC
       LIMIT 1000`
    );
    diagnosticRows(invalidVenueIdResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'shows',
        severity: 'error',
        code: 'INVALID_VENUE_ID',
        message: 'Music show references a venue_id that does not exist in music_venues.',
        entity_id: row.show_id,
        entity_name: row.name,
        details: { venue_id: row.venue_id == null ? '' : String(row.venue_id), venue: row.venue || '', date: row.date || '' }
      }));
    });
  }

  if (relationshipHasTable(existingTables, 'music_venues', warnings)) {
    if (relationshipHasColumns(columnsByTable, 'music_venues', ['venue_key'], warnings)) {
      const missingVenueKeyResult = await runRelationshipQuery(
        warnings,
        'music venues missing public venue_id',
        `SELECT venue_id, venue_key, venue, city, state
         FROM music_venues
         WHERE trim(coalesce(venue_key, '')) = ''
         ORDER BY venue ASC
         LIMIT 1000`
      );
      diagnosticRows(missingVenueKeyResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'music',
          type: 'venues',
          severity: 'error',
          code: 'MISSING_VENUE_ID',
          message: 'Music venue is missing public venue_id/venue_key.',
          entity_id: row.venue_id,
          entity_name: row.venue,
          details: { venue_key: row.venue_key || '', city: row.city || '', state: row.state || '' }
        }));
      });

      const duplicateVenueKeyResult = await runRelationshipQuery(
        warnings,
        'duplicate music venue ids',
        `SELECT lower(trim(venue_key)) AS venue_key_normalized, min(venue_key) AS venue_key, count(*)::int AS count, array_agg(venue_id::text ORDER BY venue_id) AS venue_ids
         FROM music_venues
         WHERE trim(coalesce(venue_key, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
         ORDER BY count DESC, venue_key ASC
         LIMIT 1000`
      );
      diagnosticRows(duplicateVenueKeyResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'music',
          type: 'venues',
          severity: 'warning',
          code: 'DUPLICATE_VENUE_ID',
          message: 'Duplicate music venue_id/venue_key detected.',
          entity_id: row.venue_key,
          entity_name: row.venue_key,
          details: { count: toIntegerCount(row.count), venue_ids: Array.isArray(row.venue_ids) ? row.venue_ids : [] }
        }));
      });

      if (
        existingTables.has('music_shows') &&
        relationshipHasColumns(columnsByTable, 'music_shows', ['venue_id'], warnings)
      ) {
        const orphanedVenueResult = await runRelationshipQuery(
          warnings,
          'music venues without linked shows',
          `SELECT mv.venue_id, mv.venue_key, mv.venue, mv.city, mv.state
           FROM music_venues mv
           LEFT JOIN music_shows ms
             ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
           WHERE trim(coalesce(mv.venue_key, '')) <> ''
             AND ms.show_id IS NULL
           ORDER BY mv.venue ASC
           LIMIT 1000`
        );
        diagnosticRows(orphanedVenueResult).forEach((row) => {
          items.push(buildRelationshipItem({
            section: 'music',
            type: 'venues',
            severity: 'info',
            code: 'ORPHANED_VENUE_NO_SHOWS',
            message: 'Music venue has no linked music shows yet.',
            entity_id: row.venue_key || row.venue_id,
            entity_name: row.venue,
            details: { venue_id: row.venue_key || '', city: row.city || '', state: row.state || '' }
          }));
        });
      }
    }

    if (relationshipHasColumns(columnsByTable, 'music_venues', ['venue'], warnings)) {
      const duplicateVenueResult = await runRelationshipQuery(
        warnings,
        'duplicate music venue names',
        `SELECT lower(trim(venue)) AS name_key, min(venue) AS venue, count(*)::int AS count, array_agg(venue_id::text ORDER BY venue_id) AS venue_ids
         FROM music_venues
         WHERE trim(coalesce(venue, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
         ORDER BY count DESC, venue ASC
         LIMIT 1000`
      );
      diagnosticRows(duplicateVenueResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'music',
          type: 'venues',
          severity: 'warning',
          code: 'DUPLICATE_NAME',
          message: 'Duplicate music venue name detected.',
          entity_id: Array.isArray(row.venue_ids) ? row.venue_ids[0] : '',
          entity_name: row.venue,
          details: { count: toIntegerCount(row.count), venue_ids: Array.isArray(row.venue_ids) ? row.venue_ids : [] }
        }));
      });
    }

    if (relationshipHasColumns(columnsByTable, 'music_venues', ['city', 'state'], warnings)) {
      const missingLocationResult = await runRelationshipQuery(
        warnings,
        'music venues missing city/state',
        `SELECT venue_id, venue, city, state
         FROM music_venues
         WHERE trim(coalesce(city, '')) = ''
            OR trim(coalesce(state, '')) = ''
         ORDER BY venue ASC
         LIMIT 1000`
      );
      diagnosticRows(missingLocationResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'music',
          type: 'venues',
          severity: 'warning',
          code: 'MISSING_CITY_STATE',
          message: 'Music venue is missing city or state.',
          entity_id: row.venue_id,
          entity_name: row.venue,
          details: { city: row.city || '', state: row.state || '' }
        }));
      });
    }

    if (hasDiagnosticColumn(columnsByTable, 'music_venues', 'geo')) {
      const missingGeoResult = await runRelationshipQuery(
        warnings,
        'music venues incomplete geo',
        `SELECT venue_id, venue, geo
         FROM music_venues
         WHERE jsonb_typeof(geo) = 'object'
           AND (
             trim(coalesce(geo->>'geohash', '')) = ''
             OR trim(coalesce(geo->>'google_maps_url', '')) = ''
             OR trim(coalesce(geo->>'apple_maps_url', '')) = ''
             OR trim(coalesce(geo->>'osm_url', '')) = ''
           )
         ORDER BY venue ASC
         LIMIT 1000`
      );
      diagnosticRows(missingGeoResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'music',
          type: 'venues',
          severity: 'warning',
          code: 'INCOMPLETE_GEO',
          message: 'Music venue geo is missing geohash or map URLs.',
          entity_id: row.venue_id,
          entity_name: row.venue,
          details: { geo: row.geo && typeof row.geo === 'object' ? row.geo : {} }
        }));
      });
    }
  }

  if (
    relationshipHasTable(existingTables, 'music_people', warnings) &&
    relationshipHasColumns(columnsByTable, 'music_people', ['name'], warnings)
  ) {
    const duplicatePeopleResult = await runRelationshipQuery(
      warnings,
      'duplicate music people names',
      `SELECT lower(trim(name)) AS name_key, min(name) AS name, count(*)::int AS count, array_agg(person_id::text ORDER BY person_id) AS person_ids
       FROM music_people
       WHERE trim(coalesce(name, '')) <> ''
       GROUP BY 1
       HAVING count(*) > 1
       ORDER BY count DESC, name ASC
       LIMIT 1000`
    );
    diagnosticRows(duplicatePeopleResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'people',
        severity: 'warning',
        code: 'DUPLICATE_NAME',
        message: 'Duplicate music person name detected.',
        entity_id: Array.isArray(row.person_ids) ? row.person_ids[0] : '',
        entity_name: row.name,
        details: { count: toIntegerCount(row.count), person_ids: Array.isArray(row.person_ids) ? row.person_ids : [] }
      }));
    });

    if (relationshipHasColumns(columnsByTable, 'music_people', ['person_id'], warnings)) {
      const missingPersonIdResult = await runRelationshipQuery(
        warnings,
        'music people missing person_id',
        `SELECT person_id, name, category
         FROM music_people
         WHERE person_id IS NULL
         ORDER BY name ASC
         LIMIT 1000`
      );
      diagnosticRows(missingPersonIdResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'music',
          type: 'people',
          severity: 'error',
          code: 'MISSING_PERSON_ID',
          message: 'Music person is missing person_id.',
          entity_id: row.person_id,
          entity_name: row.name,
          details: { category: row.category || '' }
        }));
      });
    }

    if (hasDiagnosticColumn(columnsByTable, 'music_people', 'bands')) {
      const malformedPeopleBandsResult = await runRelationshipQuery(
        warnings,
        'malformed music people band relationships',
        `SELECT person_id, name, jsonb_typeof(bands) AS field_type
         FROM music_people
         WHERE bands IS NOT NULL
           AND jsonb_typeof(bands) <> 'array'
         ORDER BY name ASC
         LIMIT 1000`
      );
      diagnosticRows(malformedPeopleBandsResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'music',
          type: 'people',
          severity: 'error',
          code: 'MALFORMED_PEOPLE_BANDS_FIELD',
          message: 'Music person bands field is not a JSON array.',
          entity_id: row.person_id,
          entity_name: row.name,
          details: { field_type: row.field_type || '' }
        }));
      });
    }
  }

  if (
    relationshipHasTable(existingTables, 'music_shows', warnings) &&
    relationshipHasColumns(columnsByTable, 'music_shows', ['bands'], warnings)
  ) {
    const malformedShowBandsResult = await runRelationshipQuery(
      warnings,
      'malformed music show band relationships',
      `SELECT show_id, name, date, jsonb_typeof(bands) AS field_type
       FROM music_shows
       WHERE bands IS NOT NULL
         AND jsonb_typeof(bands) <> 'array'
       ORDER BY show_id ASC
       LIMIT 1000`
    );
    diagnosticRows(malformedShowBandsResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'shows',
        severity: 'error',
        code: 'MALFORMED_SHOW_BANDS_FIELD',
        message: 'Music show bands field is not a JSON array.',
        entity_id: row.show_id,
        entity_name: row.name,
        details: { date: row.date || '', field_type: row.field_type || '' }
      }));
    });

    const duplicateShowBandResult = await runRelationshipQuery(
      warnings,
      'duplicate music show band relationships',
      `WITH refs AS (
         SELECT ms.show_id, ms.name, ms.date, lower(trim(band_item->>'band')) AS band_key, min(band_item->>'band') AS band, count(*)::int AS count
         FROM music_shows ms
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ms.bands) = 'array' THEN ms.bands ELSE '[]'::jsonb END) AS band_item
         WHERE trim(coalesce(band_item->>'band', '')) <> ''
         GROUP BY ms.show_id, ms.name, ms.date, lower(trim(band_item->>'band'))
         HAVING count(*) > 1
       )
       SELECT show_id, name, date, band, count
       FROM refs
       ORDER BY show_id ASC, band ASC
       LIMIT 1000`
    );
    diagnosticRows(duplicateShowBandResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'shows',
        severity: 'warning',
        code: 'DUPLICATE_SHOW_BAND_RELATIONSHIP',
        message: 'Music show lists the same band more than once.',
        entity_id: row.show_id,
        entity_name: row.name,
        details: { band: row.band || '', date: row.date || '', count: toIntegerCount(row.count) }
      }));
    });
  }

  if (
    existingTables.has('music_shows') &&
    existingTables.has('music_bands') &&
    relationshipHasColumns(columnsByTable, 'music_shows', ['bands'], warnings) &&
    relationshipHasColumns(columnsByTable, 'music_bands', ['band'], warnings)
  ) {
    const missingBandResult = await runRelationshipQuery(
      warnings,
      'music show band references',
      `WITH refs AS (
         SELECT DISTINCT ms.show_id, ms.name, ms.date, band_item->>'band' AS band
         FROM music_shows ms
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ms.bands) = 'array' THEN ms.bands ELSE '[]'::jsonb END) AS band_item
         WHERE trim(coalesce(band_item->>'band', '')) <> ''
       )
       SELECT refs.show_id, refs.name, refs.date, refs.band
       FROM refs
       LEFT JOIN music_bands mb
         ON lower(trim(coalesce(mb.band, ''))) = lower(trim(refs.band))
       WHERE mb.band IS NULL
       ORDER BY refs.show_id ASC, refs.band ASC
       LIMIT 1000`
    );
    diagnosticRows(missingBandResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'shows',
        severity: 'error',
        code: 'MISSING_BAND_REFERENCE',
        message: 'Music show references a band that does not exist in music_bands.',
        entity_id: row.show_id,
        entity_name: row.name,
        details: { band: row.band || '', date: row.date || '' }
      }));
    });
  }

  if (
    existingTables.has('music_people') &&
    existingTables.has('music_bands') &&
    relationshipHasColumns(columnsByTable, 'music_people', ['person_id', 'name', 'category', 'bands'], warnings) &&
    relationshipHasColumns(columnsByTable, 'music_bands', ['band'], warnings)
  ) {
    const malformedPeopleBandItemResult = await runRelationshipQuery(
      warnings,
      'malformed music people band items',
      `SELECT mp.person_id, mp.name, jsonb_typeof(band_item) AS field_type, band_item::text AS value
       FROM music_people mp
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mp.bands) = 'array' THEN mp.bands ELSE '[]'::jsonb END) AS band_item
       WHERE jsonb_typeof(band_item) <> 'object'
       ORDER BY mp.person_id ASC
       LIMIT 1000`
    );
    diagnosticRows(malformedPeopleBandItemResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'people',
        severity: 'error',
        code: 'MALFORMED_PEOPLE_BAND_ITEM',
        message: 'Music person band relationship item is not a JSON object.',
        entity_id: row.person_id,
        entity_name: row.name,
        details: { field_type: row.field_type || '', value: row.value || '' }
      }));
    });

    const missingPersonBandResult = await runRelationshipQuery(
      warnings,
      'music people band references',
      `WITH refs AS (
         SELECT DISTINCT mp.person_id, mp.name, band_item->>'band' AS band, band_item->>'instrument' AS instrument
         FROM music_people mp
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mp.bands) = 'array' THEN mp.bands ELSE '[]'::jsonb END) AS band_item
         WHERE jsonb_typeof(band_item) = 'object'
           AND trim(coalesce(band_item->>'band', '')) <> ''
       )
       SELECT refs.person_id, refs.name, refs.band, refs.instrument
       FROM refs
       LEFT JOIN music_bands mb
         ON lower(trim(coalesce(mb.band, ''))) = lower(trim(refs.band))
       WHERE mb.band IS NULL
       ORDER BY refs.name ASC, refs.band ASC
       LIMIT 1000`
    );
    diagnosticRows(missingPersonBandResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'people',
        severity: 'error',
        code: 'MISSING_PERSON_BAND_REFERENCE',
        message: 'Music person references a band that does not exist in music_bands.',
        entity_id: row.person_id,
        entity_name: row.name,
        details: { band: row.band || '', instrument: row.instrument || '' }
      }));
    });

    const duplicatePersonBandResult = await runRelationshipQuery(
      warnings,
      'duplicate music people band relationships',
      `WITH refs AS (
         SELECT mp.person_id, mp.name, lower(trim(band_item->>'band')) AS band_key, lower(trim(coalesce(band_item->>'instrument', ''))) AS instrument_key, min(band_item->>'band') AS band, min(coalesce(band_item->>'instrument', '')) AS instrument, count(*)::int AS count
         FROM music_people mp
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mp.bands) = 'array' THEN mp.bands ELSE '[]'::jsonb END) AS band_item
         WHERE jsonb_typeof(band_item) = 'object'
           AND trim(coalesce(band_item->>'band', '')) <> ''
         GROUP BY mp.person_id, mp.name, lower(trim(band_item->>'band')), lower(trim(coalesce(band_item->>'instrument', '')))
         HAVING count(*) > 1
       )
       SELECT person_id, name, band, instrument, count
       FROM refs
       ORDER BY name ASC, band ASC
       LIMIT 1000`
    );
    diagnosticRows(duplicatePersonBandResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'people',
        severity: 'warning',
        code: 'DUPLICATE_PERSON_BAND_RELATIONSHIP',
        message: 'Music person has the same band/instrument relationship more than once.',
        entity_id: row.person_id,
        entity_name: row.name,
        details: { band: row.band || '', instrument: row.instrument || '', count: toIntegerCount(row.count) }
      }));
    });

    const orphanedBandResult = await runRelationshipQuery(
      warnings,
      'music bands without people relationships',
      `WITH person_bands AS (
         SELECT DISTINCT lower(trim(band_item->>'band')) AS band_key
         FROM music_people mp
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(mp.bands) = 'array' THEN mp.bands ELSE '[]'::jsonb END) AS band_item
         WHERE jsonb_typeof(band_item) = 'object'
           AND trim(coalesce(band_item->>'band', '')) <> ''
       )
       SELECT mb.band_id, mb.band
       FROM music_bands mb
       LEFT JOIN person_bands pb
         ON pb.band_key = lower(trim(coalesce(mb.band, '')))
       WHERE trim(coalesce(mb.band, '')) <> ''
         AND pb.band_key IS NULL
       ORDER BY mb.band ASC
       LIMIT 1000`
    );
    diagnosticRows(orphanedBandResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'bands',
        severity: 'info',
        code: 'ORPHANED_BAND_NO_PEOPLE',
        message: 'Music band has no linked people records yet.',
        entity_id: row.band_id,
        entity_name: row.band,
        details: {}
      }));
    });

    const peopleWithoutBandsResult = await runRelationshipQuery(
      warnings,
      'music people without band links',
      `SELECT person_id, name, category
       FROM music_people
       WHERE lower(trim(coalesce(category, ''))) = ANY($1::text[])
         AND CASE
         WHEN jsonb_typeof(bands) = 'array' THEN jsonb_array_length(bands)
         ELSE 0
       END = 0
       ORDER BY name ASC
       LIMIT 1000`,
      [Array.from(MUSIC_BAND_LINK_DIAGNOSTIC_CATEGORY_KEYS)]
    );
    diagnosticRows(peopleWithoutBandsResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'music',
        type: 'people',
        severity: 'info',
        code: 'ORPHANED_PERSON_NO_BANDS',
        message: 'Music person has no linked bands yet.',
        entity_id: row.person_id,
        entity_name: row.name,
        details: { category: row.category || '' }
      }));
    });
  }
}

async function addWrestlingRelationshipIssues(items, warnings, existingTables, columnsByTable) {
  if (
    relationshipHasTable(existingTables, 'wrestling_shows', warnings) &&
    relationshipHasColumns(columnsByTable, 'wrestling_shows', ['venue_id'], warnings)
  ) {
    const missingVenueIdResult = await runRelationshipQuery(
      warnings,
      'wrestling shows missing venue_id',
      `SELECT show_id, show_name, date, venue_id
       FROM wrestling_shows
       WHERE trim(coalesce(venue_id, '')) = ''
       ORDER BY show_id ASC
       LIMIT 1000`
    );
    diagnosticRows(missingVenueIdResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'shows',
        severity: 'error',
        code: 'MISSING_VENUE_ID',
        message: 'Wrestling show is missing venue_id.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { date: row.date || '' }
      }));
    });
  }

  if (
    existingTables.has('wrestling_shows') &&
    existingTables.has('wrestling_venues') &&
    relationshipHasColumns(columnsByTable, 'wrestling_shows', ['venue_id'], warnings) &&
    relationshipHasColumns(columnsByTable, 'wrestling_venues', ['venue_id'], warnings)
  ) {
    const invalidVenueIdResult = await runRelationshipQuery(
      warnings,
      'wrestling shows with invalid venue_id',
      `SELECT ws.show_id, ws.show_name, ws.date, ws.venue_id
       FROM wrestling_shows ws
       LEFT JOIN wrestling_venues wv
         ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
       WHERE trim(coalesce(ws.venue_id, '')) <> ''
         AND wv.venue_id IS NULL
       ORDER BY ws.show_id ASC
       LIMIT 1000`
    );
    diagnosticRows(invalidVenueIdResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'shows',
        severity: 'error',
        code: 'INVALID_VENUE_ID',
        message: 'Wrestling show references a venue_id that does not exist in wrestling_venues.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { venue_id: row.venue_id || '', date: row.date || '' }
      }));
    });
  }

  if (relationshipHasTable(existingTables, 'wrestling_venues', warnings)) {
    if (relationshipHasColumns(columnsByTable, 'wrestling_venues', ['venue_name'], warnings)) {
      const duplicateVenueResult = await runRelationshipQuery(
        warnings,
        'duplicate wrestling venue names',
        `SELECT lower(trim(venue_name)) AS name_key, min(venue_name) AS venue_name, count(*)::int AS count, array_agg(venue_id ORDER BY venue_id) AS venue_ids
         FROM wrestling_venues
         WHERE trim(coalesce(venue_name, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
         ORDER BY count DESC, venue_name ASC
         LIMIT 1000`
      );
      diagnosticRows(duplicateVenueResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'wrestling',
          type: 'venues',
          severity: 'warning',
          code: 'DUPLICATE_NAME',
          message: 'Duplicate wrestling venue name detected.',
          entity_id: Array.isArray(row.venue_ids) ? row.venue_ids[0] : '',
          entity_name: row.venue_name,
          details: { count: toIntegerCount(row.count), venue_ids: Array.isArray(row.venue_ids) ? row.venue_ids : [] }
        }));
      });
    }

    if (
      existingTables.has('wrestling_shows') &&
      relationshipHasColumns(columnsByTable, 'wrestling_venues', ['venue_id'], warnings) &&
      relationshipHasColumns(columnsByTable, 'wrestling_shows', ['venue_id'], warnings)
    ) {
      const orphanedVenueResult = await runRelationshipQuery(
        warnings,
        'wrestling venues without linked shows',
        `SELECT wv.venue_id, wv.venue_name, wv.city, wv.state
         FROM wrestling_venues wv
         LEFT JOIN wrestling_shows ws
           ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
         WHERE trim(coalesce(wv.venue_id, '')) <> ''
           AND ws.show_id IS NULL
         ORDER BY wv.venue_name ASC
         LIMIT 1000`
      );
      diagnosticRows(orphanedVenueResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'wrestling',
          type: 'venues',
          severity: 'info',
          code: 'ORPHANED_VENUE_NO_SHOWS',
          message: 'Wrestling venue has no linked wrestling shows yet.',
          entity_id: row.venue_id,
          entity_name: row.venue_name,
          details: { city: row.city || '', state: row.state || '' }
        }));
      });
    }

    if (relationshipHasColumns(columnsByTable, 'wrestling_venues', ['city', 'state'], warnings)) {
      const missingLocationResult = await runRelationshipQuery(
        warnings,
        'wrestling venues missing city/state',
        `SELECT venue_id, venue_name, city, state
         FROM wrestling_venues
         WHERE trim(coalesce(city, '')) = ''
            OR trim(coalesce(state, '')) = ''
         ORDER BY venue_name ASC
         LIMIT 1000`
      );
      diagnosticRows(missingLocationResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'wrestling',
          type: 'venues',
          severity: 'warning',
          code: 'MISSING_CITY_STATE',
          message: 'Wrestling venue is missing city or state.',
          entity_id: row.venue_id,
          entity_name: row.venue_name,
          details: { city: row.city || '', state: row.state || '' }
        }));
      });
    }

    if (relationshipHasColumns(columnsByTable, 'wrestling_venues', ['geo'], warnings)) {
      const missingGeoResult = await runRelationshipQuery(
        warnings,
        'wrestling venues incomplete geo',
        `SELECT venue_id, venue_name, geo
         FROM wrestling_venues
         WHERE jsonb_typeof(geo) = 'object'
           AND (
             trim(coalesce(geo->>'geohash', '')) = ''
             OR trim(coalesce(geo->>'google_maps_url', '')) = ''
             OR trim(coalesce(geo->>'apple_maps_url', '')) = ''
             OR trim(coalesce(geo->>'osm_url', '')) = ''
           )
         ORDER BY venue_name ASC
         LIMIT 1000`
      );
      diagnosticRows(missingGeoResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'wrestling',
          type: 'venues',
          severity: 'warning',
          code: 'INCOMPLETE_GEO',
          message: 'Wrestling venue geo is missing geohash or map URLs.',
          entity_id: row.venue_id,
          entity_name: row.venue_name,
          details: { geo: row.geo && typeof row.geo === 'object' ? row.geo : {} }
        }));
      });
    }
  }

  if (
    relationshipHasTable(existingTables, 'wrestling_people', warnings) &&
    relationshipHasColumns(columnsByTable, 'wrestling_people', ['name'], warnings)
  ) {
    const duplicatePeopleResult = await runRelationshipQuery(
      warnings,
      'duplicate wrestling people names',
      `SELECT lower(trim(name)) AS name_key, min(name) AS name, count(*)::int AS count, array_agg(id::text ORDER BY id) AS person_ids
       FROM wrestling_people
       WHERE trim(coalesce(name, '')) <> ''
       GROUP BY 1
       HAVING count(*) > 1
       ORDER BY count DESC, name ASC
       LIMIT 1000`
    );
    diagnosticRows(duplicatePeopleResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'people',
        severity: 'warning',
        code: 'DUPLICATE_NAME',
        message: 'Duplicate wrestling person name detected.',
        entity_id: Array.isArray(row.person_ids) ? row.person_ids[0] : '',
        entity_name: row.name,
        details: { count: toIntegerCount(row.count), person_ids: Array.isArray(row.person_ids) ? row.person_ids : [] }
      }));
    });

    if (hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'slug')) {
      const missingWrestlerIdResult = await runRelationshipQuery(
        warnings,
        'wrestling people missing slug ids',
        `SELECT id, slug, name, category
         FROM wrestling_people
         WHERE trim(coalesce(slug, '')) = ''
         ORDER BY name ASC
         LIMIT 1000`
      );
      diagnosticRows(missingWrestlerIdResult).forEach((row) => {
        items.push(buildRelationshipItem({
          section: 'wrestling',
          type: 'people',
          severity: 'error',
          code: 'MISSING_WRESTLER_ID',
          message: 'Wrestling person is missing slug/wrestler ID.',
          entity_id: row.id,
          entity_name: row.name,
          details: { category: row.category || '' }
        }));
      });
    }
  }

  if (
    relationshipHasTable(existingTables, 'wrestling_shows', warnings) &&
    relationshipHasColumns(columnsByTable, 'wrestling_shows', ['matches'], warnings)
  ) {
    const malformedMatchesResult = await runRelationshipQuery(
      warnings,
      'malformed wrestling matches field',
      `SELECT show_id, show_name, date, jsonb_typeof(matches) AS field_type
       FROM wrestling_shows
       WHERE matches IS NOT NULL
         AND jsonb_typeof(matches) <> 'array'
       ORDER BY show_id ASC
       LIMIT 1000`
    );
    diagnosticRows(malformedMatchesResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'shows',
        severity: 'error',
        code: 'MALFORMED_MATCHES_FIELD',
        message: 'Wrestling show matches field is not a JSON array.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { date: row.date || '', field_type: row.field_type || '' }
      }));
    });

    const emptyMatchesResult = await runRelationshipQuery(
      warnings,
      'wrestling shows without matches',
      `SELECT show_id, show_name, date
       FROM wrestling_shows
       WHERE CASE
         WHEN jsonb_typeof(matches) = 'array' THEN jsonb_array_length(matches)
         ELSE 0
       END = 0
       ORDER BY show_id ASC
       LIMIT 1000`
    );
    diagnosticRows(emptyMatchesResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'shows',
        severity: 'warning',
        code: 'ORPHANED_SHOW_NO_MATCHES',
        message: 'Wrestling show has no match records.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { date: row.date || '' }
      }));
    });
  }

  if (
    existingTables.has('wrestling_shows') &&
    relationshipHasColumns(columnsByTable, 'wrestling_shows', ['promotion'], warnings)
  ) {
    const missingPromotionResult = await runRelationshipQuery(
      warnings,
      'wrestling shows missing promotion',
      `SELECT show_id, show_name, date
       FROM wrestling_shows
       WHERE trim(coalesce(promotion, '')) = ''
       ORDER BY show_id ASC
       LIMIT 1000`
    );
    diagnosticRows(missingPromotionResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'shows',
        severity: 'warning',
        code: 'MISSING_PROMOTION',
        message: 'Wrestling show is missing promotion.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { date: row.date || '' }
      }));
    });
  }

  if (
    existingTables.has('wrestling_shows') &&
    existingTables.has('wrestling_people') &&
    relationshipHasColumns(columnsByTable, 'wrestling_shows', ['matches'], warnings) &&
    relationshipHasColumns(columnsByTable, 'wrestling_people', ['name'], warnings)
  ) {
    const hasAliases = hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'aliases');
    const hasTeams = hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'teams');
    const peopleLookupSql = buildRelationshipPeopleLookupSql('wrestling_people', { aliases: hasAliases, teams: hasTeams });
    const peopleLookupNoTeamsSql = buildRelationshipPeopleLookupSql('wrestling_people', { aliases: hasAliases, teams: false });

    const missingParticipantResult = await runRelationshipQuery(
      warnings,
      'wrestling participant references',
      `WITH people_lookup AS (${peopleLookupSql}),
       refs AS (
         SELECT DISTINCT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, participant_item.value AS participant
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(match_item->'participants') = 'array' THEN match_item->'participants' ELSE '[]'::jsonb END) AS participant_item(value)
         WHERE trim(participant_item.value) <> ''
       )
       SELECT refs.show_id, refs.show_name, refs.date, refs.match_order, refs.participant
       FROM refs
       LEFT JOIN people_lookup pl
         ON pl.lookup_key = lower(trim(refs.participant))
       WHERE pl.lookup_key IS NULL
       ORDER BY refs.show_id ASC, refs.match_order ASC, refs.participant ASC
       LIMIT 1000`
    );
    diagnosticRows(missingParticipantResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'error',
        code: 'MISSING_PARTICIPANT_REFERENCE',
        message: 'Wrestling match participant does not exist in wrestling_people.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { participant: row.participant || '', match_order: row.match_order || '', date: row.date || '' }
      }));
    });

    const missingWinnerResult = await runRelationshipQuery(
      warnings,
      'wrestling winner references',
      `WITH people_lookup AS (${peopleLookupSql}),
       refs AS (
         SELECT DISTINCT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, winner_item.value AS winner
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingWinnerArraySql('match_item')}) AS winner_item(value)
         WHERE trim(winner_item.value) <> ''
           AND lower(trim(winner_item.value)) NOT IN ('draw', 'no contest', 'n/a', 'none', 'unknown')
       )
       SELECT refs.show_id, refs.show_name, refs.date, refs.match_order, refs.winner
       FROM refs
       LEFT JOIN people_lookup pl
         ON pl.lookup_key = lower(trim(refs.winner))
       WHERE pl.lookup_key IS NULL
       ORDER BY refs.show_id ASC, refs.match_order ASC, refs.winner ASC
       LIMIT 1000`
    );
    diagnosticRows(missingWinnerResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'error',
        code: 'MISSING_WINNER_REFERENCE',
        message: 'Wrestling match winner does not exist in wrestling_people.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { winner: row.winner || '', match_order: row.match_order || '', date: row.date || '' }
      }));
    });

    const missingRefereeResult = await runRelationshipQuery(
      warnings,
      'wrestling referee references',
      `WITH people_lookup AS (${peopleLookupNoTeamsSql}),
       refs AS (
         SELECT DISTINCT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, referee_item.value AS referee
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(match_item->'referees') = 'array' THEN match_item->'referees' ELSE '[]'::jsonb END) AS referee_item(value)
         WHERE trim(referee_item.value) <> ''
       )
       SELECT refs.show_id, refs.show_name, refs.date, refs.match_order, refs.referee
       FROM refs
       LEFT JOIN people_lookup pl
         ON pl.lookup_key = lower(trim(refs.referee))
       WHERE pl.lookup_key IS NULL
       ORDER BY refs.show_id ASC, refs.match_order ASC, refs.referee ASC
       LIMIT 1000`
    );
    diagnosticRows(missingRefereeResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'error',
        code: 'MISSING_REFEREE_REFERENCE',
        message: 'Wrestling match referee does not exist in wrestling_people.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { referee: row.referee || '', match_order: row.match_order || '', date: row.date || '' }
      }));
    });

    const malformedMatchFieldResult = await runRelationshipQuery(
      warnings,
      'malformed wrestling match relationship fields',
      `WITH fields AS (
         SELECT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, field.field_name, jsonb_typeof(field.field_value) AS field_type, field.allows_string
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL (VALUES
           ('participants', match_item->'participants', false),
           ('side_1', match_item->'side_1', false),
           ('side_2', match_item->'side_2', false),
           ('winner', match_item->'winner', true),
           ('referees', match_item->'referees', false),
           ('extra_people', match_item->'extra_people', false),
           ('tagged_people', match_item->'tagged_people', false)
         ) AS field(field_name, field_value, allows_string)
         WHERE field.field_value IS NOT NULL
       )
       SELECT show_id, show_name, date, match_order, field_name, field_type
       FROM fields
       WHERE (allows_string = true AND coalesce(field_type, '') NOT IN ('array', 'string'))
          OR (allows_string = false AND coalesce(field_type, '') <> 'array')
       ORDER BY show_id ASC, match_order ASC, field_name ASC
       LIMIT 1000`
    );
    diagnosticRows(malformedMatchFieldResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'error',
        code: 'MALFORMED_RELATIONSHIP_FIELD',
        message: 'Wrestling match relationship field has an unexpected JSON type.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { field: row.field_name || '', field_type: row.field_type || '', match_order: row.match_order || '', date: row.date || '' }
      }));
    });

    const emptyRelationshipResult = await runRelationshipQuery(
      warnings,
      'empty wrestling match relationship fields',
      `WITH match_rows AS (
         SELECT ws.show_id, ws.show_name, ws.date, match_item, match_item->>'match_order' AS match_order
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
       ),
       empty_fields AS (
         SELECT show_id, show_name, date, match_order, 'participants' AS field_name
         FROM match_rows
         WHERE jsonb_array_length(${getWrestlingParticipantsArraySql('match_item')}) = 0
         UNION ALL
         SELECT show_id, show_name, date, match_order, 'winner' AS field_name
         FROM match_rows
         WHERE jsonb_array_length(${getWrestlingWinnerArraySql('match_item')}) = 0
         UNION ALL
         SELECT show_id, show_name, date, match_order, 'tagged_people' AS field_name
         FROM match_rows
         WHERE jsonb_array_length(${getWrestlingAllTaggedPeopleArraySql('match_item')}) = 0
       )
       SELECT show_id, show_name, date, match_order, field_name
       FROM empty_fields
       ORDER BY show_id ASC, match_order ASC, field_name ASC
       LIMIT 1000`
    );
    diagnosticRows(emptyRelationshipResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'warning',
        code: row.field_name === 'winner' ? 'MISSING_WINNER' : 'EMPTY_RELATIONSHIP_FIELD',
        message: `Wrestling match has empty ${row.field_name || 'relationship'} data.`,
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { field: row.field_name || '', match_order: row.match_order || '', date: row.date || '' }
      }));
    });

    const missingExtraPeopleResult = await runRelationshipQuery(
      warnings,
      'wrestling extra_people references',
      `WITH people_lookup AS (${peopleLookupNoTeamsSql}),
       refs AS (
         SELECT DISTINCT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, extra_people_item.value AS person
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingExtraPeopleArraySql('match_item')}) AS extra_people_item(value)
         WHERE trim(extra_people_item.value) <> ''
       )
       SELECT refs.show_id, refs.show_name, refs.date, refs.match_order, refs.person
       FROM refs
       LEFT JOIN people_lookup pl
         ON pl.lookup_key = lower(trim(refs.person))
       WHERE pl.lookup_key IS NULL
       ORDER BY refs.show_id ASC, refs.match_order ASC, refs.person ASC
       LIMIT 1000`
    );
    diagnosticRows(missingExtraPeopleResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'warning',
        code: 'MISSING_EXTRA_PEOPLE_REFERENCE',
        message: 'Wrestling match extra_people value does not exist in wrestling_people.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { person: row.person || '', match_order: row.match_order || '', date: row.date || '' }
      }));
    });

    const missingTaggedPeopleResult = await runRelationshipQuery(
      warnings,
      'wrestling tagged_people references',
      `WITH people_lookup AS (${peopleLookupNoTeamsSql}),
       refs AS (
         SELECT DISTINCT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, tagged_people_item.value AS person
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingTaggedPeopleArraySql('match_item')}) AS tagged_people_item(value)
         WHERE trim(tagged_people_item.value) <> ''
       )
       SELECT refs.show_id, refs.show_name, refs.date, refs.match_order, refs.person
       FROM refs
       LEFT JOIN people_lookup pl
         ON pl.lookup_key = lower(trim(refs.person))
       WHERE pl.lookup_key IS NULL
       ORDER BY refs.show_id ASC, refs.match_order ASC, refs.person ASC
       LIMIT 1000`
    );
    diagnosticRows(missingTaggedPeopleResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'warning',
        code: 'MISSING_TAGGED_PEOPLE_REFERENCE',
        message: 'Wrestling match tagged_people value does not exist in wrestling_people.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { person: row.person || '', match_order: row.match_order || '', date: row.date || '' }
      }));
    });

    const missingSideResult = await runRelationshipQuery(
      warnings,
      'wrestling side/team references',
      `WITH people_lookup AS (${peopleLookupSql}),
       refs AS (
         SELECT DISTINCT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, 'side_1' AS field_name, side_item.value AS side_name
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(match_item->'side_1') = 'array' THEN match_item->'side_1' ELSE '[]'::jsonb END) AS side_item(value)
         WHERE trim(side_item.value) <> ''
         UNION
         SELECT DISTINCT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, 'side_2' AS field_name, side_item.value AS side_name
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(match_item->'side_2') = 'array' THEN match_item->'side_2' ELSE '[]'::jsonb END) AS side_item(value)
         WHERE trim(side_item.value) <> ''
       )
       SELECT refs.show_id, refs.show_name, refs.date, refs.match_order, refs.field_name, refs.side_name
       FROM refs
       LEFT JOIN people_lookup pl
         ON pl.lookup_key = lower(trim(refs.side_name))
       WHERE pl.lookup_key IS NULL
       ORDER BY refs.show_id ASC, refs.match_order ASC, refs.side_name ASC
       LIMIT 1000`
    );
    diagnosticRows(missingSideResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'warning',
        code: 'MISSING_SIDE_REFERENCE',
        message: 'Wrestling match side/team value does not exist in wrestling_people names, aliases, or teams.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { side: row.side_name || '', field: row.field_name || '', match_order: row.match_order || '', date: row.date || '' }
      }));
    });

    const duplicateMatchPeopleResult = await runRelationshipQuery(
      warnings,
      'duplicate wrestling match people relationships',
      `WITH refs AS (
         SELECT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, 'participants' AS field_name, participant_item.value AS person
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingParticipantsArraySql('match_item')}) AS participant_item(value)
         WHERE trim(participant_item.value) <> ''
         UNION ALL
         SELECT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, 'referees' AS field_name, referee_item.value AS person
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingRefereesArraySql('match_item')}) AS referee_item(value)
         WHERE trim(referee_item.value) <> ''
         UNION ALL
         SELECT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, 'extra_people' AS field_name, extra_people_item.value AS person
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingExtraPeopleArraySql('match_item')}) AS extra_people_item(value)
         WHERE trim(extra_people_item.value) <> ''
         UNION ALL
         SELECT ws.show_id, ws.show_name, ws.date, match_item->>'match_order' AS match_order, 'tagged_people' AS field_name, tagged_people_item.value AS person
         FROM wrestling_shows ws
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
         CROSS JOIN LATERAL jsonb_array_elements_text(${getWrestlingTaggedPeopleArraySql('match_item')}) AS tagged_people_item(value)
         WHERE trim(tagged_people_item.value) <> ''
       ),
       grouped AS (
         SELECT show_id, show_name, date, match_order, field_name, lower(trim(person)) AS person_key, min(person) AS person, count(*)::int AS count
         FROM refs
         GROUP BY show_id, show_name, date, match_order, field_name, lower(trim(person))
         HAVING count(*) > 1
       )
       SELECT show_id, show_name, date, match_order, field_name, person, count
       FROM grouped
       ORDER BY show_id ASC, match_order ASC, field_name ASC, person ASC
       LIMIT 1000`
    );
    diagnosticRows(duplicateMatchPeopleResult).forEach((row) => {
      items.push(buildRelationshipItem({
        section: 'wrestling',
        type: 'matches',
        severity: 'warning',
        code: 'DUPLICATE_MATCH_PEOPLE_RELATIONSHIP',
        message: 'Wrestling match contains a duplicate people relationship value.',
        entity_id: row.show_id,
        entity_name: row.show_name,
        details: { person: row.person || '', field: row.field_name || '', match_order: row.match_order || '', date: row.date || '', count: toIntegerCount(row.count) }
      }));
    });
  }
}

async function buildRelationshipReport(section) {
  const generated = new Date();
  const warnings = [];
  const items = [];
  const requestedSection = String(section || '').trim().toLowerCase();
  const sections = requestedSection ? [requestedSection] : ['music', 'wrestling'];
  let unknown = false;

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Missing DATABASE_URL environment variable.');
    unknown = true;
    return { generated, items, warnings, unknown };
  }

  let existingTables;
  let columnsByTable;
  try {
    await dbPool.query('SELECT 1');
    existingTables = await getExistingPublicTables(RELATIONSHIP_TABLES);
    columnsByTable = await getExistingPublicColumns(RELATIONSHIP_TABLES);
  } catch (err) {
    warnings.push(`Unable to inspect relationship tables: ${err && err.message ? err.message : String(err)}`);
    unknown = true;
    return { generated, items, warnings, unknown };
  }

  if (sections.includes('music')) {
    await addMusicRelationshipIssues(items, warnings, existingTables, columnsByTable);
  }

  if (sections.includes('wrestling')) {
    await addWrestlingRelationshipIssues(items, warnings, existingTables, columnsByTable);
  }

  return { generated, items, warnings, unknown };
}

function filterRelationshipItems(items, query, fixedSection) {
  const section = String(fixedSection || query.section || '').trim().toLowerCase();
  const type = String(query.type || '').trim().toLowerCase();
  const severity = String(query.severity || '').trim().toLowerCase();

  return (items || []).filter((item) => {
    if (section && item.section !== section) return false;
    if (type && item.type !== type) return false;
    if (severity && item.severity !== severity) return false;
    return true;
  });
}

async function buildRelationshipHealth(section) {
  const report = await buildRelationshipReport(section);
  const summary = summarizeRelationshipItems(report.items);

  return {
    ok: true,
    errors: summary.errors,
    warnings: summary.warnings,
    info: summary.info,
    overallHealth: getRelationshipOverallHealth(summary, report.unknown)
  };
}

function buildRelationshipDiagnosticSummary(items, unknown) {
  const severity = summarizeRelationshipItems(items);
  const codeCount = (predicate) => (items || []).filter((item) => predicate(String(item && item.code || '').toUpperCase())).length;
  const summary = {
    totalIssues: (items || []).length,
    errors: severity.errors,
    warnings: severity.warnings,
    info: severity.info,
    missingRelationships: codeCount((code) => code.includes('MISSING') || code.includes('INVALID')),
    orphanedRecords: codeCount((code) => code.includes('ORPHANED')),
    malformedFields: codeCount((code) => code.includes('MALFORMED')),
    duplicateRelationships: codeCount((code) => code.includes('DUPLICATE')),
    overallHealth: getRelationshipOverallHealth(severity, unknown)
  };

  return summary;
}

async function buildRelationshipDiagnosticsResponse(section) {
  const report = await buildRelationshipReport(section);
  const items = report.items || [];
  const requestedSection = String(section || '').trim().toLowerCase();
  const route = requestedSection
    ? `/api/admin/diagnostics/${requestedSection}/relationships`
    : '/api/admin/diagnostics/relationships';
  const errorItems = items.filter((item) => item.severity === 'error');

  return {
    ok: true,
    route,
    source: 'postgres',
    section: requestedSection || 'all',
    module: 'relationships',
    generatedAt: report.generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(report.generated),
    summary: buildRelationshipDiagnosticSummary(items, report.unknown),
    warnings: report.warnings || [],
    errors: errorItems.slice(0, 100),
    count: items.length,
    items: items.slice(0, 100),
    limited: items.length > 100,
    routeInfo: {
      sourceRoutes: [
        requestedSection ? `/api/admin/relationships/${requestedSection}` : '/api/admin/relationships',
        '/api/admin/relationships/summary'
      ]
    }
  };
}

async function handleRelationshipDiagnosticsRequest(req, res, fixedSection) {
  try {
    res.json(await buildRelationshipDiagnosticsResponse(fixedSection));
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: fixedSection ? `/api/admin/diagnostics/${fixedSection}/relationships` : '/api/admin/diagnostics/relationships',
      source: 'postgres',
      section: fixedSection || 'all',
      module: 'relationships',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function handleRelationshipsRequest(req, res, fixedSection) {
  try {
    const report = await buildRelationshipReport(fixedSection || req.query.section);
    const filtered = filterRelationshipItems(report.items, req.query, fixedSection);
    const summary = summarizeRelationshipItems(filtered);
    const limit = getRelationshipLimit(req.query.limit);
    const page = getPageNumber(req.query.page);
    const offset = (page - 1) * limit;
    const pagedItems = filtered.slice(offset, offset + limit);
    const pagination = buildPaginationMeta(page, limit, filtered.length, pagedItems.length);
    const relationshipFilters = {};
    ['section', 'type', 'severity'].forEach((key) => {
      if (req.query && req.query[key]) relationshipFilters[key] = String(req.query[key]);
    });

    res.json({
      ok: true,
      route: fixedSection ? `/api/admin/relationships/${fixedSection}` : '/api/admin/relationships',
      generatedAt: report.generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(report.generated),
      page,
      limit,
      count: pagination.count,
      total: filtered.length,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
      summary,
      warnings: report.warnings,
      meta: buildListMeta({ route: fixedSection ? `/api/admin/relationships/${fixedSection}` : '/api/admin/relationships', source: 'postgres', pagination, filters: relationshipFilters }),
      items: pagedItems
    });
  } catch (err) {
    res.status(500).json(buildApiError(
      fixedSection ? `/api/admin/relationships/${fixedSection}` : '/api/admin/relationships',
      err,
      {
        source: 'postgres',
        section: fixedSection || 'admin',
        type: 'relationships',
        error: 'RELATIONSHIPS_ERROR'
      }
    ));
  }
}

async function handleRelationshipSummaryRequest(req, res) {
  try {
    const musicReport = await buildRelationshipReport('music');
    const wrestlingReport = await buildRelationshipReport('wrestling');
    const music = summarizeRelationshipItems(musicReport.items);
    const wrestling = summarizeRelationshipItems(wrestlingReport.items);
    const overall = {
      errors: music.errors + wrestling.errors,
      warnings: music.warnings + wrestling.warnings,
      info: music.info + wrestling.info
    };
    const generated = new Date();

    res.json({
      ok: true,
      route: '/api/admin/relationships/summary',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      music,
      wrestling,
      overallHealth: getRelationshipOverallHealth(overall, musicReport.unknown || wrestlingReport.unknown),
      warnings: uniqueAdminWarnings((musicReport.warnings || []).concat(wrestlingReport.warnings || []))
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/admin/relationships/summary',
      error: err && err.message ? err.message : String(err)
    });
  }
}

const STATS_SNAPSHOT_CATEGORIES = {
  music: ['bands', 'shows', 'people', 'venues'],
  wrestling: ['shows', 'people', 'venues', 'matches']
};

const STATS_SNAPSHOT_TABLES = [
  'music_bands',
  'music_shows',
  'music_people',
  'music_venues',
  'wrestling_shows',
  'wrestling_people',
  'wrestling_venues',
  'import_history'
];

const STATS_SNAPSHOT_CONFIG = {
  music: {
    bands: {
      table: 'music_bands',
      importantFields: [
        { key: 'band_id', columns: ['band_id'], condition: `trim(coalesce(band_id, '')) = ''` },
        { key: 'name', columns: ['band'], condition: `trim(coalesce(band, '')) = ''` },
        { key: 'status', columns: ['status'], condition: `trim(coalesce(status, '')) = ''` },
        { key: 'region', columns: ['region'], condition: `trim(coalesce(region, '')) = ''` }
      ]
    },
    shows: {
      table: 'music_shows',
      importantFields: [
        { key: 'show_name', columns: ['name'], condition: `trim(coalesce(name, '')) = ''` },
        { key: 'date', columns: ['date'], condition: `trim(coalesce(date, '')) = ''` },
        { key: 'venue', columns: ['venue'], condition: `trim(coalesce(venue, '')) = ''` },
        { key: 'poster', columns: ['poster'], condition: `trim(coalesce(poster, '')) = ''` }
      ]
    },
    people: {
      table: 'music_people',
      importantFields: [
        { key: 'person_id', columns: ['person_id'], condition: `person_id IS NULL` },
        { key: 'name', columns: ['name'], condition: `trim(coalesce(name, '')) = ''` },
        { key: 'category', columns: ['category'], condition: `trim(coalesce(category, '')) = ''` },
        {
          key: 'bands',
          columns: ['bands'],
          condition: `CASE WHEN jsonb_typeof(bands) = 'array' THEN jsonb_array_length(bands) ELSE 0 END = 0`
        }
      ]
    },
    venues: {
      table: 'music_venues',
      importantFields: [
        { key: 'venue_id', columns: ['venue_id'], condition: `venue_id IS NULL` },
        { key: 'name', columns: ['venue'], condition: `trim(coalesce(venue, '')) = ''` },
        { key: 'city', columns: ['city'], condition: `trim(coalesce(city, '')) = ''` },
        { key: 'state', columns: ['state'], condition: `trim(coalesce(state, '')) = ''` },
        { key: 'gps', columns: ['gps_lat', 'gps_lng'], condition: `trim(coalesce(gps_lat, '')) = '' OR trim(coalesce(gps_lng, '')) = ''` }
      ]
    }
  },
  wrestling: {
    shows: {
      table: 'wrestling_shows',
      importantFields: [
        { key: 'show_name', columns: ['show_name'], condition: `trim(coalesce(show_name, '')) = ''` },
        { key: 'date', columns: ['date'], condition: `trim(coalesce(date, '')) = ''` },
        { key: 'venue_id', columns: ['venue_id'], condition: `trim(coalesce(venue_id, '')) = ''` },
        { key: 'poster', columns: ['poster'], condition: `trim(coalesce(poster, '')) = ''` }
      ]
    },
    people: {
      table: 'wrestling_people',
      importantFields: [
        { key: 'name', columns: ['name'], condition: `trim(coalesce(name, '')) = ''` },
        { key: 'category', columns: ['category'], condition: `trim(coalesce(category, '')) = ''` },
        { key: 'teams', columns: ['teams'], condition: `coalesce(array_length(teams, 1), 0) = 0` }
      ]
    },
    venues: {
      table: 'wrestling_venues',
      importantFields: [
        { key: 'venue_id', columns: ['venue_id'], condition: `trim(coalesce(venue_id, '')) = ''` },
        { key: 'name', columns: ['venue_name'], condition: `trim(coalesce(venue_name, '')) = ''` },
        { key: 'city', columns: ['city'], condition: `trim(coalesce(city, '')) = ''` },
        { key: 'state', columns: ['state'], condition: `trim(coalesce(state, '')) = ''` },
        { key: 'gps', columns: ['latitude', 'longitude'], condition: `latitude IS NULL OR longitude IS NULL` },
        {
          key: 'geo',
          columns: ['geo'],
          condition: `jsonb_typeof(geo) = 'object' AND (
            trim(coalesce(geo->>'geohash', '')) = ''
            OR trim(coalesce(geo->>'google_maps_url', '')) = ''
            OR trim(coalesce(geo->>'apple_maps_url', '')) = ''
            OR trim(coalesce(geo->>'osm_url', '')) = ''
          )`
        }
      ]
    }
  }
};

function createEmptyStatsHealth() {
  return {
    ok: true,
    snapshots: 0,
    lastRebuiltAt: null,
    overallHealth: 'unknown'
  };
}

function getGeneratedAt(date = new Date()) {
  return {
    generatedAt: date.toISOString(),
    generatedTime: formatEasternGeneratedTime(date)
  };
}

function buildAdminResponse(payload = {}) {
  const generated = payload.generated instanceof Date ? payload.generated : new Date();
  const out = {
    ok: true,
    ...getGeneratedAt(generated)
  };
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (key !== 'generated') out[key] = value;
  });
  return out;
}

function buildAdminError(route, err, extra = {}) {
  return buildAdminResponse({
    ok: false,
    route,
    error: extra.error || 'ADMIN_ERROR',
    message: extra.message || getSafeErrorMessage(err),
    ...extra
  });
}

const SMUG_MUSIC_SNAPSHOT_TABLES = ['music_bands', 'music_shows'];
const SMUG_MUSIC_SNAPSHOT_FIELDS = [
  'gallery_id',
  'album_id',
  'cover_image_url',
  'photo_count',
  'smug_last_synced_at',
  'smug_sync_status',
  'smug_sync_error'
];

function getSmugMusicSnapshotColumnType(fieldName) {
  if (fieldName === 'photo_count') return 'INTEGER DEFAULT 0';
  if (fieldName === 'smug_last_synced_at') return 'TIMESTAMPTZ';
  return 'TEXT';
}

async function ensureSmugMusicSnapshotColumns(warnings) {
  if (!String(process.env.DATABASE_URL || '').trim()) return { ok: false, skipped: true, reason: 'DATABASE_URL_NOT_CONFIGURED' };

  const columnsEnsured = [];
  try {
    for (const tableName of SMUG_MUSIC_SNAPSHOT_TABLES) {
      for (const fieldName of SMUG_MUSIC_SNAPSHOT_FIELDS) {
        const columnType = getSmugMusicSnapshotColumnType(fieldName);
        await dbPool.query(`ALTER TABLE IF EXISTS ${tableName} ADD COLUMN IF NOT EXISTS ${fieldName} ${columnType}`);
        columnsEnsured.push(`${tableName}.${fieldName}`);
      }
    }
    return { ok: true, columnsEnsured };
  } catch (err) {
    const message = `Unable to ensure SmugMug snapshot columns: ${err && err.message ? err.message : String(err)}`;
    if (Array.isArray(warnings)) warnings.push(message);
    else console.warn(message);
    return { ok: false, error: err && err.message ? err.message : String(err), columnsEnsured };
  }
}
function getSmugMusicTableColumns(columnsByTable, tableName) {
  return columnsByTable && columnsByTable.get(tableName) ? columnsByTable.get(tableName) : new Set();
}

function buildSmugMusicSnapshotFieldStatus(existingTables, columnsByTable) {
  const fieldsByTable = {};
  const missing = [];

  SMUG_MUSIC_SNAPSHOT_TABLES.forEach((tableName) => {
    const tableExists = existingTables.has(tableName);
    const tableColumns = getSmugMusicTableColumns(columnsByTable, tableName);
    fieldsByTable[tableName] = {
      tablePresent: tableExists,
      fields: {}
    };

    SMUG_MUSIC_SNAPSHOT_FIELDS.forEach((fieldName) => {
      const present = tableExists && tableColumns.has(fieldName);
      fieldsByTable[tableName].fields[fieldName] = present;
      if (!present) missing.push(`${tableName}.${fieldName}`);
    });
  });

  return {
    present: missing.length === 0,
    missing,
    tables: fieldsByTable
  };
}

async function inspectSmugMusicSnapshotFields(warnings) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('DATABASE_URL is not configured; snapshot field inspection skipped.');
    return {
      present: false,
      missing: SMUG_MUSIC_SNAPSHOT_TABLES.flatMap((tableName) => SMUG_MUSIC_SNAPSHOT_FIELDS.map((fieldName) => `${tableName}.${fieldName}`)),
      tables: {}
    };
  }

  try {
    await ensureSmugMusicSnapshotColumns(warnings);
    const existingTables = await getExistingPublicTables(SMUG_MUSIC_SNAPSHOT_TABLES);
    const columnsByTable = await getExistingPublicColumns(SMUG_MUSIC_SNAPSHOT_TABLES);
    return buildSmugMusicSnapshotFieldStatus(existingTables, columnsByTable);
  } catch (err) {
    warnings.push(`Unable to inspect SmugMug snapshot fields: ${err && err.message ? err.message : String(err)}`);
    return {
      present: false,
      missing: [],
      tables: {}
    };
  }
}

function buildSmugMusicConfigSummary(smugConfig, snapshotFields) {
  return {
    readyForDiagnostics: true,
    readyForSync: !!(smugConfig.configured && snapshotFields.present),
    missingRequirements: (smugConfig.missing || []).concat(snapshotFields.missing || [])
  };
}

async function buildSmugMusicConfigResponse() {
  const generated = new Date();
  const warnings = [];
  const smugConfig = getSmugMugConfigDiagnostics();
  const snapshotFields = await inspectSmugMusicSnapshotFields(warnings);

  return buildAdminResponse({
    route: '/admin/smug/music/config',
    generated,
    source: 'server',
    section: 'music',
    type: 'smug_config',
    config: {
      smugApiKeyConfigured: !!SMUG_API_KEY,
      smugNicknameConfigured: !!SMUG_NICKNAME_ENV,
      configured: smugConfig.configured,
      missing: smugConfig.missing,
      nickname: SMUG_NICKNAME,
      userAgentConfigured: !!SMUG_USER_AGENT,
      requestRetries: SMUG_REQUEST_RETRIES,
      retryDelayMs: SMUG_RETRY_DELAY_MS,
      requestConcurrency: SMUG_REQUEST_CONCURRENCY
    },
    helper: {
      available: typeof fetchSmugJson === 'function' && typeof buildSmugApiUrl === 'function',
      requestHelperAvailable: typeof fetchSmugJson === 'function',
      urlHelperAvailable: typeof buildSmugApiUrl === 'function',
      rateLimitRetrySupported: true,
      lowConcurrencyDefault: SMUG_REQUEST_CONCURRENCY
    },
    snapshotFields,
    summary: buildSmugMusicConfigSummary(smugConfig, snapshotFields),
    warnings
  });
}

async function runSmugMusicCountQuery(warnings, label, sql, values = []) {
  try {
    const result = await dbPool.query(sql, values);
    return toIntegerCount(result.rows && result.rows[0] && result.rows[0].count);
  } catch (err) {
    warnings.push(`Unable to query ${label}: ${err && err.message ? err.message : String(err)}`);
    return 0;
  }
}

async function runSmugMusicRowsQuery(warnings, label, sql, values = []) {
  try {
    const result = await dbPool.query(sql, values);
    return diagnosticRows(result);
  } catch (err) {
    warnings.push(`Unable to query ${label}: ${err && err.message ? err.message : String(err)}`);
    return [];
  }
}

async function buildSmugMusicBandDiagnostics(existingTables, columnsByTable, warnings) {
  const bands = {
    tablePresent: existingTables.has('music_bands'),
    missingSmugFolder: { count: 0, samples: [] },
    missingSyncData: { count: 0, samples: [] },
    syncStatus: [],
    snapshotAge: null
  };

  if (!bands.tablePresent) {
    warnings.push('Missing table for SmugMug band diagnostics: music_bands');
    return bands;
  }

  const columns = getSmugMusicTableColumns(columnsByTable, 'music_bands');
  if (columns.has('smug_folder')) {
    bands.missingSmugFolder.count = await runSmugMusicCountQuery(
      warnings,
      'bands missing smug_folder',
      `SELECT count(*)::int AS count FROM music_bands WHERE trim(coalesce(smug_folder, '')) = ''`
    );
    bands.missingSmugFolder.samples = await runSmugMusicRowsQuery(
      warnings,
      'bands missing smug_folder samples',
      `SELECT band_id, band, smug_folder
       FROM music_bands
       WHERE trim(coalesce(smug_folder, '')) = ''
       ORDER BY band ASC
       LIMIT 10`
    );
  } else {
    warnings.push('Missing column for SmugMug band diagnostics: music_bands.smug_folder');
  }

  const hasSnapshotFields = SMUG_MUSIC_SNAPSHOT_FIELDS.every((fieldName) => columns.has(fieldName));
  if (hasSnapshotFields) {
    bands.missingSyncData.count = await runSmugMusicCountQuery(
      warnings,
      'bands missing sync data',
      `SELECT count(*)::int AS count
       FROM music_bands
       WHERE trim(coalesce(gallery_id, '')) = ''
         AND trim(coalesce(album_id, '')) = ''
         AND trim(coalesce(cover_image_url, '')) = ''
         AND coalesce(photo_count, 0) = 0
         AND smug_last_synced_at IS NULL
         AND trim(coalesce(smug_sync_status, '')) = ''`
    );
    bands.missingSyncData.samples = await runSmugMusicRowsQuery(
      warnings,
      'bands missing sync data samples',
      `SELECT band_id, band, smug_folder, smug_sync_status, smug_last_synced_at
       FROM music_bands
       WHERE trim(coalesce(gallery_id, '')) = ''
         AND trim(coalesce(album_id, '')) = ''
         AND trim(coalesce(cover_image_url, '')) = ''
         AND coalesce(photo_count, 0) = 0
         AND smug_last_synced_at IS NULL
         AND trim(coalesce(smug_sync_status, '')) = ''
       ORDER BY band ASC
       LIMIT 10`
    );
    bands.syncStatus = await runSmugMusicRowsQuery(
      warnings,
      'band snapshot sync status',
      `SELECT coalesce(nullif(trim(smug_sync_status), ''), 'unsynced') AS status, count(*)::int AS count
       FROM music_bands
       GROUP BY 1
       ORDER BY count DESC, status ASC`
    );
    bands.snapshotAge = await runSmugMusicRowsQuery(
      warnings,
      'band snapshot age',
      `SELECT
         max(smug_last_synced_at) AS latest_synced_at,
         min(smug_last_synced_at) FILTER (WHERE smug_last_synced_at IS NOT NULL) AS oldest_synced_at,
         count(*) FILTER (WHERE smug_last_synced_at IS NOT NULL)::int AS synced_rows,
         count(*) FILTER (WHERE smug_last_synced_at IS NULL)::int AS never_synced_rows,
         count(*) FILTER (WHERE smug_last_synced_at < now() - interval '7 days')::int AS stale_7d_rows,
         count(*) FILTER (WHERE smug_last_synced_at < now() - interval '30 days')::int AS stale_30d_rows
       FROM music_bands`
    ).then((rows) => rows[0] || null);
  } else {
    warnings.push('Missing one or more music_bands SmugMug snapshot columns.');
  }

  return bands;
}

async function buildSmugMusicShowDiagnostics(existingTables, columnsByTable, warnings) {
  const shows = {
    tablePresent: existingTables.has('music_shows'),
    showUrlColumnPresent: false,
    missingPosterOrShowUrl: { count: 0, samples: [] },
    missingSyncData: { count: 0, samples: [] },
    syncStatus: [],
    snapshotAge: null
  };

  if (!shows.tablePresent) {
    warnings.push('Missing table for SmugMug show diagnostics: music_shows');
    return shows;
  }

  const columns = getSmugMusicTableColumns(columnsByTable, 'music_shows');
  const hasPoster = columns.has('poster');
  const hasShowUrl = columns.has('show_url');
  const hasRawSheet = columns.has('raw_sheet');
  shows.showUrlColumnPresent = hasShowUrl;
  shows.rawSheetColumnPresent = hasRawSheet;

  if (hasPoster || hasShowUrl) {
    const missingMediaWhere = hasShowUrl
      ? `trim(coalesce(poster, '')) = '' AND trim(coalesce(show_url, '')) = ''`
      : `trim(coalesce(poster, '')) = ''`;
    const sampleFields = hasShowUrl
      ? 'show_id, name, date, poster, show_url'
      : 'show_id, name, date, poster';

    shows.missingPosterOrShowUrl.count = await runSmugMusicCountQuery(
      warnings,
      'shows missing poster/show_url',
      `SELECT count(*)::int AS count FROM music_shows WHERE ${missingMediaWhere}`
    );
    shows.missingPosterOrShowUrl.samples = await runSmugMusicRowsQuery(
      warnings,
      'shows missing poster/show_url samples',
      `SELECT ${sampleFields}
       FROM music_shows
       WHERE ${missingMediaWhere}
       ORDER BY show_id ASC
       LIMIT 10`
    );
  } else {
    warnings.push('Missing poster/show_url columns for SmugMug show diagnostics.');
  }

  if (hasRawSheet) {
    try {
      shows.missingPosterOrShowUrl = await getSmugMusicShowMissingSourceDiagnostics();
    } catch (err) {
      warnings.push(`Unable to build raw-sheet show source diagnostics: ${err && err.message ? err.message : String(err)}`);
    }
  }

  const hasSnapshotFields = SMUG_MUSIC_SNAPSHOT_FIELDS.every((fieldName) => columns.has(fieldName));
  if (hasSnapshotFields) {
    shows.missingSyncData.count = await runSmugMusicCountQuery(
      warnings,
      'shows missing sync data',
      `SELECT count(*)::int AS count
       FROM music_shows
       WHERE trim(coalesce(gallery_id, '')) = ''
         AND trim(coalesce(album_id, '')) = ''
         AND trim(coalesce(cover_image_url, '')) = ''
         AND coalesce(photo_count, 0) = 0
         AND smug_last_synced_at IS NULL
         AND trim(coalesce(smug_sync_status, '')) = ''`
    );
    shows.missingSyncData.samples = await runSmugMusicRowsQuery(
      warnings,
      'shows missing sync data samples',
      `SELECT show_id, name, date, poster, smug_sync_status, smug_last_synced_at
       FROM music_shows
       WHERE trim(coalesce(gallery_id, '')) = ''
         AND trim(coalesce(album_id, '')) = ''
         AND trim(coalesce(cover_image_url, '')) = ''
         AND coalesce(photo_count, 0) = 0
         AND smug_last_synced_at IS NULL
         AND trim(coalesce(smug_sync_status, '')) = ''
       ORDER BY show_id ASC
       LIMIT 10`
    );
    shows.syncStatus = await runSmugMusicRowsQuery(
      warnings,
      'show snapshot sync status',
      `SELECT coalesce(nullif(trim(smug_sync_status), ''), 'unsynced') AS status, count(*)::int AS count
       FROM music_shows
       GROUP BY 1
       ORDER BY count DESC, status ASC`
    );
    shows.snapshotAge = await runSmugMusicRowsQuery(
      warnings,
      'show snapshot age',
      `SELECT
         max(smug_last_synced_at) AS latest_synced_at,
         min(smug_last_synced_at) FILTER (WHERE smug_last_synced_at IS NOT NULL) AS oldest_synced_at,
         count(*) FILTER (WHERE smug_last_synced_at IS NOT NULL)::int AS synced_rows,
         count(*) FILTER (WHERE smug_last_synced_at IS NULL)::int AS never_synced_rows,
         count(*) FILTER (WHERE smug_last_synced_at < now() - interval '7 days')::int AS stale_7d_rows,
         count(*) FILTER (WHERE smug_last_synced_at < now() - interval '30 days')::int AS stale_30d_rows
       FROM music_shows`
    ).then((rows) => rows[0] || null);

    shows.coverage = await runSmugMusicRowsQuery(
      warnings,
      'show SmugMug coverage',
      `SELECT
         count(*)::int AS total_shows,
         count(*) FILTER (WHERE lower(trim(coalesce(smug_sync_status, ''))) IN ('resolved', 'synced'))::int AS resolved_shows,
         count(*) FILTER (WHERE trim(coalesce(smug_sync_status, '')) = '' OR lower(trim(coalesce(smug_sync_status, ''))) IN ('error', 'unresolved', 'no_source_url', 'no_image_key', 'no_album_key', 'skipped_logo_source', 'skipped_venue_logo_source'))::int AS unresolved_shows,
         count(*) FILTER (WHERE lower(trim(coalesce(smug_sync_status, ''))) = 'skipped_logo_source')::int AS skipped_logo_sources,
         count(*) FILTER (WHERE lower(trim(coalesce(smug_sync_status, ''))) = 'skipped_venue_logo_source')::int AS skipped_venue_logo_sources,
         count(*) FILTER (WHERE lower(trim(coalesce(smug_sync_status, ''))) = 'no_image_key')::int AS missing_image_key,
         count(*) FILTER (WHERE lower(trim(coalesce(smug_sync_status, ''))) = 'no_album_key')::int AS missing_album_key,
         count(*) FILTER (WHERE trim(coalesce(album_id, '')) <> '' AND trim(coalesce(cover_image_url, '')) = '')::int AS missing_cover_image,
         count(*) FILTER (WHERE smug_last_synced_at IS NULL)::int AS never_synced,
         count(*) FILTER (WHERE smug_last_synced_at < now() - interval '30 days')::int AS stale_syncs_30d
       FROM music_shows`
    ).then((rows) => rows[0] || null);

    shows.unresolved = {
      count: shows.coverage ? toIntegerCount(shows.coverage.unresolved_shows) : 0,
      samples: await runSmugMusicRowsQuery(
        warnings,
        'show unresolved SmugMug samples',
        `SELECT show_id, name, date, poster, raw_sheet->>'show_url' AS show_url, raw_sheet->>'poster_url' AS poster_url, smug_sync_status, smug_sync_error
         FROM music_shows
         WHERE trim(coalesce(smug_sync_status, '')) = ''
            OR lower(trim(coalesce(smug_sync_status, ''))) IN ('error', 'unresolved', 'no_source_url', 'no_image_key', 'no_album_key', 'skipped_logo_source', 'skipped_venue_logo_source')
         ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
         LIMIT 10`
      )
    };

    shows.missingCoverImage = {
      count: shows.coverage ? toIntegerCount(shows.coverage.missing_cover_image) : 0,
      samples: await runSmugMusicRowsQuery(
        warnings,
        'show missing cover image samples',
        `SELECT show_id, name, date, album_id, gallery_id, poster, smug_sync_status
         FROM music_shows
         WHERE trim(coalesce(album_id, '')) <> ''
           AND trim(coalesce(cover_image_url, '')) = ''
         ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
         LIMIT 10`
      )
    };

    shows.posterFallbackUsage = {
      count: hasRawSheet ? await runSmugMusicCountQuery(
        warnings,
        'show poster fallback candidates',
        `SELECT count(*)::int AS count
         FROM music_shows
         WHERE trim(coalesce(raw_sheet->>'show_url', '')) = ''
           AND trim(coalesce(raw_sheet->>'showurl', '')) = ''
           AND (
             trim(coalesce(poster, '')) <> ''
             OR trim(coalesce(raw_sheet->>'poster_url', '')) <> ''
             OR trim(coalesce(raw_sheet->>'posterurl', '')) <> ''
             OR trim(coalesce(raw_sheet->>'poster', '')) <> ''
           )`
      ) : 0
    };
  } else {
    warnings.push('Missing one or more music_shows SmugMug snapshot columns.');
  }

  return shows;
}

async function buildSmugMusicDiagnosticsResponse() {
  const generated = new Date();
  const warnings = [];
  const snapshotFields = await inspectSmugMusicSnapshotFields(warnings);
  const response = buildAdminResponse({
    route: '/admin/smug/music/diagnostics',
    generated,
    source: 'postgres',
    section: 'music',
    type: 'smug_diagnostics',
    summary: {
      heavyScan: false,
      smugApiCalls: 0,
      snapshotFieldsPresent: snapshotFields.present
    },
    snapshotFields,
    bands: {},
    shows: {},
    warnings
  });

  if (!String(process.env.DATABASE_URL || '').trim()) {
    response.summary.databaseConnected = false;
    response.warnings = warnings;
    return response;
  }

  try {
    await ensureSmugMusicSnapshotColumns(warnings);
    const existingTables = await getExistingPublicTables(SMUG_MUSIC_SNAPSHOT_TABLES);
    const columnsByTable = await getExistingPublicColumns(SMUG_MUSIC_SNAPSHOT_TABLES);
    response.summary.databaseConnected = true;
    response.bands = await buildSmugMusicBandDiagnostics(existingTables, columnsByTable, warnings);
    response.shows = await buildSmugMusicShowDiagnostics(existingTables, columnsByTable, warnings);
    response.summary.bandsMissingSmugFolder = response.bands.missingSmugFolder ? response.bands.missingSmugFolder.count : 0;
    response.summary.bandsMissingSyncData = response.bands.missingSyncData ? response.bands.missingSyncData.count : 0;
    response.summary.showsMissingPosterOrShowUrl = response.shows.missingPosterOrShowUrl ? response.shows.missingPosterOrShowUrl.count : 0;
    response.summary.showsMissingSyncData = response.shows.missingSyncData ? response.shows.missingSyncData.count : 0;
  } catch (err) {
    response.summary.databaseConnected = false;
    warnings.push(`Unable to build SmugMug music diagnostics: ${err && err.message ? err.message : String(err)}`);
  }

  response.warnings = warnings;
  return response;
}
const SMUG_MUSIC_BAND_DISCOVER_DEFAULT_LIMIT = 25;
const SMUG_MUSIC_BAND_DISCOVER_MAX_LIMIT = 100;

function getSmugMusicBandDiscoverLimit(value) {
  const limit = Number(String(value || '').trim());
  if (!Number.isInteger(limit)) return SMUG_MUSIC_BAND_DISCOVER_DEFAULT_LIMIT;
  return Math.min(SMUG_MUSIC_BAND_DISCOVER_MAX_LIMIT, Math.max(1, limit));
}

function buildSmugMusicBandGalleryId(target) {
  if (!target) return '';
  return ['Music', 'Archives', 'Bands', target.region, target.folder].join('/');
}

function getSmugAlbumTitle(album) {
  const keys = ['Title', 'Name', 'NiceName', 'AlbumName', 'title', 'name', 'niceName', 'albumName'];
  for (const key of keys) {
    const value = String(album && album[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function isLikelySmugImageUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return false;
  if (/\.(jpe?g|png|webp)(\?|#|$)/i.test(text)) return true;
  return /photos\.smugmug\.com/i.test(text) && !/\/browse\//i.test(text);
}

function getSmugImageUrlFromObject(source, depth = 0) {
  if (!source || typeof source !== 'object' || depth > 3) return '';

  const preferredKeys = [
    'ThumbnailUrl', 'thumbnailUrl', 'TinyUrl', 'tinyUrl', 'SmallUrl', 'smallUrl',
    'MediumUrl', 'mediumUrl', 'LargeUrl', 'largeUrl', 'XLargeUrl', 'xlargeUrl',
    'ImageUrl', 'ImageURL', 'imageUrl', 'CoverImageUrl', 'CoverImageURL', 'coverImageUrl',
    'OriginalUrl', 'originalUrl', 'ArchivedUri', 'ArchivedURL', 'ArchivedUrl', 'archivedUri', 'archivedUrl'
  ];

  for (const key of preferredKeys) {
    if (isLikelySmugImageUrl(source[key])) return String(source[key]).trim();
  }

  const nestedKeys = ['HighlightImage', 'Image', 'AlbumImage', 'CoverImage', 'LargestImage', 'Uris'];
  for (const key of nestedKeys) {
    const nested = source[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const url = getSmugImageUrlFromObject(item, depth + 1);
        if (url) return url;
      }
    } else {
      const url = getSmugImageUrlFromObject(nested, depth + 1);
      if (url) return url;
    }
  }

  for (const [key, value] of Object.entries(source)) {
    if (/image|thumb|cover|photo|url|uri/i.test(key) && isLikelySmugImageUrl(value)) return String(value).trim();
  }

  return '';
}

function getSmugAlbumCoverImageUrl(album) {
  return getSmugImageUrlFromObject(album);
}

function getSmugAlbumIds(albums) {
  const ids = [];
  (Array.isArray(albums) ? albums : []).forEach((album) => {
    const key = getSmugAlbumKey(album);
    if (key && !ids.includes(key)) ids.push(key);
  });
  return ids;
}

function getSmugFolderObject(json) {
  const resp = json && json.Response ? json.Response : json;
  const folder = resp && (resp.Folder || resp.folder || resp);
  return folder && typeof folder === 'object' ? folder : null;
}

function getSmugFolderUri(folder) {
  const candidates = [
    folder && folder.Uri,
    folder && folder.URI,
    folder && folder.Url,
    folder && folder.URL,
    folder && folder.WebUri,
    folder && folder.WebURL,
    folder && folder.Uris && folder.Uris.Folder && folder.Uris.Folder.Uri,
    folder && folder.Uris && folder.Uris.Folder && folder.Uris.Folder.URI,
    folder && folder.Uris && folder.Uris.Folder && folder.Uris.Folder.Url,
    folder && folder.Uris && folder.Uris.Folder && folder.Uris.Folder.URL
  ];
  return String(candidates.find((value) => String(value || '').trim()) || '').trim();
}

function getSmugFolderKey(folder) {
  const candidates = [
    folder && folder.FolderKey,
    folder && folder.folderKey,
    folder && folder.Key,
    folder && folder.key
  ];
  const direct = String(candidates.find((value) => String(value || '').trim()) || '').trim();
  if (direct) return direct;

  const uri = getSmugFolderUri(folder);
  const match = uri.match(/\/folder\/([^/?#]+)/i);
  return match && match[1] ? String(match[1]).trim() : '';
}

function buildSmugMusicBandFolderDiagnostic(row, target, status, folderMeta, extra = {}) {
  const folder = folderMeta && folderMeta.folder ? folderMeta.folder : null;
  const folderExists = !!(folderMeta && folderMeta.exists);
  return {
    band_id: row.band_id || '',
    band: row.band || '',
    region: row.region || '',
    smug_folder: row.smug_folder || '',
    gallery_id: buildSmugMusicBandGalleryId(target),
    path_attempted: buildSmugMusicBandGalleryId(target),
    folderExists,
    folderUri: folder ? getSmugFolderUri(folder) : '',
    folderKey: folder ? getSmugFolderKey(folder) : '',
    childAlbumsAttempted: !!extra.childAlbumsAttempted,
    childAlbumCount: extra.childAlbumCount == null ? null : toIntegerCount(extra.childAlbumCount),
    status,
    message: extra.message || '',
    diagnostic_slug_candidate: slugifyMusicBandId(row.band || '')
  };
}

async function resolveMusicBandFolderMetadata(target) {
  try {
    const json = await fetchSmugJson(buildMusicBandFolderEndpoint(target));
    const folder = getSmugFolderObject(json);
    return { exists: !!folder, folder, status: folder ? 'folder_exists' : 'folder_not_found', error: null };
  } catch (err) {
    if (isSmugHttpStatusError(err, 404)) {
      return { exists: false, folder: null, status: 'folder_not_found', error: err };
    }
    throw err;
  }
}
function isSmugHttpStatusError(err, status) {
  const message = err && err.message ? err.message : String(err || '');
  return new RegExp(`HTTP\\s+${status}(\\D|$)`, 'i').test(message);
}

function getSmugAlbumPathCandidates(album) {
  const candidates = [
    album && album.WebUri,
    album && album.WebURL,
    album && album.WebUrl,
    album && album.Url,
    album && album.URL,
    album && album.Uri,
    album && album.URI,
    album && album.NiceName,
    album && album.Name,
    album && album.Title,
    album && album.AlbumKey,
    album && album.Key
  ];

  if (album && album.Uris && typeof album.Uris === 'object') {
    Object.values(album.Uris).forEach((value) => {
      if (!value || typeof value !== 'object') return;
      candidates.push(value.Uri, value.URI, value.Url, value.URL);
    });
  }

  return candidates.map((value) => String(value || '').trim()).filter(Boolean);
}

function decodeSmugPathSegment(value) {
  const clean = String(value || '').trim();
  try {
    return decodeURIComponent(clean);
  } catch (_) {
    return clean;
  }
}

function getLastSmugPathSegment(value) {
  const clean = String(value || '').split('?')[0].split('#')[0].replace(/\/+$/g, '');
  const parts = clean.split('/').filter(Boolean);
  return decodeSmugPathSegment(parts[parts.length - 1] || clean);
}

function albumMatchesDirectMusicBandTarget(album, target) {
  const expected = String(target && target.folder || '').trim();
  if (!expected) return false;
  const expectedPath = ['Music', 'Archives', 'Bands', target.region, target.folder].map(String).join('/');

  return getSmugAlbumPathCandidates(album).some((candidate) => {
    const decoded = decodeSmugPathSegment(candidate);
    if (decoded === expectedPath || decoded.endsWith(`/${expectedPath}`)) return true;
    return getLastSmugPathSegment(decoded) === expected;
  });
}

async function resolveDirectMusicBandAlbum(target) {
  const json = await fetchSmugJson(buildMusicBandParentAlbumsEndpoint(target));
  return getSmugAlbums(json).filter((album) => albumMatchesDirectMusicBandTarget(album, target));
}
function buildSmugMusicBandDuplicateSample(row, albums) {
  return {
    band_id: row.band_id || '',
    band: row.band || '',
    region: row.region || '',
    smug_folder: row.smug_folder || '',
    diagnostic_slug_candidate: slugifyMusicBandId(row.band || ''),
    match_count: Array.isArray(albums) ? albums.length : 0,
    albums: (Array.isArray(albums) ? albums : []).slice(0, 10).map((album) => ({
      album_id: getSmugAlbumKey(album),
      title: getSmugAlbumTitle(album)
    }))
  };
}

async function getSmugMusicBandDiscoverCandidates(limit, refresh) {
  const where = [
    "trim(coalesce(smug_folder, '')) <> ''",
    "trim(coalesce(region, '')) <> ''"
  ];

  if (!refresh) {
    where.push(`(
      smug_last_synced_at IS NULL
      OR trim(coalesce(smug_sync_status, '')) = ''
      OR lower(trim(coalesce(smug_sync_status, ''))) IN ('error', 'unmatched', 'folder_not_found', 'folder_exists_no_child_albums', 'duplicate_match', 'duplicate_direct_album', 'missing_region', 'missing_smug_folder')
    )`);
  }

  const countResult = await dbPool.query(`
    SELECT count(*)::int AS count
    FROM music_bands
    WHERE ${where.join(' AND ')}
  `);

  const rowsResult = await dbPool.query(`
    SELECT id, band_id, band, region, smug_folder, logo_url, gallery_id, album_id, cover_image_url, photo_count, smug_last_synced_at, smug_sync_status
    FROM music_bands
    WHERE ${where.join(' AND ')}
    ORDER BY band ASC, id ASC
    LIMIT $1
  `, [limit]);

  return {
    eligible: toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].count),
    rows: rowsResult.rows || []
  };
}

async function getSmugMusicBandMissingFolderDiagnostics() {
  const countResult = await dbPool.query(`
    SELECT count(*)::int AS count
    FROM music_bands
    WHERE trim(coalesce(smug_folder, '')) = ''
  `);
  const sampleResult = await dbPool.query(`
    SELECT band_id, band, region, smug_folder
    FROM music_bands
    WHERE trim(coalesce(smug_folder, '')) = ''
    ORDER BY band ASC, id ASC
    LIMIT 10
  `);
  return {
    count: toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].count),
    samples: sampleResult.rows || []
  };
}

async function getSmugMusicBandMissingRegionDiagnostics() {
  const countResult = await dbPool.query(`
    SELECT count(*)::int AS count
    FROM music_bands
    WHERE trim(coalesce(smug_folder, '')) <> ''
      AND trim(coalesce(region, '')) = ''
  `);
  const sampleResult = await dbPool.query(`
    SELECT band_id, band, region, smug_folder
    FROM music_bands
    WHERE trim(coalesce(smug_folder, '')) <> ''
      AND trim(coalesce(region, '')) = ''
    ORDER BY band ASC, id ASC
    LIMIT 10
  `);
  return {
    count: toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].count),
    samples: sampleResult.rows || []
  };
}

async function updateSmugMusicBandSnapshot(row, snapshot) {
  const result = await dbPool.query(`
    UPDATE music_bands
    SET gallery_id = $2,
        album_id = $3,
        cover_image_url = $4,
        photo_count = $5,
        smug_last_synced_at = NOW(),
        smug_sync_status = $6,
        smug_sync_error = $7,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, band_id, band, gallery_id, album_id, cover_image_url, photo_count, smug_last_synced_at, smug_sync_status, smug_sync_error
  `, [
    row.id,
    snapshot.gallery_id || null,
    snapshot.album_id || null,
    snapshot.cover_image_url || null,
    toIntegerCount(snapshot.photo_count),
    snapshot.smug_sync_status || 'synced',
    snapshot.smug_sync_error || null
  ]);
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

async function updateSmugMusicBandSyncError(row, status, error) {
  const message = getSafeErrorMessage(error).slice(0, 500);
  const result = await dbPool.query(`
    UPDATE music_bands
    SET smug_last_synced_at = NOW(),
        smug_sync_status = $2,
        smug_sync_error = $3,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, band_id, band, gallery_id, album_id, cover_image_url, photo_count, smug_last_synced_at, smug_sync_status, smug_sync_error
  `, [row.id, status || 'error', message || null]);
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

async function discoverSmugMusicBand(row) {
  const target = getMusicBandSmugTarget(row);
  if (!target) {
    const status = String(row.smug_folder || '').trim() ? 'missing_region' : 'missing_smug_folder';
    const updated = await updateSmugMusicBandSyncError(row, status, new Error(`Missing ${status === 'missing_region' ? 'region' : 'smug_folder'}.`));
    return {
      status,
      updated,
      diagnostic: {
        band_id: row.band_id || '',
        band: row.band || '',
        region: row.region || '',
        smug_folder: row.smug_folder || '',
        diagnostic_slug_candidate: slugifyMusicBandId(row.band || '')
      }
    };
  }

  const galleryId = buildSmugMusicBandGalleryId(target);
  const folderMeta = await resolveMusicBandFolderMetadata(target);

  if (!folderMeta.exists) {
    const message = folderMeta.error
      ? `SmugMug folder not found for ${galleryId}: ${getSafeErrorMessage(folderMeta.error)}`
      : `SmugMug folder not found for ${galleryId}.`;
    const updated = await updateSmugMusicBandSnapshot(row, {
      gallery_id: galleryId,
      album_id: null,
      cover_image_url: row.cover_image_url || row.logo_url || null,
      photo_count: 0,
      smug_sync_status: 'folder_not_found',
      smug_sync_error: message
    });

    return {
      status: 'folder_not_found',
      updated,
      diagnostic: buildSmugMusicBandFolderDiagnostic(row, target, 'folder_not_found', folderMeta, {
        childAlbumsAttempted: false,
        childAlbumCount: null,
        message
      })
    };
  }

  let albums = [];
  let childAlbumsError = null;

  try {
    const json = await fetchSmugJson(buildMusicBandAlbumsEndpoint(target));
    albums = getSmugAlbums(json);
  } catch (err) {
    childAlbumsError = err;
  }

  if (!albums.length) {
    const message = childAlbumsError
      ? `SmugMug folder exists but child albums lookup failed for ${galleryId}: ${getSafeErrorMessage(childAlbumsError)}`
      : `SmugMug folder exists but returned no child albums for ${galleryId}.`;
    const updated = await updateSmugMusicBandSnapshot(row, {
      gallery_id: galleryId,
      album_id: null,
      cover_image_url: row.cover_image_url || row.logo_url || null,
      photo_count: 0,
      smug_sync_status: 'folder_exists_no_child_albums',
      smug_sync_error: message
    });

    return {
      status: 'folder_exists_no_child_albums',
      updated,
      diagnostic: buildSmugMusicBandFolderDiagnostic(row, target, 'folder_exists_no_child_albums', folderMeta, {
        childAlbumsAttempted: true,
        childAlbumCount: childAlbumsError ? null : albums.length,
        message
      })
    };
  }

  const albumIds = getSmugAlbumIds(albums);
  const photoCount = await sumSmugAlbumImageCounts(albums);
  const coverImageUrl = albums.map(getSmugAlbumCoverImageUrl).find(Boolean) || row.cover_image_url || row.logo_url || null;
  const duplicateMatch = albums.length > 1;
  const updated = await updateSmugMusicBandSnapshot(row, {
    gallery_id: galleryId,
    album_id: albumIds.join(';') || null,
    cover_image_url: coverImageUrl,
    photo_count: photoCount == null ? 0 : photoCount,
    smug_sync_status: duplicateMatch ? 'duplicate_match' : 'synced',
    smug_sync_error: duplicateMatch ? `Multiple SmugMug albums found for ${galleryId}.` : null
  });

  return {
    status: duplicateMatch ? 'duplicate_match' : 'synced',
    updated,
    diagnostic: duplicateMatch ? buildSmugMusicBandDuplicateSample(row, albums) : null
  };
}
function buildSmugMusicBandDiscoverResultItem(row) {
  return {
    band_id: row && row.band_id ? row.band_id : '',
    band: row && row.band ? row.band : '',
    gallery_id: row && row.gallery_id ? row.gallery_id : null,
    album_id: row && row.album_id ? row.album_id : null,
    cover_image_url: row && row.cover_image_url ? row.cover_image_url : null,
    photo_count: toIntegerCount(row && row.photo_count),
    smug_last_synced_at: row && row.smug_last_synced_at ? new Date(row.smug_last_synced_at).toISOString() : null,
    smug_sync_status: row && row.smug_sync_status ? row.smug_sync_status : ''
  };
}

async function runSmugMusicBandDiscover(query = {}) {
  const generated = new Date();
  const refresh = query.refresh === '1' || query.force === '1';
  const limit = getSmugMusicBandDiscoverLimit(query.limit);
  const warnings = [];
  const config = getSmugMugConfigDiagnostics();

  if (!String(process.env.DATABASE_URL || '').trim()) {
    return buildAdminResponse({
      ok: false,
      route: '/admin/smug/music/bands/discover',
      generated,
      source: 'smugmug',
      section: 'music',
      type: 'smug_band_discovery',
      error: 'DATABASE_NOT_CONFIGURED',
      message: 'DATABASE_URL is required for SmugMug band discovery.',
      warnings
    });
  }

  if (!config.configured) {
    return buildAdminResponse({
      ok: false,
      route: '/admin/smug/music/bands/discover',
      generated,
      source: 'smugmug',
      section: 'music',
      type: 'smug_band_discovery',
      error: 'SMUGMUG_NOT_CONFIGURED',
      message: 'SMUG_API_KEY and SMUG_NICKNAME are required for SmugMug band discovery.',
      missing: config.missing,
      warnings
    });
  }

  const snapshotFields = await inspectSmugMusicSnapshotFields(warnings);
  if (!snapshotFields.present) {
    return buildAdminResponse({
      ok: false,
      route: '/admin/smug/music/bands/discover',
      generated,
      source: 'smugmug',
      section: 'music',
      type: 'smug_band_discovery',
      error: 'SNAPSHOT_FIELDS_MISSING',
      message: 'Music band SmugMug snapshot fields are missing. Restart/deploy so schema.sql can apply.',
      snapshotFields,
      warnings
    });
  }

  const missingSmugFolder = await getSmugMusicBandMissingFolderDiagnostics();
  const missingRegion = await getSmugMusicBandMissingRegionDiagnostics();
  const candidates = await getSmugMusicBandDiscoverCandidates(limit, refresh);
  const unmatchedBands = [];
  const folderNotFoundBands = [];
  const folderExistsNoChildAlbums = [];
  const duplicateMatches = [];
  const failures = [];
  const updatedItems = [];
  const counters = {
    scanned: candidates.rows.length,
    attempted: 0,
    matched: 0,
    unmatched: 0,
    folderNotFound: 0,
    folderExistsNoChildAlbums: 0,
    duplicateMatches: 0,
    failed: 0,
    recordsUpdated: 0
  };

  const results = await mapWithConcurrency(candidates.rows, SMUG_REQUEST_CONCURRENCY, async (row) => {
    counters.attempted += 1;
    try {
      const result = await discoverSmugMusicBand(row);
      if (result.updated) {
        counters.recordsUpdated += 1;
        updatedItems.push(buildSmugMusicBandDiscoverResultItem(result.updated));
      }
      if (result.status === 'synced' || result.status === 'matched_direct_album') counters.matched += 1;
      if (result.status === 'duplicate_match' || result.status === 'duplicate_direct_album') {
        counters.matched += 1;
        counters.duplicateMatches += 1;
        if (result.diagnostic) duplicateMatches.push(result.diagnostic);
      }
      if (result.status === 'unmatched') {
        counters.unmatched += 1;
        if (result.diagnostic) unmatchedBands.push(result.diagnostic);
      }
      if (result.status === 'folder_not_found') {
        counters.unmatched += 1;
        counters.folderNotFound += 1;
        if (result.diagnostic) folderNotFoundBands.push(result.diagnostic);
      }
      if (result.status === 'folder_exists_no_child_albums') {
        counters.unmatched += 1;
        counters.folderExistsNoChildAlbums += 1;
        if (result.diagnostic) folderExistsNoChildAlbums.push(result.diagnostic);
      }
      return result;
    } catch (err) {
      counters.failed += 1;
      const updated = await updateSmugMusicBandSyncError(row, 'error', err);
      if (updated) {
        counters.recordsUpdated += 1;
        updatedItems.push(buildSmugMusicBandDiscoverResultItem(updated));
      }
      failures.push({
        band_id: row.band_id || '',
        band: row.band || '',
        region: row.region || '',
        smug_folder: row.smug_folder || '',
        error: getSafeErrorMessage(err),
        diagnostic_slug_candidate: slugifyMusicBandId(row.band || '')
      });
      return { status: 'error', error: getSafeErrorMessage(err) };
    }
  });

  return buildAdminResponse({
    route: '/admin/smug/music/bands/discover',
    generated,
    source: 'smugmug',
    section: 'music',
    type: 'smug_band_discovery',
    refresh,
    limit,
    concurrency: SMUG_REQUEST_CONCURRENCY,
    eligible: candidates.eligible,
    scanned: counters.scanned,
    attempted: counters.attempted,
    matched: counters.matched,
    unmatched: counters.unmatched,
    folderNotFound: counters.folderNotFound,
    folderExistsNoChildAlbums: counters.folderExistsNoChildAlbums,
    duplicateMatches: counters.duplicateMatches,
    failed: counters.failed,
    recordsUpdated: counters.recordsUpdated,
    summary: {
      recordsUpdated: counters.recordsUpdated,
      matched: counters.matched,
      unmatched: counters.unmatched,
      folderNotFound: counters.folderNotFound,
      folderExistsNoChildAlbums: counters.folderExistsNoChildAlbums,
      duplicateMatches: counters.duplicateMatches,
      missingSmugFolder: missingSmugFolder.count,
      missingRegion: missingRegion.count,
      failed: counters.failed,
      heavyScan: false
    },
    diagnostics: {
      missingSmugFolder,
      missingRegion,
      unmatchedBands: unmatchedBands.slice(0, 25),
      folderNotFoundBands: folderNotFoundBands.slice(0, 25),
      folderExistsNoChildAlbums: folderExistsNoChildAlbums.slice(0, 25),
      duplicateMatches: duplicateMatches.slice(0, 25),
      failures: failures.slice(0, 25)
    },
    updated: updatedItems.slice(0, 25),
    resultCount: Array.isArray(results) ? results.length : 0,
    warnings
  });
}

async function handleSmugMusicBandDiscoverRequest(req, res) {
  let importLock = null;
  let response = null;

  try {
    const config = getSmugMugConfigDiagnostics();
    if (!String(process.env.DATABASE_URL || '').trim() || !config.configured) {
      response = await runSmugMusicBandDiscover(req.query || {});
      return res.status(response.ok ? 200 : 400).json(response);
    }

    const lockAttempt = await acquireImportLock({
      section: 'music',
      category: 'smug_bands_discover',
      owner: getImportLockOwner(),
      meta: {
        route: '/admin/smug/music/bands/discover',
        refresh: req.query && req.query.refresh === '1'
      }
    });

    if (lockAttempt && lockAttempt.acquired === false) {
      return res.status(409).json(buildAdminResponse({
        ok: false,
        route: '/admin/smug/music/bands/discover',
        source: 'smugmug',
        section: 'music',
        type: 'smug_band_discovery',
        locked: true,
        message: 'Import already running',
        lock: lockAttempt.lock
      }));
    }

    importLock = lockAttempt && lockAttempt.lock ? lockAttempt.lock : null;
    response = await runSmugMusicBandDiscover(req.query || {});
    const released = await releaseImportLock(importLock && importLock.id, response.ok ? 'completed' : 'failed', {
      completedAt: new Date().toISOString(),
      status: response.ok ? 'completed' : 'failed',
      route: '/admin/smug/music/bands/discover',
      recordsUpdated: response.recordsUpdated || 0
    });
    if (released) response.importLock = released;
    return res.status(response.ok ? 200 : 400).json(response);
  } catch (err) {
    const released = await releaseImportLock(importLock && importLock.id, 'failed', {
      completedAt: new Date().toISOString(),
      status: 'failed',
      error: getSafeErrorMessage(err),
      route: '/admin/smug/music/bands/discover'
    });
    const errorResponse = buildAdminError('/admin/smug/music/bands/discover', err, {
      source: 'smugmug',
      section: 'music',
      type: 'smug_band_discovery',
      error: 'SMUG_BAND_DISCOVERY_ERROR'
    });
    if (released) errorResponse.importLock = released;
    return res.status(500).json(errorResponse);
  }
}
const SMUG_MUSIC_SHOW_RESOLVE_DEFAULT_LIMIT = 25;
const SMUG_MUSIC_SHOW_RESOLVE_MAX_LIMIT = 100;

function getSmugMusicShowResolveLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return SMUG_MUSIC_SHOW_RESOLVE_DEFAULT_LIMIT;
  return Math.min(SMUG_MUSIC_SHOW_RESOLVE_MAX_LIMIT, Math.max(1, parsed));
}

function normalizeSmugImageKey(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  return /^i-/i.test(clean) ? clean : `i-${clean}`;
}

function getBareSmugImageKey(value) {
  return String(value || '').trim().replace(/^i-/i, '');
}

function buildSmugImageDetailEndpointFromSegment(segment) {
  const clean = String(segment || '').trim();
  if (!clean) return '';
  return `/image/${encodeURIComponent(clean)}?_accept=application/json&_verbosity=1&_expand=Image`;
}

function buildSmugImageDetailEndpoints(imageKey) {
  const normalizedKey = normalizeSmugImageKey(imageKey);
  if (!normalizedKey) return [];

  const bareKey = getBareSmugImageKey(normalizedKey);
  const candidates = [
    normalizedKey,
    `${normalizedKey}-0`,
    bareKey ? `${bareKey}-0` : '',
    bareKey
  ];
  const seen = new Set();
  return candidates
    .map(buildSmugImageDetailEndpointFromSegment)
    .filter((endpoint) => {
      if (!endpoint || seen.has(endpoint)) return false;
      seen.add(endpoint);
      return true;
    });
}

function buildSmugImageDetailEndpoint(imageKey) {
  return buildSmugImageDetailEndpoints(imageKey)[0] || '';
}

async function fetchSmugImageDetail(imageKey) {
  const endpoints = buildSmugImageDetailEndpoints(imageKey);
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const json = await fetchSmugJson(endpoint);
      return { json, endpoint, endpoints };
    } catch (err) {
      lastError = err;
      if (!isSmugHttpStatusError(err, 404)) throw err;
    }
  }

  const message = lastError && lastError.message ? lastError.message : 'No SmugMug image detail endpoints were available.';
  throw new Error(`${message} Tried image endpoints: ${endpoints.join(', ')}`);
}

function extractSmugImageKeyFromUrl(url) {
  const clean = String(url || '').trim();
  if (!clean) return '';

  const direct = clean.match(/\b\/i-([A-Za-z0-9]+)\b/i);
  if (direct && direct[1]) return normalizeSmugImageKey(direct[1]);

  const fileStyle = clean.match(/\/([A-Za-z0-9]+)-[A-Za-z0-9]+\.(?:jpe?g|png|gif|webp)(?:\?|#|$)/i);
  if (fileStyle && fileStyle[1]) return normalizeSmugImageKey(fileStyle[1]);

  const segmentStyle = clean.match(/\/\d+-([A-Za-z0-9]+)(?:\/|$)/i);
  if (segmentStyle && segmentStyle[1]) return normalizeSmugImageKey(segmentStyle[1]);

  return '';
}

function extractSmugAlbumKeyFromImageDetail(json) {
  const resp = json && json.Response ? json.Response : json;
  const img = resp && (resp.Image || resp.image || resp);
  if (!img || typeof img !== 'object') return '';

  if (img.AlbumKey) return String(img.AlbumKey).trim();
  if (img.albumKey) return String(img.albumKey).trim();
  if (img.Album && img.Album.AlbumKey) return String(img.Album.AlbumKey).trim();
  if (img.album && img.album.albumKey) return String(img.album.albumKey).trim();

  const directUri =
    (img.Uris && img.Uris.Album && (img.Uris.Album.Uri || img.Uris.Album.URI || img.Uris.Album.Url || img.Uris.Album.URL)) ||
    img.AlbumUri ||
    img.AlbumUrl ||
    img.AlbumURL ||
    '';
  const directMatch = String(directUri || '').match(/\/album\/([^/?#]+)/i);
  if (directMatch && directMatch[1]) return String(directMatch[1]).trim();

  try {
    const stack = [resp, img, img.Uris].filter((node) => node && typeof node === 'object');
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);

      const directKey = cur.AlbumKey || cur.albumKey || '';
      if (typeof directKey === 'string' && directKey.trim()) return directKey.trim();

      const uriCandidates = [cur.Uri, cur.URI, cur.Url, cur.URL, cur.AlbumUri, cur.AlbumURL, cur.AlbumUrl];
      for (const candidate of uriCandidates) {
        const match = String(candidate || '').match(/\/album\/([^/?#]+)/i);
        if (match && match[1]) return String(match[1]).trim();
      }

      Object.values(cur).forEach((value) => {
        if (value && typeof value === 'object') stack.push(value);
      });
    }
  } catch (_) {
    return '';
  }

  return '';
}

function getSmugMusicShowRawField(row, key) {
  const raw = row && row.raw_sheet && typeof row.raw_sheet === 'object' ? row.raw_sheet : {};
  return String(raw[key] || '').trim();
}

function decodeSmugSourceUrlForChecks(url) {
  const clean = String(url || '').trim();
  const lower = clean.toLowerCase();
  try {
    return decodeURIComponent(lower);
  } catch (_) {
    return lower;
  }
}

function isSmugMusicShowVenueLogoSourceUrl(url) {
  const decoded = decodeSmugSourceUrlForChecks(url);
  if (!decoded) return false;
  return decoded.includes('/music/venue-logos/') ||
    decoded.includes('/venue-logos/') ||
    decoded.includes('venue-logo') ||
    decoded.includes('venue_logo');
}

function isSmugMusicShowLogoSourceUrl(url) {
  const decoded = decodeSmugSourceUrlForChecks(url);
  if (!decoded) return false;

  return isSmugMusicShowVenueLogoSourceUrl(url) ||
    decoded.includes('/music/band-logos/') ||
    decoded.includes('/band-logos/') ||
    decoded.includes('band-logo') ||
    decoded.includes('band_logo') ||
    decoded.includes('logo');
}

function getSmugMusicShowSourceSkip(candidate) {
  const url = String(candidate && candidate.url || '').trim();
  if (!url) return null;
  if (isSmugMusicShowVenueLogoSourceUrl(url)) {
    return { status: 'skipped_venue_logo_source', field: candidate.field, url };
  }
  if (isSmugMusicShowLogoSourceUrl(url)) {
    return { status: 'skipped_logo_source', field: candidate.field, url };
  }
  return null;
}

function isSmugMusicShowPosterField(field) {
  return /(^|\.)poster(_url|url)?$/i.test(String(field || ''));
}

function getSmugMusicShowSourceSelection(row) {
  const showUrlCandidates = [
    { field: 'show_url', url: row && row.show_url },
    { field: 'raw_sheet.show_url', url: getSmugMusicShowRawField(row, 'show_url') },
    { field: 'raw_sheet.showurl', url: getSmugMusicShowRawField(row, 'showurl') }
  ];
  const posterCandidates = [
    { field: 'poster_url', url: row && row.poster_url },
    { field: 'raw_sheet.poster_url', url: getSmugMusicShowRawField(row, 'poster_url') },
    { field: 'raw_sheet.posterurl', url: getSmugMusicShowRawField(row, 'posterurl') },
    { field: 'poster', url: row && row.poster },
    { field: 'raw_sheet.poster', url: getSmugMusicShowRawField(row, 'poster') }
  ];
  let skippedVenueLogoSource = null;
  let skippedLogoSource = null;

  const chooseCandidate = (candidate, sourceType) => {
    const url = String(candidate.url || '').trim();
    if (!url) return null;
    const skip = getSmugMusicShowSourceSkip({ field: candidate.field, url });
    if (skip) {
      if (skip.status === 'skipped_venue_logo_source' && !skippedVenueLogoSource) skippedVenueLogoSource = skip;
      if (skip.status === 'skipped_logo_source' && !skippedLogoSource) skippedLogoSource = skip;
      return null;
    }
    return {
      status: 'selected',
      url,
      field: candidate.field,
      source_type: sourceType,
      poster_fallback: sourceType === 'poster' || isSmugMusicShowPosterField(candidate.field),
      skipped_url: skippedVenueLogoSource ? skippedVenueLogoSource.url : (skippedLogoSource ? skippedLogoSource.url : ''),
      skipped_field: skippedVenueLogoSource ? skippedVenueLogoSource.field : (skippedLogoSource ? skippedLogoSource.field : ''),
      skipped_status: skippedVenueLogoSource ? skippedVenueLogoSource.status : (skippedLogoSource ? skippedLogoSource.status : '')
    };
  };

  for (const candidate of showUrlCandidates) {
    const selected = chooseCandidate(candidate, 'show_url');
    if (selected) return selected;
  }

  for (const candidate of posterCandidates) {
    const selected = chooseCandidate(candidate, 'poster');
    if (selected) return selected;
  }

  if (skippedVenueLogoSource) {
    return {
      status: 'skipped_venue_logo_source',
      url: '',
      field: '',
      skipped_url: skippedVenueLogoSource.url,
      skipped_field: skippedVenueLogoSource.field,
      skipped_status: skippedVenueLogoSource.status,
      poster_fallback: false
    };
  }

  if (skippedLogoSource) {
    return {
      status: 'skipped_logo_source',
      url: '',
      field: '',
      skipped_url: skippedLogoSource.url,
      skipped_field: skippedLogoSource.field,
      skipped_status: skippedLogoSource.status,
      poster_fallback: false
    };
  }

  return { status: 'no_source_url', url: '', field: '', skipped_url: '', poster_fallback: false };
}
function getSmugMusicShowSourceUrl(row) {
  return getSmugMusicShowSourceSelection(row).url;
}

function buildSmugMusicShowResolveDiagnostic(row, status, extra = {}) {
  const sourceSelection = getSmugMusicShowSourceSelection(row);
  const sourceUrl = extra.source_url || sourceSelection.url || sourceSelection.skipped_url || '';
  return {
    show_id: row && row.show_id != null ? toIntegerCount(row.show_id) : null,
    name: row && row.name ? row.name : '',
    date: row && row.date ? row.date : '',
    poster: row && row.poster ? row.poster : '',
    source_url: sourceUrl,
    source_field: extra.source_field || sourceSelection.field || sourceSelection.skipped_field || '',
    image_key: extra.image_key || extractSmugImageKeyFromUrl(sourceUrl) || '',
    image_endpoint: extra.image_endpoint || (extra.image_key ? buildSmugImageDetailEndpoint(extra.image_key) : ''),
    album_id: extra.album_id || '',
    status,
    message: extra.message || ''
  };
}
function getSmugAlbumObject(json) {
  const albums = getSmugAlbums(json);
  if (albums.length) return albums[0];

  const resp = json && json.Response ? json.Response : json;
  const album = resp && (resp.Album || resp.album || resp);
  return album && typeof album === 'object' ? album : null;
}

async function fetchSmugAlbumMetadata(albumKey) {
  const cleanKey = String(albumKey || '').trim();
  if (!cleanKey) return null;
  const json = await fetchSmugJson(`/album/${encodeURIComponent(cleanKey)}?_accept=application/json&_verbosity=1&_expand=HighlightImage`);
  return getSmugAlbumObject(json);
}

function getSmugMusicShowResolvedCoverImageUrl(album, sourceUrl, row) {
  const albumCover = getSmugAlbumCoverImageUrl(album);
  if (isUsableShowImageUrl(albumCover)) return String(albumCover).trim();
  if (isUsableShowImageUrl(sourceUrl)) return String(sourceUrl).trim();
  if (row && isUsableShowImageUrl(row.poster)) return String(row.poster).trim();
  return null;
}

function buildSmugMusicShowStatsSnapshot(row, photoCount) {
  const stats = row && row.stats && typeof row.stats === 'object' && !Array.isArray(row.stats)
    ? { ...row.stats }
    : {};
  const count = toIntegerCount(photoCount);
  stats.photoCount = count;
  addMusicCanonicalAliases(stats, {
    photo_count: count
  });
  return stats;
}
async function getSmugMusicShowResolveCandidates(limit, refresh) {
  const sourceWhere = `(
    trim(coalesce(poster, '')) <> ''
    OR trim(coalesce(raw_sheet->>'show_url', '')) <> ''
    OR trim(coalesce(raw_sheet->>'showurl', '')) <> ''
    OR trim(coalesce(raw_sheet->>'poster_url', '')) <> ''
    OR trim(coalesce(raw_sheet->>'posterurl', '')) <> ''
    OR trim(coalesce(raw_sheet->>'poster', '')) <> ''
  )`;
  const where = [sourceWhere];

  if (!refresh) {
    where.push(`(
      smug_last_synced_at IS NULL
      OR trim(coalesce(smug_sync_status, '')) = ''
      OR lower(trim(coalesce(smug_sync_status, ''))) IN ('error', 'unresolved', 'missing_media', 'no_source_url', 'no_image_key', 'no_album_key')
    )`);
  }

  return dbPool.query(`
    SELECT id, show_id, name, date, poster, raw_sheet, stats, gallery_id, album_id, cover_image_url, photo_count, smug_last_synced_at, smug_sync_status
    FROM music_shows
    WHERE ${where.join(' AND ')}
    ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
    LIMIT $1
  `, [limit]);
}

async function getSmugMusicShowMissingSourceDiagnostics() {
  const missingWhere = `
    trim(coalesce(poster, '')) = ''
    AND trim(coalesce(raw_sheet->>'show_url', '')) = ''
    AND trim(coalesce(raw_sheet->>'showurl', '')) = ''
    AND trim(coalesce(raw_sheet->>'poster_url', '')) = ''
    AND trim(coalesce(raw_sheet->>'posterurl', '')) = ''
    AND trim(coalesce(raw_sheet->>'poster', '')) = ''
  `;
  const countResult = await dbPool.query(`SELECT count(*)::int AS count FROM music_shows WHERE ${missingWhere}`);
  const sampleResult = await dbPool.query(`
    SELECT show_id, name, date, poster, raw_sheet->>'show_url' AS show_url, raw_sheet->>'poster_url' AS poster_url
    FROM music_shows
    WHERE ${missingWhere}
    ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
    LIMIT 25
  `);
  return {
    count: toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].count),
    samples: sampleResult.rows || []
  };
}

async function updateSmugMusicShowSnapshot(row, snapshot) {
  const stats = snapshot.stats && typeof snapshot.stats === 'object'
    ? snapshot.stats
    : buildSmugMusicShowStatsSnapshot(row, snapshot.photo_count);
  const result = await dbPool.query(`
    UPDATE music_shows
    SET gallery_id = $2,
        album_id = $3,
        cover_image_url = $4,
        photo_count = $5,
        smug_last_synced_at = NOW(),
        smug_sync_status = $6,
        smug_sync_error = $7,
        stats = $8::jsonb,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, show_id, name, date, poster, gallery_id, album_id, cover_image_url, photo_count, stats, smug_last_synced_at, smug_sync_status, smug_sync_error
  `, [
    row.id,
    snapshot.gallery_id || null,
    snapshot.album_id || null,
    snapshot.cover_image_url || null,
    toIntegerCount(snapshot.photo_count),
    snapshot.smug_sync_status || 'resolved',
    snapshot.smug_sync_error || null,
    stringifyDbJson(stats)
  ]);
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

async function updateSmugMusicShowSyncError(row, status, error) {
  const result = await dbPool.query(`
    UPDATE music_shows
    SET smug_last_synced_at = NOW(),
        smug_sync_status = $2,
        smug_sync_error = $3,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, show_id, name, date, poster, gallery_id, album_id, cover_image_url, photo_count, stats, smug_last_synced_at, smug_sync_status, smug_sync_error
  `, [
    row.id,
    status || 'error',
    getSafeErrorMessage(error)
  ]);
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

async function resolveSmugMusicShowAlbum(row) {
  const sourceSelection = getSmugMusicShowSourceSelection(row);

  if (sourceSelection.status === 'skipped_venue_logo_source' || sourceSelection.status === 'skipped_logo_source') {
    const status = sourceSelection.status;
    const message = status === 'skipped_venue_logo_source'
      ? 'Skipped Music Venue logo source; no SmugMug lookup attempted.'
      : 'Skipped logo-style poster source; no SmugMug lookup attempted.';
    const updated = await updateSmugMusicShowSyncError(row, status, new Error(message));
    return {
      status,
      updated,
      diagnostic: buildSmugMusicShowResolveDiagnostic(row, status, {
        source_url: sourceSelection.skipped_url,
        source_field: sourceSelection.skipped_field,
        message
      })
    };
  }

  if (!sourceSelection.url) {
    const updated = await updateSmugMusicShowSyncError(row, 'no_source_url', new Error('Missing show_url/poster_url source.'));
    return { status: 'no_source_url', updated, diagnostic: buildSmugMusicShowResolveDiagnostic(row, 'no_source_url') };
  }

  const sourceUrl = sourceSelection.url;
  const imageKey = extractSmugImageKeyFromUrl(sourceUrl);
  if (!imageKey) {
    const updated = await updateSmugMusicShowSyncError(row, 'no_image_key', new Error('Unable to extract SmugMug ImageKey from show_url/poster_url.'));
    return { status: 'no_image_key', updated, diagnostic: buildSmugMusicShowResolveDiagnostic(row, 'no_image_key', { source_url: sourceUrl, source_field: sourceSelection.field }) };
  }

  const imageDetail = await fetchSmugImageDetail(imageKey);
  const imageEndpoint = imageDetail.endpoint;
  const imageJson = imageDetail.json;
  const albumKey = extractSmugAlbumKeyFromImageDetail(imageJson);
  if (!albumKey) {
    const updated = await updateSmugMusicShowSyncError(row, 'no_album_key', new Error('SmugMug image detail did not include a parent AlbumKey.'));
    return { status: 'no_album_key', updated, diagnostic: buildSmugMusicShowResolveDiagnostic(row, 'no_album_key', { source_url: sourceUrl, source_field: sourceSelection.field, image_key: imageKey, image_endpoint: imageEndpoint, image_endpoints: imageDetail.endpoints }) };
  }

  const album = await fetchSmugAlbumMetadata(albumKey);
  const albumPhotoCount = getSmugAlbumImageCount(album);
  const photoCount = albumPhotoCount == null ? await getSmugAlbumTotalPhotos(album || { AlbumKey: albumKey }) : albumPhotoCount;
  const coverImageUrl = getSmugMusicShowResolvedCoverImageUrl(album, sourceUrl, row);
  const stats = buildSmugMusicShowStatsSnapshot(row, photoCount == null ? 0 : photoCount);
  const updated = await updateSmugMusicShowSnapshot(row, {
    gallery_id: albumKey,
    album_id: albumKey,
    cover_image_url: coverImageUrl,
    photo_count: photoCount == null ? 0 : photoCount,
    stats,
    smug_sync_status: 'resolved',
    smug_sync_error: null
  });

  return {
    status: 'resolved',
    updated,
    posterFallbackUsed: !!sourceSelection.poster_fallback,
    missingCoverImage: !coverImageUrl,
    diagnostic: buildSmugMusicShowResolveDiagnostic(row, 'resolved', {
      source_url: sourceUrl,
      source_field: sourceSelection.field,
      image_key: imageKey,
      album_id: albumKey,
      message: coverImageUrl ? '' : 'Album resolved, but no cover image was available from album metadata or source URL.'
    })
  };
}
function buildSmugMusicShowResolveResultItem(row) {
  return {
    show_id: row && row.show_id != null ? toIntegerCount(row.show_id) : null,
    name: row && row.name ? row.name : '',
    date: row && row.date ? row.date : '',
    gallery_id: row && row.gallery_id ? row.gallery_id : null,
    album_id: row && row.album_id ? row.album_id : null,
    cover_image_url: row && row.cover_image_url ? row.cover_image_url : null,
    photo_count: toIntegerCount(row && row.photo_count),
    stats: row && row.stats && typeof row.stats === 'object' ? row.stats : {},
    smug_last_synced_at: row && row.smug_last_synced_at ? new Date(row.smug_last_synced_at).toISOString() : null,
    smug_sync_status: row && row.smug_sync_status ? row.smug_sync_status : '',
    smug_sync_error: row && row.smug_sync_error ? row.smug_sync_error : null
  };
}

async function runSmugMusicShowResolve(query = {}) {
  const generated = new Date();
  const refresh = query.refresh === '1' || query.force === '1';
  const limit = getSmugMusicShowResolveLimit(query.limit);
  const warnings = [];
  const config = getSmugMugConfigDiagnostics();

  if (!String(process.env.DATABASE_URL || '').trim()) {
    return buildAdminResponse({
      ok: false,
      route: '/admin/smug/music/shows/resolve',
      generated,
      source: 'smugmug',
      section: 'music',
      type: 'smug_show_album_resolution',
      error: 'DATABASE_NOT_CONFIGURED',
      message: 'DATABASE_URL is required for SmugMug show album resolution.',
      warnings
    });
  }

  if (!config.configured) {
    return buildAdminResponse({
      ok: false,
      route: '/admin/smug/music/shows/resolve',
      generated,
      source: 'smugmug',
      section: 'music',
      type: 'smug_show_album_resolution',
      error: 'SMUGMUG_NOT_CONFIGURED',
      message: 'SMUG_API_KEY and SMUG_NICKNAME are required for SmugMug show album resolution.',
      missing: config.missing,
      warnings
    });
  }

  const snapshotFields = await inspectSmugMusicSnapshotFields(warnings);
  if (!snapshotFields.present) {
    return buildAdminResponse({
      ok: false,
      route: '/admin/smug/music/shows/resolve',
      generated,
      source: 'smugmug',
      section: 'music',
      type: 'smug_show_album_resolution',
      error: 'SNAPSHOT_FIELDS_MISSING',
      message: 'Music show SmugMug snapshot fields are missing. Restart/deploy so schema.sql can apply.',
      snapshotFields,
      warnings
    });
  }

  const missingSource = await getSmugMusicShowMissingSourceDiagnostics();
  const candidates = await getSmugMusicShowResolveCandidates(limit, refresh);
  const unresolvedShows = [];
  const skippedLogoSources = [];
  const skippedVenueLogoSources = [];
  const noSourceUrlShows = [];
  const noImageKeyShows = [];
  const noAlbumKeyShows = [];
  const missingCoverImages = [];
  const failures = [];
  const updatedItems = [];
  const counters = {
    scanned: candidates.rows.length,
    attempted: 0,
    resolved: 0,
    unresolved: 0,
    skipped_logo_source: 0,
    skipped_venue_logo_source: 0,
    no_source_url: 0,
    no_image_key: 0,
    no_album_key: 0,
    missing_cover_image: 0,
    poster_fallback_usage: 0,
    failed: 0,
    recordsUpdated: 0
  };

  await mapWithConcurrency(candidates.rows, SMUG_REQUEST_CONCURRENCY, async (row) => {
    counters.attempted += 1;
    try {
      const result = await resolveSmugMusicShowAlbum(row);
      if (result.updated) {
        counters.recordsUpdated += 1;
        updatedItems.push(buildSmugMusicShowResolveResultItem(result.updated));
      }

      const diagnostic = result.diagnostic || buildSmugMusicShowResolveDiagnostic(row, result.status);
      if (result.status === 'resolved' || result.status === 'synced') {
        counters.resolved += 1;
        if (result.posterFallbackUsed) counters.poster_fallback_usage += 1;
        if (result.missingCoverImage) {
          counters.missing_cover_image += 1;
          missingCoverImages.push(diagnostic);
        }
      } else if (result.status === 'skipped_venue_logo_source') {
        counters.skipped_venue_logo_source += 1;
        skippedVenueLogoSources.push(diagnostic);
      } else if (result.status === 'skipped_logo_source') {
        counters.skipped_logo_source += 1;
        skippedLogoSources.push(diagnostic);
      } else if (result.status === 'no_source_url') {
        counters.no_source_url += 1;
        counters.unresolved += 1;
        noSourceUrlShows.push(diagnostic);
        unresolvedShows.push(diagnostic);
      } else if (result.status === 'no_image_key') {
        counters.no_image_key += 1;
        counters.unresolved += 1;
        noImageKeyShows.push(diagnostic);
        unresolvedShows.push(diagnostic);
      } else if (result.status === 'no_album_key') {
        counters.no_album_key += 1;
        counters.unresolved += 1;
        noAlbumKeyShows.push(diagnostic);
        unresolvedShows.push(diagnostic);
      } else {
        counters.unresolved += 1;
        unresolvedShows.push(diagnostic);
      }
    } catch (err) {
      counters.failed += 1;
      const updated = await updateSmugMusicShowSyncError(row, 'error', err);
      if (updated) {
        counters.recordsUpdated += 1;
        updatedItems.push(buildSmugMusicShowResolveResultItem(updated));
      }
      failures.push(buildSmugMusicShowResolveDiagnostic(row, 'error', { message: getSafeErrorMessage(err) }));
    }
  });

  return buildAdminResponse({
    route: '/admin/smug/music/shows/resolve',
    generated,
    source: 'smugmug',
    section: 'music',
    type: 'smug_show_album_resolution',
    refresh,
    limit,
    summary: {
      showsScanned: counters.scanned,
      showsAttempted: counters.attempted,
      showsResolved: counters.resolved,
      showsUnresolved: counters.unresolved,
      skippedLogoSource: counters.skipped_logo_source,
      skippedVenueLogoSource: counters.skipped_venue_logo_source,
      noSourceUrl: counters.no_source_url,
      noImageKey: counters.no_image_key,
      noAlbumKey: counters.no_album_key,
      missingCoverImage: counters.missing_cover_image,
      posterFallbackUsage: counters.poster_fallback_usage,
      failures: counters.failed,
      recordsUpdated: counters.recordsUpdated,
      missingSource: missingSource.count
    },
    showsResolved: counters.resolved,
    showsUnresolved: counters.unresolved,
    skippedLogoSource: counters.skipped_logo_source,
    skippedVenueLogoSource: counters.skipped_venue_logo_source,
    noSourceUrl: counters.no_source_url,
    noImageKey: counters.no_image_key,
    noAlbumKey: counters.no_album_key,
    missingCoverImage: counters.missing_cover_image,
    posterFallbackUsage: counters.poster_fallback_usage,
    recordsUpdated: counters.recordsUpdated,
    diagnostics: {
      missingSource,
      skippedLogoSource: skippedLogoSources.slice(0, 25),
      skippedVenueLogoSource: skippedVenueLogoSources.slice(0, 25),
      noSourceUrl: noSourceUrlShows.slice(0, 25),
      noImageKey: noImageKeyShows.slice(0, 25),
      noAlbumKey: noAlbumKeyShows.slice(0, 25),
      missingCoverImage: missingCoverImages.slice(0, 25),
      unresolvedShows: unresolvedShows.slice(0, 25),
      failures: failures.slice(0, 25)
    },
    updatedItems: updatedItems.slice(0, 25),
    resultCount: updatedItems.length,
    warnings
  });
}

async function handleSmugMusicShowResolveRequest(req, res) {
  let importLock = null;
  try {
    const config = getSmugMugConfigDiagnostics();
    if (!String(process.env.DATABASE_URL || '').trim() || !config.configured) {
      const response = await runSmugMusicShowResolve(req.query || {});
      return res.status(response.ok ? 200 : 400).json(response);
    }

    const lockAttempt = await acquireImportLock({
      section: 'music',
      category: 'smug_shows_resolve',
      owner: getImportLockOwner(),
      meta: {
        route: '/admin/smug/music/shows/resolve',
        refresh: req.query && req.query.refresh === '1'
      }
    });

    if (lockAttempt && lockAttempt.acquired === false) {
      return res.status(409).json(buildAdminResponse({
        ok: false,
        route: '/admin/smug/music/shows/resolve',
        source: 'smugmug',
        section: 'music',
        type: 'smug_show_album_resolution',
        locked: true,
        message: 'Import already running',
        lock: lockAttempt.lock
      }));
    }

    importLock = lockAttempt && lockAttempt.lock ? lockAttempt.lock : null;
    const response = await runSmugMusicShowResolve(req.query || {});
    const released = await releaseImportLock(importLock && importLock.id, response.ok ? 'completed' : 'failed', {
      completedAt: new Date().toISOString(),
      status: response.ok ? 'completed' : 'failed',
      route: '/admin/smug/music/shows/resolve',
      recordsUpdated: response.recordsUpdated || 0
    });
    if (released) response.importLock = released;
    return res.status(response.ok ? 200 : 400).json(response);
  } catch (err) {
    const released = await releaseImportLock(importLock && importLock.id, 'failed', {
      completedAt: new Date().toISOString(),
      status: 'failed',
      error: getSafeErrorMessage(err),
      route: '/admin/smug/music/shows/resolve'
    });
    const errorResponse = buildAdminError('/admin/smug/music/shows/resolve', err, {
      source: 'smugmug',
      section: 'music',
      type: 'smug_show_album_resolution',
      error: 'SMUG_SHOW_RESOLUTION_ERROR'
    });
    if (released) errorResponse.importLock = released;
    return res.status(500).json(errorResponse);
  }
}
function normalizeAdminHealth({ diagnostics, importHealth, lockHealth, relationshipHealth, statsHealth, warnings } = {}) {
  const warningCount = Array.isArray(warnings) ? warnings.length : 0;
  const diagnosticsSummary = diagnostics && diagnostics.summary ? diagnostics.summary : {};
  const database = diagnostics && diagnostics.database ? diagnostics.database : {};

  if (database.database_connected === false) return 'unknown';
  if (relationshipHealth && toIntegerCount(relationshipHealth.errors) > 0) return 'failed';
  if (toIntegerCount(diagnosticsSummary.total_music_issues) + toIntegerCount(diagnosticsSummary.total_wrestling_issues) > 0) return 'failed';
  if (importHealth && toIntegerCount(importHealth.failingImportsLast24h) > 0) return 'failed';

  if (relationshipHealth && String(relationshipHealth.overallHealth || '').toLowerCase() === 'failed') return 'failed';
  if (String(diagnosticsSummary.overall_status || '').toLowerCase() === 'issues') return 'failed';

  if (lockHealth && toIntegerCount(lockHealth.staleLocks) > 0) return 'warning';
  if (importHealth && toIntegerCount(importHealth.warningImportsLast24h) > 0) return 'warning';
  if (relationshipHealth && String(relationshipHealth.overallHealth || '').toLowerCase() === 'warning') return 'warning';
  if (statsHealth && String(statsHealth.overallHealth || '').toLowerCase() === 'unknown') return 'warning';
  if (String(diagnosticsSummary.overall_status || '').toLowerCase() === 'warnings') return 'warning';
  if (warningCount > 0) return 'warning';

  return 'healthy';
}

function buildStatsSnapshotApiItem(row) {
  return {
    id: row.id == null ? null : toIntegerCount(row.id),
    section: row.section || '',
    category: row.category || '',
    snapshot_key: row.snapshot_key || '',
    data: row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {},
    generated_at: formatStatusTimestamp(row.generated_at),
    meta: row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {},
    created_at: formatStatusTimestamp(row.created_at)
  };
}

async function runStatsSnapshotQuery(warnings, label, sql, params = []) {
  try {
    return await dbPool.query(sql, params);
  } catch (err) {
    warnings.push(`Unable to build stats snapshot for ${label}: ${err && err.message ? err.message : String(err)}`);
    return { rows: [] };
  }
}

async function getStatsLatestImportTimestamp(section, category) {
  try {
    const existingTables = await getExistingPublicTables(['import_history']);
    if (!existingTables.has('import_history')) return null;

    const importCategory = section === 'wrestling' && category === 'matches' ? 'shows' : category;
    const result = await dbPool.query(`
      SELECT max(finished_at) AS latest_imported_at
      FROM import_history
      WHERE lower(trim(coalesce(section, ''))) = $1
        AND lower(trim(coalesce(category, ''))) = $2
    `, [section, importCategory]);
    const row = result.rows && result.rows[0] ? result.rows[0] : {};
    return formatStatusTimestamp(row.latest_imported_at) || null;
  } catch (err) {
    console.warn('Stats latest import lookup failed:', err && err.message ? err.message : String(err));
    return null;
  }
}

function statsHasColumns(columnsByTable, tableName, columns) {
  return (columns || []).every((columnName) => hasDiagnosticColumn(columnsByTable, tableName, columnName));
}

async function buildTableStatsSnapshotData({ section, category, config, generated, existingTables, columnsByTable }) {
  const warnings = [];
  const data = {
    section,
    category,
    available: false,
    total: 0,
    missing: {},
    latestUpdatedAt: null,
    latestImportedAt: null,
    generatedAt: generated.toISOString()
  };

  if (!config || !config.table) {
    warnings.push(`Missing stats snapshot config for ${section}/${category}.`);
    data.warnings = warnings;
    return data;
  }

  const tableName = config.table;
  if (!existingTables.has(tableName)) {
    warnings.push(`Missing table: ${tableName}`);
    data.warnings = warnings;
    return data;
  }

  data.available = true;
  const totalResult = await runStatsSnapshotQuery(
    warnings,
    `${section}/${category} total`,
    `SELECT count(*)::int AS total FROM ${tableName}`
  );
  data.total = toIntegerCount(firstDiagnosticRow(totalResult).total);

  if (hasDiagnosticColumn(columnsByTable, tableName, 'updated_at')) {
    const latestUpdatedResult = await runStatsSnapshotQuery(
      warnings,
      `${section}/${category} latest updated`,
      `SELECT max(updated_at) AS latest_updated_at FROM ${tableName}`
    );
    data.latestUpdatedAt = formatStatusTimestamp(firstDiagnosticRow(latestUpdatedResult).latest_updated_at) || null;
  }

  for (const check of config.importantFields || []) {
    if (!statsHasColumns(columnsByTable, tableName, check.columns)) {
      warnings.push(`Skipped ${section}/${category} missing.${check.key}; missing columns on ${tableName}: ${check.columns.join(', ')}`);
      continue;
    }

    const result = await runStatsSnapshotQuery(
      warnings,
      `${section}/${category} missing ${check.key}`,
      `SELECT count(*)::int AS count FROM ${tableName} WHERE ${check.condition}`
    );
    data.missing[check.key] = toIntegerCount(firstDiagnosticRow(result).count);
  }

  data.latestImportedAt = await getStatsLatestImportTimestamp(section, category);
  if (warnings.length) data.warnings = warnings;
  return data;
}

async function buildWrestlingMatchesStatsSnapshotData({ generated, existingTables, columnsByTable }) {
  const warnings = [];
  const section = 'wrestling';
  const category = 'matches';
  const data = {
    section,
    category,
    available: false,
    total: 0,
    missing: {},
    latestUpdatedAt: null,
    latestImportedAt: null,
    generatedAt: generated.toISOString()
  };

  if (!existingTables.has('wrestling_shows')) {
    warnings.push('Missing table: wrestling_shows');
    data.warnings = warnings;
    return data;
  }
  if (!hasDiagnosticColumn(columnsByTable, 'wrestling_shows', 'matches')) {
    warnings.push('Missing columns on wrestling_shows: matches');
    data.warnings = warnings;
    return data;
  }

  data.available = true;
  const matchesArraySql = `CASE WHEN jsonb_typeof(matches) = 'array' THEN matches ELSE '[]'::jsonb END`;
  const participantArraySql = `CASE WHEN jsonb_typeof(match_item->'participants') = 'array' THEN match_item->'participants' ELSE '[]'::jsonb END`;
  const winnerArraySql = getWrestlingWinnerArraySql('match_item');
  const totalsResult = await runStatsSnapshotQuery(
    warnings,
    'wrestling/matches totals',
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE jsonb_array_length(${participantArraySql}) = 0)::int AS missing_participants,
       count(*) FILTER (WHERE jsonb_array_length(${winnerArraySql}) = 0)::int AS missing_winner,
       count(*) FILTER (WHERE trim(coalesce(match_item->>'match_type', '')) = '')::int AS missing_match_type,
       count(*) FILTER (
         WHERE match_item->'match_order' IS NULL
            OR trim(coalesce(match_item->>'match_order', '')) = ''
       )::int AS missing_match_order
     FROM wrestling_shows
     CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item`
  );
  const totals = firstDiagnosticRow(totalsResult);
  data.total = toIntegerCount(totals.total);
  data.missing = {
    participants: toIntegerCount(totals.missing_participants),
    winner: toIntegerCount(totals.missing_winner),
    match_type: toIntegerCount(totals.missing_match_type),
    match_order: toIntegerCount(totals.missing_match_order)
  };

  if (hasDiagnosticColumn(columnsByTable, 'wrestling_shows', 'updated_at')) {
    const latestUpdatedResult = await runStatsSnapshotQuery(
      warnings,
      'wrestling/matches latest updated',
      `SELECT max(updated_at) AS latest_updated_at FROM wrestling_shows`
    );
    data.latestUpdatedAt = formatStatusTimestamp(firstDiagnosticRow(latestUpdatedResult).latest_updated_at) || null;
  }

  data.latestImportedAt = await getStatsLatestImportTimestamp(section, category);
  if (warnings.length) data.warnings = warnings;
  return data;
}

async function buildStatsSnapshotData({ section, category, generated, existingTables, columnsByTable }) {
  if (section === 'wrestling' && category === 'matches') {
    return buildWrestlingMatchesStatsSnapshotData({ generated, existingTables, columnsByTable });
  }

  const config = STATS_SNAPSHOT_CONFIG[section] && STATS_SNAPSHOT_CONFIG[section][category];
  return buildTableStatsSnapshotData({ section, category, config, generated, existingTables, columnsByTable });
}

async function rebuildStatsSnapshot({ section, category }) {
  const cleanSection = String(section || '').trim().toLowerCase();
  const cleanCategory = String(category || '').trim().toLowerCase();
  const categories = STATS_SNAPSHOT_CATEGORIES[cleanSection] || [];
  if (!categories.includes(cleanCategory)) {
    throw new Error(`Unsupported stats snapshot: ${cleanSection}/${cleanCategory}`);
  }

  const ready = await ensureStatsSnapshotsTable();
  if (!ready) throw new Error('Missing DATABASE_URL environment variable.');

  const generated = new Date();
  const existingTables = await getExistingPublicTables(STATS_SNAPSHOT_TABLES);
  const columnsByTable = await getExistingPublicColumns(STATS_SNAPSHOT_TABLES);
  const data = await buildStatsSnapshotData({
    section: cleanSection,
    category: cleanCategory,
    generated,
    existingTables,
    columnsByTable
  });
  const meta = {
    rebuiltBy: 'admin',
    phase: '1',
    available: !!data.available,
    warningCount: Array.isArray(data.warnings) ? data.warnings.length : 0
  };

  const result = await dbPool.query(`
    INSERT INTO stats_snapshots (
      section,
      category,
      snapshot_key,
      data,
      generated_at,
      meta
    )
    VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
    ON CONFLICT (section, category, snapshot_key) DO UPDATE SET
      data = EXCLUDED.data,
      generated_at = EXCLUDED.generated_at,
      meta = EXCLUDED.meta
    RETURNING id, section, category, snapshot_key, data, generated_at, meta, created_at
  `, [
    cleanSection,
    cleanCategory,
    'summary',
    JSON.stringify(data),
    generated,
    JSON.stringify(meta)
  ]);

  return buildStatsSnapshotApiItem(firstDiagnosticRow(result));
}

async function rebuildSectionStats(section) {
  const cleanSection = String(section || '').trim().toLowerCase();
  const categories = STATS_SNAPSHOT_CATEGORIES[cleanSection] || [];
  const items = [];

  for (const category of categories) {
    items.push(await rebuildStatsSnapshot({ section: cleanSection, category }));
  }

  return items;
}

async function getLatestStatsSnapshots({ section } = {}) {
  const ready = await ensureStatsSnapshotsTable();
  if (!ready) throw new Error('Missing DATABASE_URL environment variable.');

  const values = [];
  const where = [];
  const cleanSection = String(section || '').trim().toLowerCase();
  if (cleanSection) {
    values.push(cleanSection);
    where.push(`lower(trim(coalesce(section, ''))) = $${values.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await dbPool.query(`
    SELECT id, section, category, snapshot_key, data, generated_at, meta, created_at
    FROM stats_snapshots
    ${whereSql}
    ORDER BY section ASC, category ASC, snapshot_key ASC
  `, values);

  return result.rows.map(buildStatsSnapshotApiItem);
}

async function buildStatsHealth(section) {
  const health = createEmptyStatsHealth();

  try {
    if (!String(process.env.DATABASE_URL || '').trim()) return health;

    const existingTables = await getExistingPublicTables(['stats_snapshots']);
    if (!existingTables.has('stats_snapshots')) return health;

    const values = [];
    const where = [];
    const cleanSection = String(section || '').trim().toLowerCase();
    if (cleanSection) {
      values.push(cleanSection);
      where.push(`lower(trim(coalesce(section, ''))) = $${values.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await dbPool.query(`
      SELECT count(*)::int AS snapshots, max(generated_at) AS last_rebuilt_at
      FROM stats_snapshots
      ${whereSql}
    `, values);
    const row = firstDiagnosticRow(result);
    health.snapshots = toIntegerCount(row.snapshots);
    health.lastRebuiltAt = formatStatusTimestamp(row.last_rebuilt_at) || null;
    health.overallHealth = health.snapshots > 0 ? 'healthy' : 'unknown';
    return health;
  } catch (err) {
    console.warn('Stats health read failed:', err && err.message ? err.message : String(err));
    return health;
  }
}

async function handleStatsSummaryRequest(req, res) {
  try {
    const generated = new Date();
    const section = String(req.query.section || '').trim().toLowerCase();
    const items = await getLatestStatsSnapshots({ section });

    res.json({
      ok: true,
      route: '/api/admin/stats/summary',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      count: items.length,
      items
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/admin/stats/summary',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function handleStatsRebuildRequest(req, res, section) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const generated = new Date();
    const cleanSection = String(section || '').trim().toLowerCase();
    const items = cleanSection
      ? await rebuildSectionStats(cleanSection)
      : (await Promise.all(Object.keys(STATS_SNAPSHOT_CATEGORIES).map(rebuildSectionStats))).flat();

    res.json({
      ok: true,
      route: cleanSection ? `/api/admin/stats/rebuild/${cleanSection}` : '/api/admin/stats/rebuild',
      generatedAt: generated.toISOString(),
      generatedTime: formatEasternGeneratedTime(generated),
      rebuilt: items.length,
      items
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: section ? `/api/admin/stats/rebuild/${section}` : '/api/admin/stats/rebuild',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function runAdminOverviewTask(label, task, fallback, warnings) {
  try {
    return await task();
  } catch (err) {
    warnings.push(`${label} unavailable: ${err && err.message ? err.message : String(err)}`);
    return fallback;
  }
}

async function getAdminOverviewLatestImports(warnings) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Latest imports unavailable: Missing DATABASE_URL environment variable.');
    return [];
  }

  const tables = await getExistingPublicTables(['import_history']);
  if (!tables.has('import_history')) return [];
  return buildLatestImportHistoryItems();
}

async function getAdminOverviewActiveLocks(warnings) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Active import locks unavailable: Missing DATABASE_URL environment variable.');
    return [];
  }

  const tables = await getExistingPublicTables(['import_locks']);
  if (!tables.has('import_locks')) return [];
  const result = await dbPool.query(`
    SELECT id, section, category, status, locked_at, expires_at, owner, meta, created_at
    FROM import_locks
    WHERE status = 'running'
      AND expires_at > NOW()
    ORDER BY locked_at DESC, id DESC
    LIMIT 50
  `);
  return result.rows.map(buildImportLockApiItem);
}

async function getAdminOverviewRelationshipSummary() {
  const musicReport = await buildRelationshipReport('music');
  const wrestlingReport = await buildRelationshipReport('wrestling');
  const music = summarizeRelationshipItems(musicReport.items);
  const wrestling = summarizeRelationshipItems(wrestlingReport.items);
  const overall = {
    errors: music.errors + wrestling.errors,
    warnings: music.warnings + wrestling.warnings,
    info: music.info + wrestling.info
  };

  return {
    ok: true,
    music,
    wrestling,
    overallHealth: getRelationshipOverallHealth(overall, musicReport.unknown || wrestlingReport.unknown),
    warnings: uniqueAdminWarnings((musicReport.warnings || []).concat(wrestlingReport.warnings || []))
  };
}

async function getAdminOverviewStatsSummary(warnings) {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Stats summary unavailable: Missing DATABASE_URL environment variable.');
    return { ok: true, count: 0, items: [] };
  }

  const tables = await getExistingPublicTables(['stats_snapshots']);
  if (!tables.has('stats_snapshots')) return { ok: true, count: 0, items: [] };

  const result = await dbPool.query(`
    SELECT id, section, category, snapshot_key, data, generated_at, meta, created_at
    FROM stats_snapshots
    ORDER BY section ASC, category ASC, snapshot_key ASC
  `);
  const items = result.rows.map(buildStatsSnapshotApiItem);
  return {
    ok: true,
    count: items.length,
    items
  };
}

function buildAdminOverviewSectionSummary(sectionDiagnostics) {
  const summary = sectionDiagnostics && sectionDiagnostics.summary ? sectionDiagnostics.summary : {};
  const relationshipHealth = sectionDiagnostics && sectionDiagnostics.relationshipHealth ? sectionDiagnostics.relationshipHealth : null;
  const statsHealth = sectionDiagnostics && sectionDiagnostics.statsHealth ? sectionDiagnostics.statsHealth : null;
  const importHealth = sectionDiagnostics && sectionDiagnostics.importHealth ? sectionDiagnostics.importHealth : null;
  const lockHealth = sectionDiagnostics && sectionDiagnostics.lockHealth ? sectionDiagnostics.lockHealth : null;
  const warningCount = toIntegerCount(summary.warning_count);
  let health = 'healthy';

  if (summary.database_connected === false) health = 'unknown';
  else if (relationshipHealth && toIntegerCount(relationshipHealth.errors) > 0) health = 'failed';
  else if (importHealth && toIntegerCount(importHealth.failingImportsLast24h) > 0) health = 'failed';
  else if (warningCount > 0 || (lockHealth && toIntegerCount(lockHealth.staleLocks) > 0)) health = 'warning';
  else if (relationshipHealth && String(relationshipHealth.overallHealth || '').toLowerCase() === 'warning') health = 'warning';
  else if (statsHealth && String(statsHealth.overallHealth || '').toLowerCase() === 'unknown') health = 'warning';

  return {
    health,
    diagnosticsWarnings: warningCount,
    importHealth: importHealth || createEmptyImportHealth(),
    lockHealth: lockHealth || createEmptyLockHealth(),
    relationshipHealth: relationshipHealth || {
      ok: true,
      errors: 0,
      warnings: 0,
      info: 0,
      overallHealth: 'unknown'
    },
    statsHealth: statsHealth || createEmptyStatsHealth()
  };
}

async function buildAdminOverviewResponse() {
  const generated = new Date();
  const warnings = [];
  const diagnostics = await runAdminOverviewTask(
    'Diagnostics',
    buildAdminDiagnosticsResponse,
    {
      ok: false,
      route: '/api/admin/diagnostics',
      source: 'postgres',
      section: 'admin',
      type: 'diagnostics',
      summary: { overall_status: 'unknown' },
      warnings: []
    },
    warnings
  );
  const importHealth = diagnostics.importHealth || await runAdminOverviewTask('Import health', () => buildImportHealth(), createEmptyImportHealth(), warnings);
  const lockHealth = diagnostics.lockHealth || await runAdminOverviewTask('Lock health', () => buildLockHealth(), createEmptyLockHealth(), warnings);
  const relationshipHealth = diagnostics.relationshipHealth || await runAdminOverviewTask('Relationship health', () => buildRelationshipHealth(), {
    ok: true,
    errors: 0,
    warnings: 0,
    info: 0,
    overallHealth: 'unknown'
  }, warnings);
  const statsHealth = diagnostics.statsHealth || await runAdminOverviewTask('Stats health', () => buildStatsHealth(), createEmptyStatsHealth(), warnings);
  const latestImports = await runAdminOverviewTask('Latest imports', () => getAdminOverviewLatestImports(warnings), [], warnings);
  const activeLocks = await runAdminOverviewTask('Active locks', () => getAdminOverviewActiveLocks(warnings), [], warnings);
  const relationshipSummary = await runAdminOverviewTask('Relationship summary', getAdminOverviewRelationshipSummary, {
    ok: true,
    music: { errors: 0, warnings: 0, info: 0 },
    wrestling: { errors: 0, warnings: 0, info: 0 },
    overallHealth: 'unknown',
    warnings: []
  }, warnings);
  const statsSummary = await runAdminOverviewTask('Stats summary', () => getAdminOverviewStatsSummary(warnings), {
    ok: true,
    count: 0,
    items: []
  }, warnings);
  const combinedWarnings = uniqueAdminWarnings(
    warnings
      .concat(Array.isArray(diagnostics.warnings) ? diagnostics.warnings : [])
      .concat(Array.isArray(relationshipSummary.warnings) ? relationshipSummary.warnings : [])
  );
  const overallHealth = normalizeAdminHealth({
    diagnostics,
    importHealth,
    lockHealth,
    relationshipHealth,
    statsHealth,
    warnings: combinedWarnings
  });

  return buildAdminResponse({
    route: '/api/admin/overview',
    generated,
    source: 'postgres',
    section: 'admin',
    type: 'overview',
    service: {
      name: 'VMPix-V3 Data',
      status: 'online'
    },
    summary: {
      overallHealth,
      sections: {
        music: buildAdminOverviewSectionSummary(diagnostics.music),
        wrestling: buildAdminOverviewSectionSummary(diagnostics.wrestling)
      }
    },
    diagnostics,
    adminProtection: getAdminProtectionStatus(),
    importHealth,
    lockHealth,
    relationshipHealth,
    statsHealth,
    latestImports,
    activeLocks,
    relationshipSummary,
    statsSummary,
    warnings: combinedWarnings
  });
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
  const category = getImportHistoryCategory(config);
  const lockAttempt = await acquireImportLock({
    section: area,
    category,
    owner: getImportLockOwner(),
    meta: {
      route: config.route,
      refresh: req.query.refresh === '1',
      source: config.source || '',
      startedAt: startedAt.toISOString()
    }
  });

  if (lockAttempt && lockAttempt.acquired === false) {
    return res.status(409).json({
      ok: false,
      locked: true,
      message: 'Import already running',
      section: area,
      category,
      lock: lockAttempt.lock || null
    });
  }

  const importLock = lockAttempt && lockAttempt.lock ? lockAttempt.lock : null;
  const history = await startImportHistory({
    section: area,
    category,
    source: config.source,
    importType: req.query.refresh === '1' ? 'manual_refresh' : 'manual',
    sourceIdentifier: config.source || config.route,
    meta: {
      route: config.route,
      refresh: req.query.refresh === '1',
      source_type: 'google_sheets'
    }
  });

  try {
    const forceRefresh = req.query.refresh === '1';
    const result = await config.importer(forceRefresh);
    const historyWarnings = getImportHistoryWarnings(result);
    const historyErrors = getImportHistoryErrors(result);
    const historyStatus = historyErrors.length ? 'failed' : (historyWarnings.length ? 'warning' : 'success');
    const totalRowsAfterImport = await getImportTableTotalRows(result && result.table);
    const importHistory = await finishImportHistory(history && history.id, {
      status: historyStatus,
      rowsFetched: getImportHistoryRowsFetched(result),
      rowsImported: getImportLogRowsWritten(result),
      rowsInserted: getNullableImportCount(result, ['rowsInserted', 'insertedRows', 'inserted']),
      rowsUpdated: getNullableImportCount(result, ['rowsUpdated', 'updatedRows', 'updated']),
      rowsSkipped: getImportHistoryRowsSkipped(result),
      totalRowsAfterImport,
      errorMessage: historyErrors[0] || null,
      warnings: historyWarnings,
      errors: historyErrors,
      meta: buildImportHistoryMeta(config, req, result)
    });
    const importLockRelease = await releaseImportLock(importLock && importLock.id, historyStatus === 'failed' ? 'failed' : 'completed', {
      completedAt: new Date().toISOString(),
      status: historyStatus,
      importHistoryId: importHistory && importHistory.id ? importHistory.id : null
    });
    await writeSystemImportLog({
      area,
      route: config.route,
      status: historyStatus === 'failed' ? 'error' : historyStatus,
      rows_read: result && result.rowsRead,
      rows_inserted: getNullableImportCount(result, ['rowsInserted', 'insertedRows', 'inserted']) ?? getImportLogRowsWritten(result),
      rows_updated: getNullableImportCount(result, ['rowsUpdated', 'updatedRows', 'updated']) ?? 0,
      started_at: startedAt,
      finished_at: new Date()
    });
    if (importHistory && result && typeof result === 'object') {
      result.importHistory = importHistory;
    }
    if (importLockRelease && result && typeof result === 'object') {
      result.importLock = importLockRelease;
    }
    res.json(result);
  } catch (err) {
    const importHistory = await finishImportHistory(history && history.id, {
      status: 'failed',
      rowsFetched: 0,
      rowsImported: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      totalRowsAfterImport: null,
      errorMessage: err && err.message ? err.message : String(err),
      warnings: [],
      errors: [err && err.message ? err.message : String(err)],
      meta: {
        route: config.route,
        refresh: req.query.refresh === '1',
        source_type: 'google_sheets'
      }
    });
    const importLockRelease = await releaseImportLock(importLock && importLock.id, 'failed', {
      completedAt: new Date().toISOString(),
      status: 'failed',
      error: err && err.message ? err.message : String(err),
      importHistoryId: importHistory && importHistory.id ? importHistory.id : null
    });
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
    const errorResponse = {
      ok: false,
      route: config.route,
      source: config.source,
      error: err && err.message ? err.message : String(err)
    };
    if (importHistory) errorResponse.importHistory = importHistory;
    if (importLockRelease) errorResponse.importLock = importLockRelease;
    res.status(500).json(errorResponse);
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

const MUSIC_DIAGNOSTIC_TABLES = ['music_bands', 'music_shows', 'music_people', 'music_venues'];
const WRESTLING_DIAGNOSTIC_TABLES = ['wrestling_shows', 'wrestling_people', 'wrestling_venues'];
const MUSIC_BAND_LINK_DIAGNOSTIC_CATEGORY_KEYS = Object.freeze(['performers', 'the fallen']);
const MUSIC_BAND_LINK_DIAGNOSTIC_CATEGORY_LABELS = Object.freeze(['Performers', 'The Fallen']);

function buildMusicDiagnosticSourceTabs() {
  return {
    bands: {
      sheet_tab: ROUTES['/api/music/bands'].label,
      gid_env: ROUTES['/api/music/bands'].gidEnv,
      source_gid: normalizeSheetGid(process.env[ROUTES['/api/music/bands'].gidEnv])
    },
    shows: {
      sheet_tab: ROUTES['/api/music/shows'].label,
      gid_env: ROUTES['/api/music/shows'].gidEnv,
      source_gid: normalizeSheetGid(process.env[ROUTES['/api/music/shows'].gidEnv])
    },
    people: {
      sheet_tab: ROUTES['/api/music/people'].label,
      gid_env: ROUTES['/api/music/people'].gidEnv,
      source_gid: normalizeSheetGid(process.env[ROUTES['/api/music/people'].gidEnv] || ROUTES['/api/music/people'].defaultGid)
    },
    venues: {
      sheet_tab: ROUTES['/api/music/venues'].label,
      gid_env: ROUTES['/api/music/venues'].gidEnv,
      source_gid: normalizeSheetGid(process.env[ROUTES['/api/music/venues'].gidEnv])
    }
  };
}

function addDiagnosticCountAliases(target) {
  Object.entries(target || {}).forEach(([key, value]) => {
    if (key === 'samples' || key.endsWith('_count')) return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      target[`${key}_count`] = value;
    }
  });
}

function buildMusicDiagnosticsSectionResponse(fullResponse, category, route) {
  const section = String(category || '').trim().toLowerCase();
  const allowed = new Set(['bands', 'shows', 'people', 'venues']);
  if (!allowed.has(section)) return null;

  return {
    ok: fullResponse.ok,
    route,
    source: fullResponse.source,
    section: fullResponse.section,
    type: fullResponse.type,
    category: section,
    generatedAt: fullResponse.generatedAt,
    generatedTime: fullResponse.generatedTime,
    summary: fullResponse.summary,
    source_tabs: fullResponse.source_tabs,
    [section]: fullResponse[section] || {},
    importHealth: {
      ok: fullResponse.importHealth && fullResponse.importHealth.ok !== false,
      latestImports: (fullResponse.importHealth && Array.isArray(fullResponse.importHealth.latestImports))
        ? fullResponse.importHealth.latestImports.filter((item) => String(item.category || '').toLowerCase() === section)
        : [],
      lastSuccessfulImportAt: fullResponse.importHealth ? fullResponse.importHealth.lastSuccessfulImportAt : null,
      lastFailedImportAt: fullResponse.importHealth ? fullResponse.importHealth.lastFailedImportAt : null
    }
  };
}

async function getExistingPublicColumns(tableNames) {
  const result = await dbPool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
  `, [tableNames]);

  const columnsByTable = new Map();
  result.rows.forEach((row) => {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name).add(row.column_name);
  });

  return columnsByTable;
}

function hasDiagnosticColumn(columnsByTable, tableName, columnName) {
  const columns = columnsByTable.get(tableName);
  return !!columns && columns.has(columnName);
}

function warnMissingDiagnosticColumns(columnsByTable, tableName, columnNames, warnings) {
  const missing = columnNames.filter((columnName) => !hasDiagnosticColumn(columnsByTable, tableName, columnName));
  if (missing.length) warnings.push(`Missing columns on ${tableName}: ${missing.join(', ')}`);
  return missing.length === 0;
}

function diagnosticRows(result) {
  return result && Array.isArray(result.rows) ? result.rows : [];
}

function firstDiagnosticRow(result) {
  const rows = diagnosticRows(result);
  return rows[0] || {};
}

async function runWrestlingDiagnosticQuery(warnings, label, sql, params = []) {
  try {
    return await dbPool.query(sql, params);
  } catch (err) {
    warnings.push(`Unable to check ${label}: ${err && err.message ? err.message : String(err)}`);
    return { rows: [] };
  }
}

async function runMusicDiagnosticQuery(warnings, label, sql, params = []) {
  try {
    return await dbPool.query(sql, params);
  } catch (err) {
    warnings.push(`Unable to check ${label}: ${err && err.message ? err.message : String(err)}`);
    return { rows: [] };
  }
}

async function addMusicBandDiagnostics(response, existingTables, columnsByTable, warnings) {
  if (!existingTables.has('music_bands')) {
    warnings.push('Missing table: music_bands');
    return;
  }

  const bands = response.bands;
  const samples = {};
  const totalResult = await runMusicDiagnosticQuery(
    warnings,
    'music band totals',
    `SELECT count(*)::int AS total_bands FROM music_bands`
  );
  bands.total_bands = toIntegerCount(firstDiagnosticRow(totalResult).total_bands);

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_bands', ['band_id'], warnings)) {
    const missingIdResult = await runMusicDiagnosticQuery(
      warnings,
      'music bands missing ID',
      `SELECT count(*)::int AS bands_missing_id
       FROM music_bands
       WHERE trim(coalesce(band_id, '')) = ''`
    );
    bands.bands_missing_id = toIntegerCount(firstDiagnosticRow(missingIdResult).bands_missing_id);

    const missingIdSamples = await runMusicDiagnosticQuery(
      warnings,
      'music bands missing ID samples',
      `SELECT id, band
       FROM music_bands
       WHERE trim(coalesce(band_id, '')) = ''
       ORDER BY band ASC
       LIMIT 10`
    );
    samples.bands_missing_id = diagnosticRows(missingIdSamples);

    const duplicateIdResult = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music band IDs',
      `SELECT count(*)::int AS duplicate_band_ids
       FROM (
         SELECT lower(trim(band_id)) AS band_id_key
         FROM music_bands
         WHERE trim(coalesce(band_id, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       ) duplicates`
    );
    bands.duplicate_band_ids = toIntegerCount(firstDiagnosticRow(duplicateIdResult).duplicate_band_ids);

    const duplicateIdSamples = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music band ID samples',
      `WITH duplicate_ids AS (
         SELECT lower(trim(band_id)) AS band_id_key
         FROM music_bands
         WHERE trim(coalesce(band_id, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       )
       SELECT
         duplicate_ids.band_id_key AS band_id,
         count(*)::int AS count,
         jsonb_agg(jsonb_build_object(
           'id', music_bands.id,
           'band_id', music_bands.band_id,
           'band', music_bands.band
         ) ORDER BY music_bands.id ASC) AS rows
       FROM duplicate_ids
       JOIN music_bands
         ON lower(trim(coalesce(music_bands.band_id, ''))) = duplicate_ids.band_id_key
       GROUP BY duplicate_ids.band_id_key
       ORDER BY count DESC, duplicate_ids.band_id_key ASC
       LIMIT 10`
    );
    samples.duplicate_band_ids = diagnosticRows(duplicateIdSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_bands', ['band'], warnings)) {
    const missingNameResult = await runMusicDiagnosticQuery(
      warnings,
      'music bands missing name',
      `SELECT count(*)::int AS bands_missing_name
       FROM music_bands
       WHERE trim(coalesce(band, '')) = ''`
    );
    bands.bands_missing_name = toIntegerCount(firstDiagnosticRow(missingNameResult).bands_missing_name);

    const missingNameSamples = await runMusicDiagnosticQuery(
      warnings,
      'music bands missing name samples',
      `SELECT id, band_id
       FROM music_bands
       WHERE trim(coalesce(band, '')) = ''
       ORDER BY id ASC
       LIMIT 10`
    );
    samples.bands_missing_name = diagnosticRows(missingNameSamples);

    const duplicateNameResult = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music band names',
      `SELECT count(*)::int AS duplicate_band_names
       FROM (
         SELECT lower(trim(band)) AS band_key
         FROM music_bands
         WHERE trim(coalesce(band, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       ) duplicates`
    );
    bands.duplicate_band_names = toIntegerCount(firstDiagnosticRow(duplicateNameResult).duplicate_band_names);

    const duplicateNameSamples = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music band name samples',
      `WITH duplicate_names AS (
         SELECT lower(trim(band)) AS canonical_name
         FROM music_bands
         WHERE trim(coalesce(band, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       )
       SELECT
         duplicate_names.canonical_name,
         count(*)::int AS count,
         jsonb_agg(jsonb_build_object(
           'id', music_bands.id,
           'band_id', music_bands.band_id,
           'band', music_bands.band
         ) ORDER BY music_bands.band_id ASC, music_bands.id ASC) AS rows
       FROM duplicate_names
       JOIN music_bands
         ON lower(trim(coalesce(music_bands.band, ''))) = duplicate_names.canonical_name
       GROUP BY duplicate_names.canonical_name
       ORDER BY count DESC, duplicate_names.canonical_name ASC
       LIMIT 10`
    );
    samples.duplicate_band_names = diagnosticRows(duplicateNameSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_bands', ['status'], warnings)) {
    const missingStatusResult = await runMusicDiagnosticQuery(
      warnings,
      'music bands missing status',
      `SELECT count(*)::int AS bands_missing_status
       FROM music_bands
       WHERE trim(coalesce(status, '')) = ''`
    );
    bands.bands_missing_status = toIntegerCount(firstDiagnosticRow(missingStatusResult).bands_missing_status);

    const missingStatusSamples = await runMusicDiagnosticQuery(
      warnings,
      'music bands missing status samples',
      `SELECT band_id, band
       FROM music_bands
       WHERE trim(coalesce(status, '')) = ''
       ORDER BY band ASC
       LIMIT 10`
    );
    samples.bands_missing_status = diagnosticRows(missingStatusSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_bands', ['region'], warnings)) {
    const missingRegionResult = await runMusicDiagnosticQuery(
      warnings,
      'music bands missing region',
      `SELECT count(*)::int AS bands_missing_region
       FROM music_bands
       WHERE trim(coalesce(region, '')) = ''`
    );
    bands.bands_missing_region = toIntegerCount(firstDiagnosticRow(missingRegionResult).bands_missing_region);

    const missingRegionSamples = await runMusicDiagnosticQuery(
      warnings,
      'music bands missing region samples',
      `SELECT band_id, band
       FROM music_bands
       WHERE trim(coalesce(region, '')) = ''
       ORDER BY band ASC
       LIMIT 10`
    );
    samples.bands_missing_region = diagnosticRows(missingRegionSamples);
  }

  addDiagnosticCountAliases(bands);
  bands.samples = samples;
}

async function addMusicShowDiagnostics(response, existingTables, columnsByTable, warnings) {
  if (!existingTables.has('music_shows')) {
    warnings.push('Missing table: music_shows');
    return;
  }

  const shows = response.shows;
  const samples = {};
  const totalResult = await runMusicDiagnosticQuery(
    warnings,
    'music show totals',
    `SELECT count(*)::int AS total_shows FROM music_shows`
  );
  shows.total_shows = toIntegerCount(firstDiagnosticRow(totalResult).total_shows);

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_shows', ['name'], warnings)) {
    const missingNameResult = await runMusicDiagnosticQuery(
      warnings,
      'music shows missing show name',
      `SELECT count(*)::int AS shows_missing_show_name
       FROM music_shows
       WHERE trim(coalesce(name, '')) = ''`
    );
    shows.shows_missing_show_name = toIntegerCount(firstDiagnosticRow(missingNameResult).shows_missing_show_name);

    const missingNameSamples = await runMusicDiagnosticQuery(
      warnings,
      'music shows missing show name samples',
      `SELECT show_id, date, venue, city, state
       FROM music_shows
       WHERE trim(coalesce(name, '')) = ''
       ORDER BY show_id ASC
       LIMIT 10`
    );
    samples.shows_missing_show_name = diagnosticRows(missingNameSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_shows', ['date'], warnings)) {
    const missingDateResult = await runMusicDiagnosticQuery(
      warnings,
      'music shows missing date',
      `SELECT count(*)::int AS shows_missing_date
       FROM music_shows
       WHERE trim(coalesce(date, '')) = ''`
    );
    shows.shows_missing_date = toIntegerCount(firstDiagnosticRow(missingDateResult).shows_missing_date);

    const missingDateSamples = await runMusicDiagnosticQuery(
      warnings,
      'music shows missing date samples',
      `SELECT show_id, name, venue, city, state
       FROM music_shows
       WHERE trim(coalesce(date, '')) = ''
       ORDER BY show_id ASC
       LIMIT 10`
    );
    samples.shows_missing_date = diagnosticRows(missingDateSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_shows', ['venue'], warnings)) {
    const canUseVenueIdLink = existingTables.has('music_venues') &&
      hasDiagnosticColumn(columnsByTable, 'music_shows', 'venue_id') &&
      hasDiagnosticColumn(columnsByTable, 'music_venues', 'venue_key');
    const missingVenueWhere = canUseVenueIdLink
      ? `trim(coalesce(ms.venue, '')) = ''
         AND (
           trim(coalesce(ms.venue_id, '')) = ''
           OR mv.venue_key IS NULL
         )`
      : `trim(coalesce(ms.venue, '')) = ''`;
    const missingVenueJoin = canUseVenueIdLink
      ? `LEFT JOIN music_venues mv
           ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))`
      : '';
    const missingVenueResult = await runMusicDiagnosticQuery(
      warnings,
      'music shows missing venue',
      `SELECT count(*)::int AS shows_missing_venue
       FROM music_shows ms
       ${missingVenueJoin}
       WHERE ${missingVenueWhere}`
    );
    shows.shows_missing_venue = toIntegerCount(firstDiagnosticRow(missingVenueResult).shows_missing_venue);

    const missingVenueSamples = await runMusicDiagnosticQuery(
      warnings,
      'music shows missing venue samples',
      `SELECT
         ms.show_id,
         ms.name,
         ms.date,
         ms.venue_id,
         ms.venue,
         ms.city,
         ms.state${canUseVenueIdLink ? `,
         (mv.venue_key IS NOT NULL) AS venue_id_exists_in_db,
         mv.venue AS matched_venue` : ''}
       FROM music_shows ms
       ${missingVenueJoin}
       WHERE ${missingVenueWhere}
       ORDER BY ms.show_id ASC
       LIMIT 10`
    );
    samples.shows_missing_venue = diagnosticRows(missingVenueSamples);
    if (shows.shows_missing_venue > 0 && canUseVenueIdLink) {
      shows.refresh_hint = 'Run /admin/import/music/venues?refresh=1 before validating Music Shows diagnostics.';
    }
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_shows', ['show_id'], warnings)) {
    const duplicateShowKeyResult = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music show keys',
      `SELECT count(*)::int AS duplicate_show_keys
       FROM (
         SELECT show_id
         FROM music_shows
         WHERE show_id IS NOT NULL
         GROUP BY show_id
         HAVING count(*) > 1
       ) duplicates`
    );
    shows.duplicate_show_keys = toIntegerCount(firstDiagnosticRow(duplicateShowKeyResult).duplicate_show_keys);

    const duplicateShowKeySamples = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music show key samples',
      `SELECT show_id, count(*)::int AS count
       FROM music_shows
       WHERE show_id IS NOT NULL
       GROUP BY show_id
       HAVING count(*) > 1
       ORDER BY count DESC, show_id ASC
       LIMIT 10`
    );
    samples.duplicate_show_keys = diagnosticRows(duplicateShowKeySamples);
  }

  addDiagnosticCountAliases(shows);
  shows.samples = samples;
}

async function addMusicPeopleDiagnostics(response, existingTables, columnsByTable, warnings) {
  if (!existingTables.has('music_people')) {
    warnings.push('Missing table: music_people');
    return;
  }

  const people = response.people;
  const samples = {};
  const totalResult = await runMusicDiagnosticQuery(
    warnings,
    'music people totals',
    `SELECT count(*)::int AS total_people FROM music_people`
  );
  people.total_people = toIntegerCount(firstDiagnosticRow(totalResult).total_people);

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_people', ['person_id'], warnings)) {
    const missingIdResult = await runMusicDiagnosticQuery(
      warnings,
      'music people missing ID',
      `SELECT count(*)::int AS people_missing_id
       FROM music_people
       WHERE person_id IS NULL`
    );
    people.people_missing_id = toIntegerCount(firstDiagnosticRow(missingIdResult).people_missing_id);

    const missingIdSamples = await runMusicDiagnosticQuery(
      warnings,
      'music people missing ID samples',
      `SELECT id, name, category
       FROM music_people
       WHERE person_id IS NULL
       ORDER BY name ASC
       LIMIT 10`
    );
    samples.people_missing_id = diagnosticRows(missingIdSamples);

    const duplicateIdResult = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music person IDs',
      `SELECT count(*)::int AS duplicate_person_ids
       FROM (
         SELECT person_id
         FROM music_people
         WHERE person_id IS NOT NULL
         GROUP BY person_id
         HAVING count(*) > 1
       ) duplicates`
    );
    people.duplicate_person_ids = toIntegerCount(firstDiagnosticRow(duplicateIdResult).duplicate_person_ids);

    const duplicateIdSamples = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music person ID samples',
      `SELECT person_id, count(*)::int AS count
       FROM music_people
       WHERE person_id IS NOT NULL
       GROUP BY person_id
       HAVING count(*) > 1
       ORDER BY count DESC, person_id ASC
       LIMIT 10`
    );
    samples.duplicate_person_ids = diagnosticRows(duplicateIdSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_people', ['name'], warnings)) {
    const missingNameResult = await runMusicDiagnosticQuery(
      warnings,
      'music people missing name',
      `SELECT count(*)::int AS people_missing_name
       FROM music_people
       WHERE trim(coalesce(name, '')) = ''`
    );
    people.people_missing_name = toIntegerCount(firstDiagnosticRow(missingNameResult).people_missing_name);

    const missingNameSamples = await runMusicDiagnosticQuery(
      warnings,
      'music people missing name samples',
      `SELECT id, person_id, category
       FROM music_people
       WHERE trim(coalesce(name, '')) = ''
       ORDER BY person_id ASC
       LIMIT 10`
    );
    samples.people_missing_name = diagnosticRows(missingNameSamples);

    const duplicateNameResult = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music person names',
      `SELECT count(*)::int AS duplicate_person_names
       FROM (
         SELECT lower(trim(name)) AS name_key
         FROM music_people
         WHERE trim(coalesce(name, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       ) duplicates`
    );
    people.duplicate_person_names = toIntegerCount(firstDiagnosticRow(duplicateNameResult).duplicate_person_names);

    const duplicateNameSamples = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music person name samples',
      `SELECT lower(trim(name)) AS name, count(*)::int AS count
       FROM music_people
       WHERE trim(coalesce(name, '')) <> ''
       GROUP BY 1
       HAVING count(*) > 1
       ORDER BY count DESC, name ASC
       LIMIT 10`
    );
    samples.duplicate_person_names = diagnosticRows(duplicateNameSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_people', ['category'], warnings)) {
    const missingCategoryResult = await runMusicDiagnosticQuery(
      warnings,
      'music people missing category',
      `SELECT count(*)::int AS people_missing_category
       FROM music_people
       WHERE trim(coalesce(category, '')) = ''`
    );
    people.people_missing_category = toIntegerCount(firstDiagnosticRow(missingCategoryResult).people_missing_category);

    const missingCategorySamples = await runMusicDiagnosticQuery(
      warnings,
      'music people missing category samples',
      `SELECT person_id, name
       FROM music_people
       WHERE trim(coalesce(category, '')) = ''
       ORDER BY name ASC
       LIMIT 10`
    );
    samples.people_missing_category = diagnosticRows(missingCategorySamples);
  }

  addDiagnosticCountAliases(people);
  people.samples = samples;
}

async function addMusicVenueDiagnostics(response, existingTables, columnsByTable, warnings) {
  if (!existingTables.has('music_venues')) {
    warnings.push('Missing table: music_venues');
    return;
  }

  const venues = response.venues;
  const samples = {};
  const totalResult = await runMusicDiagnosticQuery(
    warnings,
    'music venue totals',
    `SELECT count(*)::int AS total_venues FROM music_venues`
  );
  venues.total_venues = toIntegerCount(firstDiagnosticRow(totalResult).total_venues);

  if (
    existingTables.has('music_shows') &&
    hasDiagnosticColumn(columnsByTable, 'music_shows', 'venue_id') &&
    hasDiagnosticColumn(columnsByTable, 'music_venues', 'venue_key')
  ) {
    const showCountRelationshipResult = await runMusicDiagnosticQuery(
      warnings,
      'music venue showCount relationship totals',
      `SELECT
         (SELECT count(*)::int FROM music_shows) AS music_shows_total,
         (SELECT count(*)::int FROM music_shows WHERE trim(coalesce(venue_id, '')) <> '') AS music_shows_with_venue_id,
         (SELECT count(*)::int
          FROM music_shows ms
          JOIN music_venues mv
            ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
          WHERE trim(coalesce(ms.venue_id, '')) <> '') AS matching_show_venue_relationships,
         (SELECT count(DISTINCT lower(trim(mv.venue_key)))::int
          FROM music_venues mv
          JOIN music_shows ms
            ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
          WHERE trim(coalesce(ms.venue_id, '')) <> '') AS venues_with_show_count`
    );
    const showCountRelationship = firstDiagnosticRow(showCountRelationshipResult);
    venues.music_shows_total = toIntegerCount(showCountRelationship.music_shows_total);
    venues.music_shows_with_venue_id = toIntegerCount(showCountRelationship.music_shows_with_venue_id);
    venues.matching_show_venue_relationships = toIntegerCount(showCountRelationship.matching_show_venue_relationships);
    venues.venues_with_show_count = toIntegerCount(showCountRelationship.venues_with_show_count);

    const showCountSamples = await runMusicDiagnosticQuery(
      warnings,
      'music venue showCount samples',
      `SELECT
         coalesce(mv.venue_key, mv.venue_id::text) AS venue_id,
         mv.venue,
         mv.city,
         mv.state,
         count(ms.show_id)::int AS showCount
       FROM music_venues mv
       LEFT JOIN music_shows ms
         ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
        AND trim(coalesce(ms.venue_id, '')) <> ''
       GROUP BY mv.venue_key, mv.venue_id, mv.venue, mv.city, mv.state
       HAVING count(ms.show_id) > 0
       ORDER BY showCount DESC, mv.venue ASC
       LIMIT 10`
    );
    samples.venue_show_counts = diagnosticRows(showCountSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['venue_key'], warnings)) {
    const missingIdResult = await runMusicDiagnosticQuery(
      warnings,
      'music venues missing ID',
      `SELECT count(*)::int AS venues_missing_id
       FROM music_venues
       WHERE trim(coalesce(venue_key, '')) = ''`
    );
    venues.venues_missing_id = toIntegerCount(firstDiagnosticRow(missingIdResult).venues_missing_id);

    const missingIdSamples = await runMusicDiagnosticQuery(
      warnings,
      'music venues missing ID samples',
      `SELECT coalesce(venue_key, venue_id::text) AS venue_id, venue_id AS legacy_venue_id, venue, city, state, latitude, longitude
       FROM music_venues
       WHERE trim(coalesce(venue_key, '')) = ''
       ORDER BY venue ASC
       LIMIT 10`
    );
    samples.venues_missing_id = diagnosticRows(missingIdSamples);

    const duplicateIdResult = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music venue IDs',
      `SELECT count(*)::int AS duplicate_venue_ids
       FROM (
         SELECT lower(trim(venue_key)) AS venue_key
         FROM music_venues
         WHERE trim(coalesce(venue_key, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       ) duplicates`
    );
    venues.duplicate_venue_ids = toIntegerCount(firstDiagnosticRow(duplicateIdResult).duplicate_venue_ids);

    const duplicateIdSamples = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music venue ID samples',
      `SELECT lower(trim(venue_key)) AS venue_id, count(*)::int AS count
       FROM music_venues
       WHERE trim(coalesce(venue_key, '')) <> ''
       GROUP BY 1
       HAVING count(*) > 1
       ORDER BY count DESC, venue_id ASC
       LIMIT 10`
    );
    samples.duplicate_venue_ids = diagnosticRows(duplicateIdSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['venue'], warnings)) {
    const missingNameResult = await runMusicDiagnosticQuery(
      warnings,
      'music venues missing name',
      `SELECT count(*)::int AS venues_missing_name
       FROM music_venues
       WHERE trim(coalesce(venue, '')) = ''`
    );
    venues.venues_missing_name = toIntegerCount(firstDiagnosticRow(missingNameResult).venues_missing_name);

    const missingNameSamples = await runMusicDiagnosticQuery(
      warnings,
      'music venues missing name samples',
      `SELECT coalesce(venue_key, venue_id::text) AS venue_id, venue, city, state, latitude, longitude
       FROM music_venues
       WHERE trim(coalesce(venue, '')) = ''
       ORDER BY coalesce(venue_key, venue_id::text) ASC
       LIMIT 10`
    );
    samples.venues_missing_name = diagnosticRows(missingNameSamples);

    const duplicateNameResult = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music venue names',
      `SELECT count(*)::int AS duplicate_venue_names
       FROM (
         SELECT lower(trim(venue)) AS venue_key
         FROM music_venues
         WHERE trim(coalesce(venue, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       ) duplicates`
    );
    venues.duplicate_venue_names = toIntegerCount(firstDiagnosticRow(duplicateNameResult).duplicate_venue_names);

    const duplicateNameSamples = await runMusicDiagnosticQuery(
      warnings,
      'duplicate music venue name samples',
      `SELECT lower(trim(venue)) AS venue, count(*)::int AS count
       FROM music_venues
       WHERE trim(coalesce(venue, '')) <> ''
       GROUP BY 1
       HAVING count(*) > 1
       ORDER BY count DESC, venue ASC
       LIMIT 10`
    );
    samples.duplicate_venue_names = diagnosticRows(duplicateNameSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['city'], warnings)) {
    const missingCityResult = await runMusicDiagnosticQuery(
      warnings,
      'music venues missing city',
      `SELECT count(*)::int AS venues_missing_city
       FROM music_venues
       WHERE trim(coalesce(city, '')) = ''`
    );
    venues.venues_missing_city = toIntegerCount(firstDiagnosticRow(missingCityResult).venues_missing_city);

    const missingCitySamples = await runMusicDiagnosticQuery(
      warnings,
      'music venues missing city samples',
      `SELECT coalesce(venue_key, venue_id::text) AS venue_id, venue, city, state, latitude, longitude
       FROM music_venues
       WHERE trim(coalesce(city, '')) = ''
       ORDER BY venue ASC
       LIMIT 10`
    );
    samples.venues_missing_city = diagnosticRows(missingCitySamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['state'], warnings)) {
    const missingStateResult = await runMusicDiagnosticQuery(
      warnings,
      'music venues missing state',
      `SELECT count(*)::int AS venues_missing_state
       FROM music_venues
       WHERE trim(coalesce(state, '')) = ''`
    );
    venues.venues_missing_state = toIntegerCount(firstDiagnosticRow(missingStateResult).venues_missing_state);

    const missingStateSamples = await runMusicDiagnosticQuery(
      warnings,
      'music venues missing state samples',
      `SELECT coalesce(venue_key, venue_id::text) AS venue_id, venue, city, state, latitude, longitude
       FROM music_venues
       WHERE trim(coalesce(state, '')) = ''
       ORDER BY venue ASC
       LIMIT 10`
    );
    samples.venues_missing_state = diagnosticRows(missingStateSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['latitude', 'longitude'], warnings)) {
    const gpsResult = await runMusicDiagnosticQuery(
      warnings,
      'music venue GPS',
      `SELECT
         count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int AS venues_with_gps,
         count(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL)::int AS venues_missing_gps
       FROM music_venues`
    );
    const gps = firstDiagnosticRow(gpsResult);
    venues.venues_with_gps = toIntegerCount(gps.venues_with_gps);
    venues.venues_missing_gps = toIntegerCount(gps.venues_missing_gps);
    venues.venues_missing_coordinates = venues.venues_missing_gps;

    const missingGpsSamples = await runMusicDiagnosticQuery(
      warnings,
      'music venue missing GPS samples',
      `SELECT coalesce(venue_key, venue_id::text) AS venue_id, venue, city, state, latitude, longitude
       FROM music_venues
       WHERE latitude IS NULL OR longitude IS NULL
       ORDER BY venue ASC
       LIMIT 10`
    );
    samples.venues_missing_gps = diagnosticRows(missingGpsSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['latitude', 'longitude', 'geo'], warnings)) {
    const geocodeResult = await runMusicDiagnosticQuery(
      warnings,
      'music venue geocode enrichment completeness',
      `SELECT
         count(*) FILTER (WHERE trim(coalesce(geo->>'formatted_address', '')) <> '')::int AS venues_with_formatted_address,
         count(*) FILTER (
           WHERE latitude IS NOT NULL
             AND longitude IS NOT NULL
             AND trim(coalesce(geo->>'formatted_address', '')) = ''
         )::int AS venues_pending_geocode_enrichment
       FROM music_venues`
    );
    const geocode = firstDiagnosticRow(geocodeResult);
    venues.venues_with_formatted_address = toIntegerCount(geocode.venues_with_formatted_address);
    venues.venues_pending_geocode_enrichment = toIntegerCount(geocode.venues_pending_geocode_enrichment);

    const pendingGeocodeSamples = await runMusicDiagnosticQuery(
      warnings,
      'music venue pending geocode samples',
      `SELECT coalesce(venue_key, venue_id::text) AS venue_id, venue, city, state, latitude, longitude
       FROM music_venues
       WHERE latitude IS NOT NULL
         AND longitude IS NOT NULL
         AND trim(coalesce(geo->>'formatted_address', '')) = ''
       ORDER BY venue ASC
       LIMIT 10`
    );
    samples.venues_pending_geocode_enrichment = diagnosticRows(pendingGeocodeSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['venue_key', 'venue', 'city', 'state', 'latitude', 'longitude'], warnings)) {
    const badMappingCondition = `length(trim(coalesce(venue, ''))) > 120
       OR length(trim(coalesce(city, ''))) > 80
       OR length(trim(coalesce(state, ''))) > 80
       OR lower(coalesce(venue, '')) LIKE '%http%'
       OR lower(coalesce(city, '')) LIKE '%http%'
       OR lower(coalesce(state, '')) LIKE '%http%'`;
    const badMappingResult = await runMusicDiagnosticQuery(
      warnings,
      'music venue bad column mapping detection',
      `SELECT count(*)::int AS bad_column_mapping_detected
       FROM music_venues
       WHERE ${badMappingCondition}`
    );
    venues.bad_column_mapping_detected = toIntegerCount(firstDiagnosticRow(badMappingResult).bad_column_mapping_detected);

    const badMappingSamples = await runMusicDiagnosticQuery(
      warnings,
      'music venue bad column mapping samples',
      `SELECT coalesce(venue_key, venue_id::text) AS venue_id, venue, city, state, latitude, longitude
       FROM music_venues
       WHERE ${badMappingCondition}
       ORDER BY venue ASC
       LIMIT 10`
    );
    samples.bad_column_mapping_detected = diagnosticRows(badMappingSamples);
  }

  addDiagnosticCountAliases(venues);
  venues.samples = samples;
}

async function addMusicRelationshipDiagnostics(response, existingTables, columnsByTable, warnings) {
  const relationships = response.relationships;
  const samples = {};

  if (existingTables.has('music_shows') && warnMissingDiagnosticColumns(columnsByTable, 'music_shows', ['venue'], warnings)) {
    const canUseVenueIdLink = existingTables.has('music_venues') &&
      hasDiagnosticColumn(columnsByTable, 'music_shows', 'venue_id') &&
      hasDiagnosticColumn(columnsByTable, 'music_venues', 'venue_key');
    const missingVenueWhere = canUseVenueIdLink
      ? `trim(coalesce(ms.venue, '')) = ''
         AND (
           trim(coalesce(ms.venue_id, '')) = ''
           OR mv.venue_key IS NULL
         )`
      : `trim(coalesce(ms.venue, '')) = ''`;
    const missingVenueJoin = canUseVenueIdLink
      ? `LEFT JOIN music_venues mv
           ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))`
      : '';
    const missingVenueResult = await runMusicDiagnosticQuery(
      warnings,
      'music relationship shows missing venue',
      `SELECT count(*)::int AS shows_missing_venue
       FROM music_shows ms
       ${missingVenueJoin}
       WHERE ${missingVenueWhere}`
    );
    relationships.shows_missing_venue = toIntegerCount(firstDiagnosticRow(missingVenueResult).shows_missing_venue);

    const missingVenueSamples = await runMusicDiagnosticQuery(
      warnings,
      'music relationship shows missing venue samples',
      `SELECT
         ms.show_id,
         ms.name,
         ms.date,
         ms.venue_id,
         ms.venue,
         ms.city,
         ms.state${canUseVenueIdLink ? `,
         (mv.venue_key IS NOT NULL) AS venue_id_exists_in_db,
         mv.venue AS matched_venue` : ''}
       FROM music_shows ms
       ${missingVenueJoin}
       WHERE ${missingVenueWhere}
       ORDER BY ms.show_id ASC
       LIMIT 10`
    );
    samples.shows_missing_venue = diagnosticRows(missingVenueSamples);
    if (relationships.shows_missing_venue > 0 && canUseVenueIdLink) {
      relationships.refresh_hint = 'Run /admin/import/music/venues?refresh=1 before validating Music Shows diagnostics.';
    }
  } else if (!existingTables.has('music_shows')) {
    warnings.push('Missing table for music relationship diagnostics: music_shows');
  }

  if (
    existingTables.has('music_shows') &&
    existingTables.has('music_venues') &&
    warnMissingDiagnosticColumns(columnsByTable, 'music_shows', ['venue_id'], warnings) &&
    warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['venue_key'], warnings)
  ) {
    relationships.music_show_venue_id_match_column = 'music_venues.venue_key';
    const invalidVenueIdResult = await runMusicDiagnosticQuery(
      warnings,
      'music relationship shows invalid venue_id',
      `SELECT count(*)::int AS shows_with_invalid_venue_id
       FROM music_shows ms
       LEFT JOIN music_venues mv
         ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
       WHERE trim(coalesce(ms.venue_id, '')) <> ''
         AND mv.venue_key IS NULL`
    );
    relationships.shows_with_invalid_venue_id = toIntegerCount(firstDiagnosticRow(invalidVenueIdResult).shows_with_invalid_venue_id);

    const invalidVenueIdSamples = await runMusicDiagnosticQuery(
      warnings,
      'music relationship shows invalid venue_id samples',
      `SELECT
         ms.show_id,
         ms.name,
         ms.date,
         ms.venue_id,
         ms.venue,
         false AS venue_id_exists_in_db
       FROM music_shows ms
       LEFT JOIN music_venues mv
         ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
       WHERE trim(coalesce(ms.venue_id, '')) <> ''
         AND mv.venue_key IS NULL
       ORDER BY ms.show_id ASC
       LIMIT 10`
    );
    samples.shows_with_invalid_venue_id = diagnosticRows(invalidVenueIdSamples);
    if (relationships.shows_with_invalid_venue_id > 0) {
      relationships.refresh_hint = 'Run /admin/import/music/venues?refresh=1 before validating Music Shows diagnostics.';
    }
  }

  if (
    existingTables.has('music_shows') &&
    existingTables.has('music_venues') &&
    warnMissingDiagnosticColumns(columnsByTable, 'music_shows', ['venue'], warnings) &&
    warnMissingDiagnosticColumns(columnsByTable, 'music_venues', ['venue'], warnings)
  ) {
    const unmatchedVenueResult = await runMusicDiagnosticQuery(
      warnings,
      'music unmatched venue names',
      `WITH show_venues AS (
         SELECT DISTINCT trim(venue) AS venue
         FROM music_shows
         WHERE trim(coalesce(venue, '')) <> ''
       )
       SELECT coalesce(array_agg(sv.venue ORDER BY sv.venue), '{}'::text[]) AS unmatched_venue_names
       FROM show_venues sv
       LEFT JOIN music_venues mv
         ON lower(trim(coalesce(mv.venue, ''))) = lower(trim(sv.venue))
       WHERE mv.venue IS NULL`
    );
    const unmatchedVenueNames = firstDiagnosticRow(unmatchedVenueResult).unmatched_venue_names;
    relationships.unmatched_venue_names = Array.isArray(unmatchedVenueNames) ? unmatchedVenueNames.slice(0, 100) : [];

    const unmatchedVenueSamples = await runMusicDiagnosticQuery(
      warnings,
      'music unmatched venue samples',
      `SELECT ms.show_id, ms.name, ms.date, ms.venue, ms.city, ms.state
       FROM music_shows ms
       LEFT JOIN music_venues mv
         ON lower(trim(coalesce(mv.venue, ''))) = lower(trim(coalesce(ms.venue, '')))
       WHERE trim(coalesce(ms.venue, '')) <> ''
         AND mv.venue IS NULL
       ORDER BY ms.show_id ASC
       LIMIT 10`
    );
    samples.unmatched_venue_names = diagnosticRows(unmatchedVenueSamples);
  } else if (!existingTables.has('music_venues')) {
    warnings.push('Unable to validate music show venue names because music_venues is missing.');
  }

  if (
    existingTables.has('music_bands') &&
    existingTables.has('music_people') &&
    warnMissingDiagnosticColumns(columnsByTable, 'music_bands', ['band'], warnings) &&
    warnMissingDiagnosticColumns(columnsByTable, 'music_people', ['bands'], warnings)
  ) {
    const bandsWithoutPeopleResult = await runMusicDiagnosticQuery(
      warnings,
      'music bands without people links',
      `WITH person_bands AS (
         SELECT DISTINCT lower(trim(band_item->>'band')) AS band_key
         FROM music_people
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(bands) = 'array' THEN bands ELSE '[]'::jsonb END) AS band_item
         WHERE trim(coalesce(band_item->>'band', '')) <> ''
       )
       SELECT count(*)::int AS bands_without_people_if_detectable
       FROM music_bands mb
       LEFT JOIN person_bands pb
         ON lower(trim(coalesce(mb.band, ''))) = pb.band_key
       WHERE trim(coalesce(mb.band, '')) <> ''
         AND pb.band_key IS NULL`
    );
    relationships.bands_without_people_if_detectable = toIntegerCount(firstDiagnosticRow(bandsWithoutPeopleResult).bands_without_people_if_detectable);

    const bandsWithoutPeopleSamples = await runMusicDiagnosticQuery(
      warnings,
      'music bands without people link samples',
      `WITH person_bands AS (
         SELECT DISTINCT lower(trim(band_item->>'band')) AS band_key
         FROM music_people
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(bands) = 'array' THEN bands ELSE '[]'::jsonb END) AS band_item
         WHERE trim(coalesce(band_item->>'band', '')) <> ''
       )
       SELECT mb.band_id, mb.band
       FROM music_bands mb
       LEFT JOIN person_bands pb
         ON lower(trim(coalesce(mb.band, ''))) = pb.band_key
       WHERE trim(coalesce(mb.band, '')) <> ''
         AND pb.band_key IS NULL
       ORDER BY mb.band ASC
       LIMIT 10`
    );
    samples.bands_without_people_if_detectable = diagnosticRows(bandsWithoutPeopleSamples);
  } else if (!existingTables.has('music_bands') || !existingTables.has('music_people')) {
    warnings.push('Unable to detect music bands without people because music_bands or music_people is missing.');
  }

  if (existingTables.has('music_people') && warnMissingDiagnosticColumns(columnsByTable, 'music_people', ['bands', 'category'], warnings)) {
    relationships.band_link_diagnostic_categories = Array.from(MUSIC_BAND_LINK_DIAGNOSTIC_CATEGORY_LABELS);
    const ignoredCategoryResult = await runMusicDiagnosticQuery(
      warnings,
      'music ignored people categories for band links',
      `SELECT coalesce(array_agg(DISTINCT category ORDER BY category), '{}'::text[]) AS ignored_categories
       FROM music_people
       WHERE trim(coalesce(category, '')) <> ''
         AND NOT (lower(trim(category)) = ANY($1::text[]))`,
      [Array.from(MUSIC_BAND_LINK_DIAGNOSTIC_CATEGORY_KEYS)]
    );
    const ignoredCategories = firstDiagnosticRow(ignoredCategoryResult).ignored_categories;
    relationships.ignored_categories_for_band_link_diagnostics = Array.isArray(ignoredCategories) ? ignoredCategories : [];

    const peopleWithoutBandsResult = await runMusicDiagnosticQuery(
      warnings,
      'music people without band links',
      `SELECT count(*)::int AS people_without_band_links_if_detectable
       FROM music_people
       WHERE lower(trim(coalesce(category, ''))) = ANY($1::text[])
         AND CASE
         WHEN jsonb_typeof(bands) = 'array' THEN jsonb_array_length(bands)
         ELSE 0
       END = 0`,
      [Array.from(MUSIC_BAND_LINK_DIAGNOSTIC_CATEGORY_KEYS)]
    );
    relationships.people_without_band_links_if_detectable = toIntegerCount(firstDiagnosticRow(peopleWithoutBandsResult).people_without_band_links_if_detectable);

    const peopleWithoutBandsSamples = await runMusicDiagnosticQuery(
      warnings,
      'music people without band link samples',
      `SELECT person_id, name, category
       FROM music_people
       WHERE lower(trim(coalesce(category, ''))) = ANY($1::text[])
         AND CASE
         WHEN jsonb_typeof(bands) = 'array' THEN jsonb_array_length(bands)
         ELSE 0
       END = 0
       ORDER BY name ASC
       LIMIT 10`,
      [Array.from(MUSIC_BAND_LINK_DIAGNOSTIC_CATEGORY_KEYS)]
    );
    samples.people_without_band_links_if_detectable = diagnosticRows(peopleWithoutBandsSamples);
  } else if (!existingTables.has('music_people')) {
    warnings.push('Unable to detect music people without band links because music_people is missing.');
  }

  addDiagnosticCountAliases(relationships);
  relationships.samples = samples;
}

async function buildMusicDiagnosticsResponse() {
  const generated = new Date();
  const warnings = [];
  const response = {
    ok: true,
    route: '/api/admin/diagnostics/music',
    source: 'postgres',
    section: 'music',
    type: 'diagnostics',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    source_tabs: buildMusicDiagnosticSourceTabs(),
    summary: {
      database_connected: false,
      tables: {
        music_bands: false,
        music_shows: false,
        music_people: false,
        music_venues: false
      },
      warning_count: 0,
      warnings
    },
    bands: {},
    shows: {},
    people: {},
    venues: {},
    relationships: {},
    adminProtection: getAdminProtectionStatus(),
    importHealth: createEmptyImportHealth(),
    lockHealth: createEmptyLockHealth(),
    relationshipHealth: {
      ok: true,
      errors: 0,
      warnings: 0,
      info: 0,
      overallHealth: 'unknown'
    },
    statsHealth: createEmptyStatsHealth()
  };

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Missing DATABASE_URL environment variable.');
    response.summary.warning_count = warnings.length;
    return response;
  }

  try {
    await dbPool.query('SELECT 1');
    response.summary.database_connected = true;
  } catch (err) {
    warnings.push(`Database disconnected: ${err && err.message ? err.message : String(err)}`);
    response.summary.warning_count = warnings.length;
    return response;
  }

  let existingTables;
  let columnsByTable;
  try {
    existingTables = await getExistingPublicTables(MUSIC_DIAGNOSTIC_TABLES);
    columnsByTable = await getExistingPublicColumns(MUSIC_DIAGNOSTIC_TABLES);
  } catch (err) {
    warnings.push(`Unable to inspect music tables: ${err && err.message ? err.message : String(err)}`);
    response.summary.warning_count = warnings.length;
    return response;
  }

  MUSIC_DIAGNOSTIC_TABLES.forEach((tableName) => {
    response.summary.tables[tableName] = existingTables.has(tableName);
  });

  await addMusicBandDiagnostics(response, existingTables, columnsByTable, warnings);
  await addMusicShowDiagnostics(response, existingTables, columnsByTable, warnings);
  await addMusicPeopleDiagnostics(response, existingTables, columnsByTable, warnings);
  await addMusicVenueDiagnostics(response, existingTables, columnsByTable, warnings);
  await addMusicRelationshipDiagnostics(response, existingTables, columnsByTable, warnings);
  response.importHealth = await buildImportHealth('music');
  response.summary.last_imported_at = response.importHealth.lastSuccessfulImportAt;
  response.summary.latest_imports = response.importHealth.latestImports;
  response.lockHealth = await buildLockHealth('music');
  response.relationshipHealth = await buildRelationshipHealth('music');
  response.statsHealth = await buildStatsHealth('music');

  response.summary.warning_count = warnings.length;
  return response;
}

async function addWrestlingVenueDiagnostics(response, existingTables, columnsByTable, warnings) {
  if (!existingTables.has('wrestling_venues')) {
    warnings.push('Missing table: wrestling_venues');
    return;
  }

  const venues = response.venues;
  const samples = {};
  const totalResult = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling venue totals',
    `SELECT count(*)::int AS total_venues FROM wrestling_venues`
  );
  venues.total_venues = toIntegerCount(firstDiagnosticRow(totalResult).total_venues);

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_venues', ['latitude', 'longitude'], warnings)) {
    const gpsResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling venue GPS',
      `SELECT
         count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int AS venues_with_gps,
         count(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL)::int AS venues_missing_gps
       FROM wrestling_venues`
    );
    const gps = firstDiagnosticRow(gpsResult);
    venues.venues_with_gps = toIntegerCount(gps.venues_with_gps);
    venues.venues_missing_gps = toIntegerCount(gps.venues_missing_gps);

    const missingGpsResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling venue missing GPS samples',
      `SELECT venue_id, venue_name, city, state
       FROM wrestling_venues
       WHERE latitude IS NULL OR longitude IS NULL
       ORDER BY venue_name ASC, city ASC, state ASC
       LIMIT 10`
    );
    samples.venues_missing_gps = diagnosticRows(missingGpsResult);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_venues', ['venue_name'], warnings)) {
    const missingNameResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling venues missing name',
      `SELECT count(*)::int AS venues_missing_name
       FROM wrestling_venues
       WHERE trim(coalesce(venue_name, '')) = ''`
    );
    venues.venues_missing_name = toIntegerCount(firstDiagnosticRow(missingNameResult).venues_missing_name);

    const missingNameSamples = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling venues missing name samples',
      `SELECT venue_id, city, state
       FROM wrestling_venues
       WHERE trim(coalesce(venue_name, '')) = ''
       ORDER BY venue_id ASC
       LIMIT 10`
    );
    samples.venues_missing_name = diagnosticRows(missingNameSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_venues', ['venue_id'], warnings)) {
    const duplicateVenueIdResult = await runWrestlingDiagnosticQuery(
      warnings,
      'duplicate wrestling venue IDs',
      `SELECT count(*)::int AS duplicate_venue_ids
       FROM (
         SELECT lower(trim(venue_id)) AS venue_id_key
         FROM wrestling_venues
         WHERE trim(coalesce(venue_id, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       ) duplicates`
    );
    venues.duplicate_venue_ids = toIntegerCount(firstDiagnosticRow(duplicateVenueIdResult).duplicate_venue_ids);

    const duplicateVenueIdSamples = await runWrestlingDiagnosticQuery(
      warnings,
      'duplicate wrestling venue ID samples',
      `SELECT lower(trim(venue_id)) AS venue_id, count(*)::int AS count
       FROM wrestling_venues
       WHERE trim(coalesce(venue_id, '')) <> ''
       GROUP BY 1
       HAVING count(*) > 1
       ORDER BY count DESC, venue_id ASC
       LIMIT 10`
    );
    samples.duplicate_venue_ids = diagnosticRows(duplicateVenueIdSamples);
  }

  venues.samples = samples;
}

async function addWrestlingShowDiagnostics(response, existingTables, columnsByTable, warnings) {
  if (!existingTables.has('wrestling_shows')) {
    warnings.push('Missing table: wrestling_shows');
    return;
  }

  const shows = response.shows;
  const samples = {};
  const totalResult = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling show totals',
    `SELECT count(*)::int AS total_records FROM wrestling_shows`
  );
  shows.total_records = toIntegerCount(firstDiagnosticRow(totalResult).total_records);

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_shows', ['show_name'], warnings)) {
    const missingShowNameResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling shows missing show name',
      `SELECT count(*)::int AS records_missing_show_name
       FROM wrestling_shows
       WHERE trim(coalesce(show_name, '')) = ''`
    );
    shows.records_missing_show_name = toIntegerCount(firstDiagnosticRow(missingShowNameResult).records_missing_show_name);

    const missingShowNameSamples = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling shows missing show name samples',
      `SELECT show_id, show_key, date, venue_id
       FROM wrestling_shows
       WHERE trim(coalesce(show_name, '')) = ''
       ORDER BY show_id ASC
       LIMIT 10`
    );
    samples.records_missing_show_name = diagnosticRows(missingShowNameSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_shows', ['date'], warnings)) {
    const missingDateResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling shows missing date',
      `SELECT count(*)::int AS records_missing_date
       FROM wrestling_shows
       WHERE trim(coalesce(date, '')) = ''`
    );
    shows.records_missing_date = toIntegerCount(firstDiagnosticRow(missingDateResult).records_missing_date);

    const missingDateSamples = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling shows missing date samples',
      `SELECT show_id, show_key, show_name, venue_id
       FROM wrestling_shows
       WHERE trim(coalesce(date, '')) = ''
       ORDER BY show_id ASC
       LIMIT 10`
    );
    samples.records_missing_date = diagnosticRows(missingDateSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_shows', ['venue_id'], warnings)) {
    const missingVenueIdResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling shows missing venue ID',
      `SELECT count(*)::int AS records_missing_venue_id
       FROM wrestling_shows
       WHERE trim(coalesce(venue_id, '')) = ''`
    );
    shows.records_missing_venue_id = toIntegerCount(firstDiagnosticRow(missingVenueIdResult).records_missing_venue_id);

    const missingVenueIdSamples = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling shows missing venue ID samples',
      `SELECT show_id, show_key, show_name, date
       FROM wrestling_shows
       WHERE trim(coalesce(venue_id, '')) = ''
       ORDER BY show_id ASC
       LIMIT 10`
    );
    samples.records_missing_venue_id = diagnosticRows(missingVenueIdSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_shows', ['show_key'], warnings)) {
    const duplicateShowKeyResult = await runWrestlingDiagnosticQuery(
      warnings,
      'duplicate wrestling show keys',
      `SELECT count(*)::int AS duplicate_show_keys
       FROM (
         SELECT lower(trim(show_key)) AS show_key_key
         FROM wrestling_shows
         WHERE trim(coalesce(show_key, '')) <> ''
         GROUP BY 1
         HAVING count(*) > 1
       ) duplicates`
    );
    shows.duplicate_show_keys = toIntegerCount(firstDiagnosticRow(duplicateShowKeyResult).duplicate_show_keys);

    const duplicateShowKeySamples = await runWrestlingDiagnosticQuery(
      warnings,
      'duplicate wrestling show key samples',
      `SELECT lower(trim(show_key)) AS show_key, count(*)::int AS count
       FROM wrestling_shows
       WHERE trim(coalesce(show_key, '')) <> ''
       GROUP BY 1
       HAVING count(*) > 1
       ORDER BY count DESC, show_key ASC
       LIMIT 10`
    );
    samples.duplicate_show_keys = diagnosticRows(duplicateShowKeySamples);
  }

  if (
    existingTables.has('wrestling_venues') &&
    warnMissingDiagnosticColumns(columnsByTable, 'wrestling_shows', ['venue_id'], warnings) &&
    warnMissingDiagnosticColumns(columnsByTable, 'wrestling_venues', ['venue_id'], warnings)
  ) {
    const invalidVenueResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling shows with invalid venue ID',
      `SELECT count(*)::int AS records_with_invalid_venue_id
       FROM wrestling_shows ws
       LEFT JOIN wrestling_venues wv
         ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
       WHERE trim(coalesce(ws.venue_id, '')) <> ''
         AND wv.venue_id IS NULL`
    );
    shows.records_with_invalid_venue_id = toIntegerCount(firstDiagnosticRow(invalidVenueResult).records_with_invalid_venue_id);

    const invalidVenueSamples = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling shows invalid venue ID samples',
      `SELECT ws.show_id, ws.show_name, ws.date, ws.venue_id
       FROM wrestling_shows ws
       LEFT JOIN wrestling_venues wv
         ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
       WHERE trim(coalesce(ws.venue_id, '')) <> ''
         AND wv.venue_id IS NULL
       ORDER BY ws.show_id ASC
       LIMIT 10`
    );
    samples.records_with_invalid_venue_id = diagnosticRows(invalidVenueSamples);
  } else if (!existingTables.has('wrestling_venues')) {
    warnings.push('Unable to validate wrestling show venue IDs because wrestling_venues is missing.');
  }

  shows.samples = samples;
}

async function addWrestlingMatchDiagnostics(response, existingTables, columnsByTable, warnings) {
  if (!existingTables.has('wrestling_shows')) {
    warnings.push('Missing table for match diagnostics: wrestling_shows');
    return;
  }
  if (!warnMissingDiagnosticColumns(columnsByTable, 'wrestling_shows', ['matches'], warnings)) return;

  const matchesArraySql = `CASE WHEN jsonb_typeof(matches) = 'array' THEN matches ELSE '[]'::jsonb END`;
  const participantArraySql = `CASE WHEN jsonb_typeof(match_item->'participants') = 'array' THEN match_item->'participants' ELSE '[]'::jsonb END`;
  const winnerArraySql = getWrestlingWinnerArraySql('match_item');
  const matches = response.matches;
  const samples = {};

  const totalsResult = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling match details',
    `SELECT
       count(*)::int AS total_matches,
       count(*) FILTER (WHERE jsonb_array_length(${participantArraySql}) = 0)::int AS matches_missing_participants,
       count(*) FILTER (WHERE jsonb_array_length(${winnerArraySql}) = 0)::int AS matches_missing_winner,
       count(*) FILTER (WHERE trim(coalesce(match_item->>'match_type', '')) = '')::int AS matches_missing_match_type,
       count(*) FILTER (
         WHERE match_item->'match_order' IS NULL
            OR trim(coalesce(match_item->>'match_order', '')) = ''
       )::int AS matches_missing_match_order
     FROM wrestling_shows
     CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) AS match_item`
  );
  const totals = firstDiagnosticRow(totalsResult);
  matches.total_matches = toIntegerCount(totals.total_matches);
  matches.total_records = matches.total_matches;
  matches.matches_missing_participants = toIntegerCount(totals.matches_missing_participants);
  matches.matches_missing_winner = toIntegerCount(totals.matches_missing_winner);
  matches.matches_missing_match_type = toIntegerCount(totals.matches_missing_match_type);
  matches.matches_missing_match_order = toIntegerCount(totals.matches_missing_match_order);

  const sampleBaseSql = `
    SELECT
      ws.show_id,
      ws.show_name,
      ws.date,
      match_item->>'match_order' AS match_order,
      match_item->>'match_type' AS match_type,
      match_item->'participants' AS participants,
      (
        SELECT array_to_string(array_agg(winner_item.value), '; ')
        FROM jsonb_array_elements_text(${winnerArraySql}) AS winner_item(value)
        WHERE trim(winner_item.value) <> ''
      ) AS winner
    FROM wrestling_shows ws
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END) AS match_item
  `;
  const missingParticipantSamples = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling match missing participant samples',
    `${sampleBaseSql}
     WHERE jsonb_array_length(CASE WHEN jsonb_typeof(match_item->'participants') = 'array' THEN match_item->'participants' ELSE '[]'::jsonb END) = 0
     ORDER BY ws.show_id ASC
     LIMIT 10`
  );
  samples.matches_missing_participants = diagnosticRows(missingParticipantSamples);

  const missingWinnerSamples = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling match missing winner samples',
    `${sampleBaseSql}
     WHERE jsonb_array_length(${winnerArraySql}) = 0
     ORDER BY ws.show_id ASC
     LIMIT 10`
  );
  samples.matches_missing_winner = diagnosticRows(missingWinnerSamples);

  const missingMatchTypeSamples = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling match missing type samples',
    `${sampleBaseSql}
     WHERE trim(coalesce(match_item->>'match_type', '')) = ''
     ORDER BY ws.show_id ASC
     LIMIT 10`
  );
  samples.matches_missing_match_type = diagnosticRows(missingMatchTypeSamples);

  const missingMatchOrderSamples = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling match missing order samples',
    `${sampleBaseSql}
     WHERE match_item->'match_order' IS NULL
        OR trim(coalesce(match_item->>'match_order', '')) = ''
     ORDER BY ws.show_id ASC
     LIMIT 10`
  );
  samples.matches_missing_match_order = diagnosticRows(missingMatchOrderSamples);
  matches.samples = samples;
}

async function addWrestlingPeopleDiagnostics(response, existingTables, columnsByTable, warnings) {
  if (!existingTables.has('wrestling_people')) {
    warnings.push('Missing table: wrestling_people');
    return;
  }

  const people = response.people;
  const samples = {};
  const totalResult = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling people totals',
    `SELECT count(*)::int AS total_people FROM wrestling_people`
  );
  people.total_people = toIntegerCount(firstDiagnosticRow(totalResult).total_people);

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_people', ['name'], warnings)) {
    const missingNameResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling people missing name',
      `SELECT count(*)::int AS people_missing_name
       FROM wrestling_people
       WHERE trim(coalesce(name, '')) = ''`
    );
    people.people_missing_name = toIntegerCount(firstDiagnosticRow(missingNameResult).people_missing_name);

    const missingNameSamples = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling people missing name samples',
      `SELECT id, slug, category
       FROM wrestling_people
       WHERE trim(coalesce(name, '')) = ''
       ORDER BY id ASC
       LIMIT 10`
    );
    samples.people_missing_name = diagnosticRows(missingNameSamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_people', ['category'], warnings)) {
    const missingCategoryResult = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling people missing category',
      `SELECT count(*)::int AS people_missing_category
       FROM wrestling_people
       WHERE trim(coalesce(category, '')) = ''`
    );
    people.people_missing_category = toIntegerCount(firstDiagnosticRow(missingCategoryResult).people_missing_category);

    const missingCategorySamples = await runWrestlingDiagnosticQuery(
      warnings,
      'wrestling people missing category samples',
      `SELECT id, slug, name
       FROM wrestling_people
       WHERE trim(coalesce(category, '')) = ''
       ORDER BY id ASC
       LIMIT 10`
    );
    samples.people_missing_category = diagnosticRows(missingCategorySamples);
  }

  if (warnMissingDiagnosticColumns(columnsByTable, 'wrestling_people', ['id'], warnings)) {
    const duplicatePersonIdResult = await runWrestlingDiagnosticQuery(
      warnings,
      'duplicate wrestling person IDs',
      `SELECT count(*)::int AS duplicate_person_ids
       FROM (
         SELECT id
         FROM wrestling_people
         GROUP BY id
         HAVING count(*) > 1
       ) duplicates`
    );
    people.duplicate_person_ids = toIntegerCount(firstDiagnosticRow(duplicatePersonIdResult).duplicate_person_ids);

    const duplicatePersonIdSamples = await runWrestlingDiagnosticQuery(
      warnings,
      'duplicate wrestling person ID samples',
      `SELECT id, count(*)::int AS count
       FROM wrestling_people
       GROUP BY id
       HAVING count(*) > 1
       ORDER BY count DESC, id ASC
       LIMIT 10`
    );
    samples.duplicate_person_ids = diagnosticRows(duplicatePersonIdSamples);
  }

  people.samples = samples;
}

async function addWrestlingRelationshipDiagnostics(response, existingTables, columnsByTable, warnings) {
  const relationships = response.relationships;
  const samples = {};

  if (!existingTables.has('wrestling_shows')) {
    warnings.push('Missing table for relationship diagnostics: wrestling_shows');
    return;
  }
  if (!existingTables.has('wrestling_venues')) {
    warnings.push('Missing table for relationship diagnostics: wrestling_venues');
    return;
  }
  if (
    !warnMissingDiagnosticColumns(columnsByTable, 'wrestling_shows', ['venue_id'], warnings) ||
    !warnMissingDiagnosticColumns(columnsByTable, 'wrestling_venues', ['venue_id'], warnings)
  ) {
    return;
  }

  const linkingResult = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling venue relationships',
    `WITH linked AS (
       SELECT
         nullif(trim(ws.venue_id), '') AS show_venue_id,
         wv.venue_id AS matched_venue_id
       FROM wrestling_shows ws
       LEFT JOIN wrestling_venues wv
         ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
     )
     SELECT
       count(matched_venue_id)::int AS valid_venue_links,
       count(*) FILTER (WHERE show_venue_id IS NOT NULL AND matched_venue_id IS NULL)::int AS invalid_venue_links,
       count(*) FILTER (WHERE show_venue_id IS NULL)::int AS shows_missing_venue_id,
       coalesce(
         array_agg(DISTINCT show_venue_id) FILTER (WHERE show_venue_id IS NOT NULL AND matched_venue_id IS NULL),
         '{}'::text[]
       ) AS unmatched_venue_ids
     FROM linked`
  );
  const linking = firstDiagnosticRow(linkingResult);
  const unmatchedVenueIds = Array.isArray(linking.unmatched_venue_ids) ? linking.unmatched_venue_ids : [];
  relationships.valid_venue_links = toIntegerCount(linking.valid_venue_links);
  relationships.invalid_venue_links = toIntegerCount(linking.invalid_venue_links);
  relationships.unmatched_venue_ids = unmatchedVenueIds;
  relationships.shows_missing_venue_id = toIntegerCount(linking.shows_missing_venue_id);
  relationships.venue_ids_not_in_venues_table = unmatchedVenueIds;

  const invalidSamples = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling invalid venue relationship samples',
    `SELECT ws.show_id, ws.show_name, ws.date, ws.venue_id
     FROM wrestling_shows ws
     LEFT JOIN wrestling_venues wv
       ON lower(trim(coalesce(ws.venue_id, ''))) = lower(trim(coalesce(wv.venue_id, '')))
     WHERE trim(coalesce(ws.venue_id, '')) <> ''
       AND wv.venue_id IS NULL
     ORDER BY ws.show_id ASC
     LIMIT 10`
  );
  samples.invalid_venue_links = diagnosticRows(invalidSamples);

  const missingVenueSamples = await runWrestlingDiagnosticQuery(
    warnings,
    'wrestling missing venue relationship samples',
    `SELECT show_id, show_name, date
     FROM wrestling_shows
     WHERE trim(coalesce(venue_id, '')) = ''
     ORDER BY show_id ASC
     LIMIT 10`
  );
  samples.shows_missing_venue_id = diagnosticRows(missingVenueSamples);
  relationships.samples = samples;
}

async function buildWrestlingDiagnosticsResponse() {
  const generated = new Date();
  const warnings = [];
  const response = {
    ok: true,
    route: '/api/admin/diagnostics/wrestling',
    source: 'postgres',
    section: 'wrestling',
    type: 'diagnostics',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    summary: {
      database_connected: false,
      tables: {
        wrestling_shows: false,
        wrestling_people: false,
        wrestling_venues: false
      },
      warning_count: 0,
      warnings
    },
    shows: {},
    matches: {},
    people: {},
    venues: {},
    relationships: {},
    adminProtection: getAdminProtectionStatus(),
    importHealth: createEmptyImportHealth(),
    lockHealth: createEmptyLockHealth(),
    relationshipHealth: {
      ok: true,
      errors: 0,
      warnings: 0,
      info: 0,
      overallHealth: 'unknown'
    },
    statsHealth: createEmptyStatsHealth()
  };

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Missing DATABASE_URL environment variable.');
    response.summary.warning_count = warnings.length;
    return response;
  }

  try {
    await dbPool.query('SELECT 1');
    response.summary.database_connected = true;
  } catch (err) {
    warnings.push(`Database disconnected: ${err && err.message ? err.message : String(err)}`);
    response.summary.warning_count = warnings.length;
    return response;
  }

  let existingTables;
  let columnsByTable;
  try {
    existingTables = await getExistingPublicTables(WRESTLING_DIAGNOSTIC_TABLES);
    columnsByTable = await getExistingPublicColumns(WRESTLING_DIAGNOSTIC_TABLES);
  } catch (err) {
    warnings.push(`Unable to inspect wrestling tables: ${err && err.message ? err.message : String(err)}`);
    response.summary.warning_count = warnings.length;
    return response;
  }

  WRESTLING_DIAGNOSTIC_TABLES.forEach((tableName) => {
    response.summary.tables[tableName] = existingTables.has(tableName);
  });

  await addWrestlingVenueDiagnostics(response, existingTables, columnsByTable, warnings);
  await addWrestlingShowDiagnostics(response, existingTables, columnsByTable, warnings);
  await addWrestlingMatchDiagnostics(response, existingTables, columnsByTable, warnings);
  await addWrestlingPeopleDiagnostics(response, existingTables, columnsByTable, warnings);
  await addWrestlingRelationshipDiagnostics(response, existingTables, columnsByTable, warnings);
  response.importHealth = await buildImportHealth('wrestling');
  response.lockHealth = await buildLockHealth('wrestling');
  response.relationshipHealth = await buildRelationshipHealth('wrestling');
  response.statsHealth = await buildStatsHealth('wrestling');

  response.summary.warning_count = warnings.length;
  return response;
}

const ADMIN_DIAGNOSTIC_TABLES = MUSIC_DIAGNOSTIC_TABLES.concat(WRESTLING_DIAGNOSTIC_TABLES);
const ADMIN_DIAGNOSTIC_ISSUE_KEY_RE = /(^|_)(missing|duplicate|invalid|unmatched|without|not_in)(_|\b)/i;

function countAdminDiagnosticIssues(value, key = '') {
  if (value == null) return 0;
  if (key === 'summary' || key === 'samples' || key === 'warnings' || key === 'tables') return 0;

  if (Array.isArray(value)) {
    return ADMIN_DIAGNOSTIC_ISSUE_KEY_RE.test(key) ? value.length : 0;
  }

  if (typeof value === 'number') {
    return ADMIN_DIAGNOSTIC_ISSUE_KEY_RE.test(key) ? toIntegerCount(value) : 0;
  }

  if (typeof value === 'object') {
    return Object.entries(value).reduce((sum, [childKey, childValue]) => {
      return sum + countAdminDiagnosticIssues(childValue, childKey);
    }, 0);
  }

  return 0;
}

function getAdminDiagnosticWarnings(diagnostic) {
  const warnings = diagnostic && diagnostic.summary && Array.isArray(diagnostic.summary.warnings)
    ? diagnostic.summary.warnings
    : [];
  return warnings.filter(Boolean).map((warning) => String(warning));
}

function uniqueAdminWarnings(warnings) {
  return Array.from(new Set((warnings || []).filter(Boolean).map((warning) => String(warning))));
}

function getAdminDiagnosticStatus(issueCount, warningCount) {
  if (issueCount > 0) return 'issues';
  if (warningCount > 0) return 'warnings';
  return 'ok';
}

async function buildAdminDiagnosticsDatabaseSummary(warnings) {
  const database = {
    database_connected: false,
    tables_checked: ADMIN_DIAGNOSTIC_TABLES,
    missing_tables: [],
    warning_count: 0
  };

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Missing DATABASE_URL environment variable.');
    database.warning_count = warnings.length;
    return database;
  }

  try {
    await dbPool.query('SELECT 1');
    database.database_connected = true;
  } catch (err) {
    warnings.push(`Database disconnected: ${err && err.message ? err.message : String(err)}`);
    database.warning_count = warnings.length;
    return database;
  }

  try {
    const existingTables = await getExistingPublicTables(ADMIN_DIAGNOSTIC_TABLES);
    database.missing_tables = ADMIN_DIAGNOSTIC_TABLES.filter((tableName) => !existingTables.has(tableName));
    database.missing_tables.forEach((tableName) => {
      warnings.push(`Missing table: ${tableName}`);
    });
  } catch (err) {
    warnings.push(`Unable to inspect admin diagnostic tables: ${err && err.message ? err.message : String(err)}`);
  }

  database.warning_count = warnings.length;
  return database;
}

async function buildAdminDiagnosticsResponse() {
  const generated = new Date();
  const warnings = [];
  const response = {
    ok: true,
    route: '/api/admin/diagnostics',
    source: 'postgres',
    section: 'admin',
    type: 'diagnostics',
    generatedAt: generated.toISOString(),
    generatedTime: formatEasternGeneratedTime(generated),
    database: {},
    summary: {
      total_music_issues: 0,
      total_wrestling_issues: 0,
      total_warnings: 0,
      music_status: 'ok',
      wrestling_status: 'ok',
      overall_status: 'ok'
    },
    music: {},
    wrestling: {},
    adminProtection: getAdminProtectionStatus(),
    importHealth: createEmptyImportHealth(),
    lockHealth: createEmptyLockHealth(),
    relationshipHealth: {
      ok: true,
      errors: 0,
      warnings: 0,
      info: 0,
      overallHealth: 'unknown'
    },
    statsHealth: createEmptyStatsHealth(),
    warnings
  };

  response.database = await buildAdminDiagnosticsDatabaseSummary(warnings);
  response.importHealth = await buildImportHealth();
  response.lockHealth = await buildLockHealth();
  response.relationshipHealth = await buildRelationshipHealth();
  response.statsHealth = await buildStatsHealth();

  try {
    response.music = await buildMusicDiagnosticsResponse();
  } catch (err) {
    const message = `Music diagnostics failed: ${err && err.message ? err.message : String(err)}`;
    warnings.push(message);
    response.music = {
      ok: false,
      route: '/api/admin/diagnostics/music',
      source: 'postgres',
      section: 'music',
      type: 'diagnostics',
      error: message
    };
  }

  try {
    response.wrestling = await buildWrestlingDiagnosticsResponse();
  } catch (err) {
    const message = `Wrestling diagnostics failed: ${err && err.message ? err.message : String(err)}`;
    warnings.push(message);
    response.wrestling = {
      ok: false,
      route: '/api/admin/diagnostics/wrestling',
      source: 'postgres',
      section: 'wrestling',
      type: 'diagnostics',
      error: message
    };
  }

  const musicWarnings = getAdminDiagnosticWarnings(response.music);
  const wrestlingWarnings = getAdminDiagnosticWarnings(response.wrestling);
  response.warnings = uniqueAdminWarnings(warnings.concat(musicWarnings, wrestlingWarnings));

  const totalMusicIssues = countAdminDiagnosticIssues(response.music);
  const totalWrestlingIssues = countAdminDiagnosticIssues(response.wrestling);
  const musicWarningCount = musicWarnings.length;
  const wrestlingWarningCount = wrestlingWarnings.length;
  const totalWarnings = response.warnings.length;

  response.summary = {
    total_music_issues: totalMusicIssues,
    total_wrestling_issues: totalWrestlingIssues,
    total_warnings: totalWarnings,
    music_status: getAdminDiagnosticStatus(totalMusicIssues, musicWarningCount),
    wrestling_status: getAdminDiagnosticStatus(totalWrestlingIssues, wrestlingWarningCount),
    overall_status: getAdminDiagnosticStatus(totalMusicIssues + totalWrestlingIssues, totalWarnings)
  };
  response.database.warning_count = warnings.length;

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


app.get('/admin/enrich/music/venues/geocode', requireAdminAccess, async (req, res) => {
  try {
    const result = await runMusicVenueGeocodeEnrichment(req.query || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: MUSIC_VENUE_GEOCODE_ROUTE,
      provider: getMusicVenueGeocodeProvider(),
      error: err && err.message ? err.message : String(err)
    });
  }
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

app.get('/api/admin/import-history', async (req, res) => {
  return handleImportHistoryRequest(req, res);
});

app.get('/api/admin/import-history/music', async (req, res) => {
  return handleImportHistoryRequest(req, res, 'music');
});

app.get('/api/admin/import-history/wrestling', async (req, res) => {
  return handleImportHistoryRequest(req, res, 'wrestling');
});

app.get('/api/admin/import-history/latest', async (req, res) => {
  return handleLatestImportHistoryRequest(req, res);
});

app.get('/api/admin/status', async (req, res) => {
  return handleAdminStatusRequest(req, res);
});

app.get('/api/admin/status/imports', async (req, res) => {
  return handleAdminImportStatusRequest(req, res, '/api/admin/status/imports');
});

app.get('/api/admin/diagnostics/imports', async (req, res) => {
  return handleImportDiagnosticsRequest(req, res);
});

app.get('/api/admin/import-locks', async (req, res) => {
  return handleImportLocksRequest(req, res);
});

app.get('/api/admin/import-locks/music', async (req, res) => {
  return handleImportLocksRequest(req, res, 'music');
});

app.get('/api/admin/import-locks/wrestling', async (req, res) => {
  return handleImportLocksRequest(req, res, 'wrestling');
});

app.get('/api/admin/relationships', async (req, res) => {
  return handleRelationshipsRequest(req, res);
});

app.get('/api/admin/relationships/summary', async (req, res) => {
  return handleRelationshipSummaryRequest(req, res);
});

app.get('/api/admin/relationships/music', async (req, res) => {
  return handleRelationshipsRequest(req, res, 'music');
});

app.get('/api/admin/relationships/wrestling', async (req, res) => {
  return handleRelationshipsRequest(req, res, 'wrestling');
});

app.get('/api/admin/diagnostics/relationships', async (req, res) => {
  return handleRelationshipDiagnosticsRequest(req, res);
});

app.get('/api/admin/diagnostics/music/relationships', async (req, res) => {
  return handleRelationshipDiagnosticsRequest(req, res, 'music');
});

app.get('/api/admin/diagnostics/wrestling/relationships', async (req, res) => {
  return handleRelationshipDiagnosticsRequest(req, res, 'wrestling');
});

async function buildSmugMusicSnapshotMigrationResponse(route) {
  const generated = new Date();
  const warnings = [];

  if (!String(process.env.DATABASE_URL || '').trim()) {
    return buildAdminResponse({
      ok: false,
      route,
      generated,
      source: 'postgres',
      section: 'music',
      type: 'smug_snapshot_migration',
      error: 'DATABASE_NOT_CONFIGURED',
      message: 'DATABASE_URL is required to run SmugMug snapshot field migration.',
      warnings
    });
  }

  const migration = await ensureSmugMusicSnapshotColumns(warnings);
  const existingTables = await getExistingPublicTables(SMUG_MUSIC_SNAPSHOT_TABLES);
  const columnsByTable = await getExistingPublicColumns(SMUG_MUSIC_SNAPSHOT_TABLES);
  const snapshotFields = buildSmugMusicSnapshotFieldStatus(existingTables, columnsByTable);

  return buildAdminResponse({
    ok: !!(migration && migration.ok && snapshotFields.present),
    route,
    generated,
    source: 'postgres',
    section: 'music',
    type: 'smug_snapshot_migration',
    migration,
    snapshotFields,
    readyForSync: snapshotFields.present,
    warnings
  });
}

async function handleSmugMusicSnapshotMigrationRequest(req, res) {
  try {
    const response = await buildSmugMusicSnapshotMigrationResponse(req.path || '/api/admin/smug/music/migrate-snapshot-fields');
    const statusCode = response.ok ? 200 : (response.error === 'DATABASE_NOT_CONFIGURED' ? 400 : 500);
    return res.status(statusCode).json(response);
  } catch (err) {
    return res.status(500).json(buildAdminError(req.path || '/api/admin/smug/music/migrate-snapshot-fields', err, {
      source: 'postgres',
      section: 'music',
      type: 'smug_snapshot_migration',
      error: 'SMUG_SNAPSHOT_MIGRATION_ERROR'
    }));
  }
}
async function handleSmugMusicConfigRequest(req, res) {
  try {
    res.json(await buildSmugMusicConfigResponse());
  } catch (err) {
    res.status(500).json(buildAdminError(req.path || '/admin/smug/music/config', err, {
      source: 'server',
      section: 'music',
      type: 'smug_config'
    }));
  }
}

async function handleSmugMusicDiagnosticsRequest(req, res) {
  try {
    res.json(await buildSmugMusicDiagnosticsResponse());
  } catch (err) {
    res.status(500).json(buildAdminError(req.path || '/admin/smug/music/diagnostics', err, {
      source: 'postgres',
      section: 'music',
      type: 'smug_diagnostics'
    }));
  }
}

app.get([
  '/admin/smug/music/migrate-snapshot-fields',
  '/api/admin/smug/music/migrate-snapshot-fields'
], handleSmugMusicSnapshotMigrationRequest);
app.get([
  '/admin/smug/music/bands/discover',
  '/admin/smug/music/discover',
  '/api/admin/smug/music/bands/discover',
  '/api/admin/smug/music/discover'
], async (req, res) => {
  return handleSmugMusicBandDiscoverRequest(req, res);
});

app.get([
  '/admin/smug/music/shows/resolve',
  '/admin/smug/music/resolve',
  '/api/admin/smug/music/shows/resolve',
  '/api/admin/smug/music/resolve'
], async (req, res) => {
  return handleSmugMusicShowResolveRequest(req, res);
});

app.get([
  '/admin/smug/music/config',
  '/api/admin/smug/music/config'
], handleSmugMusicConfigRequest);

app.get([
  '/admin/smug/music/diagnostics',
  '/api/admin/smug/music/diagnostics'
], handleSmugMusicDiagnosticsRequest);
app.get('/api/admin/stats/summary', async (req, res) => {
  return handleStatsSummaryRequest(req, res);
});

app.get('/api/admin/stats/rebuild', async (req, res) => {
  return handleStatsRebuildRequest(req, res);
});

app.get('/api/admin/stats/rebuild/music', async (req, res) => {
  return handleStatsRebuildRequest(req, res, 'music');
});

app.get('/api/admin/stats/rebuild/wrestling', async (req, res) => {
  return handleStatsRebuildRequest(req, res, 'wrestling');
});

app.get('/api/admin/overview', async (req, res) => {
  try {
    res.json(await buildAdminOverviewResponse());
  } catch (err) {
    res.status(500).json(buildAdminError('/api/admin/overview', err, {
      source: 'postgres',
      section: 'admin',
      type: 'overview'
    }));
  }
});

app.get('/api/admin/diagnostics', async (req, res) => {
  try {
    res.json(await buildAdminDiagnosticsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/admin/diagnostics',
      source: 'postgres',
      section: 'admin',
      type: 'diagnostics',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/admin/diagnostics/music', async (req, res) => {
  try {
    res.json(await buildMusicDiagnosticsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/admin/diagnostics/music',
      source: 'postgres',
      section: 'music',
      type: 'diagnostics',
      error: err && err.message ? err.message : String(err)
    });
  }
});

async function handleMusicDiagnosticsSectionRequest(req, res, category) {
  const route = `/api/admin/diagnostics/music/${category}`;
  try {
    const fullResponse = await buildMusicDiagnosticsResponse();
    const sectionResponse = buildMusicDiagnosticsSectionResponse(fullResponse, category, route);
    if (!sectionResponse) {
      return res.status(404).json({
        ok: false,
        route,
        source: 'postgres',
        section: 'music',
        type: 'diagnostics',
        error: 'NOT_FOUND'
      });
    }
    return res.json(sectionResponse);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      route,
      source: 'postgres',
      section: 'music',
      type: 'diagnostics',
      error: err && err.message ? err.message : String(err)
    });
  }
}

app.get('/api/admin/diagnostics/music/bands', async (req, res) => {
  return handleMusicDiagnosticsSectionRequest(req, res, 'bands');
});

app.get('/api/admin/diagnostics/music/shows', async (req, res) => {
  return handleMusicDiagnosticsSectionRequest(req, res, 'shows');
});

app.get('/api/admin/diagnostics/music/people', async (req, res) => {
  return handleMusicDiagnosticsSectionRequest(req, res, 'people');
});

app.get('/api/admin/diagnostics/music/venues', async (req, res) => {
  return handleMusicDiagnosticsSectionRequest(req, res, 'venues');
});

app.get('/api/admin/diagnostics/wrestling', async (req, res) => {
  try {
    res.json(await buildWrestlingDiagnosticsResponse());
  } catch (err) {
    res.status(500).json({
      ok: false,
      route: '/api/admin/diagnostics/wrestling',
      source: 'postgres',
      section: 'wrestling',
      type: 'diagnostics',
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
      if (routePath === '/api/music/people' && !forceRefresh) {
        try {
          const dbPeopleResponse = await buildMusicPeoplePublicDbResponse();
          if (dbPeopleResponse) {
            res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=60');
            return res.json(dbPeopleResponse);
          }
        } catch (dbErr) {
          console.warn('Music-People public DB response failed; falling back to sheet route:', getSafeErrorMessage(dbErr));
        }
      }
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
      if (routePath === '/api/music/venues') {
        return res.json(buildMusicVenuesResponse(payload));
      }
      return res.json(payload);
    } catch (err) {
      res.status(500).json(buildApiError(routePath, err, {
        source: cfg.label,
        error: 'SHEET_ROUTE_ERROR'
      }));
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
  res.status(404).json(buildApiError(req.path, new Error('Route not found.'), {
    error: 'NOT_FOUND',
    message: 'Route not found.',
    details: { path: req.path }
  }));
});

async function startServer() {
  logStartupEnvironmentWarnings();
  await applyDatabaseSchema();
  await applyRuntimeDatabaseMigrations();
  app.listen(PORT, () => {
    console.log(`VMPix V3 Data API listening on ${PORT}`);
  });
}

startServer();






























