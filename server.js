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
const SMUG_ALBUM_PHOTOS_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.SMUG_ALBUM_PHOTOS_CACHE_TTL_MS || 1000 * 60 * 10) || 1000 * 60 * 10
);
const SMUG_ALBUM_PHOTOS_DEFAULT_LIMIT = 12;
const SMUG_ALBUM_PHOTOS_MAX_LIMIT = 25;
const SMUG_ALBUM_PHOTOS_CACHE_VERSION = 'album_photos:v2';
const SMUG_WRESTLING_MATCH_PHOTOS_PAGE_LIMIT = getIntegerEnv('SMUG_WRESTLING_MATCH_PHOTOS_PAGE_LIMIT', 200, 1, 200);
const SMUG_WRESTLING_MATCH_PHOTOS_MAX_PAGES = getIntegerEnv('SMUG_WRESTLING_MATCH_PHOTOS_MAX_PAGES', 8, 1, 200);
const SMUG_WRESTLING_MATCH_PHOTOS_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.SMUG_WRESTLING_MATCH_PHOTOS_CACHE_TTL_MS || 1000 * 60 * 10) || 1000 * 60 * 10
);
const SMUG_WRESTLING_MATCH_PHOTOS_CACHE_VERSION = 'wrestling_match_photos:v3';
const WRESTLING_PEOPLE_PHOTO_COUNT_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.WRESTLING_PEOPLE_PHOTO_COUNT_CACHE_TTL_MS || SMUG_WRESTLING_MATCH_PHOTOS_CACHE_TTL_MS) || SMUG_WRESTLING_MATCH_PHOTOS_CACHE_TTL_MS
);
const WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS = getIntegerEnv('WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS', 500, 1, 2000);
const MUSIC_PEOPLE_ARCHIVE_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.MUSIC_PEOPLE_ARCHIVE_CACHE_TTL_MS || 1000 * 60 * 60 * 6) || 1000 * 60 * 60 * 6
);
const MUSIC_PEOPLE_ARCHIVE_REQUEST_WAIT_MS = getIntegerEnv('MUSIC_PEOPLE_ARCHIVE_REQUEST_WAIT_MS', 2500, 0, 15000);
const MUSIC_PEOPLE_ARCHIVE_MAX_ALBUMS = getIntegerEnv('MUSIC_PEOPLE_ARCHIVE_MAX_ALBUMS', 1000, 1, 1000);
const MUSIC_PEOPLE_ARCHIVE_MAX_PHOTO_PAGES_PER_ALBUM = getIntegerEnv('MUSIC_PEOPLE_ARCHIVE_MAX_PHOTO_PAGES_PER_ALBUM', 8, 1, 200);
const SMUG_BAND_COVERAGE_PHOTOS_PAGE_LIMIT = getIntegerEnv('SMUG_BAND_COVERAGE_PHOTOS_PAGE_LIMIT', 200, 1, 200);
const SMUG_BAND_COVERAGE_MAX_PAGES_PER_ALBUM = getIntegerEnv('SMUG_BAND_COVERAGE_MAX_PAGES_PER_ALBUM', 100, 1, 500);
const cache = new Map();
const smugTotalPhotosCache = new Map();
const smugTotalPhotosInFlight = new Map();
const smugPeoplePhotoCountCache = new Map();
const smugPeoplePhotoCountInFlight = new Map();
const smugAlbumPhotosCache = new Map();
const smugWrestlingMatchPhotosCache = new Map();
const smugWrestlingMatchPhotosInFlight = new Map();
const smugWrestlingAlbumIdCache = new Map();
const smugWrestlingAlbumIdInFlight = new Map();
const smugWrestlingFolderAlbumsCache = new Map();
const smugWrestlingFolderAlbumsInFlight = new Map();
const wrestlingPeoplePhotoAggregationPersonCache = new Map();
const wrestlingPeoplePhotoAggregationAlbumPhotosCache = new Map();
const wrestlingPeoplePhotoAggregationAlbumPhotosInFlight = new Map();
let smugWrestlingPeoplePhotoCountCache = null;
let smugWrestlingPeoplePhotoCountInFlight = null;
const smugMusicPeopleArchiveAlbumPhotosCache = new Map();
const smugMusicPeopleArchiveAlbumPhotosInFlight = new Map();
const smugMusicPersonArchiveRelationshipCache = new Map();
const smugMusicPersonArchiveRelationshipInFlight = new Map();
let smugMusicPeopleArchiveRelationshipCache = null;
let smugMusicPeopleArchiveRelationshipInFlight = null;
const smugBandArchiveCoverageCache = new Map();
const smugBandArchiveCoverageInFlight = new Map();

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
    '/api/admin/diagnostics/music/smugmug-shows/classification',
    '/api/admin/smug/music/shows/repair',
    '/api/admin/diagnostics/music/people',
    '/api/admin/diagnostics/music/venues',
    '/api/admin/diagnostics/wrestling',
    '/api/admin/diagnostics/wrestling/people/photo-aggregation',
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

  const showResolverResult = await ensureMusicShowResolverColumns();
  if (showResolverResult && showResolverResult.ok) {
    console.log('Runtime migration applied: Music show resolver columns ensured.');
  } else if (showResolverResult && showResolverResult.error) {
    console.warn(`Runtime migration warning: Music show resolver columns were not fully ensured: ${showResolverResult.error}`);
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

function buildSmugApiDebugUrl(endpoint) {
  const cleanEndpoint = normalizeSmugEndpoint(endpoint);
  return `${SMUG_API_BASE_URL}${cleanEndpoint}`;
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

function getSmugImageDateTimeOriginal(image) {
  return getSmugNestedField(image, [
    'DateTimeOriginal',
    'date_time_original',
    'dateTimeOriginal'
  ]);
}

function getSmugImageDateTaken(image) {
  return getSmugNestedField(image, [
    'DateTaken',
    'date_taken',
    'dateTaken'
  ]);
}

function getSmugImageTakenAt(image) {
  return getSmugNestedField(image, [
    'TakenAt',
    'taken_at',
    'takenAt'
  ]);
}

function clampSmugAlbumPhotoLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return SMUG_ALBUM_PHOTOS_DEFAULT_LIMIT;
  return Math.min(SMUG_ALBUM_PHOTOS_MAX_LIMIT, Math.max(1, parsed));
}

function clampSmugAlbumPhotoStart(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, parsed);
}

function getSmugNestedField(source, fieldNames, depth = 0) {
  if (!source || typeof source !== 'object' || depth > 5) return '';

  for (const fieldName of fieldNames) {
    const value = source[fieldName];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }

  const nestedKeys = ['Image', 'AlbumImage', 'Uris', 'UrisBySize', 'Thumbnail', 'Small', 'Medium', 'Large', 'XLarge', 'LargestImage'];
  for (const nestedKey of nestedKeys) {
    const nested = source[nestedKey];
    if (nested && typeof nested === 'object') {
      const value = getSmugNestedField(nested, fieldNames, depth + 1);
      if (value) return value;
    }
  }

  return '';
}

function getSmugNestedRawField(source, fieldNames, depth = 0) {
  if (!source || typeof source !== 'object' || depth > 5) return undefined;

  for (const fieldName of fieldNames) {
    if (Object.prototype.hasOwnProperty.call(source, fieldName)) return source[fieldName];
  }

  const nestedKeys = ['Image', 'AlbumImage', 'Uris', 'UrisBySize', 'Thumbnail', 'Small', 'Medium', 'Large', 'XLarge', 'LargestImage', 'DetailImage'];
  for (const nestedKey of nestedKeys) {
    const nested = source[nestedKey];
    if (nested && typeof nested === 'object') {
      const value = getSmugNestedRawField(nested, fieldNames, depth + 1);
      if (value !== undefined) return value;
    }
  }

  return undefined;
}
function getSmugAlbumPhotoImageKey(image) {
  const direct = getSmugNestedField(image, ['ImageKey', 'imageKey', 'Key', 'key']);
  if (direct) return direct;

  const uri = getSmugNestedField(image, ['Uri', 'URI', 'ImageUri', 'ImageURI', 'Url', 'URL', 'WebUri', 'WebURI']);
  const uriMatch = uri.match(/\/image\/([^/?#]+)/i);
  if (uriMatch && uriMatch[1]) return uriMatch[1].replace(/-0$/i, '');

  const url = getSmugImageUrlFromObject(image);
  const photoMatch = String(url || '').match(/\/photos\/(i-[A-Za-z0-9]+)/i);
  if (photoMatch && photoMatch[1]) return photoMatch[1];

  const looseMatch = String(url || '').match(/\bi-([A-Za-z0-9]+)\b/i);
  return looseMatch && looseMatch[1] ? `i-${looseMatch[1]}` : '';
}

const SMUG_ALBUM_PHOTO_URL_FIELDS = Object.freeze({
  thumbnail: ['ThumbnailUrl', 'ThumbnailURL', 'ThumbUrl', 'ThumbURL', 'TinyUrl', 'TinyURL'],
  small: ['SmallUrl', 'SmallURL'],
  medium: ['MediumUrl', 'MediumURL'],
  large: [
    'LargestUrl', 'LargestURL', 'X5LargeUrl', 'X5LargeURL', 'X4LargeUrl', 'X4LargeURL',
    'X3LargeUrl', 'X3LargeURL', 'X2LargeUrl', 'X2LargeURL', 'XLargeUrl', 'XLargeURL',
    'LargeUrl', 'LargeURL', 'OriginalUrl', 'OriginalURL', 'ImageUrl', 'ImageURL'
  ]
});

const SMUG_IMAGE_SIZE_RANK = {
  TI: 0,
  TH: 1,
  S: 2,
  M: 3,
  L: 4,
  XL: 5,
  X2: 6,
  X3: 7,
  X4: 8,
  X5: 9,
  O: 10
};
const SMUG_IMAGE_SIZE_PATTERN = 'Ti|Th|S|M|L|XL|X2|X3|X4|X5|O';

function normalizeSmugImageSizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(SMUG_IMAGE_SIZE_RANK, code) ? code : '';
}

function getSmugImageUrlSizeCode(sourceUrl) {
  const url = String(sourceUrl || '').trim();
  if (!url || !/photos\.smugmug\.com/i.test(url)) return '';

  const match = url.match(new RegExp(`/(${SMUG_IMAGE_SIZE_PATTERN})/[^/?#]+?-(${SMUG_IMAGE_SIZE_PATTERN})(?:\\.[a-z0-9]+)(?:[?#].*)?$`, 'i'));
  if (!match) return '';

  const folderCode = normalizeSmugImageSizeCode(match[1]);
  const fileCode = normalizeSmugImageSizeCode(match[2]);
  return folderCode && folderCode === fileCode ? folderCode : '';
}

function isSmugImageUrlAtLeast(sourceUrl, minimumSizeCode) {
  const sizeCode = getSmugImageUrlSizeCode(sourceUrl);
  const minimumCode = normalizeSmugImageSizeCode(minimumSizeCode);
  if (!sourceUrl || !minimumCode) return false;
  if (!sizeCode) return true;
  return SMUG_IMAGE_SIZE_RANK[sizeCode] >= SMUG_IMAGE_SIZE_RANK[minimumCode];
}

function buildSmugImageSizeVariantUrl(sourceUrl, sizeCode) {
  const url = String(sourceUrl || '').trim();
  const normalizedSizeCode = normalizeSmugImageSizeCode(sizeCode);
  if (!url || !normalizedSizeCode || !/photos\.smugmug\.com/i.test(url)) return '';

  const sizeUrlPattern = new RegExp(`/(${SMUG_IMAGE_SIZE_PATTERN})/([^/?#]+?)-(${SMUG_IMAGE_SIZE_PATTERN})(\\.[a-z0-9]+)([?#].*)?$`, 'i');
  if (!sizeUrlPattern.test(url)) return '';

  return url.replace(sizeUrlPattern, `/${normalizedSizeCode}/$2-${normalizedSizeCode}$4$5`);
}

function buildFirstSmugImageSizeVariantUrl(sourceUrl, sizeCodes) {
  for (const sizeCode of sizeCodes) {
    const variant = buildSmugImageSizeVariantUrl(sourceUrl, sizeCode);
    if (variant) return variant;
  }
  return '';
}

function getSmugAlbumPhotoDirectUrl(image, fieldNames) {
  return getSmugNestedField(image, fieldNames) || '';
}

function getSmugAlbumPhotoBaseUrl(image) {
  return getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.large)
    || getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.medium)
    || getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.small)
    || getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.thumbnail)
    || getSmugImageUrlFromObject(image)
    || '';
}

function getSmugAlbumPhotoUrls(image) {
  const baseUrl = getSmugAlbumPhotoBaseUrl(image);
  const thumbnailDirect = getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.thumbnail);
  const thumbnailUrl = thumbnailDirect || buildFirstSmugImageSizeVariantUrl(baseUrl, ['Th', 'Ti']) || baseUrl;

  const smallDirect = getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.small);
  const smallUrl = smallDirect || buildFirstSmugImageSizeVariantUrl(baseUrl || thumbnailUrl, ['S']) || thumbnailUrl;

  const mediumDirect = getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.medium);
  const mediumUrl = mediumDirect && isSmugImageUrlAtLeast(mediumDirect, 'M')
    ? mediumDirect
    : buildFirstSmugImageSizeVariantUrl(mediumDirect || smallUrl || thumbnailUrl || baseUrl, ['M']) || smallUrl || thumbnailUrl;

  const largeDirect = getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.large);
  const largeUrl = largeDirect && isSmugImageUrlAtLeast(largeDirect, 'L')
    ? largeDirect
    : buildFirstSmugImageSizeVariantUrl(largeDirect || mediumUrl || smallUrl || thumbnailUrl || baseUrl, ['X3', 'X2', 'XL', 'L']) || mediumUrl || smallUrl || thumbnailUrl;

  return {
    thumbnail_url: thumbnailUrl || '',
    small_url: smallUrl || '',
    medium_url: mediumUrl || '',
    large_url: largeUrl || ''
  };
}

function collectSmugAlbumPhotoAvailableUrlKeys(source, keys = new Set(), depth = 0) {
  if (!source || typeof source !== 'object' || depth > 5) return keys;

  Object.entries(source).forEach(([key, value]) => {
    if (typeof value === 'string') {
      if (isLikelySmugImageUrl(value)) keys.add(key);
      return;
    }

    if (value && typeof value === 'object' && /image|uri|url|thumb|small|medium|large|original|size/i.test(key)) {
      collectSmugAlbumPhotoAvailableUrlKeys(value, keys, depth + 1);
    }
  });

  return keys;
}

function getSmugAlbumPhotoAvailableUrlKeys(image) {
  return Array.from(collectSmugAlbumPhotoAvailableUrlKeys(image)).sort();
}

function hasSmugAlbumPhotoExplicitLargerUrl(image) {
  const smallUrl = getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.small);
  const mediumUrl = getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.medium);
  const largeUrl = getSmugAlbumPhotoDirectUrl(image, SMUG_ALBUM_PHOTO_URL_FIELDS.large);

  return !!(
    (smallUrl && isSmugImageUrlAtLeast(smallUrl, 'S'))
    || (mediumUrl && isSmugImageUrlAtLeast(mediumUrl, 'M'))
    || (largeUrl && isSmugImageUrlAtLeast(largeUrl, 'L'))
  );
}

function getSmugImageObjectFromDetail(json) {
  const resp = json && json.Response ? json.Response : json;
  const image = resp && (resp.Image || resp.AlbumImage || resp.Images || resp.AlbumImages || resp.image || resp.images);
  if (Array.isArray(image)) return image[0] && typeof image[0] === 'object' ? image[0] : null;
  return image && typeof image === 'object' ? image : null;
}

function mergeSmugAlbumPhotoDetail(image, detailImage) {
  if (!detailImage || typeof detailImage !== 'object') return image;

  const existingImage = image && image.Image && typeof image.Image === 'object' ? image.Image : {};
  return {
    ...image,
    Image: {
      ...existingImage,
      ...detailImage
    },
    DetailImage: detailImage
  };
}

async function hydrateSmugAlbumPhotoImage(image) {
  const imageKey = getSmugAlbumPhotoImageKey(image);
  if (!imageKey) return { image, hydrated: false, error: 'missing_image_key' };

  try {
    const detail = await fetchSmugImageDetail(imageKey);
    const detailImage = getSmugImageObjectFromDetail(detail.json);
    return {
      image: mergeSmugAlbumPhotoDetail(image, detailImage),
      hydrated: !!detailImage,
      endpoint: detail.endpoint || ''
    };
  } catch (err) {
    return {
      image,
      hydrated: false,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function buildSmugAlbumPhotoItem(image, options = {}) {
  const urls = getSmugAlbumPhotoUrls(image);
  const dateTimeOriginal = getSmugImageDateTimeOriginal(image);
  const dateTaken = getSmugImageDateTaken(image) || dateTimeOriginal;
  const takenAt = getSmugImageTakenAt(image) || dateTimeOriginal || dateTaken;
  const item = {
    image_key: getSmugAlbumPhotoImageKey(image),
    thumbnail_url: urls.thumbnail_url,
    small_url: urls.small_url,
    medium_url: urls.medium_url,
    large_url: urls.large_url,
    caption: getSmugImageCaption(image),
    date_taken: dateTaken || null,
    taken_at: takenAt || null,
    date_time_original: dateTimeOriginal || null
  };

  if (options.debug) {
    item.available_url_keys = getSmugAlbumPhotoAvailableUrlKeys(image);
    item.hydrated = !!options.hydrated;
    if (options.hydration_endpoint) item.hydration_endpoint = options.hydration_endpoint;
    if (options.hydration_error) item.hydration_error = options.hydration_error;
  }

  return item;
}

async function buildSmugAlbumPhotoItemForResponse(image, debug = false) {
  if (hasSmugAlbumPhotoExplicitLargerUrl(image)) {
    return buildSmugAlbumPhotoItem(image, { debug, hydrated: false });
  }

  const hydrated = await hydrateSmugAlbumPhotoImage(image);
  return buildSmugAlbumPhotoItem(hydrated.image, {
    debug,
    hydrated: hydrated.hydrated,
    hydration_endpoint: hydrated.endpoint || '',
    hydration_error: hydrated.error || ''
  });
}

async function buildSmugAlbumPhotoItemsForResponse(images, debug = false) {
  return mapWithConcurrency(images, SMUG_REQUEST_CONCURRENCY, (image) => buildSmugAlbumPhotoItemForResponse(image, debug));
}

function normalizeSmugKeywordValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function getSmugImageKeywordValues(image) {
  const raw = getSmugNestedRawField(image, [
    'Keywords',
    'Keyword',
    'keywords',
    'keyword',
    'Tags',
    'Tag',
    'tags',
    'tag'
  ]);

  if (Array.isArray(raw)) {
    return raw.map(normalizeSmugKeywordValue).filter(Boolean);
  }

  if (raw && typeof raw === 'object') {
    return Object.values(raw).map(normalizeSmugKeywordValue).filter(Boolean);
  }

  return String(raw || '')
    .split(/[;,|]/g)
    .map(normalizeSmugKeywordValue)
    .filter(Boolean);
}

async function buildSmugWrestlingAlbumPhotoItemForResponse(image) {
  const hydrated = await hydrateSmugAlbumPhotoImage(image);
  const sourceImage = hydrated.image || image;
  const item = buildSmugAlbumPhotoItem(sourceImage, {
    hydrated: hydrated.hydrated,
    hydration_endpoint: hydrated.endpoint || '',
    hydration_error: hydrated.error || ''
  });
  const keywords = getSmugImageKeywordValues(sourceImage);
  item.keywords = keywords;
  return item;
}

async function buildSmugWrestlingAlbumPhotoItemsForResponse(images) {
  return mapWithConcurrency(images, SMUG_REQUEST_CONCURRENCY, buildSmugWrestlingAlbumPhotoItemForResponse);
}
function getSmugAlbumPhotosCacheKey(albumId, limit, start) {
  return `${SMUG_ALBUM_PHOTOS_CACHE_VERSION}:${albumId}:${limit}:${start}`;
}

function getCachedSmugAlbumPhotos(albumId, limit, start) {
  const cacheKey = getSmugAlbumPhotosCacheKey(albumId, limit, start);
  const hit = smugAlbumPhotosCache.get(cacheKey);
  if (!hit) return null;

  if (Date.now() - hit.fetchedAt > SMUG_ALBUM_PHOTOS_CACHE_TTL_MS) {
    smugAlbumPhotosCache.delete(cacheKey);
    return null;
  }

  return hit.response;
}

function setCachedSmugAlbumPhotos(albumId, limit, start, response) {
  smugAlbumPhotosCache.set(getSmugAlbumPhotosCacheKey(albumId, limit, start), {
    fetchedAt: Date.now(),
    response
  });
}

function getSmugAlbumPhotosTotal(json, returnedCount, start, hasMore) {
  const pageTotal = getSmugPageTotal(json);
  if (pageTotal != null) return pageTotal;

  const resp = json && json.Response ? json.Response : json;
  const candidates = [
    resp && resp.Total,
    resp && resp.total,
    resp && resp.Album && getSmugAlbumImageCount(resp.Album),
    json && json.Album && getSmugAlbumImageCount(json.Album)
  ];

  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const total = Number(candidate);
    if (Number.isFinite(total) && total >= 0) return total;
  }

  const currentLast = start + Math.max(0, returnedCount) - 1;
  return hasMore ? currentLast + 1 : Math.max(0, currentLast);
}

function buildSmugAlbumPhotosPagination(json, photos, limit, start) {
  const returnedCount = Array.isArray(photos) ? photos.length : 0;
  const totalFromPayload = getSmugAlbumPhotosTotal(json, returnedCount, start, hasSmugNextPage(json));
  const hasMore = totalFromPayload != null
    ? start + returnedCount - 1 < totalFromPayload
    : hasSmugNextPage(json) || returnedCount >= limit;

  return {
    total: totalFromPayload,
    has_more: !!hasMore,
    next_start: hasMore && returnedCount > 0 ? start + returnedCount : null
  };
}

async function handleMusicSmugAlbumPhotosRequest(req, res) {
  const albumId = String(req.params.album_id || '').trim();
  const limit = clampSmugAlbumPhotoLimit(req.query.limit);
  const start = clampSmugAlbumPhotoStart(req.query.start);
  const generatedAt = new Date().toISOString();

  if (!albumId) {
    return res.status(400).json({
      ok: false,
      error: 'album photos unavailable',
      message: 'Missing album_id.',
      album_id: '',
      generatedAt
    });
  }

  const debug = req.query.debug === '1';
  const cached = debug ? null : getCachedSmugAlbumPhotos(albumId, limit, start);
  if (cached) {
    return res.json({ ...cached, cache: { hit: true } });
  }

  try {
    const endpoint = `/album/${encodeURIComponent(albumId)}!images?count=${limit}&start=${start}&_accept=application/json&_expand=Image`;
    const json = await fetchSmugJson(endpoint);
    const photos = await buildSmugAlbumPhotoItemsForResponse(getSmugAlbumImages(json).slice(0, limit), debug);
    const pagination = buildSmugAlbumPhotosPagination(json, photos, limit, start);
    const response = {
      ok: true,
      album_id: albumId,
      count: photos.length,
      limit,
      start,
      total: pagination.total,
      has_more: pagination.has_more,
      next_start: pagination.next_start,
      photos
    };

    if (!debug) setCachedSmugAlbumPhotos(albumId, limit, start, response);
    return res.json({ ...response, cache: { hit: false } });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'album photos unavailable',
      album_id: albumId,
      generatedAt,
      message: err && err.message ? err.message : String(err)
    });
  }
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
    .split(';')
    .map((part) => normalizePersonCaptionText(part).toLowerCase())
    .filter(Boolean);
  return captionParts.includes(cleanName.toLowerCase());
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

function createEmptyMusicPeopleArchiveRelationship() {
  return {
    photoKeys: new Set(),
    setKeys: new Set(),
    showKeys: new Set(),
    matchedPhotos: [],
    showMatches: new Map(),
    photo_count: 0,
    set_count: 0,
    show_count: 0,
    event_count: 0,
    gallery_id: null,
    album_id: null,
    cover_image_url: null,
    latestPhotoTime: 0,
    firstSeenTime: 0,
    first_seen: null,
    first_seen_display: null,
    latestSeenTime: 0,
    latest_seen: null,
    latest_seen_display: null
  };
}

function splitMusicPeopleArchiveAliases(value) {
  if (Array.isArray(value)) return value.flatMap(splitMusicPeopleArchiveAliases);
  if (value && typeof value === 'object') {
    return [value.alias, value.name, value.title, value.label, value.value].flatMap(splitMusicPeopleArchiveAliases);
  }
  return splitMusicDelimitedList(value);
}

function getMusicPeopleArchiveMatchNames(row) {
  const values = [
    row && row.name,
    ...splitMusicPeopleArchiveAliases(row && row.aliases)
  ];
  const seen = new Set();
  return values
    .map(normalizePersonCaptionText)
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function createMusicPeopleArchivePersonMatchers(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      person_id: String(row && row.person_id != null ? row.person_id : '').trim(),
      name: row && row.name ? row.name : '',
      matchNames: getMusicPeopleArchiveMatchNames(row)
    }))
    .filter((person) => person.person_id && person.matchNames.length > 0);
}

function getMusicPeopleArchiveAlbumKey(album) {
  return String(album && (album.album_id || album.albumId || album.gallery_id || album.galleryId || '') || '').trim();
}

function getMusicPeopleArchiveShowKey(show) {
  return String(show && (
    show.show_key ||
    show.showKey ||
    show.show_url ||
    show.showUrl ||
    formatMusicShowUrlDateKey(show.show_date || show.date) ||
    show.show_id ||
    show.id ||
    show.name ||
    ''
  ) || '').trim();
}

function getMusicPeopleArchiveShowTime(show) {
  const dateValue = String(show && (show.show_date || show.date || '') || '').trim();
  const parsed = dateValue ? Date.parse(dateValue) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMusicPeopleArchiveDateTimeOriginalTime(value) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMusicPeopleArchiveDateValue(...values) {
  return values
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
}

function getMusicPeopleArchivePhotoDateValue(photo, includeShowDateFallback = false) {
  const photoDate = getMusicPeopleArchiveDateValue(
    photo && photo.date_time_original,
    photo && photo.dateTimeOriginal,
    photo && photo.DateTimeOriginal,
    photo && photo.date_taken,
    photo && photo.dateTaken,
    photo && photo.DateTaken,
    photo && photo.taken_at,
    photo && photo.takenAt,
    photo && photo.TakenAt
  );
  if (photoDate || !includeShowDateFallback) return photoDate;
  return getMusicPeopleArchiveDateValue(
    photo && photo.show_date,
    photo && photo.showDate,
    photo && photo.date
  );
}

function getMusicPeopleArchiveMatchedPhotoTime(photo) {
  return getMusicPeopleArchiveDateTimeOriginalTime(getMusicPeopleArchivePhotoDateValue(photo, true));
}

function formatMusicPeopleArchiveSeenDate(value) {
  const time = getMusicPeopleArchiveDateTimeOriginalTime(value);
  if (!time) return null;
  const date = new Date(time);
  return [
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCFullYear())
  ].join('/');
}

function getMusicPeopleArchivePhotoUrl(photo) {
  return String(photo && (photo.thumbnail_url || photo.small_url || photo.medium_url || photo.large_url) || '').trim();
}

function buildMusicPeopleArchiveMatchedPhoto(album, photo, photoKey) {
  const show = album && album.show ? album.show : {};
  const albumId = String(album && album.album_id || '').trim();
  const dateTimeOriginal = getMusicPeopleArchiveDateValue(photo && photo.date_time_original, photo && photo.dateTimeOriginal, photo && photo.DateTimeOriginal);
  const dateTaken = getMusicPeopleArchiveDateValue(photo && photo.date_taken, photo && photo.dateTaken, photo && photo.DateTaken, dateTimeOriginal);
  const takenAt = getMusicPeopleArchiveDateValue(photo && photo.taken_at, photo && photo.takenAt, photo && photo.TakenAt, dateTimeOriginal, dateTaken);
  const showKey = getMusicPeopleArchiveShowKey(show);
  const showTitle = String(show && (show.show_title || show.showTitle || show.name || show.title) || '').trim();
  return {
    image_key: String(photo && photo.image_key || photoKey || '').trim(),
    caption: String(photo && photo.caption || '').trim(),
    date_taken: dateTaken || null,
    taken_at: takenAt || null,
    date_time_original: dateTimeOriginal || null,
    thumbnail_url: String(photo && photo.thumbnail_url || '').trim() || null,
    small_url: String(photo && photo.small_url || '').trim() || null,
    medium_url: String(photo && photo.medium_url || '').trim() || null,
    large_url: String(photo && photo.large_url || '').trim() || null,
    album_id: albumId || null,
    gallery_id: String(album && (album.gallery_id || albumId) || '').trim() || null,
    show_id: String(show && (show.show_id || show.id) || '').trim() || null,
    show_key: showKey || null,
    show_title: showTitle || null,
    show_name: showTitle || null,
    show_date: String(show && (show.show_date || show.date) || '').trim() || null,
    venue: String(show && show.venue || '').trim() || null,
    location: [show && show.city, show && show.state].map((part) => String(part || '').trim()).filter(Boolean).join(', ') || null
  };
}

function compareMusicPeopleArchiveMatchedPhotos(a, b) {
  const bTime = getMusicPeopleArchiveMatchedPhotoTime(b);
  const aTime = getMusicPeopleArchiveMatchedPhotoTime(a);
  if (bTime !== aTime) return bTime - aTime;
  return String(b && b.image_key || '').localeCompare(String(a && a.image_key || ''));
}

function finalizeMusicPeopleArchiveRelationships(relationships) {
  const finalized = new Map();
  relationships.forEach((relationship, personId) => {
    const matchedPhotos = relationship.matchedPhotos
      .slice()
      .sort(compareMusicPeopleArchiveMatchedPhotos);
    const taggedShows = Array.from(relationship.showMatches.values())
      .map((show) => {
        const showPhotos = Array.isArray(show.matched_photos) ? show.matched_photos.slice().sort(compareMusicPeopleArchiveMatchedPhotos) : [];
        return {
          ...show,
          tagged_photo_count: showPhotos.length,
          matched_photos: showPhotos
        };
      })
      .sort((a, b) => {
        const bTime = Math.max(0, ...(Array.isArray(b.matched_photos) ? b.matched_photos : []).map(getMusicPeopleArchiveMatchedPhotoTime));
        const aTime = Math.max(0, ...(Array.isArray(a.matched_photos) ? a.matched_photos : []).map(getMusicPeopleArchiveMatchedPhotoTime));
        return bTime - aTime;
      });
    finalized.set(String(personId || '').trim(), {
      photo_count: toIntegerCount(relationship.photo_count),
      set_count: toIntegerCount(relationship.set_count),
      show_count: toIntegerCount(relationship.show_count),
      event_count: toIntegerCount(relationship.event_count),
      gallery_id: relationship.gallery_id || null,
      album_id: relationship.album_id || null,
      cover_image_url: relationship.cover_image_url || null,
      first_seen: relationship.first_seen_display || null,
      first_seen_date_time_original: relationship.first_seen || null,
      first_seen_display: relationship.first_seen_display || null,
      latest_seen: relationship.latest_seen_display || null,
      latest_seen_date_time_original: relationship.latest_seen || null,
      latest_seen_display: relationship.latest_seen_display || null,
      matched_photos: matchedPhotos.slice(0, 24),
      tagged_shows: taggedShows
    });
  });
  return finalized;
}

function createEmptyMusicPersonArchivePayload() {
  return {
    photo_count: 0,
    set_count: 0,
    show_count: 0,
    event_count: 0,
    gallery_id: null,
    album_id: null,
    cover_image_url: null,
    first_seen: null,
    first_seen_date_time_original: null,
    first_seen_display: null,
    latest_seen: null,
    latest_seen_date_time_original: null,
    latest_seen_display: null,
    matched_photos: [],
    tagged_shows: []
  };
}

function collectMusicPeopleArchiveShowAlbums(show) {
  const albums = [];
  const sourceAlbums = Array.isArray(show && show.smug_albums) ? show.smug_albums : [];
  sourceAlbums.forEach((album) => {
    const albumId = getMusicPeopleArchiveAlbumKey(album);
    if (!albumId) return;
    albums.push({
      album_id: albumId,
      gallery_id: String(album && (album.gallery_id || album.galleryId || albumId) || '').trim(),
      cover_image_url: String(album && album.cover_image_url || '').trim(),
      show
    });
  });

  const directAlbumId = String(show && (show.album_id || show.gallery_id) || '').trim();
  if (directAlbumId && !albums.some((album) => album.album_id === directAlbumId)) {
    albums.push({
      album_id: directAlbumId,
      gallery_id: String(show && (show.gallery_id || directAlbumId) || '').trim(),
      cover_image_url: String(show && show.cover_image_url || '').trim(),
      show
    });
  }

  return albums;
}

async function fetchMusicPeopleArchiveAlbumPhotos(albumId) {
  const cacheKey = String(albumId || '').trim();
  if (!cacheKey || !SMUG_API_KEY) return [];

  const hit = smugMusicPeopleArchiveAlbumPhotosCache.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < MUSIC_PEOPLE_ARCHIVE_CACHE_TTL_MS) {
    return hit.photos;
  }

  if (smugMusicPeopleArchiveAlbumPhotosInFlight.has(cacheKey)) {
    return smugMusicPeopleArchiveAlbumPhotosInFlight.get(cacheKey);
  }

  const run = (async () => {
    const photos = [];
    let start = 1;
    for (let page = 0; page < MUSIC_PEOPLE_ARCHIVE_MAX_PHOTO_PAGES_PER_ALBUM; page += 1) {
      const endpoint = `/album/${encodeURIComponent(cacheKey)}!images?count=${SMUG_ALBUM_PHOTOS_MAX_LIMIT}&start=${start}&_accept=application/json&_expand=Image`;
      const json = await fetchSmugJson(endpoint);
      const images = getSmugAlbumImages(json).slice(0, SMUG_ALBUM_PHOTOS_MAX_LIMIT);
      if (!images.length) break;
      photos.push(...images.map((image) => buildSmugAlbumPhotoItem(image)));

      const pagination = buildSmugAlbumPhotosPagination(json, images, SMUG_ALBUM_PHOTOS_MAX_LIMIT, start);
      if (!pagination.has_more || !pagination.next_start) break;
      start = pagination.next_start;
    }

    smugMusicPeopleArchiveAlbumPhotosCache.set(cacheKey, { fetchedAt: Date.now(), photos });
    return photos;
  })().catch((err) => {
    console.warn(`Music-People archive album caption scan failed for ${cacheKey}:`, err && err.message ? err.message : String(err));
    smugMusicPeopleArchiveAlbumPhotosCache.set(cacheKey, { fetchedAt: Date.now(), photos: [] });
    return [];
  }).finally(() => {
    smugMusicPeopleArchiveAlbumPhotosInFlight.delete(cacheKey);
  });

  smugMusicPeopleArchiveAlbumPhotosInFlight.set(cacheKey, run);
  return run;
}

async function getMusicPeopleArchiveAlbumsForScan() {
  const showsResult = await dbPool.query(`
    SELECT id, show_id, name, date, show_date, show_url, venue, city, state, gallery_id, album_id, cover_image_url, smug_albums
    FROM music_shows
    WHERE (
      (jsonb_typeof(smug_albums) = 'array' AND jsonb_array_length(smug_albums) > 0)
      OR trim(coalesce(album_id, '')) <> ''
      OR trim(coalesce(gallery_id, '')) <> ''
    )
    ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST, id DESC
  `);

  const albumMap = new Map();
  (showsResult.rows || []).forEach((show) => {
    collectMusicPeopleArchiveShowAlbums(show).forEach((album) => {
      if (!album.album_id || albumMap.has(album.album_id)) return;
      albumMap.set(album.album_id, album);
    });
  });
  return Array.from(albumMap.values()).slice(0, MUSIC_PEOPLE_ARCHIVE_MAX_ALBUMS);
}

async function buildMusicPeopleArchiveRelationshipsForPeople(people) {
  const matchers = createMusicPeopleArchivePersonMatchers(people);
  if (!matchers.length) return new Map();

  const albums = await getMusicPeopleArchiveAlbumsForScan();
  const relationships = new Map();
  await mapWithConcurrency(albums, SMUG_REQUEST_CONCURRENCY, async (album) => {
    const photos = await fetchMusicPeopleArchiveAlbumPhotos(album.album_id);
    photos.forEach((photo) => {
      const caption = photo && photo.caption;
      if (!caption) return;
      matchers.forEach((person) => {
        if (person.matchNames.some((name) => captionMatchesPersonName(caption, name))) {
          addMusicPeopleArchiveMatch(relationships, person.person_id, album, photo);
        }
      });
    });
  });

  return finalizeMusicPeopleArchiveRelationships(relationships);
}

function addMusicPeopleArchiveMatch(relationships, personId, album, photo) {
  if (!relationships.has(personId)) {
    relationships.set(personId, createEmptyMusicPeopleArchiveRelationship());
  }

  const relationship = relationships.get(personId);
  const albumId = album.album_id || '';
  const showKey = getMusicPeopleArchiveShowKey(album.show);
  const imageKey = String(photo && photo.image_key || '').trim();
  const photoKey = imageKey || `${albumId}:${relationship.photoKeys.size + 1}`;

  const isNewPhoto = !relationship.photoKeys.has(photoKey);
  if (isNewPhoto) relationship.photoKeys.add(photoKey);
  if (albumId) {
    relationship.setKeys.add(albumId);
    relationship.set_count = relationship.setKeys.size;
  }
  if (showKey) {
    relationship.showKeys.add(showKey);
    relationship.show_count = relationship.showKeys.size;
    relationship.event_count = relationship.show_count;
  }

  let matchedPhoto = null;
  if (isNewPhoto) {
    matchedPhoto = buildMusicPeopleArchiveMatchedPhoto(album, photo, photoKey);
    relationship.matchedPhotos.push(matchedPhoto);
    relationship.photo_count = relationship.photoKeys.size;

    const matchedPhotoDate = getMusicPeopleArchivePhotoDateValue(matchedPhoto, true);
    const originalTime = getMusicPeopleArchiveDateTimeOriginalTime(matchedPhotoDate);
    if (originalTime && (!relationship.firstSeenTime || originalTime < relationship.firstSeenTime)) {
      relationship.firstSeenTime = originalTime;
      relationship.first_seen = matchedPhotoDate;
      relationship.first_seen_display = formatMusicPeopleArchiveSeenDate(matchedPhotoDate);
    }
    if (originalTime && originalTime >= relationship.latestSeenTime) {
      relationship.latestSeenTime = originalTime;
      relationship.latest_seen = matchedPhotoDate;
      relationship.latest_seen_display = formatMusicPeopleArchiveSeenDate(matchedPhotoDate);
    }

    const groupKey = showKey || albumId || photoKey;
    if (!relationship.showMatches.has(groupKey)) {
      relationship.showMatches.set(groupKey, {
        show_id: matchedPhoto.show_id,
        show_key: matchedPhoto.show_key,
        show_title: matchedPhoto.show_title,
        album_id: matchedPhoto.album_id,
        gallery_id: matchedPhoto.gallery_id,
        title: matchedPhoto.show_title || matchedPhoto.show_name || `Tagged Set ${relationship.showMatches.size + 1}`,
        date: matchedPhoto.show_date,
        venue: matchedPhoto.venue,
        location: matchedPhoto.location,
        matched_photos: []
      });
    }
    relationship.showMatches.get(groupKey).matched_photos.push(matchedPhoto);
  }

  const photoTime = matchedPhoto
    ? getMusicPeopleArchiveMatchedPhotoTime(matchedPhoto)
    : getMusicPeopleArchiveDateTimeOriginalTime(getMusicPeopleArchivePhotoDateValue(photo, true));
  const coverUrl = getMusicPeopleArchivePhotoUrl(photo) || String(album && album.cover_image_url || '').trim();
  if (coverUrl && (!relationship.cover_image_url || (photoTime && photoTime >= relationship.latestPhotoTime))) {
    relationship.latestPhotoTime = photoTime || relationship.latestPhotoTime;
    relationship.gallery_id = album.gallery_id || albumId || null;
    relationship.album_id = albumId || null;
    relationship.cover_image_url = coverUrl;
  }
}

async function buildMusicPeopleArchiveRelationships() {
  if (!SMUG_API_KEY || !String(process.env.DATABASE_URL || '').trim()) {
    return new Map();
  }

  const now = Date.now();
  if (
    smugMusicPeopleArchiveRelationshipCache &&
    now - smugMusicPeopleArchiveRelationshipCache.fetchedAt < MUSIC_PEOPLE_ARCHIVE_CACHE_TTL_MS
  ) {
    return smugMusicPeopleArchiveRelationshipCache.relationships;
  }

  if (smugMusicPeopleArchiveRelationshipInFlight) {
    return smugMusicPeopleArchiveRelationshipInFlight;
  }

  smugMusicPeopleArchiveRelationshipInFlight = (async () => {
    const peopleResult = await dbPool.query(`
      SELECT person_id, name, aliases
      FROM music_people
      WHERE trim(coalesce(name, '')) <> ''
      ORDER BY name ASC, person_id ASC
    `);
    const people = createMusicPeopleArchivePersonMatchers(peopleResult.rows || []);
    if (!people.length) return new Map();

    const finalized = await buildMusicPeopleArchiveRelationshipsForPeople(peopleResult.rows || []);

    smugMusicPeopleArchiveRelationshipCache = { fetchedAt: Date.now(), relationships: finalized };
    return finalized;
  })().catch((err) => {
    console.warn('Music-People archive relationship scan failed:', err && err.message ? err.message : String(err));
    return new Map();
  }).finally(() => {
    smugMusicPeopleArchiveRelationshipInFlight = null;
  });

  return smugMusicPeopleArchiveRelationshipInFlight;
}

function getCachedMusicPeopleArchiveRelationships() {
  if (
    smugMusicPeopleArchiveRelationshipCache &&
    Date.now() - smugMusicPeopleArchiveRelationshipCache.fetchedAt < MUSIC_PEOPLE_ARCHIVE_CACHE_TTL_MS
  ) {
    return smugMusicPeopleArchiveRelationshipCache.relationships;
  }
  return null;
}

async function getMusicPeopleArchiveRelationshipsForRequest() {
  const cached = getCachedMusicPeopleArchiveRelationships();
  if (cached) return cached;

  const relationshipBuild = buildMusicPeopleArchiveRelationships();
  if (!MUSIC_PEOPLE_ARCHIVE_REQUEST_WAIT_MS) {
    relationshipBuild.catch(() => {});
    return new Map();
  }

  return Promise.race([
    relationshipBuild,
    new Promise((resolve) => {
      setTimeout(() => resolve(new Map()), MUSIC_PEOPLE_ARCHIVE_REQUEST_WAIT_MS);
    })
  ]);
}

function shouldIncludeMusicPeopleArchive(query) {
  const value = String(query && (query.archive ?? query.include_archive ?? query.includeArchive) || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'detail', 'full'].includes(value);
}

function shouldUseCachedMusicPeopleArchive(query) {
  const value = String(query && (query.archive ?? query.include_archive ?? query.includeArchive) || '').trim().toLowerCase();
  return ['cache', 'cached', 'if-cached', 'if_cached'].includes(value);
}

function getMusicPeopleArchiveRelationshipsForListRequest(query) {
  if (shouldIncludeMusicPeopleArchive(query)) {
    return getMusicPeopleArchiveRelationshipsForRequest();
  }
  if (shouldUseCachedMusicPeopleArchive(query)) {
    const cached = getCachedMusicPeopleArchiveRelationships();
    if (cached) return Promise.resolve(cached);
    buildMusicPeopleArchiveRelationships().catch(() => {});
  }
  return Promise.resolve(new Map());
}

async function getMusicPersonArchiveRelationship(row) {
  if (!row || !String(row.person_id || '').trim()) return {};
  if (!SMUG_API_KEY || !String(process.env.DATABASE_URL || '').trim()) return {};

  const personId = String(row.person_id || '').trim();
  const cached = smugMusicPersonArchiveRelationshipCache.get(personId);
  if (cached && Date.now() - cached.fetchedAt < MUSIC_PEOPLE_ARCHIVE_CACHE_TTL_MS) {
    return cached.archive || {};
  }

  if (smugMusicPersonArchiveRelationshipInFlight.has(personId)) {
    return smugMusicPersonArchiveRelationshipInFlight.get(personId);
  }

  const run = buildMusicPeopleArchiveRelationshipsForPeople([row])
    .then((relationships) => relationships.get(personId) || createEmptyMusicPersonArchivePayload())
    .catch((err) => {
      console.warn(`Music-People person archive scan failed for ${personId}:`, err && err.message ? err.message : String(err));
      return {};
    })
    .then((archive) => {
      smugMusicPersonArchiveRelationshipCache.set(personId, { fetchedAt: Date.now(), archive });
      return archive;
    })
    .finally(() => {
      smugMusicPersonArchiveRelationshipInFlight.delete(personId);
    });

  smugMusicPersonArchiveRelationshipInFlight.set(personId, run);
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

const MUSIC_BAND_ARCHIVE_COVERAGE_KEYS = Object.freeze([
  'years_covered',
  'first_capture_year',
  'last_capture_year',
  'most_active_year',
  'most_active_year_photo_count',
  'latest_seen',
  'last_updated'
]);

function createEmptyMusicBandArchiveCoverage() {
  return {
    years_covered: null,
    first_capture_year: null,
    last_capture_year: null,
    most_active_year: null,
    most_active_year_photo_count: null,
    latest_seen: null,
    last_updated: null
  };
}

function getMusicBandArchiveCoverageFromStats(stats) {
  const source = stats && typeof stats === 'object' ? stats : {};
  const coverage = {};

  MUSIC_BAND_ARCHIVE_COVERAGE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      coverage[key] = source[key];
    }
  });

  return coverage;
}

function addMusicBandArchiveCoverageFields(target, coverage) {
  if (!target || typeof target !== 'object' || !coverage || typeof coverage !== 'object') return target;

  MUSIC_BAND_ARCHIVE_COVERAGE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(coverage, key)) {
      target[key] = coverage[key];
    }
  });

  return target;
}

function normalizeMusicBandCoverageLookupKey(value) {
  return String(value || '').trim().toLowerCase();
}

async function buildMusicBandArchiveCoverageLookup(rows) {
  if (!String(process.env.DATABASE_URL || '').trim()) return new Map();

  const bandIds = Array.from(new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row && row.band_id || '').trim())
    .filter(Boolean)));
  const bandNames = Array.from(new Set((Array.isArray(rows) ? rows : [])
    .map((row) => getMusicBandName(row))
    .map(normalizeMusicBandCoverageLookupKey)
    .filter(Boolean)));
  if (!bandIds.length && !bandNames.length) return new Map();

  try {
    const result = await dbPool.query(
      `SELECT band_id, band, stats
       FROM music_bands
       WHERE band_id = ANY($1::text[])
          OR lower(trim(band)) = ANY($2::text[])`,
      [bandIds, bandNames]
    );
    const lookup = new Map();

    (result.rows || []).forEach((row) => {
      const coverage = getMusicBandArchiveCoverageFromStats(row.stats);
      if (Object.keys(coverage).length > 0) {
        lookup.set(normalizeMusicBandCoverageLookupKey(row.band_id), coverage);
        lookup.set(normalizeMusicBandCoverageLookupKey(row.band), coverage);
      }
    });

    return lookup;
  } catch (err) {
    console.warn('Music-Bands archive coverage lookup failed:', err && err.message ? err.message : String(err));
    return new Map();
  }
}

function getMusicBandArchiveCoverageForRow(row, coverageLookup) {
  if (!coverageLookup || typeof coverageLookup.get !== 'function') return {};
  return coverageLookup.get(normalizeMusicBandCoverageLookupKey(row && row.band_id)) ||
    coverageLookup.get(normalizeMusicBandCoverageLookupKey(getMusicBandName(row))) ||
    {};
}

function hasMusicBandArchiveCoverageData(coverage) {
  if (!coverage || typeof coverage !== 'object') return false;
  return MUSIC_BAND_ARCHIVE_COVERAGE_KEYS.some((key) => {
    const value = coverage[key];
    return value != null && String(value).trim() !== '';
  });
}

function hasRequiredMusicBandArchiveCoverageData(coverage) {
  if (!coverage || typeof coverage !== 'object') return false;
  return ['years_covered', 'most_active_year', 'latest_seen', 'last_updated'].every((key) => {
    const value = coverage[key];
    return value != null && String(value).trim() !== '';
  });
}

function getMusicBandArchiveCoverageRequestRef(query) {
  const params = query && typeof query === 'object' ? query : {};
  const mode = String(params.coverage || params.archive_coverage || '').trim().toLowerCase();
  if (!['1', 'true', 'archive', 'archive_coverage'].includes(mode)) return '';

  return String(params.band_id || params.bandId || params.band || params.id || '').trim();
}

function getMusicBandArchiveCoverageRowKeys(row) {
  const bandName = getMusicBandName(row);
  return [
    row && row.band_id,
    row && row.bandId,
    row && row.id,
    row && row.slug,
    bandName,
    slugifyMusicBandId(bandName),
    row && row.smug_folder,
    row && row.slug_folder
  ]
    .map(normalizeMusicBandCoverageLookupKey)
    .filter(Boolean);
}

function findMusicBandArchiveCoverageRow(rows, bandRef) {
  const requestedKeys = new Set([
    normalizeMusicBandCoverageLookupKey(bandRef),
    normalizeMusicBandCoverageLookupKey(slugifyMusicBandId(bandRef))
  ].filter(Boolean));

  return (Array.isArray(rows) ? rows : []).find((row) => {
    return getMusicBandArchiveCoverageRowKeys(row).some((key) => requestedKeys.has(key));
  }) || null;
}

async function buildMusicBandArchiveCoverageForRow(row, forceRefresh) {
  const dbLookup = await buildMusicBandArchiveCoverageLookup([row]);
  const dbCoverage = getMusicBandArchiveCoverageForRow(row, dbLookup);
  if (!forceRefresh && hasRequiredMusicBandArchiveCoverageData(dbCoverage)) {
    return {
      sourceType: 'database',
      albumCount: null,
      coverage: dbCoverage
    };
  }

  const target = getMusicBandSmugTarget(row);
  if (!target || !SMUG_API_KEY) {
    return {
      sourceType: target ? 'smugmug_unavailable' : 'missing_smugmug_target',
      albumCount: null,
      coverage: hasMusicBandArchiveCoverageData(dbCoverage)
        ? dbCoverage
        : createEmptyMusicBandArchiveCoverage()
    };
  }

  try {
    const json = await fetchSmugJson(buildMusicBandAlbumsEndpoint(target));
    const albums = getSmugAlbums(json);
    const coverage = await fetchMusicBandArchiveCoverage(row, albums, forceRefresh);
    return {
      sourceType: 'smugmug',
      albumCount: albums.length,
      coverage
    };
  } catch (err) {
    console.warn(`Music-Bands archive coverage request failed for ${target.region}/${target.folder}:`, err && err.message ? err.message : String(err));
    return {
      sourceType: 'smugmug_error',
      albumCount: null,
      coverage: hasMusicBandArchiveCoverageData(dbCoverage)
        ? dbCoverage
        : createEmptyMusicBandArchiveCoverage()
    };
  }
}

async function buildMusicBandArchiveCoverageResponse(payload, bandRef, forceRefresh) {
  const row = findMusicBandArchiveCoverageRow(payload && payload.rows, bandRef);
  if (!row) {
    return {
      ok: false,
      route: '/api/music/bands',
      type: 'music_band_archive_coverage',
      error: 'BAND_NOT_FOUND',
      band_ref: bandRef,
      archive_coverage: createEmptyMusicBandArchiveCoverage()
    };
  }

  const bandName = getMusicBandName(row);
  const bandId = String(row.band_id || '').trim() || slugifyMusicBandId(bandName);
  const result = await buildMusicBandArchiveCoverageForRow(row, forceRefresh);
  const coverage = {
    ...createEmptyMusicBandArchiveCoverage(),
    ...(result.coverage && typeof result.coverage === 'object' ? result.coverage : {})
  };
  const stats = {};
  addMusicBandArchiveCoverageFields(stats, coverage);

  return {
    ok: true,
    route: '/api/music/bands',
    type: 'music_band_archive_coverage',
    band_id: bandId,
    band: bandName,
    source: {
      name: payload && payload.source ? payload.source : 'Music-Bands',
      type: result.sourceType,
      album_count: result.albumCount
    },
    archive_coverage: coverage,
    stats,
    ...coverage
  };
}

function normalizeSmugCoverageDateValue(value) {
  const clean = String(value || '').trim();
  if (!clean || /^0{4}[:/-]0{1,2}[:/-]0{1,2}/.test(clean)) return null;

  let match = clean.match(/^(\d{4})[:/-](\d{1,2})[:/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);
    if (year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        year,
        month,
        day,
        time: Date.UTC(year, month - 1, day, hour, minute, second)
      };
    }
  }

  match = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const shortYear = String(match[3]);
    const year = shortYear.length === 2 ? Number(`20${shortYear}`) : Number(shortYear);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);
    if (year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        year,
        month,
        day,
        time: Date.UTC(year, month - 1, day, hour, minute, second)
      };
    }
  }

  const parsed = Date.parse(clean);
  if (Number.isNaN(parsed)) return null;
  const date = new Date(parsed);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    time: parsed
  };
}

function formatMusicBandCoverageDate(dateInfo) {
  if (!dateInfo) return null;
  return `${String(dateInfo.month).padStart(2, '0')}/${String(dateInfo.day).padStart(2, '0')}/${dateInfo.year}`;
}

function getSmugArchiveCoverageField(image, fieldName, depth = 0, seen = new Set()) {
  if (!image || typeof image !== 'object' || depth > 8 || seen.has(image)) return '';
  seen.add(image);

  const camelField = fieldName.charAt(0).toLowerCase() + fieldName.slice(1);
  for (const key of [fieldName, camelField]) {
    const value = image[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }

  for (const value of Object.values(image)) {
    if (value && typeof value === 'object') {
      const nested = getSmugArchiveCoverageField(value, fieldName, depth + 1, seen);
      if (nested) return nested;
    }
  }

  return '';
}

function createSmugBandArchiveCoverageAccumulator() {
  return {
    firstOriginal: null,
    latestOriginal: null,
    latestUpdated: null,
    yearCounts: new Map()
  };
}

function addSmugImageToBandArchiveCoverage(accumulator, image) {
  const dateTimeOriginal = normalizeSmugCoverageDateValue(getSmugArchiveCoverageField(image, 'DateTimeOriginal'));
  if (dateTimeOriginal) {
    if (!accumulator.firstOriginal || dateTimeOriginal.time < accumulator.firstOriginal.time) {
      accumulator.firstOriginal = dateTimeOriginal;
    }
    if (!accumulator.latestOriginal || dateTimeOriginal.time > accumulator.latestOriginal.time) {
      accumulator.latestOriginal = dateTimeOriginal;
    }
    accumulator.yearCounts.set(dateTimeOriginal.year, (accumulator.yearCounts.get(dateTimeOriginal.year) || 0) + 1);
  }

  const lastUpdated = normalizeSmugCoverageDateValue(getSmugArchiveCoverageField(image, 'LastUpdated'));
  if (lastUpdated && (!accumulator.latestUpdated || lastUpdated.time > accumulator.latestUpdated.time)) {
    accumulator.latestUpdated = lastUpdated;
  }
}

function finalizeSmugBandArchiveCoverage(accumulator) {
  if (!accumulator || !accumulator.firstOriginal) {
    return createEmptyMusicBandArchiveCoverage();
  }

  let mostActiveYear = null;
  let mostActiveYearPhotoCount = 0;
  Array.from(accumulator.yearCounts.entries())
    .sort(([yearA, countA], [yearB, countB]) => countB - countA || yearA - yearB)
    .forEach(([year, count], index) => {
      if (index === 0) {
        mostActiveYear = year;
        mostActiveYearPhotoCount = count;
      }
    });

  const firstYear = accumulator.firstOriginal.year;
  const lastYear = accumulator.latestOriginal.year;
  return {
    years_covered: firstYear === lastYear ? String(firstYear) : `${firstYear}-${lastYear}`,
    first_capture_year: firstYear,
    last_capture_year: lastYear,
    most_active_year: mostActiveYear,
    most_active_year_photo_count: mostActiveYearPhotoCount,
    latest_seen: formatMusicBandCoverageDate(accumulator.latestOriginal),
    last_updated: formatMusicBandCoverageDate(accumulator.latestUpdated)
  };
}

async function addSmugAlbumImagesToBandArchiveCoverage(album, accumulator) {
  const albumId = getSmugAlbumKey(album);
  if (!albumId) return;

  let start = 1;
  let page = 0;
  while (page < SMUG_BAND_COVERAGE_MAX_PAGES_PER_ALBUM) {
    const json = await fetchSmugJson(`/album/${encodeURIComponent(albumId)}!images?count=${SMUG_BAND_COVERAGE_PHOTOS_PAGE_LIMIT}&start=${start}&_accept=application/json&_expand=Image`);
    const images = getSmugAlbumImages(json);
    if (!images.length) break;

    images.forEach((image) => addSmugImageToBandArchiveCoverage(accumulator, image));

    const pageCount = getSmugPageCount(json);
    if (!hasSmugNextPage(json) || pageCount == null || pageCount <= 0) break;
    start += pageCount;
    page += 1;
  }
}

async function buildSmugMusicBandArchiveCoverage(albums) {
  const accumulator = createSmugBandArchiveCoverageAccumulator();
  const albumList = Array.isArray(albums) ? albums : [];

  await mapWithConcurrency(albumList, SMUG_REQUEST_CONCURRENCY, async (album) => {
    try {
      await addSmugAlbumImagesToBandArchiveCoverage(album, accumulator);
    } catch (err) {
      console.warn(`Music-Bands SmugMug archive coverage failed for album ${getSmugAlbumKey(album) || 'unknown'}:`, err && err.message ? err.message : String(err));
    }
  });

  return finalizeSmugBandArchiveCoverage(accumulator);
}

async function fetchMusicBandArchiveCoverage(row, albums, forceRefresh) {
  if (!SMUG_API_KEY) return createEmptyMusicBandArchiveCoverage();

  const target = getMusicBandSmugTarget(row);
  if (!target) return createEmptyMusicBandArchiveCoverage();

  const cacheKey = `${target.region}/${target.folder}`;
  const hit = smugBandArchiveCoverageCache.get(cacheKey);
  if (!forceRefresh && hit && Date.now() - hit.fetchedAt < SMUG_TOTAL_PHOTOS_CACHE_TTL_MS) {
    return hit.coverage;
  }

  if (smugBandArchiveCoverageInFlight.has(cacheKey)) {
    return smugBandArchiveCoverageInFlight.get(cacheKey);
  }

  const run = (async () => {
    try {
      const coverage = await buildSmugMusicBandArchiveCoverage(albums);
      smugBandArchiveCoverageCache.set(cacheKey, { coverage, fetchedAt: Date.now() });
      return coverage;
    } catch (err) {
      console.warn(`Music-Bands SmugMug archive coverage failed for ${cacheKey}:`, err && err.message ? err.message : String(err));
      const coverage = createEmptyMusicBandArchiveCoverage();
      smugBandArchiveCoverageCache.set(cacheKey, { coverage, fetchedAt: Date.now() });
      return coverage;
    } finally {
      smugBandArchiveCoverageInFlight.delete(cacheKey);
    }
  })();

  smugBandArchiveCoverageInFlight.set(cacheKey, run);
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

function filterInferredCurrentMusicBandMembers(members, pastMembers) {
  if (!Array.isArray(members) || !members.length) return [];
  if (!Array.isArray(pastMembers) || !pastMembers.length) return members;

  const pastKeys = new Set(
    pastMembers
      .map((member) => normalizeMusicLookupKey(member && member.name))
      .filter(Boolean)
  );

  return members.filter((member) => !pastKeys.has(normalizeMusicLookupKey(member && member.name)));
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

async function buildMusicBandItem(row, forceRefresh, peoplePersonnelLookup, archiveCoverageLookup) {
  const band = getMusicBandName(row);
  const bandId = String(row.band_id || '').trim();
  const personnel = {};
  const explicitMembers = parsePersonnelString(row.members);
  const pastMembers = parsePersonnelString(row.past_members);
  const peopleMembers = getMusicPeopleMembersForBand(band, peoplePersonnelLookup);
  // Music-People band links are historical associations, not current-member flags.
  // If Music-Bands marks someone as past and has no explicit current entry, keep them past-only.
  const members = explicitMembers.length ? explicitMembers : filterInferredCurrentMusicBandMembers(peopleMembers, pastMembers);
  const totalPhotos = await fetchMusicBandTotalPhotos(row, forceRefresh);
  const archiveCoverage = getMusicBandArchiveCoverageForRow(row, archiveCoverageLookup);
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
  addMusicBandArchiveCoverageFields(stats, archiveCoverage);
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
  addMusicBandArchiveCoverageFields(item, archiveCoverage);
  if (hasJsonFields(general)) item.general = general;
  if (hasJsonFields(personnel)) item.personnel = personnel;
  if (hasJsonFields(stats)) item.stats = stats;

  return item;
}

async function groupMusicBandsByLetter(rows, forceRefresh, peoplePersonnelLookup, archiveCoverageLookup) {
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
    item: await buildMusicBandItem(row, forceRefresh, peoplePersonnelLookup, archiveCoverageLookup)
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
  const archiveCoverageLookup = await buildMusicBandArchiveCoverageLookup(payload.rows);
  const bands = await groupMusicBandsByLetter(payload.rows, forceRefresh, peoplePersonnelLookup, archiveCoverageLookup);
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
  const archiveRelationships = await getMusicPeopleArchiveRelationshipsForRequest();
  const data = (result.rows || []).map((row) => buildMusicPersonDbApiItem(row, archiveRelationships));

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

function isValidMusicBandName(value) {
  const clean = String(value || '').trim();
  if (!clean) return false;
  if (/^[0-9]+$/.test(clean)) return false;

  const normalized = normalizeImportHeaderKey(clean);
  const invalidNames = new Set([
    'archived_sets',
    'total_sets',
    'photo_count',
    'photocount',
    'total_photos',
    'totalphotos',
    'band_id',
    'bandid',
    'band',
    'name',
    'region',
    'smug_folder',
    'slug_folder',
    'logo_url',
    'status',
    'notes',
    'members',
    'past_members',
    'tags',
    'location',
    'state',
    'country'
  ]);

  return !invalidNames.has(normalized);
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
    skippedInvalidBand: 0,
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

      if (!isValidMusicBandName(item.band)) {
        result.skipped += 1;
        result.skippedInvalidBand += 1;
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
  show_url: 'show_url',
  showurl: 'show_url',
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

function formatMusicShowUrlDateKey(value) {
  const parsed = parseMusicShowDate(value);
  if (!parsed || !parsed.iso) return '';

  const [year, month, day] = parsed.iso.split('-');
  if (!year || !month || !day) return '';
  return `${month}${day}${year.slice(-2)}`;
}

function buildMusicShowFallbackShowUrl(row) {
  const dateKey = formatMusicShowUrlDateKey(row && row.date);
  return dateKey || null;
}

function hasMusicShowImportData(row) {
  if (['name', 'venue_id', 'venue', 'city', 'state', 'date', 'show_url', 'poster', 'notes', 'camera_1', 'camera_2'].some((key) => toDbText(row[key]))) {
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
  const showUrl = toDbText(row.show_url) || buildMusicShowFallbackShowUrl(row);

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
    show_url: showUrl,
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
      show_url,
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
      $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb
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
      show_url = EXCLUDED.show_url,
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
    item.show_url,
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
  const archiveCoverage = getMusicBandArchiveCoverageFromStats(stats);
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
  addMusicBandArchiveCoverageFields(stats, archiveCoverage);

  const item = {
    band: row.band,
    band_id: row.band_id,
    region: row.region || stats.region || '',
    location: row.location || stats.location || '',
    state: row.state || stats.state || '',
    status: row.status || general.status || '',
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
  addMusicBandArchiveCoverageFields(item, archiveCoverage);
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
       SELECT band, band_id, region, location, state, status, general, personnel, stats
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


function findMusicShowLineupBandForAlbum(album, bands) {
  const list = Array.isArray(bands) ? bands : [];
  const slot = album && album.slot != null ? toIntegerCount(album.slot) : null;
  if (slot != null) {
    const bySlot = list.find((item) => item && item.slot != null && toIntegerCount(item.slot) === slot);
    if (bySlot) return bySlot;
  }

  const bandKey = normalizeMusicLookupKey(album && album.band);
  if (!bandKey) return null;
  return list.find((item) => normalizeMusicLookupKey(item && item.band) === bandKey) || null;
}

function enrichMusicShowSmugAlbumsWithLineup(smugAlbums, bands) {
  return (Array.isArray(smugAlbums) ? smugAlbums : []).map((album) => {
    const item = album && typeof album === 'object' && !Array.isArray(album) ? { ...album } : {};
    const lineup = findMusicShowLineupBandForAlbum(item, bands);
    if (!lineup) return item;

    if (lineup.bandViewCount != null) item.bandViewCount = toIntegerCount(lineup.bandViewCount);
    if (lineup.band) item.lineupBand = lineup.band;
    if (lineup.slot != null) item.lineupSlot = toIntegerCount(lineup.slot);
    return item;
  });
}
function buildMusicShowDbApiItem(row, venueDetailsMap) {
  const venueId = row.venue_id || '';
  const fullVenueDetails = venueId ? (venueDetailsMap.get(normalizeMusicLookupKey(venueId)) || null) : null;
  const venueDetails = buildMusicShowVenueDetailsSummary(fullVenueDetails);
  // bands[] is show lineup compatibility data; smug_albums[] is resolved SmugMug archive/media album mappings.
  const bands = Array.isArray(row.bands) ? row.bands : [];
  const smugAlbums = enrichMusicShowSmugAlbumsWithLineup(row.smug_albums, bands);
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
    show_url: row.show_url || '',
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
    smug_sync_error: getCanonicalNullableString(row.smug_sync_error),
    smug_albums: smugAlbums
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
      OR coalesce(show_url, '') ILIKE $${idx}
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
      `SELECT show_id, name, venue_id, venue, city, state, date, poster, show_url, notes, camera_1, camera_2, bands, stats, gallery_id, album_id, cover_image_url, photo_count, smug_last_synced_at, smug_sync_status, smug_sync_error, smug_albums
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

function shouldIncludeWrestlingMatchPhotos(query = {}) {
  const value = String(
    query.include_photos ||
    query.includePhotos ||
    query.photos ||
    ''
  ).trim().toLowerCase();
  return ['1', 'true', 'yes', 'match', 'matches'].includes(value);
}

function normalizeWrestlingMatchPhotoToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['â€™]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getWrestlingRawSheetValues(row, fieldNames = []) {
  const raw = row && row.raw_sheet;
  const rawRows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return rawRows.flatMap((rawRow) => {
    if (!rawRow || typeof rawRow !== 'object') return [];
    return fieldNames.map((field) => rawRow[field]).filter((value) => String(value || '').trim());
  });
}

function uniqueWrestlingSmugSourceValues(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeWrestlingSmugAlbumIdCandidate(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) return extractSmugAlbumKeyFromUrl(clean);
  return clean;
}

function getWrestlingShowAlbumIdCandidates(row) {
  return uniqueWrestlingSmugSourceValues([
    row && row.album_id,
    row && row.gallery_id,
    row && row.smugmug_album_id,
    row && row.smugmug_gallery_id,
    ...getWrestlingRawSheetValues(row, [
      'album_id',
      'albumid',
      'album_key',
      'albumkey',
      'gallery_id',
      'galleryid',
      'gallery_key',
      'gallerykey',
      'smugmug_album_id',
      'smug_album_id',
      'smugmug_gallery_id',
      'smug_gallery_id'
    ])
  ])
    .map(normalizeWrestlingSmugAlbumIdCandidate)
    .filter(Boolean);
}

function getWrestlingShowPhotoSourceUrls(row) {
  return uniqueWrestlingSmugSourceValues([
    row && row.show_url,
    row && row.album_url,
    row && row.gallery_url,
    ...getWrestlingRawSheetValues(row, [
      'show_url',
      'showurl',
      'album_url',
      'albumurl',
      'gallery_url',
      'galleryurl',
      'smugmug_album_url',
      'smug_album_url',
      'smugmug_gallery_url',
      'smug_gallery_url'
    ])
  ]).filter((value) => /^https?:\/\//i.test(value));
}

function getSmugAlbumPathFromUrl(value) {
  const clean = String(value || '').trim();
  if (!/^https?:\/\//i.test(clean)) return '';

  try {
    const parsed = new URL(clean);
    let segments = parsed.pathname
      .split('/')
      .map((segment) => decodeSmugPathSegment(segment))
      .filter(Boolean);

    if (segments[0] === 'app' && segments[1] === 'organize') {
      segments = segments.slice(2);
    }

    const imageIndex = segments.findIndex((segment) => /^i-[A-Za-z0-9]+$/i.test(segment));
    if (imageIndex > -1) segments = segments.slice(0, imageIndex);

    const photosIndex = segments.findIndex((segment) => /^photos$/i.test(segment));
    if (photosIndex > -1) segments = segments.slice(0, photosIndex);

    return getSmugPathSegments(segments.join('/')).join('/');
  } catch (_) {
    return '';
  }
}

function normalizeWrestlingSmugPathSegment(value) {
  return String(value || '').trim().replace(/^\/+|\/+$/g, '').replace(/\s+/g, ' ');
}

function getWrestlingSmugPathSegmentVariants(value) {
  const clean = normalizeWrestlingSmugPathSegment(value);
  if (!clean) return [];

  const hyphenated = clean
    .replace(/[\u2019']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = slugifyMusicBandId(clean);

  return uniqueWrestlingSmugSourceValues([clean, hyphenated, slug]);
}

function getWrestlingShowDateParts(row, item) {
  const dateValue = row && row.date ? row.date : item && item.date;
  const parsed = parseMusicShowDate(dateValue);
  if (!parsed || !parsed.iso) {
    return {
      dateFolder: '',
      iso: '',
      year: '',
      dateSegments: getWrestlingSmugPathSegmentVariants(dateValue)
    };
  }

  const [year, month, day] = parsed.iso.split('-');
  const dateFolder = `${month}${day}${String(year || '').slice(-2)}`;

  return {
    dateFolder,
    iso: parsed.iso,
    year,
    dateSegments: uniqueWrestlingSmugSourceValues([
      dateFolder,
      parsed.iso,
      `${month}-${day}-${String(year || '').slice(-2)}`,
      `${month}-${day}-${year}`,
      ...getWrestlingSmugPathSegmentVariants(dateValue)
    ])
  };
}

function addWrestlingMatchAlbumPathCandidate(paths, segments) {
  const path = (segments || [])
    .flat()
    .map(normalizeWrestlingSmugPathSegment)
    .filter(Boolean)
    .join('/');

  if (path) paths.push(path);
}

function getWrestlingMatchAlbumSourceValues(match) {
  return uniqueWrestlingSmugSourceValues([
    match && match.match_url,
    match && match.matchUrl,
    match && match.album_url,
    match && match.albumUrl,
    match && match.gallery_url,
    match && match.galleryUrl,
    match && match.album_id,
    match && match.albumId,
    match && match.gallery_id,
    match && match.galleryId
  ]);
}

function isLikelySmugAlbumKeyCandidate(value) {
  return /^[A-Za-z0-9]{4,}$/.test(String(value || '').trim());
}

function getWrestlingSmugPromotionSegment(value) {
  const clean = normalizeWrestlingSmugPathSegment(value);
  if (!clean) return '';
  return clean.replace(/\s+Wrestling$/i, '').trim() || clean;
}

function getWrestlingMatchAlbumPathCandidates(match, row, item) {
  const paths = [];
  const sourceValues = getWrestlingMatchAlbumSourceValues(match);

  sourceValues.forEach((sourceValue) => {
    const sourcePath = getSmugAlbumPathFromUrl(sourceValue);
    if (sourcePath) addWrestlingMatchAlbumPathCandidate(paths, [sourcePath]);

    const cleanSource = String(sourceValue || '').trim();
    if (cleanSource && !/^https?:\/\//i.test(cleanSource) && cleanSource.includes('/')) {
      addWrestlingMatchAlbumPathCandidate(paths, [cleanSource]);
    }
  });

  const matchSegments = uniqueWrestlingSmugSourceValues(
    sourceValues
      .filter((sourceValue) => !/^https?:\/\//i.test(String(sourceValue || '').trim()))
      .filter((sourceValue) => !String(sourceValue || '').includes('/'))
      .flatMap(getWrestlingSmugPathSegmentVariants)
  );
  if (!matchSegments.length) return uniqueWrestlingSmugSourceValues(paths);

  const dateParts = getWrestlingShowDateParts(row, item);
  const promotionShort = getWrestlingSmugPromotionSegment((row && row.promotion) || (item && item.promotion));
  const promotionSegments = getWrestlingSmugPathSegmentVariants((row && row.promotion) || (item && item.promotion));
  const showSegments = getWrestlingSmugPathSegmentVariants((row && row.show_name) || (item && item.show_name));
  const showKeySegments = getWrestlingSmugPathSegmentVariants((row && row.show_key) || (item && item.show_key));
  const roots = [
    ['Wrestling'],
    ['Wrestling', 'Archives'],
    ['Wrestling', 'Shows'],
    ['Wrestling', 'Archives', 'Shows'],
    ['Wrestling', 'Events'],
    ['Wrestling', 'Archives', 'Events']
  ];

  matchSegments.forEach((matchSegment) => {
    if (promotionShort && dateParts.dateFolder) {
      addWrestlingMatchAlbumPathCandidate(paths, ['Wrestling', promotionShort, dateParts.dateFolder, matchSegment]);
    }

    roots.forEach((root) => {
      showKeySegments.forEach((showKeySegment) => {
        addWrestlingMatchAlbumPathCandidate(paths, [root, showKeySegment, matchSegment]);
      });

      promotionSegments.forEach((promotionSegment) => {
        showSegments.forEach((showSegment) => {
          dateParts.dateSegments.forEach((dateSegment) => {
            addWrestlingMatchAlbumPathCandidate(paths, [root, promotionSegment, showSegment, dateSegment, matchSegment]);
            addWrestlingMatchAlbumPathCandidate(paths, [root, promotionSegment, dateSegment, showSegment, matchSegment]);
          });

          addWrestlingMatchAlbumPathCandidate(paths, [root, promotionSegment, showSegment, matchSegment]);

          if (dateParts.year) {
            addWrestlingMatchAlbumPathCandidate(paths, [root, dateParts.year, promotionSegment, showSegment, matchSegment]);
            addWrestlingMatchAlbumPathCandidate(paths, [root, promotionSegment, dateParts.year, showSegment, matchSegment]);
          }
        });

        dateParts.dateSegments.forEach((dateSegment) => {
          addWrestlingMatchAlbumPathCandidate(paths, [root, promotionSegment, dateSegment, matchSegment]);
        });

        addWrestlingMatchAlbumPathCandidate(paths, [root, promotionSegment, matchSegment]);
      });

      dateParts.dateSegments.forEach((dateSegment) => {
        addWrestlingMatchAlbumPathCandidate(paths, [root, dateSegment, matchSegment]);
      });

      if (dateParts.year) {
        dateParts.dateSegments.forEach((dateSegment) => {
          addWrestlingMatchAlbumPathCandidate(paths, [root, dateParts.year, dateSegment, matchSegment]);
        });
      }

      addWrestlingMatchAlbumPathCandidate(paths, [root, matchSegment]);
    });
  });

  return uniqueWrestlingSmugSourceValues(paths).slice(0, 120);
}

function getCachedSmugWrestlingAlbumId(sourceUrl) {
  const key = String(sourceUrl || '').trim();
  const hit = key ? smugWrestlingAlbumIdCache.get(key) : null;
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > SMUG_WRESTLING_MATCH_PHOTOS_CACHE_TTL_MS) {
    smugWrestlingAlbumIdCache.delete(key);
    return null;
  }
  return hit.albumId || '';
}

function setCachedSmugWrestlingAlbumId(sourceUrl, albumId) {
  const key = String(sourceUrl || '').trim();
  if (!key) return;
  smugWrestlingAlbumIdCache.set(key, {
    fetchedAt: Date.now(),
    albumId: String(albumId || '').trim()
  });
}

function getCachedSmugWrestlingFolderAlbums(parentPath) {
  const key = `${SMUG_WRESTLING_MATCH_PHOTOS_CACHE_VERSION}:folder:${String(parentPath || '').trim()}`;
  const hit = parentPath ? smugWrestlingFolderAlbumsCache.get(key) : null;
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > SMUG_WRESTLING_MATCH_PHOTOS_CACHE_TTL_MS) {
    smugWrestlingFolderAlbumsCache.delete(key);
    return null;
  }
  return hit;
}

function setCachedSmugWrestlingFolderAlbums(parentPath, payload) {
  const cleanParentPath = String(parentPath || '').trim();
  if (!cleanParentPath) return;
  const key = `${SMUG_WRESTLING_MATCH_PHOTOS_CACHE_VERSION}:folder:${cleanParentPath}`;
  smugWrestlingFolderAlbumsCache.set(key, {
    fetchedAt: Date.now(),
    albums: Array.isArray(payload && payload.albums) ? payload.albums : [],
    endpoint: payload && payload.endpoint ? payload.endpoint : '',
    api_url_before_api_key: payload && payload.api_url_before_api_key ? payload.api_url_before_api_key : ''
  });
}

async function fetchSmugWrestlingFolderAlbums(parentPath) {
  const cleanParentPath = getSmugPathSegments(parentPath).join('/');
  if (!cleanParentPath || !isSmugMugConfigured()) return { albums: [] };

  const cached = getCachedSmugWrestlingFolderAlbums(cleanParentPath);
  if (cached) return cached;
  if (smugWrestlingFolderAlbumsInFlight.has(cleanParentPath)) {
    return smugWrestlingFolderAlbumsInFlight.get(cleanParentPath);
  }

  const endpoint = buildSmugFolderAlbumsEndpointFromPath(cleanParentPath);
  const run = (async () => {
    const payload = {
      endpoint,
      api_url_before_api_key: buildSmugApiDebugUrl(endpoint),
      albums: []
    };

    try {
      const json = await fetchSmugJson(endpoint);
      payload.albums = getSmugAlbums(json);
    } catch (err) {
      if (!isSmugHttpStatusError(err, 404)) throw err;
    }

    setCachedSmugWrestlingFolderAlbums(cleanParentPath, payload);
    return payload;
  })().finally(() => {
    smugWrestlingFolderAlbumsInFlight.delete(cleanParentPath);
  });

  smugWrestlingFolderAlbumsInFlight.set(cleanParentPath, run);
  return run;
}

async function resolveSmugWrestlingAlbumIdFromPathCandidate(smugPath) {
  const segments = getSmugPathSegments(smugPath);
  const albumSegment = segments[segments.length - 1] || '';
  const parentPath = segments.slice(0, -1).join('/');
  if (!albumSegment || !parentPath) return '';

  const cacheKey = `match-path:${segments.join('/')}`;
  const cachedPathAlbumId = getCachedSmugWrestlingAlbumId(cacheKey);
  if (cachedPathAlbumId != null) return cachedPathAlbumId;

  try {
    const { albums } = await fetchSmugWrestlingFolderAlbums(parentPath);
    const match = albums.find((album) => albumMatchesSmugMusicShowPath(album, segments.join('/')));
    const albumId = match ? getSmugAlbumKey(match) : '';
    setCachedSmugWrestlingAlbumId(cacheKey, albumId);
    return albumId || '';
  } catch (err) {
    console.warn(`Wrestling SmugMug folder album lookup failed for ${smugPath}:`, err && err.message ? err.message : String(err));
    setCachedSmugWrestlingAlbumId(cacheKey, '');
    return '';
  }
}

async function resolveSmugWrestlingAlbumIdFromSourceUrl(sourceUrl) {
  const cleanUrl = String(sourceUrl || '').trim();
  if (!cleanUrl || !isSmugMugConfigured()) return '';

  const cached = getCachedSmugWrestlingAlbumId(cleanUrl);
  if (cached != null) return cached;
  if (smugWrestlingAlbumIdInFlight.has(cleanUrl)) {
    return smugWrestlingAlbumIdInFlight.get(cleanUrl);
  }

  const run = (async () => {
    let albumId = extractSmugAlbumKeyFromUrl(cleanUrl);
    if (!albumId) {
      const imageKey = extractSmugImageKeyFromUrl(cleanUrl);
      if (imageKey) {
        const detail = await fetchSmugImageDetail(imageKey);
        albumId = extractSmugAlbumKeyFromImageDetail(detail.json);
      }
    }
    setCachedSmugWrestlingAlbumId(cleanUrl, albumId);
    return albumId || '';
  })().catch((err) => {
    console.warn(`Wrestling SmugMug album resolution failed for ${cleanUrl}:`, err && err.message ? err.message : String(err));
    setCachedSmugWrestlingAlbumId(cleanUrl, '');
    return '';
  }).finally(() => {
    smugWrestlingAlbumIdInFlight.delete(cleanUrl);
  });

  smugWrestlingAlbumIdInFlight.set(cleanUrl, run);
  return run;
}

async function resolveSmugWrestlingShowAlbumId(row) {
  const albumIds = getWrestlingShowAlbumIdCandidates(row);
  if (albumIds.length) return albumIds[0];

  const sourceUrls = getWrestlingShowPhotoSourceUrls(row);
  for (const sourceUrl of sourceUrls) {
    const albumId = await resolveSmugWrestlingAlbumIdFromSourceUrl(sourceUrl);
    if (albumId) return albumId;
  }
  return '';
}

async function resolveSmugWrestlingMatchAlbum(match, row, item) {
  const sourceValues = getWrestlingMatchAlbumSourceValues(match);
  const dateParts = getWrestlingShowDateParts(row, item);
  const cacheKey = uniqueWrestlingSmugSourceValues([
    row && row.show_key,
    item && item.show_key,
    dateParts.dateFolder,
    ...sourceValues
  ]).join('|');

  if (!cacheKey || !isSmugMugConfigured()) return { albumId: '', path: '', source: '', attemptedPaths: [] };

  const cached = getCachedSmugWrestlingAlbumId(`match:${cacheKey}`);
  if (cached != null) return { albumId: cached, path: '', source: cached ? 'cache' : '', attemptedPaths: [] };
  if (smugWrestlingAlbumIdInFlight.has(`match:${cacheKey}`)) {
    return smugWrestlingAlbumIdInFlight.get(`match:${cacheKey}`);
  }

  const run = (async () => {
    for (const sourceValue of sourceValues) {
      const cleanSource = String(sourceValue || '').trim();
      if (!cleanSource) continue;

      const albumIdFromUrl = extractSmugAlbumKeyFromUrl(cleanSource);
      if (albumIdFromUrl) {
        setCachedSmugWrestlingAlbumId(`match:${cacheKey}`, albumIdFromUrl);
        return { albumId: albumIdFromUrl, path: '', source: 'source_url', attemptedPaths: [] };
      }

      if (!/^https?:\/\//i.test(cleanSource) && isLikelySmugAlbumKeyCandidate(cleanSource)) {
        try {
          const metadata = await fetchSmugAlbumMetadata(cleanSource);
          const albumId = getSmugAlbumKey(metadata) || cleanSource;
          if (albumId) {
            setCachedSmugWrestlingAlbumId(`match:${cacheKey}`, albumId);
            return { albumId, path: '', source: 'direct_album_id', attemptedPaths: [] };
          }
        } catch (err) {
          if (!isSmugHttpStatusError(err, 404)) throw err;
        }
      }
    }

    const pathCandidates = getWrestlingMatchAlbumPathCandidates(match, row, item);
    const attemptedPaths = pathCandidates.slice(0, 10);
    for (const pathCandidate of pathCandidates) {
      const albumId = await resolveSmugWrestlingAlbumIdFromPathCandidate(pathCandidate);
      if (albumId) {
        setCachedSmugWrestlingAlbumId(`match:${cacheKey}`, albumId);
        return { albumId, path: pathCandidate, source: 'path_candidate', attemptedPaths };
      }
    }

    setCachedSmugWrestlingAlbumId(`match:${cacheKey}`, '');
    return { albumId: '', path: '', source: '', attemptedPaths };
  })().catch((err) => {
    console.warn(`Wrestling match SmugMug album resolution failed for ${cacheKey}:`, err && err.message ? err.message : String(err));
    setCachedSmugWrestlingAlbumId(`match:${cacheKey}`, '');
    return { albumId: '', path: '', source: 'error', attemptedPaths: [] };
  }).finally(() => {
    smugWrestlingAlbumIdInFlight.delete(`match:${cacheKey}`);
  });

  smugWrestlingAlbumIdInFlight.set(`match:${cacheKey}`, run);
  return run;
}

async function resolveSmugWrestlingMatchAlbumId(match, row, item) {
  const resolved = await resolveSmugWrestlingMatchAlbum(match, row, item);
  return resolved.albumId || '';
}

function getCachedSmugWrestlingAlbumPhotos(albumId) {
  const key = `${SMUG_WRESTLING_MATCH_PHOTOS_CACHE_VERSION}:${String(albumId || '').trim()}`;
  const hit = smugWrestlingMatchPhotosCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > SMUG_WRESTLING_MATCH_PHOTOS_CACHE_TTL_MS) {
    smugWrestlingMatchPhotosCache.delete(key);
    return null;
  }
  return hit.photos;
}

function setCachedSmugWrestlingAlbumPhotos(albumId, photos) {
  const key = `${SMUG_WRESTLING_MATCH_PHOTOS_CACHE_VERSION}:${String(albumId || '').trim()}`;
  smugWrestlingMatchPhotosCache.set(key, {
    fetchedAt: Date.now(),
    photos: Array.isArray(photos) ? photos : []
  });
}

async function fetchSmugWrestlingAlbumPhotos(albumId) {
  const cleanAlbumId = String(albumId || '').trim();
  if (!cleanAlbumId || !isSmugMugConfigured()) return [];

  const cached = getCachedSmugWrestlingAlbumPhotos(cleanAlbumId);
  if (cached) return cached;
  if (smugWrestlingMatchPhotosInFlight.has(cleanAlbumId)) {
    return smugWrestlingMatchPhotosInFlight.get(cleanAlbumId);
  }

  const run = (async () => {
    const photos = [];
    let start = 1;
    for (let page = 0; page < SMUG_WRESTLING_MATCH_PHOTOS_MAX_PAGES; page += 1) {
      const endpoint = `/album/${encodeURIComponent(cleanAlbumId)}!images?count=${SMUG_WRESTLING_MATCH_PHOTOS_PAGE_LIMIT}&start=${start}&_accept=application/json&_expand=Image`;
      const json = await fetchSmugJson(endpoint);
      const images = getSmugAlbumImages(json);
      if (!images.length) break;

      const items = await buildSmugWrestlingAlbumPhotoItemsForResponse(images);
      photos.push(...items.map((item) => ({ ...item, album_id: cleanAlbumId })));

      const pageCount = getSmugPageCount(json) || images.length;
      if (!hasSmugNextPage(json) || pageCount <= 0) break;
      start += pageCount;
    }
    setCachedSmugWrestlingAlbumPhotos(cleanAlbumId, photos);
    return photos;
  })().catch((err) => {
    console.warn(`Wrestling SmugMug album photos failed for ${cleanAlbumId}:`, err && err.message ? err.message : String(err));
    setCachedSmugWrestlingAlbumPhotos(cleanAlbumId, []);
    return [];
  }).finally(() => {
    smugWrestlingMatchPhotosInFlight.delete(cleanAlbumId);
  });

  smugWrestlingMatchPhotosInFlight.set(cleanAlbumId, run);
  return run;
}

function getWrestlingMatchPhotoTokens(match) {
  const order = toNullableInteger(match && (match.match_order || match.matchOrder || match.order));
  const values = [
    match && match.match_url,
    match && match.matchUrl,
    match && match.match_id,
    match && match.matchId,
    match && match.photo_tag,
    match && match.photoTag,
    order ? `match-${order}` : '',
    order ? `match ${order}` : ''
  ];
  const tokens = values
    .filter((value) => !/^https?:\/\//i.test(String(value || '').trim()))
    .map(normalizeWrestlingMatchPhotoToken)
    .filter(Boolean);
  return Array.from(new Set(tokens));
}

function getWrestlingPhotoMatchTextValues(photo) {
  const values = [
    photo && photo.caption,
    photo && photo.title,
    photo && photo.filename,
    photo && photo.image_key,
    photo && photo.imageKey,
    photo && photo.key,
    photo && photo.id
  ];
  if (Array.isArray(photo && photo.keywords)) {
    values.push(...photo.keywords);
  } else if (photo && photo.keywords) {
    values.push(photo.keywords);
  }
  return values;
}

function getWrestlingPhotoMatchTokens(photo) {
  return getWrestlingPhotoMatchTextValues(photo)
    .flatMap((value) => String(value || '').split(/[;,|\r\n]+/g))
    .map(normalizeWrestlingMatchPhotoToken)
    .filter(Boolean);
}

function doesWrestlingAlbumPhotoMatchMatch(photo, match) {
  const matchTokens = getWrestlingMatchPhotoTokens(match);
  if (!matchTokens.length) return false;
  const photoTokens = new Set(getWrestlingPhotoMatchTokens(photo));
  return matchTokens.some((token) => photoTokens.has(token));
}

async function enrichWrestlingShowItemWithMatchPhotos(item, row) {
  if (Array.isArray(item.matches)) {
    let showPhotoCount = 0;

    item.matches = await mapWithConcurrency(item.matches, SMUG_REQUEST_CONCURRENCY, async (match) => {
      const resolvedAlbum = await resolveSmugWrestlingMatchAlbum(match, row, item);
      const albumId = resolvedAlbum.albumId || '';
      if (!albumId) {
        return {
          ...match,
          smug_path: '',
          smug_match_album_source: resolvedAlbum.source || '',
          smug_attempted_paths: Array.isArray(resolvedAlbum.attemptedPaths) ? resolvedAlbum.attemptedPaths : []
        };
      }

      const matchedPhotos = await fetchSmugWrestlingAlbumPhotos(albumId);

      showPhotoCount += matchedPhotos.length;
      return {
        ...match,
        album_id: albumId,
        gallery_id: albumId,
        smug_path: resolvedAlbum.path || '',
        smug_match_album_source: resolvedAlbum.source || '',
        smug_attempted_paths: Array.isArray(resolvedAlbum.attemptedPaths) ? resolvedAlbum.attemptedPaths : [],
        photos: matchedPhotos,
        match_photos: matchedPhotos,
        photo_count: matchedPhotos.length,
        photoCount: matchedPhotos.length,
        stats: {
          ...(match.stats && typeof match.stats === 'object' ? match.stats : {}),
          photo_count: matchedPhotos.length,
          photoCount: matchedPhotos.length
        }
      };
    });

    if (showPhotoCount > 0) {
      item.photo_count = showPhotoCount;
      item.cover_image_url = item.cover_image_url || item.poster || item.matches
        .flatMap((match) => Array.isArray(match.photos) ? match.photos : [])
        .find((photo) => photo.large_url || photo.medium_url || photo.small_url || photo.thumbnail_url)?.large_url || '';
    }
  }

  return item;
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

async function buildWrestlingShowDbApiItem(row, venueDetailsMap, options = {}) {
  const venueId = row.venue_id || '';
  const venueDetails = venueId ? (venueDetailsMap.get(normalizeMusicLookupKey(venueId)) || null) : null;

  const item = {
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

  if (options.includePhotos) {
    return enrichWrestlingShowItemWithMatchPhotos(item, row);
  }

  return item;
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
      OR coalesce(show_key, '') ILIKE $${idx}
      OR coalesce(date, '') ILIKE $${idx}
      OR to_char(show_date, 'MMDDYY') ILIKE $${idx}
      OR to_char(show_date, 'MMDDYYYY') ILIKE $${idx}
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
    const includePhotos = shouldIncludeWrestlingMatchPhotos(req.query);
    const countResult = await dbPool.query(
      `SELECT count(*)::int AS total FROM wrestling_shows ${options.whereSql}`,
      options.values
    );
    const total = toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].total);
    const dataValues = options.values.concat([limit, offset]);
    const limitIdx = dataValues.length - 1;
    const offsetIdx = dataValues.length;
    const result = await dbPool.query(
      `SELECT show_id, show_key, promotion, show_name, date, venue_id, venue, city, state, poster, camera_1, camera_2, matches, stats, raw_sheet
       FROM wrestling_shows
       ${options.whereSql}
       ORDER BY ${options.orderBySql}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      dataValues
    );
    const venueDetailsMap = await getWrestlingVenueDetailsMap(result.rows.map((row) => row.venue_id));
    const data = await mapWithConcurrency(
      result.rows,
      includePhotos ? 1 : 4,
      (row) => buildWrestlingShowDbApiItem(row, venueDetailsMap, { includePhotos })
    );
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
      meta: {
        ...buildListMeta({ route: '/api/wrestling/shows/db', source: 'PostgreSQL:wrestling_shows', pagination, filters: options.filters, sort: options.sort }),
        payload: {
          matchPhotos: includePhotos ? 'data[].matches[].photos' : 'omitted unless include_photos=1',
          matchPhotoSource: 'SmugMug album photos resolved from matches[].match_url'
        }
      },
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

function normalizeWrestlingPersonExactMatchKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildWrestlingPersonDbApiItem(row, appearanceCounts = new Map(), photoCounts = new Map(), photoMeta = new Map()) {
  const personKey = normalizeWrestlingPersonExactMatchKey(row && row.name);
  const counts = appearanceCounts.get(personKey) || {};
  const hasPhotoCount = photoCounts && typeof photoCounts.has === 'function' ? photoCounts.has(personKey) : false;
  const photoCount = hasPhotoCount ? photoCounts.get(personKey) : 0;
  const meta = photoMeta && typeof photoMeta.get === 'function' ? photoMeta.get(personKey) : null;
  const item = {
    id: toIntegerCount(row.id),
    slug: row.slug || '',
    name: row.name || '',
    category: row.category || '',
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    teams: Array.isArray(row.teams) ? row.teams : [],
    notes: row.notes || '',
    event_count: toIntegerCount(counts.event_count),
    match_count: toIntegerCount(counts.match_count),
    photo_count: toIntegerCount(photoCount)
  };

  if (meta && typeof meta === 'object') {
    if (meta.status) item.photo_count_status = meta.status;
    if (meta.source) item.photo_count_source = meta.source;
    if (meta.warning) item.photo_count_warning = meta.warning;
  }

  return item;
}

async function getWrestlingPeopleAppearanceCounts(names = []) {
  const nameKeys = Array.from(new Set(
    (Array.isArray(names) ? names : [])
      .map(normalizeWrestlingPersonExactMatchKey)
      .filter(Boolean)
  ));
  const counts = new Map();
  if (!nameKeys.length) return counts;

  const result = await dbPool.query(`
    WITH selected_people AS (
      SELECT unnest($1::text[]) AS name_key
    ), match_rows AS (
      SELECT
        coalesce(nullif(trim(ws.show_key), ''), ws.show_id::text) AS show_identity,
        match_row.ordinality AS match_ordinality,
        match_row.match AS match
      FROM wrestling_shows ws
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(ws.matches) = 'array' THEN ws.matches ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS match_row(match, ordinality)
    ), person_match_rows AS (
      SELECT DISTINCT
        selected_people.name_key,
        match_rows.show_identity,
        match_rows.match_ordinality
      FROM selected_people
      JOIN match_rows ON EXISTS (
        SELECT 1
        FROM (
          SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(match_rows.match->'participants') = 'array' THEN match_rows.match->'participants' ELSE '[]'::jsonb END) AS value
          UNION ALL
          SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(match_rows.match->'referees') = 'array' THEN match_rows.match->'referees' ELSE '[]'::jsonb END) AS value
          UNION ALL
          SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(match_rows.match->'extra_people') = 'array' THEN match_rows.match->'extra_people' ELSE '[]'::jsonb END) AS value
          UNION ALL
          SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(match_rows.match->'tagged_people') = 'array' THEN match_rows.match->'tagged_people' ELSE '[]'::jsonb END) AS value
        ) AS people_values
        WHERE lower(trim(people_values.value)) = selected_people.name_key
      )
    )
    SELECT
      name_key,
      count(DISTINCT show_identity)::int AS event_count,
      count(*)::int AS match_count
    FROM person_match_rows
    GROUP BY name_key
  `, [nameKeys]);

  result.rows.forEach((row) => {
    counts.set(row.name_key, {
      event_count: toIntegerCount(row.event_count),
      match_count: toIntegerCount(row.match_count)
    });
  });

  return counts;
}
function getWrestlingPersonPhotoMatchKeys(row) {
  const values = [
    row && row.name,
    ...(Array.isArray(row && row.aliases) ? row.aliases : splitWrestlingSemicolonList(row && row.aliases)),
    ...(Array.isArray(row && row.teams) ? row.teams : splitWrestlingSemicolonList(row && row.teams))
  ];
  return Array.from(new Set(
    values
      .map(normalizeWrestlingPersonExactMatchKey)
      .filter(Boolean)
  ));
}

function createWrestlingPeoplePhotoMatchers(people = []) {
  return (Array.isArray(people) ? people : [])
    .map((person) => ({
      personKey: normalizeWrestlingPersonExactMatchKey(person && person.name),
      matchKeys: getWrestlingPersonPhotoMatchKeys(person)
    }))
    .filter((person) => person.personKey && person.matchKeys.length);
}

function getWrestlingCaptionTokenKeys(caption) {
  return String(caption || '')
    .split(';')
    .map(normalizeWrestlingPersonExactMatchKey)
    .filter(Boolean);
}

function addWrestlingPeoplePhotoCountMatches(photoSets, matchers, albumId, photo) {
  const captionTokens = new Set(getWrestlingCaptionTokenKeys(photo && photo.caption));
  if (!captionTokens.size) return;

  const imageKey = String(photo && (photo.image_key || photo.imageKey || photo.key || photo.id) || '').trim();
  const photoKey = `${String(albumId || '').trim()}:${imageKey || photoSets.size + 1}`;

  matchers.forEach((person) => {
    if (!person.matchKeys.some((key) => captionTokens.has(key))) return;
    if (!photoSets.has(person.personKey)) photoSets.set(person.personKey, new Set());
    photoSets.get(person.personKey).add(photoKey);
  });
}

function getCachedWrestlingPeoplePhotoCounts() {
  if (
    smugWrestlingPeoplePhotoCountCache &&
    Date.now() - smugWrestlingPeoplePhotoCountCache.fetchedAt < WRESTLING_PEOPLE_PHOTO_COUNT_CACHE_TTL_MS
  ) {
    return smugWrestlingPeoplePhotoCountCache.counts;
  }
  return null;
}

function getWrestlingPeoplePhotoCountsForRequest() {
  const cached = getCachedWrestlingPeoplePhotoCounts();
  if (cached) return cached;

  // SmugMug caption scans are intentionally deferred so roster reads never block or fail.
  buildWrestlingPeoplePhotoCounts().catch(() => {});
  return new Map();
}
async function buildWrestlingPeoplePhotoCounts() {
  if (!isSmugMugConfigured() || !String(process.env.DATABASE_URL || '').trim()) {
    return new Map();
  }

  const now = Date.now();
  if (
    smugWrestlingPeoplePhotoCountCache &&
    now - smugWrestlingPeoplePhotoCountCache.fetchedAt < WRESTLING_PEOPLE_PHOTO_COUNT_CACHE_TTL_MS
  ) {
    return smugWrestlingPeoplePhotoCountCache.counts;
  }

  if (smugWrestlingPeoplePhotoCountInFlight) {
    return smugWrestlingPeoplePhotoCountInFlight;
  }

  smugWrestlingPeoplePhotoCountInFlight = (async () => {
    const peopleResult = await dbPool.query(`
      SELECT name, aliases, teams
      FROM wrestling_people
      WHERE trim(coalesce(name, '')) <> ''
      ORDER BY name ASC, id ASC
    `);
    const matchers = createWrestlingPeoplePhotoMatchers(peopleResult.rows || []);
    if (!matchers.length) return new Map();

    const showsResult = await dbPool.query(`
      SELECT id, show_id, show_key, promotion, show_name, date, matches
      FROM wrestling_shows
      WHERE jsonb_typeof(matches) = 'array'
      ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST, id DESC
    `);

    const matchAlbumTasks = [];
    (showsResult.rows || []).forEach((row) => {
      const item = {
        show_id: row.show_id,
        show_key: row.show_key || '',
        promotion: row.promotion || '',
        show_name: row.show_name || '',
        date: row.date || ''
      };
      (Array.isArray(row.matches) ? row.matches : []).forEach((match) => {
        if (match && typeof match === 'object') matchAlbumTasks.push({ row, item, match });
      });
    });

    const photoSets = new Map();
    await mapWithConcurrency(
      matchAlbumTasks.slice(0, WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS),
      SMUG_REQUEST_CONCURRENCY,
      async ({ row, item, match }) => {
        const resolved = await resolveSmugWrestlingMatchAlbum(match, row, item);
        const albumId = resolved && resolved.albumId ? resolved.albumId : '';
        if (!albumId) return;

        const photos = await fetchSmugWrestlingAlbumPhotos(albumId);
        photos.forEach((photo) => addWrestlingPeoplePhotoCountMatches(photoSets, matchers, albumId, photo));
      }
    );

    const counts = new Map();
    photoSets.forEach((photoKeys, personKey) => {
      counts.set(personKey, photoKeys.size);
    });

    smugWrestlingPeoplePhotoCountCache = { fetchedAt: Date.now(), counts };
    return counts;
  })().catch((err) => {
    console.warn('Wrestling-People SmugMug photo count scan failed:', err && err.message ? err.message : String(err));
    return new Map();
  }).finally(() => {
    smugWrestlingPeoplePhotoCountInFlight = null;
  });

  return smugWrestlingPeoplePhotoCountInFlight;
}

const WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_ROUTE = '/api/admin/diagnostics/wrestling/people/photo-aggregation';
const WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_TABLES = ['wrestling_people', 'wrestling_shows'];

function getWrestlingPeoplePhotoAggregationSampleLimit(value) {
  const limit = Number(String(value || '').trim());
  if (!Number.isInteger(limit)) return 10;
  return Math.min(25, Math.max(1, limit));
}

function getWrestlingPeoplePhotoAggregationTextArray(value) {
  if (Array.isArray(value)) {
    return uniqueWrestlingPeopleList(value);
  }
  return splitWrestlingSemicolonList(value);
}

function addWrestlingPeoplePhotoAggregationLookup(entries, type, value, source) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  const key = normalizeWrestlingPersonExactMatchKey(clean);
  if (!key) return;

  if (entries.some((entry) => entry.type === type && entry.key === key)) return;
  entries.push({
    type,
    value: clean,
    key,
    source: source || ''
  });
}

function buildWrestlingPeoplePhotoAggregationLookupEntries(requestedPerson, rows) {
  const entries = [];
  addWrestlingPeoplePhotoAggregationLookup(entries, 'requested', requestedPerson, 'query.person');

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    addWrestlingPeoplePhotoAggregationLookup(entries, 'name', row && row.name, `wrestling_people:${row && row.id ? row.id : row && row.slug ? row.slug : ''}`);
    getWrestlingPeoplePhotoAggregationTextArray(row && row.aliases).forEach((alias) => {
      addWrestlingPeoplePhotoAggregationLookup(entries, 'alias', alias, `wrestling_people.aliases:${row && row.id ? row.id : row && row.slug ? row.slug : ''}`);
    });
    getWrestlingPeoplePhotoAggregationTextArray(row && row.teams).forEach((team) => {
      addWrestlingPeoplePhotoAggregationLookup(entries, 'team', team, `wrestling_people.teams:${row && row.id ? row.id : row && row.slug ? row.slug : ''}`);
    });
  });

  return entries;
}

function getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, tableName, columnName, fallbackSql) {
  return hasDiagnosticColumn(columnsByTable, tableName, columnName) ? columnName : `${fallbackSql} AS ${columnName}`;
}

function getWrestlingPeoplePhotoAggregationPersonMatchReasons(row, requestedKey, requestedSlug) {
  const reasons = [];
  if (normalizeWrestlingPersonExactMatchKey(row && row.name) === requestedKey) reasons.push('name');
  if (normalizeWrestlingPersonExactMatchKey(row && row.slug) === requestedSlug) reasons.push('slug');
  if (getWrestlingPeoplePhotoAggregationTextArray(row && row.aliases).some((alias) => normalizeWrestlingPersonExactMatchKey(alias) === requestedKey)) reasons.push('alias');
  if (getWrestlingPeoplePhotoAggregationTextArray(row && row.teams).some((team) => normalizeWrestlingPersonExactMatchKey(team) === requestedKey)) reasons.push('team');
  return reasons;
}

async function getWrestlingPeoplePhotoAggregationPersonRows(requestedPerson, columnsByTable, warnings) {
  const hasName = hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'name');
  if (!hasName) {
    warnings.push('Missing required column on wrestling_people: name');
    return [];
  }

  const requestedKey = normalizeWrestlingPersonExactMatchKey(requestedPerson);
  const requestedSlug = slugifyMusicBandId(requestedPerson);
  const selectColumns = [
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'id', 'NULL'),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'slug', 'NULL'),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'name', 'NULL'),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'category', 'NULL'),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'aliases', "'{}'::text[]"),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'teams', "'{}'::text[]"),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'notes', 'NULL'),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'photo_count', 'NULL'),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'event_count', 'NULL'),
    getWrestlingPeoplePhotoAggregationColumnSql(columnsByTable, 'wrestling_people', 'match_count', 'NULL')
  ];
  const conditions = ['lower(trim(coalesce(name, \'\'))) = $1'];
  const values = [requestedKey, requestedSlug];

  if (hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'slug')) {
    conditions.push('lower(trim(coalesce(slug, \'\'))) = $2');
  }
  if (hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'aliases')) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM unnest(coalesce(aliases, '{}'::text[])) AS alias_item(value)
      WHERE lower(trim(alias_item.value)) = $1
    )`);
  }
  if (hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'teams')) {
    conditions.push(`EXISTS (
      SELECT 1
      FROM unnest(coalesce(teams, '{}'::text[])) AS team_item(value)
      WHERE lower(trim(team_item.value)) = $1
    )`);
  }

  const orderSql = [
    'CASE WHEN lower(trim(coalesce(name, \'\'))) = $1 THEN 0 ELSE 1 END',
    hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'name') ? 'name ASC NULLS LAST' : '',
    hasDiagnosticColumn(columnsByTable, 'wrestling_people', 'id') ? 'id ASC' : ''
  ].filter(Boolean).join(', ');

  const result = await runWrestlingDiagnosticQuery(
    warnings,
    'single wrestling person photo aggregation person resolution',
    `SELECT ${selectColumns.join(', ')}
     FROM wrestling_people
     WHERE ${conditions.join(' OR ')}
     ORDER BY ${orderSql}
     LIMIT 25`,
    values
  );

  return diagnosticRows(result).map((row) => ({
    ...row,
    aliases: getWrestlingPeoplePhotoAggregationTextArray(row.aliases),
    teams: getWrestlingPeoplePhotoAggregationTextArray(row.teams),
    match_reasons: getWrestlingPeoplePhotoAggregationPersonMatchReasons(row, requestedKey, requestedSlug)
  }));
}

function getWrestlingPeoplePhotoAggregationCurrentPhotoCount(row, cachedPhotoCounts) {
  const personKey = normalizeWrestlingPersonExactMatchKey(row && row.name);
  if (!personKey || !cachedPhotoCounts) return 0;
  return toIntegerCount(cachedPhotoCounts.get(personKey));
}

function buildWrestlingPeoplePhotoAggregationPersonRows(rows, appearanceCounts, cachedPhotoCounts) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const personKey = normalizeWrestlingPersonExactMatchKey(row && row.name);
    const computedAppearance = appearanceCounts.get(personKey) || {};
    const computedPhotoCount = getWrestlingPeoplePhotoAggregationCurrentPhotoCount(row, cachedPhotoCounts);

    return {
      id: toIntegerCount(row.id),
      slug: row.slug || '',
      name: row.name || '',
      category: row.category || '',
      aliases: getWrestlingPeoplePhotoAggregationTextArray(row.aliases),
      teams: getWrestlingPeoplePhotoAggregationTextArray(row.teams),
      notes: row.notes || '',
      match_reasons: Array.isArray(row.match_reasons) ? row.match_reasons : [],
      stored_counts: {
        photo_count: row.photo_count == null ? null : toIntegerCount(row.photo_count),
        event_count: row.event_count == null ? null : toIntegerCount(row.event_count),
        match_count: row.match_count == null ? null : toIntegerCount(row.match_count)
      },
      current_endpoint_counts: {
        photo_count: computedPhotoCount,
        event_count: toIntegerCount(computedAppearance.event_count),
        match_count: toIntegerCount(computedAppearance.match_count)
      }
    };
  });
}

async function getWrestlingPeoplePhotoAggregationMatchedMatches(lookupEntries, warnings) {
  const lookupKeys = Array.from(new Set(
    (Array.isArray(lookupEntries) ? lookupEntries : [])
      .map((entry) => entry && entry.key)
      .filter(Boolean)
  ));
  if (!lookupKeys.length) return [];

  const matchesArraySql = getWrestlingMatchesArraySql();
  const participantsArraySql = getWrestlingParticipantsArraySql('match_item');
  const winnerArraySql = getWrestlingWinnerArraySql('match_item');
  const refereesArraySql = getWrestlingRefereesArraySql('match_item');
  const extraPeopleArraySql = getWrestlingExtraPeopleArraySql('match_item');
  const taggedPeopleArraySql = getWrestlingTaggedPeopleArraySql('match_item');
  const sideOneArraySql = "CASE WHEN jsonb_typeof(match_item->'side_1') = 'array' THEN match_item->'side_1' ELSE '[]'::jsonb END";
  const sideTwoArraySql = "CASE WHEN jsonb_typeof(match_item->'side_2') = 'array' THEN match_item->'side_2' ELSE '[]'::jsonb END";

  const result = await runWrestlingDiagnosticQuery(
    warnings,
    'single wrestling person photo aggregation show relationship scan',
    `WITH match_rows AS (
       SELECT
         ws.id,
         ws.show_id,
         ws.show_key,
         ws.promotion,
         ws.show_name,
         ws.date,
         ws.show_date,
         match_row.ordinality AS match_ordinality,
         match_row.match AS match_item
       FROM wrestling_shows ws
       CROSS JOIN LATERAL jsonb_array_elements(${matchesArraySql}) WITH ORDINALITY AS match_row(match, ordinality)
     ),
     scored AS (
       SELECT
         match_rows.*,
         EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(${participantsArraySql}) AS participant_item(value)
           WHERE lower(trim(participant_item.value)) = ANY($1::text[])
         ) AS participants_match,
         EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(${winnerArraySql}) AS winner_item(value)
           WHERE lower(trim(winner_item.value)) = ANY($1::text[])
         ) AS winner_match,
         EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(${refereesArraySql}) AS referee_item(value)
           WHERE lower(trim(referee_item.value)) = ANY($1::text[])
         ) AS referees_match,
         EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(${extraPeopleArraySql}) AS extra_people_item(value)
           WHERE lower(trim(extra_people_item.value)) = ANY($1::text[])
         ) AS extra_people_match,
         EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(${taggedPeopleArraySql}) AS tagged_people_item(value)
           WHERE lower(trim(tagged_people_item.value)) = ANY($1::text[])
         ) AS tagged_people_match,
         EXISTS (
           SELECT 1
           FROM (
             SELECT jsonb_array_elements_text(${sideOneArraySql}) AS value
             UNION ALL
             SELECT jsonb_array_elements_text(${sideTwoArraySql}) AS value
           ) AS side_item
           WHERE lower(trim(side_item.value)) = ANY($1::text[])
         ) AS side_match,
         EXISTS (
           SELECT 1
           FROM unnest($1::text[]) AS lookup_key(value)
           WHERE lookup_key.value <> ''
             AND (
               lower(trim(coalesce(match_item->>'title', ''))) = lookup_key.value
               OR lower(trim(coalesce(match_item->>'name', ''))) = lookup_key.value
               OR lower(trim(coalesce(match_item->>'match_name', ''))) = lookup_key.value
               OR lower(coalesce(match_item->>'title', '')) LIKE '%' || lookup_key.value || '%'
               OR lower(coalesce(match_item->>'name', '')) LIKE '%' || lookup_key.value || '%'
               OR lower(coalesce(match_item->>'match_name', '')) LIKE '%' || lookup_key.value || '%'
             )
         ) AS title_match
       FROM match_rows
     ),
     filtered AS (
       SELECT
         *,
         array_remove(ARRAY[
           CASE WHEN participants_match THEN 'participants' END,
           CASE WHEN winner_match THEN 'winner' END,
           CASE WHEN referees_match THEN 'referees' END,
           CASE WHEN extra_people_match THEN 'extra_people' END,
           CASE WHEN tagged_people_match THEN 'tagged_people' END,
           CASE WHEN side_match THEN 'side_1_or_side_2' END,
           CASE WHEN title_match THEN 'title_or_name' END
         ], NULL) AS matched_fields
       FROM scored
       WHERE participants_match
          OR winner_match
          OR referees_match
          OR extra_people_match
          OR tagged_people_match
          OR side_match
          OR title_match
     )
     SELECT
       id,
       show_id,
       show_key,
       promotion,
       show_name,
       date,
       show_date,
       match_ordinality,
       match_item AS match,
       matched_fields
     FROM filtered
     ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST, match_ordinality ASC`,
    [lookupKeys]
  );

  return diagnosticRows(result);
}

function getWrestlingPeoplePhotoAggregationArrayMatches(values, lookupSet) {
  return getWrestlingPeoplePhotoAggregationTextArray(values)
    .filter((value) => lookupSet.has(normalizeWrestlingPersonExactMatchKey(value)));
}

function getWrestlingPeoplePhotoAggregationTitleMatches(match, lookupEntries) {
  const fields = ['title', 'name', 'match_name'];
  const matches = [];
  fields.forEach((field) => {
    const value = String(match && match[field] || '').trim();
    const keyValue = normalizeWrestlingPersonExactMatchKey(value);
    if (!value) return;

    const matchedKeys = (Array.isArray(lookupEntries) ? lookupEntries : [])
      .filter((entry) => entry && entry.key && (keyValue === entry.key || keyValue.includes(entry.key)))
      .map((entry) => entry.key);
    if (matchedKeys.length) matches.push({ field, value, matched_keys: Array.from(new Set(matchedKeys)) });
  });
  return matches;
}

function buildWrestlingPeoplePhotoAggregationMatchSample(row, lookupEntries) {
  const lookupSet = new Set(
    (Array.isArray(lookupEntries) ? lookupEntries : [])
      .map((entry) => entry && entry.key)
      .filter(Boolean)
  );
  const match = buildWrestlingMatchDbApiItem(row && row.match);

  return {
    show_id: toIntegerCount(row && row.show_id),
    show_key: row && row.show_key || '',
    promotion: row && row.promotion || '',
    show_name: row && row.show_name || '',
    date: row && row.date || '',
    match_ordinality: toIntegerCount(row && row.match_ordinality),
    match_order: match.match_order == null ? null : toIntegerCount(match.match_order),
    title: match.title || match.name || match.match_name || '',
    match_url: match.match_url || match.matchUrl || '',
    participants: getWrestlingPeoplePhotoAggregationTextArray(match.participants),
    winner: splitWrestlingWinnerList(match.winner),
    side_1: getWrestlingPeoplePhotoAggregationTextArray(match.side_1),
    side_2: getWrestlingPeoplePhotoAggregationTextArray(match.side_2),
    matched_fields: Array.isArray(row && row.matched_fields) ? row.matched_fields : [],
    matched_values: {
      participants: getWrestlingPeoplePhotoAggregationArrayMatches(match.participants, lookupSet),
      winner: getWrestlingPeoplePhotoAggregationArrayMatches(splitWrestlingWinnerList(match.winner), lookupSet),
      referees: getWrestlingPeoplePhotoAggregationArrayMatches(match.referees, lookupSet),
      extra_people: getWrestlingPeoplePhotoAggregationArrayMatches(match.extra_people, lookupSet),
      tagged_people: getWrestlingPeoplePhotoAggregationArrayMatches(match.tagged_people, lookupSet),
      side_1: getWrestlingPeoplePhotoAggregationArrayMatches(match.side_1, lookupSet),
      side_2: getWrestlingPeoplePhotoAggregationArrayMatches(match.side_2, lookupSet),
      title_or_name: getWrestlingPeoplePhotoAggregationTitleMatches(match, lookupEntries)
    }
  };
}

function summarizeWrestlingPeoplePhotoAggregationMatches(rows, lookupEntries, sampleLimit) {
  const eventMap = new Map();
  const countsByField = {};

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const eventKey = row && (row.show_key || row.show_id || row.id);
    if (eventKey != null && !eventMap.has(eventKey)) {
      eventMap.set(eventKey, {
        show_id: toIntegerCount(row.show_id),
        show_key: row.show_key || '',
        promotion: row.promotion || '',
        show_name: row.show_name || '',
        date: row.date || ''
      });
    }

    (Array.isArray(row && row.matched_fields) ? row.matched_fields : []).forEach((field) => {
      countsByField[field] = toIntegerCount(countsByField[field]) + 1;
    });
  });

  return {
    matchedEventsCount: eventMap.size,
    matchedMatchesCount: Array.isArray(rows) ? rows.length : 0,
    countsByField,
    sampleEvents: Array.from(eventMap.values()).slice(0, sampleLimit),
    sampleMatches: (Array.isArray(rows) ? rows : []).slice(0, sampleLimit).map((row) => buildWrestlingPeoplePhotoAggregationMatchSample(row, lookupEntries))
  };
}

function getWrestlingPeoplePhotoAggregationPhotoArrays(match) {
  const arrays = [];
  [
    ['photos', match && match.photos],
    ['match_photos', match && match.match_photos],
    ['images', match && match.images],
    ['photo_refs', match && match.photo_refs]
  ].forEach(([field, value]) => {
    if (Array.isArray(value) && value.length) arrays.push({ field, photos: value });
  });
  return arrays;
}

function getWrestlingPeoplePhotoAggregationPhotoKey(albumId, photo, fallback) {
  const cleanAlbumId = String(albumId || '').trim();
  const imageKey = String(photo && (photo.image_key || photo.imageKey || photo.key || photo.id) || '').trim();
  if (cleanAlbumId || imageKey) return `${cleanAlbumId}:${imageKey}`;
  return String(fallback || '').trim();
}

function buildWrestlingPeoplePhotoAggregationPhotoRef(photo, context = {}) {
  const ref = {
    album_id: String(context.album_id || photo && photo.album_id || photo && photo.albumId || '').trim(),
    image_key: String(photo && (photo.image_key || photo.imageKey || photo.key || photo.id) || '').trim(),
    caption: String(photo && photo.caption || '').trim(),
    show_id: toIntegerCount(context.show_id),
    show_key: context.show_key || '',
    show_name: context.show_name || '',
    date: context.date || '',
    match_order: context.match_order == null ? null : toIntegerCount(context.match_order),
    title: context.title || ''
  };

  const url = String(photo && (photo.large_url || photo.medium_url || photo.small_url || photo.thumbnail_url || photo.url) || '').trim();
  if (url) ref.url = url;
  return ref;
}

function buildWrestlingPeoplePhotoAggregationMatchContext(row) {
  const match = buildWrestlingMatchDbApiItem(row && row.match);
  return {
    show_id: row && row.show_id,
    show_key: row && row.show_key || '',
    promotion: row && row.promotion || '',
    show_name: row && row.show_name || '',
    date: row && row.date || '',
    match_order: match.match_order,
    title: match.title || match.name || match.match_name || ''
  };
}

function getWrestlingPeoplePhotoAggregationPersonCacheKey(matcher) {
  const personKey = normalizeWrestlingPersonExactMatchKey(matcher && matcher.personKey);
  const matchKeys = Array.from(new Set(Array.isArray(matcher && matcher.matchKeys) ? matcher.matchKeys : []))
    .map(normalizeWrestlingPersonExactMatchKey)
    .filter(Boolean)
    .sort();
  if (!personKey || !matchKeys.length) return '';
  return `${personKey}:${matchKeys.join('|')}`;
}

function getCachedWrestlingPeoplePhotoAggregationPersonCount(matcher) {
  const cacheKey = getWrestlingPeoplePhotoAggregationPersonCacheKey(matcher);
  const hit = cacheKey ? wrestlingPeoplePhotoAggregationPersonCache.get(cacheKey) : null;
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > WRESTLING_PEOPLE_PHOTO_COUNT_CACHE_TTL_MS) {
    wrestlingPeoplePhotoAggregationPersonCache.delete(cacheKey);
    return null;
  }
  return hit;
}

function setCachedWrestlingPeoplePhotoAggregationPersonCount(matcher, payload) {
  const cacheKey = getWrestlingPeoplePhotoAggregationPersonCacheKey(matcher);
  if (!cacheKey) return;
  wrestlingPeoplePhotoAggregationPersonCache.set(cacheKey, {
    fetchedAt: Date.now(),
    count: toIntegerCount(payload && payload.count),
    status: payload && payload.status ? payload.status : 'computed',
    source: payload && payload.source ? payload.source : 'bounded_scan',
    warning: payload && payload.warning ? payload.warning : ''
  });
}

function getCachedWrestlingPeoplePhotoAggregationAlbumPhotos(albumId) {
  const cleanAlbumId = String(albumId || '').trim();
  const hit = cleanAlbumId ? wrestlingPeoplePhotoAggregationAlbumPhotosCache.get(cleanAlbumId) : null;
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > SMUG_WRESTLING_MATCH_PHOTOS_CACHE_TTL_MS) {
    wrestlingPeoplePhotoAggregationAlbumPhotosCache.delete(cleanAlbumId);
    return null;
  }
  return hit.photos;
}

function setCachedWrestlingPeoplePhotoAggregationAlbumPhotos(albumId, photos) {
  const cleanAlbumId = String(albumId || '').trim();
  if (!cleanAlbumId) return;
  wrestlingPeoplePhotoAggregationAlbumPhotosCache.set(cleanAlbumId, {
    fetchedAt: Date.now(),
    photos: Array.isArray(photos) ? photos : []
  });
}

async function fetchWrestlingPeoplePhotoAggregationAlbumPhotos(albumId) {
  const cleanAlbumId = String(albumId || '').trim();
  if (!cleanAlbumId || !isSmugMugConfigured()) return [];

  const hydratedCache = getCachedSmugWrestlingAlbumPhotos(cleanAlbumId);
  if (hydratedCache) return hydratedCache;

  const cached = getCachedWrestlingPeoplePhotoAggregationAlbumPhotos(cleanAlbumId);
  if (cached) return cached;
  if (wrestlingPeoplePhotoAggregationAlbumPhotosInFlight.has(cleanAlbumId)) {
    return wrestlingPeoplePhotoAggregationAlbumPhotosInFlight.get(cleanAlbumId);
  }

  const run = (async () => {
    const photos = [];
    let start = 1;
    for (let page = 0; page < SMUG_WRESTLING_MATCH_PHOTOS_MAX_PAGES; page += 1) {
      const endpoint = `/album/${encodeURIComponent(cleanAlbumId)}!images?count=${SMUG_WRESTLING_MATCH_PHOTOS_PAGE_LIMIT}&start=${start}&_accept=application/json&_expand=Image`;
      const json = await fetchSmugJson(endpoint);
      const images = getSmugAlbumImages(json);
      if (!images.length) break;

      images.forEach((image) => {
        const item = buildSmugAlbumPhotoItem(image, { hydrated: false });
        item.keywords = getSmugImageKeywordValues(image);
        item.album_id = cleanAlbumId;
        photos.push(item);
      });

      const pageCount = getSmugPageCount(json) || images.length;
      if (!hasSmugNextPage(json) || pageCount <= 0) break;
      start += pageCount;
    }

    const hasCaption = photos.some((photo) => String(photo && photo.caption || '').trim());
    if (!hasCaption && photos.length) {
      const hydrated = await fetchSmugWrestlingAlbumPhotos(cleanAlbumId);
      setCachedWrestlingPeoplePhotoAggregationAlbumPhotos(cleanAlbumId, hydrated);
      return hydrated;
    }

    setCachedWrestlingPeoplePhotoAggregationAlbumPhotos(cleanAlbumId, photos);
    return photos;
  })().catch((err) => {
    setCachedWrestlingPeoplePhotoAggregationAlbumPhotos(cleanAlbumId, []);
    throw err;
  }).finally(() => {
    wrestlingPeoplePhotoAggregationAlbumPhotosInFlight.delete(cleanAlbumId);
  });

  wrestlingPeoplePhotoAggregationAlbumPhotosInFlight.set(cleanAlbumId, run);
  return run;
}

async function scanWrestlingPeoplePhotoAggregationSources(matchRows, sampleLimit, warnings) {
  const state = {
    storedMatchPhotoArrays: {
      matches_with_arrays: 0,
      photo_count: 0,
      samplePhotoRefs: []
    },
    smugMug: {
      configured: isSmugMugConfigured(),
      matchAlbumsScanned: 0,
      albumsResolved: 0,
      uniqueAlbumsResolved: 0,
      photo_count: 0,
      unique_photo_count: 0,
      albums: [],
      albumsAll: [],
      skippedAlbums: [],
      skipped_album_count: 0,
      scan_limited: false,
      limit: WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS
    },
    allPhotoRefs: []
  };
  const uniquePhotoKeys = new Set();
  const uniqueSmugPhotoKeys = new Set();
  const uniqueAlbumIds = new Set();
  const albumPhotoCache = new Map();

  (Array.isArray(matchRows) ? matchRows : []).forEach((row, rowIndex) => {
    const context = buildWrestlingPeoplePhotoAggregationMatchContext(row);
    getWrestlingPeoplePhotoAggregationPhotoArrays(row && row.match).forEach(({ field, photos }) => {
      state.storedMatchPhotoArrays.matches_with_arrays += 1;
      state.storedMatchPhotoArrays.photo_count += photos.length;
      photos.forEach((photo, photoIndex) => {
        const normalizedPhoto = typeof photo === 'string' ? { id: photo, caption: '' } : photo;
        const ref = {
          ...buildWrestlingPeoplePhotoAggregationPhotoRef(normalizedPhoto, context),
          source: `stored_match.${field}`
        };
        const key = getWrestlingPeoplePhotoAggregationPhotoKey(ref.album_id, normalizedPhoto, `stored:${rowIndex}:${field}:${photoIndex}`);
        if (!uniquePhotoKeys.has(key)) {
          uniquePhotoKeys.add(key);
          state.allPhotoRefs.push(ref);
        }
        if (state.storedMatchPhotoArrays.samplePhotoRefs.length < sampleLimit) {
          state.storedMatchPhotoArrays.samplePhotoRefs.push(ref);
        }
      });
    });
  });

  if (!state.smugMug.configured) {
    warnings.push('SmugMug is not configured; live album photo source scan skipped.');
    return state;
  }

  const rowsToScan = (Array.isArray(matchRows) ? matchRows : []).slice(0, WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS);
  state.smugMug.scan_limited = Array.isArray(matchRows) && matchRows.length > rowsToScan.length;
  if (state.smugMug.scan_limited) {
    const skippedRows = (Array.isArray(matchRows) ? matchRows : []).slice(WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS);
    state.smugMug.skipped_album_count = skippedRows.length;
    state.smugMug.skippedAlbums = skippedRows.map((row) => {
      const context = buildWrestlingPeoplePhotoAggregationMatchContext(row);
      return {
        show_id: toIntegerCount(row && row.show_id),
        show_key: row && row.show_key || '',
        show_name: row && row.show_name || '',
        date: row && row.date || '',
        match_order: context.match_order == null ? null : toIntegerCount(context.match_order),
        title: context.title || '',
        album_id: '',
        skipped_reason: 'WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS'
      };
    });
  }

  await mapWithConcurrency(rowsToScan, SMUG_REQUEST_CONCURRENCY, async (row) => {
    const match = row && row.match && typeof row.match === 'object' ? row.match : {};
    const item = {
      show_id: row && row.show_id,
      show_key: row && row.show_key || '',
      promotion: row && row.promotion || '',
      show_name: row && row.show_name || '',
      date: row && row.date || ''
    };
    const context = buildWrestlingPeoplePhotoAggregationMatchContext(row);
    state.smugMug.matchAlbumsScanned += 1;
    const resolved = await resolveSmugWrestlingMatchAlbum(match, row, item);
    const albumId = resolved && resolved.albumId ? String(resolved.albumId).trim() : '';
    const albumSummary = {
      show_id: toIntegerCount(row && row.show_id),
      show_key: row && row.show_key || '',
      show_name: row && row.show_name || '',
      date: row && row.date || '',
      match_order: context.match_order == null ? null : toIntegerCount(context.match_order),
      title: context.title || '',
      album_id: albumId,
      source: resolved && resolved.source || '',
      path: resolved && resolved.path || '',
      attempted_paths: Array.isArray(resolved && resolved.attemptedPaths) ? resolved.attemptedPaths : [],
      photo_count: 0
    };

    if (!albumId) {
      state.smugMug.albumsAll.push(albumSummary);
      if (state.smugMug.albums.length < sampleLimit) state.smugMug.albums.push(albumSummary);
      return;
    }

    state.smugMug.albumsResolved += 1;
    uniqueAlbumIds.add(albumId);

    let photos = albumPhotoCache.get(albumId);
    if (!photos) {
      photos = await fetchWrestlingPeoplePhotoAggregationAlbumPhotos(albumId);
      albumPhotoCache.set(albumId, photos);
    }

    albumSummary.photo_count = Array.isArray(photos) ? photos.length : 0;
    state.smugMug.albumsAll.push(albumSummary);
    if (state.smugMug.albums.length < sampleLimit) state.smugMug.albums.push(albumSummary);

    (Array.isArray(photos) ? photos : []).forEach((photo, photoIndex) => {
      const ref = {
        ...buildWrestlingPeoplePhotoAggregationPhotoRef(photo, { ...context, album_id: albumId }),
        source: 'smugmug_match_album'
      };
      const key = getWrestlingPeoplePhotoAggregationPhotoKey(albumId, photo, `smug:${albumId}:${photoIndex}`);
      uniqueSmugPhotoKeys.add(key);
      if (!uniquePhotoKeys.has(key)) {
        uniquePhotoKeys.add(key);
        state.allPhotoRefs.push(ref);
      }
    });
  });

  state.smugMug.uniqueAlbumsResolved = uniqueAlbumIds.size;
  state.smugMug.photo_count = Array.from(albumPhotoCache.values()).reduce((sum, photos) => sum + (Array.isArray(photos) ? photos.length : 0), 0);
  state.smugMug.unique_photo_count = uniqueSmugPhotoKeys.size;
  return state;
}

function getWrestlingPeoplePhotoAggregationCaptionTokens(caption) {
  return String(caption || '')
    .split(';')
    .map((token) => String(token || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map((token) => ({
      token,
      key: normalizeWrestlingPersonExactMatchKey(token)
    }))
    .filter((entry) => entry.key);
}

function addWrestlingPeoplePhotoAggregationCaptionToken(map, tokenEntry, photoRef, sampleLimit) {
  const key = tokenEntry && tokenEntry.key;
  if (!key) return;
  if (!map.has(key)) {
    map.set(key, {
      token: tokenEntry.token,
      key,
      count: 0,
      samplePhotoRefs: []
    });
  }
  const entry = map.get(key);
  entry.count += 1;
  if (entry.samplePhotoRefs.length < sampleLimit) {
    entry.samplePhotoRefs.push(photoRef);
  }
}

function buildWrestlingPeoplePhotoAggregationCaptionTokenList(map) {
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))
    .map((entry) => ({
      token: entry.token,
      key: entry.key,
      count: toIntegerCount(entry.count),
      samplePhotoRefs: entry.samplePhotoRefs
    }));
}

function scanWrestlingPeoplePhotoAggregationCaptions(photoRefs, lookupEntries, sampleLimit) {
  const personKeys = new Set(
    (Array.isArray(lookupEntries) ? lookupEntries : [])
      .filter((entry) => entry && ['requested', 'name'].includes(entry.type))
      .map((entry) => entry.key)
  );
  const aliasKeys = new Set(
    (Array.isArray(lookupEntries) ? lookupEntries : [])
      .filter((entry) => entry && entry.type === 'alias')
      .map((entry) => entry.key)
  );
  const teamKeys = new Set(
    (Array.isArray(lookupEntries) ? lookupEntries : [])
      .filter((entry) => entry && entry.type === 'team')
      .map((entry) => entry.key)
  );
  const allKnownKeys = new Set([...personKeys, ...aliasKeys, ...teamKeys]);
  const personTokenMatches = new Map();
  const aliasTokenMatches = new Map();
  const teamTokenMatches = new Map();
  const unmatchedNearbyTokens = new Map();
  const matchedPhotoKeys = new Set();
  const captionSampleRefs = [];
  let photosWithCaptions = 0;
  let captionTokensParsed = 0;

  (Array.isArray(photoRefs) ? photoRefs : []).forEach((photoRef, index) => {
    const caption = String(photoRef && photoRef.caption || '').trim();
    if (!caption) return;

    photosWithCaptions += 1;
    if (captionSampleRefs.length < sampleLimit) captionSampleRefs.push(photoRef);

    const tokens = getWrestlingPeoplePhotoAggregationCaptionTokens(caption);
    captionTokensParsed += tokens.length;
    const hasRelevantToken = tokens.some((tokenEntry) => allKnownKeys.has(tokenEntry.key));
    tokens.forEach((tokenEntry) => {
      if (personKeys.has(tokenEntry.key)) {
        addWrestlingPeoplePhotoAggregationCaptionToken(personTokenMatches, tokenEntry, photoRef, sampleLimit);
        matchedPhotoKeys.add(getWrestlingPeoplePhotoAggregationPhotoKey(photoRef.album_id, photoRef, `caption:${index}`));
        return;
      }
      if (aliasKeys.has(tokenEntry.key)) {
        addWrestlingPeoplePhotoAggregationCaptionToken(aliasTokenMatches, tokenEntry, photoRef, sampleLimit);
        matchedPhotoKeys.add(getWrestlingPeoplePhotoAggregationPhotoKey(photoRef.album_id, photoRef, `caption:${index}`));
        return;
      }
      if (teamKeys.has(tokenEntry.key)) {
        addWrestlingPeoplePhotoAggregationCaptionToken(teamTokenMatches, tokenEntry, photoRef, sampleLimit);
        matchedPhotoKeys.add(getWrestlingPeoplePhotoAggregationPhotoKey(photoRef.album_id, photoRef, `caption:${index}`));
        return;
      }
      if (hasRelevantToken) {
        addWrestlingPeoplePhotoAggregationCaptionToken(unmatchedNearbyTokens, tokenEntry, photoRef, sampleLimit);
      }
    });
  });

  const personMatches = buildWrestlingPeoplePhotoAggregationCaptionTokenList(personTokenMatches);
  const aliasMatches = buildWrestlingPeoplePhotoAggregationCaptionTokenList(aliasTokenMatches);
  const teamMatches = buildWrestlingPeoplePhotoAggregationCaptionTokenList(teamTokenMatches);
  const nearbyTokens = buildWrestlingPeoplePhotoAggregationCaptionTokenList(unmatchedNearbyTokens).slice(0, sampleLimit);
  const personTokenMatchCount = personMatches.reduce((sum, entry) => sum + toIntegerCount(entry.count), 0);
  const aliasTokenMatchCount = aliasMatches.reduce((sum, entry) => sum + toIntegerCount(entry.count), 0);
  const teamTokenMatchCount = teamMatches.reduce((sum, entry) => sum + toIntegerCount(entry.count), 0);

  return {
    summary: {
      photos_scanned: Array.isArray(photoRefs) ? photoRefs.length : 0,
      photos_with_captions: photosWithCaptions,
      caption_tokens_parsed: captionTokensParsed,
      person_token_match_count: personTokenMatchCount,
      alias_token_match_count: aliasTokenMatchCount,
      team_token_match_count: teamTokenMatchCount,
      matched_photo_count: matchedPhotoKeys.size
    },
    personTokenMatches: personMatches,
    aliasTokenMatches: aliasMatches,
    teamTokenMatches: teamMatches,
    unmatchedNearbyTokens: nearbyTokens,
    samplePhotoRefs: captionSampleRefs
  };
}

function getWrestlingPeoplePhotoAggregationExpectedCount(value) {
  const clean = String(value == null ? '' : value).trim();
  if (!clean) return null;
  const number = Number(clean);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  return integer >= 0 ? integer : null;
}

function buildWrestlingPeoplePhotoAggregationCaptionTokenSets(lookupEntries) {
  const primaryKeys = new Set();
  const aliasKeys = new Set();
  const teamKeys = new Set();

  (Array.isArray(lookupEntries) ? lookupEntries : []).forEach((entry) => {
    const key = entry && entry.key;
    if (!key) return;
    if (['requested', 'name'].includes(entry.type)) {
      primaryKeys.add(key);
      return;
    }
    if (entry.type === 'alias') {
      aliasKeys.add(key);
      return;
    }
    if (entry.type === 'team') {
      teamKeys.add(key);
    }
  });

  return {
    primaryKeys,
    aliasKeys,
    teamKeys,
    allKnownKeys: new Set([...primaryKeys, ...aliasKeys, ...teamKeys])
  };
}

function getWrestlingPeoplePhotoAggregationPhotoRefKey(photoRef, fallback) {
  return getWrestlingPeoplePhotoAggregationPhotoKey(photoRef && photoRef.album_id, photoRef, fallback);
}

function getWrestlingPeoplePhotoAggregationUniquePhotoRefEntries(photoRefs) {
  const seen = new Set();
  const entries = [];
  (Array.isArray(photoRefs) ? photoRefs : []).forEach((photoRef, index) => {
    const key = getWrestlingPeoplePhotoAggregationPhotoRefKey(photoRef, `photo:${index}`);
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push({ key, photoRef, index });
  });
  return entries;
}

function buildWrestlingPeoplePhotoAggregationCaptionBreakdown(photoRefs, lookupEntries, sampleLimit) {
  const tokenSets = buildWrestlingPeoplePhotoAggregationCaptionTokenSets(lookupEntries);
  const primaryTokenMatches = new Map();
  const aliasTokenMatches = new Map();
  const teamTokenMatches = new Map();
  const unmatchedCaptionTokens = new Map();
  const matchedPhotoKeys = new Set();
  const primaryMatchedPhotoKeys = new Set();
  const aliasMatchedPhotoKeys = new Set();
  const teamMatchedPhotoKeys = new Set();
  const noCaptionPhotoKeys = new Set();
  const captionNoMatchPhotoKeys = new Set();
  const sampleUnmatchedPhotoRefs = [];
  const sampleNoCaptionPhotoRefs = [];
  let photosWithCaptions = 0;
  let captionTokensParsed = 0;

  const uniquePhotoEntries = getWrestlingPeoplePhotoAggregationUniquePhotoRefEntries(photoRefs);
  uniquePhotoEntries.forEach(({ key, photoRef }) => {
    const caption = String(photoRef && photoRef.caption || '').trim();
    if (!caption) {
      noCaptionPhotoKeys.add(key);
      if (sampleNoCaptionPhotoRefs.length < sampleLimit) sampleNoCaptionPhotoRefs.push(photoRef);
      return;
    }

    photosWithCaptions += 1;
    const tokens = getWrestlingPeoplePhotoAggregationCaptionTokens(caption);
    captionTokensParsed += tokens.length;
    let photoMatched = false;

    tokens.forEach((tokenEntry) => {
      let tokenMatched = false;
      if (tokenSets.primaryKeys.has(tokenEntry.key)) {
        addWrestlingPeoplePhotoAggregationCaptionToken(primaryTokenMatches, tokenEntry, photoRef, sampleLimit);
        primaryMatchedPhotoKeys.add(key);
        tokenMatched = true;
      }
      if (tokenSets.aliasKeys.has(tokenEntry.key)) {
        addWrestlingPeoplePhotoAggregationCaptionToken(aliasTokenMatches, tokenEntry, photoRef, sampleLimit);
        aliasMatchedPhotoKeys.add(key);
        tokenMatched = true;
      }
      if (tokenSets.teamKeys.has(tokenEntry.key)) {
        addWrestlingPeoplePhotoAggregationCaptionToken(teamTokenMatches, tokenEntry, photoRef, sampleLimit);
        teamMatchedPhotoKeys.add(key);
        tokenMatched = true;
      }
      if (tokenMatched) {
        photoMatched = true;
        matchedPhotoKeys.add(key);
      }
    });

    if (!photoMatched) {
      captionNoMatchPhotoKeys.add(key);
      if (sampleUnmatchedPhotoRefs.length < sampleLimit) sampleUnmatchedPhotoRefs.push(photoRef);
      tokens.forEach((tokenEntry) => {
        addWrestlingPeoplePhotoAggregationCaptionToken(unmatchedCaptionTokens, tokenEntry, photoRef, sampleLimit);
      });
    }
  });

  const primaryMatches = buildWrestlingPeoplePhotoAggregationCaptionTokenList(primaryTokenMatches);
  const aliasMatches = buildWrestlingPeoplePhotoAggregationCaptionTokenList(aliasTokenMatches);
  const teamMatches = buildWrestlingPeoplePhotoAggregationCaptionTokenList(teamTokenMatches);
  const topUnmatchedTokens = buildWrestlingPeoplePhotoAggregationCaptionTokenList(unmatchedCaptionTokens).slice(0, sampleLimit);
  const primaryTokenMatchCount = primaryMatches.reduce((sum, entry) => sum + toIntegerCount(entry.count), 0);
  const aliasTokenMatchCount = aliasMatches.reduce((sum, entry) => sum + toIntegerCount(entry.count), 0);
  const teamTokenMatchCount = teamMatches.reduce((sum, entry) => sum + toIntegerCount(entry.count), 0);

  return {
    summary: {
      photos_scanned: Array.isArray(photoRefs) ? photoRefs.length : 0,
      unique_photos_scanned: uniquePhotoEntries.length,
      photos_with_captions: photosWithCaptions,
      photos_with_no_caption: noCaptionPhotoKeys.size,
      photos_with_captions_but_no_matching_token: captionNoMatchPhotoKeys.size,
      caption_tokens_parsed: captionTokensParsed,
      primary_token_match_count: primaryTokenMatchCount,
      alias_token_match_count: aliasTokenMatchCount,
      team_token_match_count: teamTokenMatchCount,
      alias_team_token_match_count: aliasTokenMatchCount + teamTokenMatchCount,
      primary_token_matched_photo_count: primaryMatchedPhotoKeys.size,
      alias_token_matched_photo_count: aliasMatchedPhotoKeys.size,
      team_token_matched_photo_count: teamMatchedPhotoKeys.size,
      alias_team_token_matched_photo_count: new Set([...aliasMatchedPhotoKeys, ...teamMatchedPhotoKeys]).size,
      matched_photo_count: matchedPhotoKeys.size,
      unmatched_or_uncaptioned_photo_count: uniquePhotoEntries.length - matchedPhotoKeys.size
    },
    primaryTokenMatches: primaryMatches,
    aliasTokenMatches: aliasMatches,
    teamTokenMatches: teamMatches,
    topUnmatchedCaptionTokens: topUnmatchedTokens,
    sampleUnmatchedPhotoRefs,
    sampleNoCaptionPhotoRefs
  };
}

function buildWrestlingPeoplePhotoAggregationAlbumCoverage(photoScan, lookupEntries, sampleLimit) {
  const smugMug = photoScan && photoScan.smugMug ? photoScan.smugMug : {};
  const refsByAlbum = new Map();
  getWrestlingPeoplePhotoAggregationUniquePhotoRefEntries(photoScan && photoScan.allPhotoRefs).forEach(({ photoRef }) => {
    const albumId = String(photoRef && photoRef.album_id || '').trim();
    const albumKey = albumId || `source:${String(photoRef && photoRef.source || 'unknown')}`;
    if (!refsByAlbum.has(albumKey)) refsByAlbum.set(albumKey, []);
    refsByAlbum.get(albumKey).push(photoRef);
  });

  const albumRows = (Array.isArray(smugMug.albumsAll) ? smugMug.albumsAll : Array.isArray(smugMug.albums) ? smugMug.albums : [])
    .map((album, index) => {
      const albumId = String(album && album.album_id || '').trim();
      const refs = albumId ? (refsByAlbum.get(albumId) || []) : [];
      const breakdown = buildWrestlingPeoplePhotoAggregationCaptionBreakdown(refs, lookupEntries, sampleLimit);
      return {
        ...album,
        coverage_index: index + 1,
        unique_photo_count: breakdown.summary.unique_photos_scanned,
        caption_matched_photo_count: breakdown.summary.matched_photo_count,
        primary_caption_matched_photo_count: breakdown.summary.primary_token_matched_photo_count,
        alias_team_caption_matched_photo_count: breakdown.summary.alias_team_token_matched_photo_count,
        photos_with_no_caption: breakdown.summary.photos_with_no_caption,
        captions_without_matching_token: breakdown.summary.photos_with_captions_but_no_matching_token
      };
    });

  return {
    related_match_albums_found: albumRows.filter((album) => String(album && album.album_id || '').trim()).length,
    related_match_album_rows: albumRows.length,
    albums_scanned: toIntegerCount(smugMug.matchAlbumsScanned),
    albums_resolved: toIntegerCount(smugMug.albumsResolved),
    unique_albums_resolved: toIntegerCount(smugMug.uniqueAlbumsResolved),
    albums_skipped_due_to_limit: toIntegerCount(smugMug.skipped_album_count),
    album_scan_limit: toIntegerCount(smugMug.limit || WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS),
    scan_limited: !!smugMug.scan_limited,
    albums: albumRows,
    skippedAlbums: Array.isArray(smugMug.skippedAlbums) ? smugMug.skippedAlbums : []
  };
}

function buildWrestlingPeoplePhotoAggregationParticipantInferredGap(photoRefs, captionBreakdown) {
  const summary = captionBreakdown && captionBreakdown.summary ? captionBreakdown.summary : {};
  const totalUniquePhotos = toIntegerCount(summary.unique_photos_scanned);
  const captionMatchedPhotos = toIntegerCount(summary.matched_photo_count);
  const notCaptionMatchedPhotos = Math.max(0, totalUniquePhotos - captionMatchedPhotos);

  return {
    total_unique_photos_in_related_matches: totalUniquePhotos,
    unique_caption_matched_photos: captionMatchedPhotos,
    unique_photos_not_caption_matched: notCaptionMatchedPhotos,
    photos_with_no_caption: toIntegerCount(summary.photos_with_no_caption),
    photos_with_captions_but_no_matching_token: toIntegerCount(summary.photos_with_captions_but_no_matching_token),
    likely_match_participant_inferred_photos: notCaptionMatchedPhotos,
    classification: notCaptionMatchedPhotos > 0
      ? 'caption_not_matched_but_match_relationship_present'
      : 'caption_matched_all_related_match_photos'
  };
}

function getWrestlingPeoplePhotoAggregationPersonMeta(personRows, photoAggregation) {
  const metaRows = [];
  const meta = photoAggregation && photoAggregation.meta;
  (Array.isArray(personRows) ? personRows : []).forEach((row) => {
    const personKey = normalizeWrestlingPersonExactMatchKey(row && row.name);
    const personMeta = meta && typeof meta.get === 'function' ? meta.get(personKey) : null;
    metaRows.push({
      personKey,
      name: row && row.name || '',
      status: personMeta && personMeta.status || '',
      source: personMeta && personMeta.source || '',
      warning: personMeta && personMeta.warning || ''
    });
  });
  return metaRows;
}

function buildWrestlingPeoplePhotoAggregationCurrentApiReport(personRows, photoAggregation, currentEndpointPhotoCount, warnings) {
  const summary = photoAggregation && photoAggregation.summary ? photoAggregation.summary : {};
  const personMeta = getWrestlingPeoplePhotoAggregationPersonMeta(personRows, photoAggregation);
  const status = personMeta.find((entry) => entry.status && entry.status !== 'computed')?.status || summary.status || 'computed';
  const source = personMeta.find((entry) => entry.source)?.source || summary.source || 'bounded_scan';
  const skippedAlbums = Math.max(0, toIntegerCount(summary.show_match_albums_considered) - toIntegerCount(summary.albums_scanned));
  const limitHit = !!summary.match_scan_limited;
  const hasAlbumErrors = toIntegerCount(summary.albums_with_errors) > 0;
  const partial = status === 'partial' || limitHit || hasAlbumErrors;
  const unavailable = status === 'unavailable';
  const apiWarnings = Array.from(new Set([
    ...personMeta.map((entry) => entry.warning).filter(Boolean),
    ...(Array.isArray(warnings) ? warnings : []).filter(Boolean)
  ]));

  return {
    current_wrestling_people_db_photo_count: toIntegerCount(currentEndpointPhotoCount),
    aggregation_source: source,
    aggregation_status: status,
    complete: !partial && !unavailable,
    partial,
    cache_hit_count: toIntegerCount(summary.cache_hit_count),
    scanned_people_count: toIntegerCount(summary.scanned_people_count),
    related_show_count: toIntegerCount(summary.related_show_count),
    matched_matches_count: toIntegerCount(summary.matched_matches_count),
    show_match_albums_considered: toIntegerCount(summary.show_match_albums_considered),
    scanned_albums_count: toIntegerCount(summary.albums_scanned),
    skipped_albums_count: skippedAlbums,
    albums_resolved: toIntegerCount(summary.albums_resolved),
    unique_albums_resolved: toIntegerCount(summary.unique_albums_resolved),
    albums_with_errors: toIntegerCount(summary.albums_with_errors),
    caption_photo_match_count: toIntegerCount(summary.caption_photo_match_count),
    limit: WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS,
    limits_hit: {
      WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS: limitHit
    },
    warnings: apiWarnings,
    personMeta
  };
}

function chooseWrestlingPeoplePhotoAggregationRecommendedFixMode({ expectedCount, currentCount, apiCaptionBreakdown, apiPhotoScan, participantInferredGap }) {
  const gap = expectedCount == null ? null : expectedCount - currentCount;
  const apiSummary = apiCaptionBreakdown && apiCaptionBreakdown.summary ? apiCaptionBreakdown.summary : {};
  const smugMug = apiPhotoScan && apiPhotoScan.smugMug ? apiPhotoScan.smugMug : {};
  if (smugMug.scan_limited) return 'increase_album_scan_limit';
  if (toIntegerCount(apiSummary.alias_team_token_matched_photo_count) > 0 && currentCount < toIntegerCount(apiSummary.matched_photo_count)) {
    return 'include_alias_token_matches';
  }
  if (gap != null && gap > 0 && toIntegerCount(participantInferredGap && participantInferredGap.unique_photos_not_caption_matched) >= gap) {
    return 'include_match_participant_inferred_photos';
  }
  if (gap != null && gap > 0 && toIntegerCount(apiSummary.photos_with_captions_but_no_matching_token) > 0) {
    return 'normalize_caption_variant_tokens';
  }
  if (gap != null && gap > 0 && toIntegerCount(smugMug.unique_photo_count) > currentCount) {
    return 'source_library_count_includes_non_match_or_non-captioned_photos';
  }
  return 'unknown';
}

function buildWrestlingPeoplePhotoAggregationParityAnalysis({
  expectedCount,
  currentCount,
  apiCaptionBreakdown,
  apiPhotoScan,
  participantInferredGap,
  diagnosticApiMatchedPhotoCount
}) {
  const apiSummary = apiCaptionBreakdown && apiCaptionBreakdown.summary ? apiCaptionBreakdown.summary : {};
  const smugMug = apiPhotoScan && apiPhotoScan.smugMug ? apiPhotoScan.smugMug : {};
  const gap = expectedCount == null ? null : expectedCount - currentCount;
  const likelyReasons = [];

  if (diagnosticApiMatchedPhotoCount !== currentCount) {
    likelyReasons.push(`The diagnostic exact-caption scan found ${diagnosticApiMatchedPhotoCount} matched photos while /api/wrestling/people/db currently reports ${currentCount}.`);
  }
  if (smugMug.scan_limited) {
    likelyReasons.push(`The API aggregation album scan reached WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS=${WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS}.`);
  }
  if (expectedCount != null && gap > 0) {
    likelyReasons.push(`Expected input is ${expectedCount}; current aggregation is ${currentCount}, leaving a gap of ${gap}.`);
  }
  if (toIntegerCount(apiSummary.photos_with_no_caption) > 0) {
    likelyReasons.push(`${toIntegerCount(apiSummary.photos_with_no_caption)} unique photos in API-related match albums have no caption.`);
  }
  if (toIntegerCount(apiSummary.photos_with_captions_but_no_matching_token) > 0) {
    likelyReasons.push(`${toIntegerCount(apiSummary.photos_with_captions_but_no_matching_token)} unique photos in API-related match albums have captions but no exact semicolon token for the person, aliases, or teams.`);
  }
  if (participantInferredGap && toIntegerCount(participantInferredGap.unique_photos_not_caption_matched) > 0) {
    likelyReasons.push(`${toIntegerCount(participantInferredGap.unique_photos_not_caption_matched)} unique photos in directly related person matches are not exact caption-token matches and would require participant-inferred counting or caption cleanup.`);
  }
  if (!likelyReasons.length) {
    likelyReasons.push('No specific parity gap reason was identified from the bounded diagnostic scan.');
  }

  return {
    expectedCountFromInput: expectedCount,
    currentAggregatedCount: currentCount,
    diagnosticApiCaptionMatchedCount: toIntegerCount(diagnosticApiMatchedPhotoCount),
    gap,
    likelyReasons,
    recommendedFixMode: chooseWrestlingPeoplePhotoAggregationRecommendedFixMode({
      expectedCount,
      currentCount,
      apiCaptionBreakdown,
      apiPhotoScan,
      participantInferredGap
    })
  };
}

function createWrestlingPeoplePhotoAggregationMatchersForRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const personKey = normalizeWrestlingPersonExactMatchKey(row && row.name);
      const matchKeys = getWrestlingPersonPhotoMatchKeys(row);
      return {
        row,
        personKey,
        name: row && row.name || '',
        matchKeys,
        lookupEntries: buildWrestlingPeoplePhotoAggregationLookupEntries(row && row.name, [row])
      };
    })
    .filter((matcher) => matcher.personKey && matcher.matchKeys.length);
}

function doesWrestlingPeoplePhotoAggregationMatchRowMatchLookupEntries(row, lookupEntries) {
  const lookupKeys = new Set(
    (Array.isArray(lookupEntries) ? lookupEntries : [])
      .map((entry) => entry && entry.key)
      .filter(Boolean)
  );
  if (!lookupKeys.size) return false;

  const rawMatch = row && row.match && typeof row.match === 'object' ? row.match : {};
  const match = buildWrestlingMatchDbApiItem(rawMatch);
  const relationshipValues = [
    ...getWrestlingPeoplePhotoAggregationTextArray(match.participants),
    ...getWrestlingPeoplePhotoAggregationTextArray(splitWrestlingWinnerList(match.winner)),
    ...getWrestlingPeoplePhotoAggregationTextArray(match.referees),
    ...getWrestlingPeoplePhotoAggregationTextArray(match.extra_people),
    ...getWrestlingPeoplePhotoAggregationTextArray(match.tagged_people),
    ...getWrestlingPeoplePhotoAggregationTextArray(match.side_1),
    ...getWrestlingPeoplePhotoAggregationTextArray(match.side_2)
  ];

  if (relationshipValues.some((value) => lookupKeys.has(normalizeWrestlingPersonExactMatchKey(value)))) return true;

  return ['title', 'name', 'match_name'].some((field) => {
    const keyValue = normalizeWrestlingPersonExactMatchKey(rawMatch[field]);
    return keyValue && Array.from(lookupKeys).some((lookupKey) => keyValue === lookupKey || keyValue.includes(lookupKey));
  });
}

function getWrestlingPeoplePhotoAggregationShowIdentity(row) {
  const showKey = String(row && row.show_key || '').trim();
  if (showKey) return `key:${showKey}`;
  const showId = toIntegerCount(row && row.show_id);
  if (showId) return `id:${showId}`;
  const id = toIntegerCount(row && row.id);
  return id ? `row:${id}` : '';
}

async function getWrestlingPeoplePhotoAggregationShowMatchRowsForMatchedEvents(matchRows, warnings) {
  const showIds = Array.from(new Set(
    (Array.isArray(matchRows) ? matchRows : [])
      .map((row) => toIntegerCount(row && row.show_id))
      .filter(Boolean)
  ));
  const showKeys = Array.from(new Set(
    (Array.isArray(matchRows) ? matchRows : [])
      .map((row) => String(row && row.show_key || '').trim())
      .filter(Boolean)
  ));
  if (!showIds.length && !showKeys.length) return [];

  const result = await runWrestlingDiagnosticQuery(
    warnings,
    'single wrestling person photo aggregation related show match scan',
    `SELECT
       ws.id,
       ws.show_id,
       ws.show_key,
       ws.promotion,
       ws.show_name,
       ws.date,
       ws.show_date,
       match_row.ordinality AS match_ordinality,
       match_row.match AS match
     FROM wrestling_shows ws
     CROSS JOIN LATERAL jsonb_array_elements(${getWrestlingMatchesArraySql()}) WITH ORDINALITY AS match_row(match, ordinality)
     WHERE (cardinality($1::int[]) > 0 AND ws.show_id = ANY($1::int[]))
        OR (cardinality($2::text[]) > 0 AND ws.show_key = ANY($2::text[]))
     ORDER BY ws.show_date DESC NULLS LAST, ws.show_id DESC NULLS LAST, match_row.ordinality ASC`,
    [showIds, showKeys]
  );

  return diagnosticRows(result);
}

function addWrestlingPeoplePagePhotoAggregationMatch(photoSets, matchers, albumId, photo, fallbackKey) {
  const captionTokens = new Set(getWrestlingCaptionTokenKeys(photo && photo.caption));
  if (!captionTokens.size) return 0;

  const photoKey = getWrestlingPeoplePhotoAggregationPhotoKey(albumId, photo, fallbackKey);
  let matchedPeople = 0;
  (Array.isArray(matchers) ? matchers : []).forEach((matcher) => {
    if (!matcher.matchKeys.some((key) => captionTokens.has(key))) return;
    if (!photoSets.has(matcher.personKey)) photoSets.set(matcher.personKey, new Set());
    photoSets.get(matcher.personKey).add(photoKey);
    matchedPeople += 1;
  });
  return matchedPeople;
}

async function buildWrestlingPeoplePagePhotoAggregation(rows = [], options = {}) {
  const warnings = Array.isArray(options.warnings) ? options.warnings : [];
  const counts = new Map();
  const meta = new Map();
  const summary = {
    source: 'bounded_scan',
    scoped_to_result_rows: true,
    requested_people_count: Array.isArray(rows) ? rows.length : 0,
    scanned_people_count: 0,
    cache_hit_count: 0,
    related_show_count: 0,
    matched_matches_count: 0,
    show_match_albums_considered: 0,
    match_scan_limited: false,
    match_scan_limit: WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS,
    albums_scanned: 0,
    albums_resolved: 0,
    albums_with_errors: 0,
    unique_albums_resolved: 0,
    caption_photo_match_count: 0,
    status: 'computed'
  };

  const matchers = createWrestlingPeoplePhotoAggregationMatchersForRows(rows);
  if (!matchers.length) return { counts, meta, warnings, summary };

  if (!isSmugMugConfigured()) {
    const warning = 'SmugMug is not configured; Wrestling People photo_count is unavailable for this request.';
    warnings.push(warning);
    summary.status = 'unavailable';
    matchers.forEach((matcher) => {
      counts.set(matcher.personKey, 0);
      meta.set(matcher.personKey, { status: 'unavailable', source: 'bounded_scan', warning });
    });
    return { counts, meta, warnings, summary };
  }

  const unresolved = [];
  matchers.forEach((matcher) => {
    const personCache = getCachedWrestlingPeoplePhotoAggregationPersonCount(matcher);
    if (personCache) {
      counts.set(matcher.personKey, toIntegerCount(personCache.count));
      meta.set(matcher.personKey, {
        status: personCache.status || 'cached',
        source: personCache.source || 'bounded_scan_cache',
        warning: personCache.warning || ''
      });
      summary.cache_hit_count += 1;
      return;
    }

    unresolved.push(matcher);
  });

  if (!unresolved.length) {
    summary.scanned_people_count = 0;
    return { counts, meta, warnings, summary };
  }

  summary.scanned_people_count = unresolved.length;
  const lookupEntries = unresolved.flatMap((matcher) => matcher.lookupEntries);
  const matchRows = await getWrestlingPeoplePhotoAggregationMatchedMatches(lookupEntries, warnings);
  summary.matched_matches_count = matchRows.length;

  const relatedShowsByPerson = new Map();
  unresolved.forEach((matcher) => relatedShowsByPerson.set(matcher.personKey, new Set()));
  matchRows.forEach((row) => {
    const showIdentity = getWrestlingPeoplePhotoAggregationShowIdentity(row);
    if (!showIdentity) return;
    unresolved.forEach((matcher) => {
      if (doesWrestlingPeoplePhotoAggregationMatchRowMatchLookupEntries(row, matcher.lookupEntries)) {
        relatedShowsByPerson.get(matcher.personKey).add(showIdentity);
      }
    });
  });

  const relatedShowIdentities = new Set();
  relatedShowsByPerson.forEach((showSet) => {
    showSet.forEach((showIdentity) => relatedShowIdentities.add(showIdentity));
  });
  summary.related_show_count = relatedShowIdentities.size;

  const showMatchRows = await getWrestlingPeoplePhotoAggregationShowMatchRowsForMatchedEvents(matchRows, warnings);
  summary.show_match_albums_considered = showMatchRows.length;
  const rowsToScan = showMatchRows.slice(0, WRESTLING_PEOPLE_PHOTO_COUNT_MAX_MATCH_ALBUMS);
  summary.match_scan_limited = showMatchRows.length > rowsToScan.length;
  if (summary.match_scan_limited) {
    warnings.push(`Wrestling People photo aggregation scanned ${rowsToScan.length} of ${showMatchRows.length} related show match albums for this request.`);
    summary.status = 'partial';
  }

  const photoSets = new Map();
  const uniqueAlbumIds = new Set();

  await mapWithConcurrency(rowsToScan, SMUG_REQUEST_CONCURRENCY, async (row, rowIndex) => {
    const showIdentity = getWrestlingPeoplePhotoAggregationShowIdentity(row);
    const applicableMatchers = unresolved.filter((matcher) => (
      showIdentity && relatedShowsByPerson.has(matcher.personKey) && relatedShowsByPerson.get(matcher.personKey).has(showIdentity)
    ));
    if (!applicableMatchers.length) return;

    const match = row && row.match && typeof row.match === 'object' ? row.match : {};
    const context = buildWrestlingPeoplePhotoAggregationMatchContext(row);

    getWrestlingPeoplePhotoAggregationPhotoArrays(match).forEach(({ field, photos }) => {
      (Array.isArray(photos) ? photos : []).forEach((photo, photoIndex) => {
        const normalizedPhoto = typeof photo === 'string' ? { id: photo, caption: '' } : photo;
        summary.caption_photo_match_count += addWrestlingPeoplePagePhotoAggregationMatch(
          photoSets,
          applicableMatchers,
          normalizedPhoto && (normalizedPhoto.album_id || normalizedPhoto.albumId) || '',
          normalizedPhoto,
          `stored:${rowIndex}:${field}:${photoIndex}`
        );
      });
    });

    const item = {
      show_id: row && row.show_id,
      show_key: row && row.show_key || '',
      promotion: row && row.promotion || '',
      show_name: row && row.show_name || '',
      date: row && row.date || ''
    };
    const resolved = await resolveSmugWrestlingMatchAlbum(match, row, item);
    const albumId = resolved && resolved.albumId ? String(resolved.albumId).trim() : '';
    summary.albums_scanned += 1;
    if (!albumId) return;

    summary.albums_resolved += 1;
    uniqueAlbumIds.add(albumId);

    let photos = [];
    try {
      photos = await fetchWrestlingPeoplePhotoAggregationAlbumPhotos(albumId);
    } catch (err) {
      summary.albums_with_errors += 1;
      summary.status = 'partial';
      warnings.push(`Unable to fetch Wrestling People photo aggregation album ${albumId}: ${getSafeErrorMessage(err)}`);
      return;
    }

    (Array.isArray(photos) ? photos : []).forEach((photo, photoIndex) => {
      summary.caption_photo_match_count += addWrestlingPeoplePagePhotoAggregationMatch(
        photoSets,
        applicableMatchers,
        albumId,
        photo,
        `smug:${albumId}:${photoIndex}`
      );
    });
  });

  summary.unique_albums_resolved = uniqueAlbumIds.size;
  unresolved.forEach((matcher) => {
    const count = photoSets.has(matcher.personKey) ? photoSets.get(matcher.personKey).size : 0;
    const status = summary.status === 'partial' ? 'partial' : 'computed';
    const warning = summary.match_scan_limited
      ? 'Wrestling People photo_count is partial because the related match scan reached its configured limit.'
      : summary.albums_with_errors > 0
        ? 'Wrestling People photo_count is partial because one or more related albums could not be read.'
        : '';
    counts.set(matcher.personKey, count);
    meta.set(matcher.personKey, { status, source: 'bounded_match_caption_scan', warning });
    setCachedWrestlingPeoplePhotoAggregationPersonCount(matcher, { count, status, source: 'bounded_match_caption_scan', warning });
  });

  return { counts, meta, warnings, summary };
}

function classifyWrestlingPeoplePhotoAggregationDiagnostic(personRows, matches, photos, captions, currentEndpointPhotoCount) {
  if (!Array.isArray(personRows) || !personRows.length) return 'people_row_missing';

  const hasAliasOrTeam = personRows.some((row) => (
    getWrestlingPeoplePhotoAggregationTextArray(row.aliases).length ||
    getWrestlingPeoplePhotoAggregationTextArray(row.teams).length
  ));
  const matchedMatchesCount = toIntegerCount(matches && matches.matchedMatchesCount);
  const storedPhotoCount = toIntegerCount(photos && photos.storedMatchPhotoArrays && photos.storedMatchPhotoArrays.photo_count);
  const smugPhotoCount = toIntegerCount(photos && photos.smugMug && photos.smugMug.unique_photo_count);
  const sourcePhotoCount = storedPhotoCount + smugPhotoCount;
  const personAliasCaptionMatches = toIntegerCount(captions && captions.summary && captions.summary.person_token_match_count) +
    toIntegerCount(captions && captions.summary && captions.summary.alias_token_match_count);
  const teamCaptionMatches = toIntegerCount(captions && captions.summary && captions.summary.team_token_match_count);

  if (!hasAliasOrTeam && matchedMatchesCount === 0) return 'aliases_missing';
  if (matchedMatchesCount === 0) return 'show_relationship_missing';
  if (sourcePhotoCount === 0) return 'match_relationship_present_but_photos_missing';
  if (currentEndpointPhotoCount > 0 && personAliasCaptionMatches > 0) return 'aggregation_working';
  if (currentEndpointPhotoCount === 0 && personAliasCaptionMatches > 0) return 'photos_present_but_people_aggregation_not_using_them';
  if (currentEndpointPhotoCount === 0 && teamCaptionMatches > 0 && personAliasCaptionMatches === 0) return 'captions_present_but_alias_matching_missing';
  if (!photos || !photos.smugMug || photos.smugMug.configured === false) return 'source_data_missing';
  return 'unknown';
}

function getWrestlingPeoplePhotoAggregationRecommendedNextActions(diagnosis) {
  const actions = {
    people_row_missing: [
      'Confirm the Wrestling-People source row exists and refresh the wrestling_people import after review.'
    ],
    aliases_missing: [
      'Add missing aliases or team names to the Wrestling-People source when match rows identify the person indirectly.'
    ],
    show_relationship_missing: [
      'Add the person, alias, or team value to wrestling_shows match relationship fields such as participants, winner, side_1, side_2, extra_people, or tagged_people.'
    ],
    match_relationship_present_but_photos_missing: [
      'Verify match_url, album_id, or SmugMug path data for the matched wrestling_shows rows; the relationship exists but no stored or resolved photos were found.'
    ],
    photos_present_but_people_aggregation_not_using_them: [
      'Update Wrestling People photo aggregation to use the same resolved match albums/caption scan surfaced here, or block the people response until the read-only cache is available.'
    ],
    captions_present_but_alias_matching_missing: [
      'Extend Wrestling People photo aggregation to include team fields or add the caption token as an alias for the person.'
    ],
    source_data_missing: [
      'Confirm DATABASE_URL and SmugMug configuration, then rerun the diagnostic after source data is available.'
    ],
    aggregation_working: [
      'No data repair is indicated by this diagnostic; the Wrestling People endpoint is now using the bounded match-album caption aggregation path.'
    ],
    unknown: [
      'Review the person, relationship, photo, and caption samples in this response before applying a data or aggregation fix.'
    ]
  };
  return actions[diagnosis] || actions.unknown;
}

async function buildWrestlingPeoplePhotoAggregationDiagnosticResponse(query = {}) {
  const generated = new Date();
  const requestedPerson = String(query.person || '').trim();
  const sampleLimit = getWrestlingPeoplePhotoAggregationSampleLimit(query.limit);
  const warnings = [];

  if (!requestedPerson) {
    return buildAdminResponse({
      ok: false,
      route: WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_ROUTE,
      source: 'postgres+smugmug',
      section: 'wrestling',
      type: 'people_photo_aggregation_diagnostic',
      generated,
      readOnly: true,
      databaseMutated: false,
      error: 'PERSON_REQUIRED',
      message: 'Pass a person query parameter.',
      person: {
        requested: '',
        normalized: { exact_key: '', slug_key: '' },
        rows: []
      },
      summary: {},
      matches: {},
      photos: {},
      captions: {},
      currentApiAggregation: {},
      participantInferredGap: {},
      albumCoverage: {},
      parityAnalysis: {
        expectedCountFromInput: getWrestlingPeoplePhotoAggregationExpectedCount(query.expected),
        currentAggregatedCount: 0,
        diagnosticApiCaptionMatchedCount: 0,
        gap: null,
        likelyReasons: ['Pass ?person=<name> to inspect one wrestling person.'],
        recommendedFixMode: 'unknown'
      },
      warnings,
      recommendedNextActions: ['Pass ?person=<name> to inspect one wrestling person.']
    });
  }

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Missing DATABASE_URL environment variable.');
    return buildAdminResponse({
      ok: false,
      route: WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_ROUTE,
      source: 'postgres+smugmug',
      section: 'wrestling',
      type: 'people_photo_aggregation_diagnostic',
      generated,
      readOnly: true,
      databaseMutated: false,
      diagnosis: 'source_data_missing',
      error: 'DATABASE_NOT_CONFIGURED',
      person: {
        requested: requestedPerson,
        normalized: {
          exact_key: normalizeWrestlingPersonExactMatchKey(requestedPerson),
          slug_key: slugifyMusicBandId(requestedPerson)
        },
        rows: []
      },
      summary: {},
      matches: {},
      photos: {},
      captions: {},
      currentApiAggregation: {},
      participantInferredGap: {},
      albumCoverage: {},
      parityAnalysis: {
        expectedCountFromInput: getWrestlingPeoplePhotoAggregationExpectedCount(query.expected),
        currentAggregatedCount: 0,
        diagnosticApiCaptionMatchedCount: 0,
        gap: null,
        likelyReasons: ['DATABASE_URL is missing, so live parity analysis could not run.'],
        recommendedFixMode: 'unknown'
      },
      warnings,
      recommendedNextActions: getWrestlingPeoplePhotoAggregationRecommendedNextActions('source_data_missing')
    });
  }

  const existingTables = await getExistingPublicTables(WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_TABLES);
  const columnsByTable = await getExistingPublicColumns(WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_TABLES);
  if (!existingTables.has('wrestling_people') || !existingTables.has('wrestling_shows')) {
    if (!existingTables.has('wrestling_people')) warnings.push('Missing table: wrestling_people');
    if (!existingTables.has('wrestling_shows')) warnings.push('Missing table: wrestling_shows');
    return buildAdminResponse({
      ok: true,
      route: WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_ROUTE,
      source: 'postgres+smugmug',
      section: 'wrestling',
      type: 'people_photo_aggregation_diagnostic',
      generated,
      readOnly: true,
      databaseMutated: false,
      diagnosis: 'source_data_missing',
      person: {
        requested: requestedPerson,
        normalized: {
          exact_key: normalizeWrestlingPersonExactMatchKey(requestedPerson),
          slug_key: slugifyMusicBandId(requestedPerson)
        },
        rows: []
      },
      summary: {},
      matches: {},
      photos: {},
      captions: {},
      currentApiAggregation: {},
      participantInferredGap: {},
      albumCoverage: {},
      parityAnalysis: {
        expectedCountFromInput: getWrestlingPeoplePhotoAggregationExpectedCount(query.expected),
        currentAggregatedCount: 0,
        diagnosticApiCaptionMatchedCount: 0,
        gap: null,
        likelyReasons: ['Required wrestling source tables are missing, so live parity analysis could not run.'],
        recommendedFixMode: 'unknown'
      },
      warnings,
      recommendedNextActions: getWrestlingPeoplePhotoAggregationRecommendedNextActions('source_data_missing')
    });
  }

  const expectedCount = getWrestlingPeoplePhotoAggregationExpectedCount(query.expected);
  const personRows = await getWrestlingPeoplePhotoAggregationPersonRows(requestedPerson, columnsByTable, warnings);
  const appearanceCounts = await getWrestlingPeopleAppearanceCounts(personRows.map((row) => row.name));
  const cachedPhotoCounts = getCachedWrestlingPeoplePhotoCounts();
  const fixedPhotoAggregation = await buildWrestlingPeoplePagePhotoAggregation(personRows, { warnings });
  const currentEndpointPhotoCounts = personRows.map((row) => {
    const personKey = normalizeWrestlingPersonExactMatchKey(row && row.name);
    return fixedPhotoAggregation.counts.has(personKey)
      ? toIntegerCount(fixedPhotoAggregation.counts.get(personKey))
      : getWrestlingPeoplePhotoAggregationCurrentPhotoCount(row, cachedPhotoCounts);
  });
  const currentEndpointPhotoCount = currentEndpointPhotoCounts.length ? Math.max(...currentEndpointPhotoCounts) : 0;
  const responsePersonRows = buildWrestlingPeoplePhotoAggregationPersonRows(personRows, appearanceCounts, fixedPhotoAggregation.counts);
  const lookupEntries = buildWrestlingPeoplePhotoAggregationLookupEntries(requestedPerson, personRows);
  const matchRows = await getWrestlingPeoplePhotoAggregationMatchedMatches(lookupEntries, warnings);
  const matches = summarizeWrestlingPeoplePhotoAggregationMatches(matchRows, lookupEntries, sampleLimit);
  const photoScan = await scanWrestlingPeoplePhotoAggregationSources(matchRows, sampleLimit, warnings);
  const directCaptionBreakdown = buildWrestlingPeoplePhotoAggregationCaptionBreakdown(photoScan.allPhotoRefs, lookupEntries, sampleLimit);
  const directAlbumCoverage = buildWrestlingPeoplePhotoAggregationAlbumCoverage(photoScan, lookupEntries, sampleLimit);
  const participantInferredGap = buildWrestlingPeoplePhotoAggregationParticipantInferredGap(photoScan.allPhotoRefs, directCaptionBreakdown);
  const apiAggregationShowMatchRows = await getWrestlingPeoplePhotoAggregationShowMatchRowsForMatchedEvents(matchRows, warnings);
  const apiAggregationPhotoScan = await scanWrestlingPeoplePhotoAggregationSources(apiAggregationShowMatchRows, sampleLimit, warnings);
  const apiAggregationCaptionBreakdown = buildWrestlingPeoplePhotoAggregationCaptionBreakdown(apiAggregationPhotoScan.allPhotoRefs, lookupEntries, sampleLimit);
  const apiAggregationAlbumCoverage = buildWrestlingPeoplePhotoAggregationAlbumCoverage(apiAggregationPhotoScan, lookupEntries, sampleLimit);
  const currentApiAggregation = buildWrestlingPeoplePhotoAggregationCurrentApiReport(personRows, fixedPhotoAggregation, currentEndpointPhotoCount, warnings);
  const parityAnalysis = buildWrestlingPeoplePhotoAggregationParityAnalysis({
    expectedCount,
    currentCount: currentEndpointPhotoCount,
    apiCaptionBreakdown: apiAggregationCaptionBreakdown,
    apiPhotoScan: apiAggregationPhotoScan,
    participantInferredGap,
    diagnosticApiMatchedPhotoCount: apiAggregationCaptionBreakdown.summary.matched_photo_count
  });
  const photos = {
    storedMatchPhotoArrays: photoScan.storedMatchPhotoArrays,
    smugMug: {
      ...photoScan.smugMug,
      albums: photoScan.smugMug.albums.slice(0, sampleLimit),
      skippedAlbums: photoScan.smugMug.skippedAlbums.slice(0, sampleLimit)
    },
    albumCoverage: directAlbumCoverage,
    apiAggregationCoverage: {
      relatedShowMatchRows: apiAggregationShowMatchRows.length,
      storedMatchPhotoArrays: apiAggregationPhotoScan.storedMatchPhotoArrays,
      smugMug: {
        ...apiAggregationPhotoScan.smugMug,
        albums: apiAggregationPhotoScan.smugMug.albums.slice(0, sampleLimit),
        skippedAlbums: apiAggregationPhotoScan.smugMug.skippedAlbums.slice(0, sampleLimit)
      },
      albumCoverage: apiAggregationAlbumCoverage,
      samplePhotoRefs: apiAggregationPhotoScan.allPhotoRefs.slice(0, sampleLimit)
    },
    samplePhotoRefs: photoScan.allPhotoRefs.slice(0, sampleLimit)
  };
  const captions = {
    ...scanWrestlingPeoplePhotoAggregationCaptions(photoScan.allPhotoRefs, lookupEntries, sampleLimit),
    tokenBreakdown: directCaptionBreakdown.summary,
    topUnmatchedCaptionTokens: directCaptionBreakdown.topUnmatchedCaptionTokens,
    sampleUnmatchedPhotoRefs: directCaptionBreakdown.sampleUnmatchedPhotoRefs,
    sampleNoCaptionPhotoRefs: directCaptionBreakdown.sampleNoCaptionPhotoRefs,
    apiAggregationTokenBreakdown: {
      ...apiAggregationCaptionBreakdown,
      relatedShowMatchRows: apiAggregationShowMatchRows.length
    }
  };
  const diagnosis = classifyWrestlingPeoplePhotoAggregationDiagnostic(personRows, matches, photos, captions, currentEndpointPhotoCount);
  const recommendedNextActions = getWrestlingPeoplePhotoAggregationRecommendedNextActions(diagnosis);

  return buildAdminResponse({
    ok: true,
    route: WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_ROUTE,
    source: 'postgres+smugmug',
    section: 'wrestling',
    type: 'people_photo_aggregation_diagnostic',
    generated,
    readOnly: true,
    databaseMutated: false,
    diagnosis,
    person: {
      requested: requestedPerson,
      normalized: {
        exact_key: normalizeWrestlingPersonExactMatchKey(requestedPerson),
        slug_key: slugifyMusicBandId(requestedPerson)
      },
      lookupEntries,
      photoCountCache: {
        cached: !!cachedPhotoCounts,
        inFlight: !!smugWrestlingPeoplePhotoCountInFlight,
        ttlMs: WRESTLING_PEOPLE_PHOTO_COUNT_CACHE_TTL_MS,
        ageMs: smugWrestlingPeoplePhotoCountCache ? Date.now() - smugWrestlingPeoplePhotoCountCache.fetchedAt : null,
        currentEndpointPhotoCount
      },
      fixedPhotoAggregation: fixedPhotoAggregation.summary,
      currentApiAggregation,
      rows: responsePersonRows
    },
    summary: {
      requestedPerson,
      normalized_key: normalizeWrestlingPersonExactMatchKey(requestedPerson),
      slug_key: slugifyMusicBandId(requestedPerson),
      matching_people_rows: responsePersonRows.length,
      aliases_present: responsePersonRows.some((row) => Array.isArray(row.aliases) && row.aliases.length),
      teams_present: responsePersonRows.some((row) => Array.isArray(row.teams) && row.teams.length),
      current_endpoint_photo_count: currentEndpointPhotoCount,
      current_endpoint_event_count: responsePersonRows.reduce((max, row) => Math.max(max, toIntegerCount(row.current_endpoint_counts && row.current_endpoint_counts.event_count)), 0),
      current_endpoint_match_count: responsePersonRows.reduce((max, row) => Math.max(max, toIntegerCount(row.current_endpoint_counts && row.current_endpoint_counts.match_count)), 0),
      matched_events_count: matches.matchedEventsCount,
      matched_matches_count: matches.matchedMatchesCount,
      stored_match_photo_count: photos.storedMatchPhotoArrays.photo_count,
      smugmug_unique_photo_count: photos.smugMug.unique_photo_count,
      caption_person_token_match_count: captions.summary.person_token_match_count,
      caption_alias_token_match_count: captions.summary.alias_token_match_count,
      caption_team_token_match_count: captions.summary.team_token_match_count,
      caption_matched_photo_count: captions.summary.matched_photo_count,
      caption_photos_with_no_caption: directCaptionBreakdown.summary.photos_with_no_caption,
      caption_photos_with_captions_but_no_matching_token: directCaptionBreakdown.summary.photos_with_captions_but_no_matching_token,
      api_aggregation_related_show_match_rows: apiAggregationShowMatchRows.length,
      api_aggregation_unique_photo_count: apiAggregationPhotoScan.smugMug.unique_photo_count,
      api_aggregation_caption_matched_photo_count: apiAggregationCaptionBreakdown.summary.matched_photo_count,
      api_aggregation_photos_with_no_caption: apiAggregationCaptionBreakdown.summary.photos_with_no_caption,
      api_aggregation_photos_with_captions_but_no_matching_token: apiAggregationCaptionBreakdown.summary.photos_with_captions_but_no_matching_token,
      participant_inferred_gap_photo_count: participantInferredGap.unique_photos_not_caption_matched,
      expected_count_from_input: expectedCount,
      parity_gap: parityAnalysis.gap,
      recommended_fix_mode: parityAnalysis.recommendedFixMode,
      sample_limit: sampleLimit
    },
    currentApiAggregation,
    matches,
    photos,
    albumCoverage: directAlbumCoverage,
    participantInferredGap,
    captions,
    parityAnalysis,
    warnings,
    recommendedNextActions
  });
}

async function handleWrestlingPeoplePhotoAggregationDiagnosticRequest(req, res) {
  try {
    const response = await buildWrestlingPeoplePhotoAggregationDiagnosticResponse(req.query || {});
    return res.status(response.ok === false ? 400 : 200).json(response);
  } catch (err) {
    const requestedPerson = String(req && req.query && req.query.person || '').trim();
    return res.status(500).json(buildAdminError(WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_ROUTE, err, {
      source: 'postgres+smugmug',
      section: 'wrestling',
      type: 'people_photo_aggregation_diagnostic',
      readOnly: true,
      databaseMutated: false,
      person: {
        requested: requestedPerson,
        normalized: {
          exact_key: normalizeWrestlingPersonExactMatchKey(requestedPerson),
          slug_key: slugifyMusicBandId(requestedPerson)
        },
        rows: []
      },
      summary: {},
      matches: {},
      photos: {},
      captions: {},
      currentApiAggregation: {},
      participantInferredGap: {},
      albumCoverage: {},
      parityAnalysis: {
        expectedCountFromInput: getWrestlingPeoplePhotoAggregationExpectedCount(req && req.query && req.query.expected),
        currentAggregatedCount: 0,
        diagnosticApiCaptionMatchedCount: 0,
        gap: null,
        likelyReasons: ['The diagnostic failed before parity analysis could complete.'],
        recommendedFixMode: 'unknown'
      },
      warnings: [],
      recommendedNextActions: getWrestlingPeoplePhotoAggregationRecommendedNextActions('unknown'),
      error: 'WRESTLING_PEOPLE_PHOTO_AGGREGATION_DIAGNOSTIC_ERROR'
    }));
  }
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
    const warnings = [];
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
    const appearanceCounts = await getWrestlingPeopleAppearanceCounts(result.rows.map((row) => row.name));
    const photoAggregation = await buildWrestlingPeoplePagePhotoAggregation(result.rows, { warnings });
    const data = result.rows.map((row) => buildWrestlingPersonDbApiItem(row, appearanceCounts, photoAggregation.counts, photoAggregation.meta));
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
      warnings,
      meta: {
        ...buildListMeta({ route: '/api/wrestling/people', source: 'db', pagination, filters: options.filters, sort: options.sort, warnings }),
        photoAggregation: photoAggregation.summary
      },
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

function buildMusicPersonDbApiItem(row, archiveRelationships = new Map()) {
  const bands = Array.isArray(row.bands) ? row.bands : [];
  const archive = archiveRelationships.get(String(row.person_id || '').trim()) || {};
  const hasArchive = Object.keys(archive).length > 0;
  const stats = row.stats && typeof row.stats === 'object' ? { ...row.stats } : {};
  const statsAliases = {
    band_count: bands.length,
    artist_count: bands.length,
    people_count: 1
  };
  const statsPhotoCount = hasArchive && archive.photo_count != null
    ? archive.photo_count
    : getMusicStatsNumber(stats, ['photo_count', 'photoCount', 'photos', 'tagged_photo_count', 'taggedPhotoCount']);
  if (statsPhotoCount != null) statsAliases.photo_count = statsPhotoCount;
  const statsEventCount = hasArchive && archive.event_count != null
    ? archive.event_count
    : getMusicStatsNumber(stats, ['event_count', 'eventCount', 'appearance_count', 'appearanceCount', 'appearances']);
  const statsShowCount = hasArchive && archive.show_count != null
    ? archive.show_count
    : getMusicStatsNumber(stats, ['show_count', 'showCount', 'appearance_count', 'appearanceCount', 'appearances']);
  const statsSetCount = hasArchive && archive.set_count != null
    ? archive.set_count
    : getMusicStatsNumber(stats, ['set_count', 'setCount', 'sets', 'appearance_count', 'appearanceCount', 'appearances']);
  if (statsEventCount != null) statsAliases.event_count = statsEventCount;
  if (statsShowCount != null) statsAliases.show_count = statsShowCount;
  if (statsSetCount != null) statsAliases.set_count = statsSetCount;
  addMusicCanonicalAliases(stats, statsAliases);
  if (archive.first_seen || stats.first_seen) stats.first_seen = archive.first_seen || stats.first_seen;
  if (archive.first_seen_display || stats.first_seen_display) stats.first_seen_display = archive.first_seen_display || stats.first_seen_display;
  if (archive.latest_seen || stats.latest_seen) stats.latest_seen = archive.latest_seen || stats.latest_seen;
  if (archive.latest_seen_display || stats.latest_seen_display) stats.latest_seen_display = archive.latest_seen_display || stats.latest_seen_display;
  if (hasArchive) {
    stats.matched_photos = Array.isArray(archive.matched_photos) ? archive.matched_photos : [];
    stats.tagged_shows = Array.isArray(archive.tagged_shows) ? archive.tagged_shows : [];
  }
  const item = {
    person_id: toIntegerCount(row.person_id),
    name: row.name || '',
    category: row.category || '',
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    bands,
    associations: Array.isArray(row.associations) ? row.associations : [],
    stats
  };
  if (archive.first_seen || stats.first_seen) item.first_seen = archive.first_seen || stats.first_seen;
  if (archive.first_seen_display || stats.first_seen_display) item.first_seen_display = archive.first_seen_display || stats.first_seen_display;
  if (archive.latest_seen || stats.latest_seen) item.latest_seen = archive.latest_seen || stats.latest_seen;
  if (archive.latest_seen_display || stats.latest_seen_display) item.latest_seen_display = archive.latest_seen_display || stats.latest_seen_display;
  if (hasArchive) {
    item.matched_photos = Array.isArray(archive.matched_photos) ? archive.matched_photos : [];
    item.tagged_shows = Array.isArray(archive.tagged_shows) ? archive.tagged_shows : [];
  }
  const itemAliases = {
    band_count: bands.length,
    artist_count: bands.length,
    people_count: 1
  };
  if (stats.photo_count != null) itemAliases.photo_count = stats.photo_count;
  if (stats.event_count != null) itemAliases.event_count = stats.event_count;
  if (stats.show_count != null) itemAliases.show_count = stats.show_count;
  if (stats.set_count != null) itemAliases.set_count = stats.set_count;
  if (hasArchive) {
    itemAliases.gallery_id = archive.gallery_id || null;
    itemAliases.album_id = archive.album_id || null;
    itemAliases.cover_image_url = archive.cover_image_url || null;
  }
  addMusicCanonicalAliases(item, itemAliases);
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
    const archiveRelationships = await getMusicPeopleArchiveRelationshipsForListRequest(req.query);
    const data = result.rows.map((row) => buildMusicPersonDbApiItem(row, archiveRelationships));
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

async function handleMusicPersonDbDetailRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }

    const rawPersonId = String(req.params.personId || '').trim();
    const lowerPersonId = rawPersonId.toLowerCase();
    const personSlug = slugifyMusicBandId(rawPersonId);
    if (!personSlug) {
      res.status(400).json({
        ok: false,
        route: '/api/music/people/db/:personId',
        error: 'MUSIC_PERSON_ID_REQUIRED'
      });
      return;
    }

    const result = await dbPool.query(
      `SELECT person_id, name, category, aliases, bands, associations, stats
       FROM music_people
       WHERE person_id::text = $1
          OR lower(trim(person_id::text)) = $2
          OR lower(regexp_replace(trim(coalesce(name, '')), '[^a-z0-9]+', '-', 'g')) = $3
       ORDER BY person_id ASC
       LIMIT 1`,
      [rawPersonId, lowerPersonId, personSlug]
    );
    const row = result.rows && result.rows[0];
    if (!row) {
      res.status(404).json({
        ok: false,
        route: '/api/music/people/db/:personId',
        error: 'MUSIC_PERSON_NOT_FOUND',
        person_id: rawPersonId
      });
      return;
    }

    const archive = await getMusicPersonArchiveRelationship(row);
    const archiveRelationships = new Map([[String(row.person_id || '').trim(), archive]]);
    const data = buildMusicPersonDbApiItem(row, archiveRelationships);
    res.json({
      ok: true,
      route: '/api/music/people/db/:personId',
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      generatedAt: new Date().toISOString(),
      generatedTime: formatEasternGeneratedTime(new Date()),
      person_id: data.person_id,
      data
    });
  } catch (err) {
    res.status(500).json(buildApiError('/api/music/people/db/:personId', err, {
      source: {
        type: 'postgres',
        table: 'music_people'
      },
      section: 'music',
      type: 'people',
      error: 'MUSIC_PERSON_DB_DETAIL_ERROR'
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


const MUSIC_VENUE_PHOTOS_ROUTE = '/api/music/venues/:venue_id/photos';
const MUSIC_VENUE_PHOTOS_CACHE_VERSION = 'music_venue_photos:v4';
const MUSIC_VENUE_PHOTOS_CACHE_TTL_MS = 1000 * 60 * 10;
const musicVenuePhotoAggregationCache = new Map();

function getMusicVenuePhotoLimit(value) {
  const number = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(number)) return 24;
  return Math.min(100, Math.max(1, number));
}

function getMusicVenuePhotoAlbumLimit(value) {
  const number = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(number)) return 25;
  return Math.min(75, Math.max(1, number));
}

function getMusicVenuePhotoLimitPerAlbum(value) {
  const number = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(number)) return 12;
  return Math.min(50, Math.max(1, number));
}

function getMusicVenuePhotoCacheKey(venueId, albumLimit, photoLimitPerAlbum) {
  return `${MUSIC_VENUE_PHOTOS_CACHE_VERSION}:${normalizeMusicLookupKey(venueId)}:${albumLimit}:${photoLimitPerAlbum}`;
}

function getCachedMusicVenuePhotoAggregation(cacheKey) {
  const hit = musicVenuePhotoAggregationCache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > MUSIC_VENUE_PHOTOS_CACHE_TTL_MS) {
    musicVenuePhotoAggregationCache.delete(cacheKey);
    return null;
  }
  return hit.payload;
}

function setCachedMusicVenuePhotoAggregation(cacheKey, payload) {
  musicVenuePhotoAggregationCache.set(cacheKey, { fetchedAt: Date.now(), payload });
}

function buildMusicVenuePhotoSlugCandidates(row) {
  const values = [
    row && row.venue_key,
    row && row.venue,
    [row && row.venue, row && row.city, row && row.state].map((part) => String(part || '').trim()).filter(Boolean).join(' ')
  ];
  return new Set(values.map(slugifyMusicBandId).filter(Boolean));
}

async function findMusicVenueForPhotoAggregation(value) {
  const requested = String(value || '').trim();
  const key = normalizeMusicLookupKey(requested);
  if (!key) return null;

  const exactResult = await dbPool.query(`
    SELECT venue_id, venue_key, venue, city, state, country, region, status, stats, raw_sheet
    FROM music_venues
    WHERE lower(trim(coalesce(venue_key, ''))) = $1
       OR lower(trim(coalesce(venue_id::text, ''))) = $1
    ORDER BY venue_key ASC NULLS LAST, venue_id ASC
    LIMIT 1
  `, [key]);
  if (exactResult.rows && exactResult.rows[0]) return exactResult.rows[0];

  const slugResult = await dbPool.query(`
    SELECT venue_id, venue_key, venue, city, state, country, region, status, stats, raw_sheet
    FROM music_venues
    ORDER BY venue_key ASC NULLS LAST, venue ASC NULLS LAST, venue_id ASC
  `);
  const requestedSlug = slugifyMusicBandId(requested);
  return (slugResult.rows || []).find((row) => buildMusicVenuePhotoSlugCandidates(row).has(requestedSlug)) || null;
}

function buildMusicVenuePhotoVenuePayload(row) {
  const venueId = String(row && (row.venue_key || row.venue_id) || '').trim();
  const venueName = String(row && row.venue || '').trim();
  return {
    venue_id: venueId,
    venue_name: venueName,
    venue: venueName,
    slug: slugifyMusicBandId(venueId || venueName),
    city: String(row && row.city || '').trim(),
    state: String(row && row.state || '').trim(),
    country: String(row && row.country || '').trim(),
    region: String(row && row.region || '').trim(),
    status: String(row && row.status || '').trim()
  };
}

function getMusicVenuePhotoTotalNumber(value) {
  if (value == null || value === '') return null;
  const clean = String(value).replace(/,/g, '').trim();
  if (!clean) return null;
  const number = Number(clean);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function getMusicVenuePhotoTotalCandidate(source, pathLabel, fieldName) {
  if (!source || typeof source !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(source, fieldName)) return null;
  const raw = source[fieldName];
  const normalized = getMusicVenuePhotoTotalNumber(raw);
  if (normalized == null) return null;
  return {
    value: normalized,
    source: `${pathLabel}.${fieldName}`,
    raw,
    normalized
  };
}

function getMusicVenuePhotoTotalFromObject(source, pathLabel) {
  const fields = ['totalPhotos', 'totalphotos', 'total_photos', 'photo_count', 'photoCount', 'photocount', 'photosTotal', 'photostotal', 'total'];
  const zeroCandidate = { value: 0, source: '', raw: null, normalized: 0 };
  for (const field of fields) {
    const candidate = getMusicVenuePhotoTotalCandidate(source, pathLabel, field);
    if (!candidate) continue;
    if (candidate.value > 0) return candidate;
    if (!zeroCandidate.source) Object.assign(zeroCandidate, candidate);
  }
  return zeroCandidate.source ? zeroCandidate : null;
}

function getMusicVenueRawSheetRows(row) {
  const rawSheet = row && row.raw_sheet && typeof row.raw_sheet === 'object' && !Array.isArray(row.raw_sheet)
    ? row.raw_sheet
    : getMusicDataAuditObject(row && row.raw_sheet);
  if (Array.isArray(rawSheet.rows)) return rawSheet.rows.filter((item) => item && typeof item === 'object');
  return rawSheet && Object.keys(rawSheet).length ? [rawSheet] : [];
}

function getMusicVenueOfficialPhotoTotalInfo(row) {
  const stats = row && row.stats && typeof row.stats === 'object' && !Array.isArray(row.stats)
    ? row.stats
    : getMusicDataAuditObject(row && row.stats);
  const normalizedVenue = buildMusicVenueDbApiItem(row || {});
  const rawRows = getMusicVenueRawSheetRows(row);
  const sourceObjects = [
    { label: 'normalizedVenue.stats', value: normalizedVenue && normalizedVenue.stats },
    { label: 'db.stats', value: stats },
    { label: 'normalizedVenue', value: normalizedVenue },
    { label: 'db.row', value: row }
  ];
  rawRows.forEach((rawRow, index) => {
    const sheetItem = buildMusicVenueSheetItem(rawRow);
    sourceObjects.push({ label: `raw_sheet.rows[${index}]`, value: rawRow });
    sourceObjects.push({ label: `buildMusicVenueSheetItem(raw_sheet.rows[${index}])`, value: sheetItem });
  });

  let zeroCandidate = null;
  for (const source of sourceObjects) {
    const candidate = getMusicVenuePhotoTotalFromObject(source.value, source.label);
    if (!candidate) continue;
    if (candidate.value > 0) {
      return {
        ...candidate,
        availableVenueRowKeys: row && typeof row === 'object' ? Object.keys(row).sort() : [],
        normalizedVenueKeys: normalizedVenue && typeof normalizedVenue === 'object' ? Object.keys(normalizedVenue).sort() : []
      };
    }
    if (!zeroCandidate) zeroCandidate = candidate;
  }

  return {
    value: zeroCandidate ? zeroCandidate.value : 0,
    source: zeroCandidate ? zeroCandidate.source : '',
    raw: zeroCandidate ? zeroCandidate.raw : null,
    normalized: zeroCandidate ? zeroCandidate.normalized : 0,
    availableVenueRowKeys: row && typeof row === 'object' ? Object.keys(row).sort() : [],
    normalizedVenueKeys: normalizedVenue && typeof normalizedVenue === 'object' ? Object.keys(normalizedVenue).sort() : []
  };
}

function buildMusicVenuePhotoShowRef(row) {
  return {
    show_id: row && row.show_id != null ? toIntegerCount(row.show_id) : null,
    show_key: String(row && (row.show_url || formatMusicShowUrlDateKey(row.date)) || '').trim() || null,
    show_title: String(row && row.name || '').trim() || null,
    show_date: String(row && row.date || '').trim() || null,
    venue_id: String(row && row.venue_id || '').trim() || null
  };
}

function addMusicVenuePhotoAlbum(albumMap, show, albumId, source, extra = {}) {
  const cleanAlbumId = String(albumId || '').trim();
  if (!cleanAlbumId) return false;
  if (albumMap.has(cleanAlbumId)) return true;
  albumMap.set(cleanAlbumId, {
    album_id: cleanAlbumId,
    gallery_id: String(extra.gallery_id || cleanAlbumId).trim(),
    source,
    band: String(extra.band || '').trim() || null,
    slot: extra.slot == null ? null : toIntegerCount(extra.slot),
    show: buildMusicVenuePhotoShowRef(show)
  });
  return true;
}

function collectMusicVenuePhotoAlbumsFromShows(rows, skippedShows) {
  const albumMap = new Map();
  (Array.isArray(rows) ? rows : []).forEach((show) => {
    let hasUsableAlbum = false;
    hasUsableAlbum = addMusicVenuePhotoAlbum(albumMap, show, show.album_id, 'music_shows.album_id', { gallery_id: show.gallery_id }) || hasUsableAlbum;
    hasUsableAlbum = addMusicVenuePhotoAlbum(albumMap, show, show.gallery_id, 'music_shows.gallery_id', { gallery_id: show.gallery_id }) || hasUsableAlbum;
    getMusicDataAuditArray(show.smug_albums).forEach((album) => {
      const albumId = getMusicPeopleArchiveAlbumKey(album);
      hasUsableAlbum = addMusicVenuePhotoAlbum(albumMap, show, albumId, 'music_shows.smug_albums', {
        gallery_id: album && (album.gallery_id || album.galleryId || albumId),
        band: album && album.band,
        slot: album && album.slot
      }) || hasUsableAlbum;
    });
    if (!hasUsableAlbum) {
      skippedShows.push({
        show_id: show && show.show_id != null ? toIntegerCount(show.show_id) : null,
        show_key: String(show && (show.show_url || formatMusicShowUrlDateKey(show.date)) || '').trim() || null,
        show_title: String(show && show.name || '').trim() || null,
        show_date: String(show && show.date || '').trim() || null,
        reason: 'no_usable_album_id'
      });
    }
  });
  return Array.from(albumMap.values());
}

function getMusicVenuePhotoSortTime(photo) {
  const candidates = [photo && photo.date_taken, photo && photo.taken_at, photo && photo.date_time_original, photo && photo.show_date];
  for (const candidate of candidates) {
    const parsed = Date.parse(String(candidate || '').trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function buildMusicVenueAggregatedPhoto(album, photo) {
  const show = album && album.show ? album.show : {};
  const takenAt = String(photo && photo.date_time_original || '').trim() || null;
  return {
    image_key: String(photo && photo.image_key || '').trim() || null,
    thumbnail_url: String(photo && photo.thumbnail_url || '').trim() || null,
    small_url: String(photo && photo.small_url || '').trim() || null,
    medium_url: String(photo && photo.medium_url || '').trim() || null,
    large_url: String(photo && photo.large_url || '').trim() || null,
    caption: String(photo && photo.caption || '').trim(),
    date_taken: takenAt,
    taken_at: takenAt,
    date_time_original: takenAt,
    show_id: show.show_id,
    show_key: show.show_key,
    show_title: show.show_title,
    show_date: show.show_date,
    album_id: album.album_id,
    gallery_id: album.gallery_id || album.album_id,
    band: album.band || null,
    slot: album.slot
  };
}

function getMusicVenueAggregatedPhotoDedupeKey(photo) {
  return String(photo && (photo.image_key || photo.large_url || photo.medium_url || photo.small_url || photo.thumbnail_url) || '').trim().toLowerCase();
}

async function fetchMusicVenueAlbumPhotos(album, photoLimitPerAlbum, debug) {
  const endpoint = `/album/${encodeURIComponent(album.album_id)}!images?count=${photoLimitPerAlbum}&start=1&_accept=application/json&_expand=Image`;
  const json = await fetchSmugJson(endpoint);
  const images = getSmugAlbumImages(json).slice(0, photoLimitPerAlbum);
  const photos = await buildSmugAlbumPhotoItemsForResponse(images, !!debug);
  return {
    album_id: album.album_id,
    endpoint,
    total: getSmugAlbumPhotosTotal(json, photos.length, 1, hasSmugNextPage(json)),
    count: photos.length,
    photos: photos.map((photo) => buildMusicVenueAggregatedPhoto(album, photo))
  };
}

async function buildMusicVenuePhotoAggregationPayload(venueRow, query = {}) {
  const generated = new Date();
  const debug = query.debug === '1';
  const albumLimit = getMusicVenuePhotoAlbumLimit(query.album_limit);
  const photoLimitPerAlbum = getMusicVenuePhotoLimitPerAlbum(query.photo_limit_per_album);
  const venue = buildMusicVenuePhotoVenuePayload(venueRow);
  const venueTotalPhotoInfo = getMusicVenueOfficialPhotoTotalInfo(venueRow);
  const venueTotalPhotos = toIntegerCount(venueTotalPhotoInfo.value);
  const cacheKey = getMusicVenuePhotoCacheKey(venue.venue_id, albumLimit, photoLimitPerAlbum);
  const cached = debug ? null : getCachedMusicVenuePhotoAggregation(cacheKey);
  if (cached) return { ...cached, generated, cache: { hit: true, key: cacheKey } };

  const warnings = [];
  const skippedShows = [];
  const showResult = await dbPool.query(`
    SELECT show_id, name, date, show_date, show_url, venue_id, venue, album_id, gallery_id, smug_albums
    FROM music_shows
    WHERE lower(trim(coalesce(venue_id, ''))) = lower(trim($1))
    ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
  `, [venue.venue_id]);
  const linkedShows = showResult.rows || [];
  const allAlbums = collectMusicVenuePhotoAlbumsFromShows(linkedShows, skippedShows);
  const albums = allAlbums.slice(0, albumLimit);
  if (allAlbums.length > albums.length) warnings.push(`Album scan limited to ${albumLimit} of ${allAlbums.length} linked albums.`);

  let perAlbum = [];
  let photos = [];
  const smugConfig = getSmugMugConfigDiagnostics();
  if (!smugConfig.configured) {
    warnings.push(`SmugMug is not configured; missing ${smugConfig.missing.join(', ')}.`);
  } else if (albums.length) {
    perAlbum = await mapWithConcurrency(albums, SMUG_REQUEST_CONCURRENCY, async (album) => {
      try {
        return await fetchMusicVenueAlbumPhotos(album, photoLimitPerAlbum, debug);
      } catch (err) {
        warnings.push(`Album ${album.album_id} fetch failed: ${getSafeErrorMessage(err)}`);
        return { album_id: album.album_id, count: 0, total: 0, photos: [], error: getSafeErrorMessage(err) };
      }
    });
    const seen = new Set();
    perAlbum.forEach((albumResult) => {
      (albumResult.photos || []).forEach((photo) => {
        const key = getMusicVenueAggregatedPhotoDedupeKey(photo);
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        photos.push(photo);
      });
    });
    photos = photos.sort((a, b) => getMusicVenuePhotoSortTime(b) - getMusicVenuePhotoSortTime(a));
  }

  const aggregatedPhotoCount = photos.length;
  const albumMetadataTotalPhotos = perAlbum.reduce((sum, album) => {
    const total = album && album.total != null ? toIntegerCount(album.total) : null;
    if (total != null && total > 0) return sum + total;
    return sum + toIntegerCount(album && album.count);
  }, 0);
  const resolvedVenueTotalPhotos = venueTotalPhotos > 0 ? venueTotalPhotos : albumMetadataTotalPhotos;
  const resolvedVenueTotalInfo = venueTotalPhotos > 0
    ? venueTotalPhotoInfo
    : {
      value: resolvedVenueTotalPhotos,
      source: albumMetadataTotalPhotos > 0 ? 'linked_smugmug_album_metadata.total_sum' : (venueTotalPhotoInfo.source || ''),
      raw: albumMetadataTotalPhotos > 0 ? String(albumMetadataTotalPhotos) : venueTotalPhotoInfo.raw,
      normalized: resolvedVenueTotalPhotos,
      availableVenueRowKeys: venueTotalPhotoInfo.availableVenueRowKeys || [],
      normalizedVenueKeys: venueTotalPhotoInfo.normalizedVenueKeys || []
    };
  if (!resolvedVenueTotalInfo.source) {
    warnings.push('Official venue total photo source could not be resolved from venue normalization or linked album metadata.');
  }
  if (resolvedVenueTotalPhotos > aggregatedPhotoCount) {
    warnings.push('Aggregated photo count is lower than the official venue total; this route is limited by linked show albums, album_limit/photo_limit_per_album, and de-dupe. It does not replace venue_total_photos.');
  }

  const payload = {
    ok: true,
    route: `/api/music/venues/${encodeURIComponent(venue.venue_id)}/photos`,
    section: 'music',
    type: 'venue_photo_aggregation',
    readOnly: true,
    databaseMutated: false,
    venue,
    summary: {
      linked_show_count: linkedShows.length,
      album_count: albums.length,
      available_album_count: allAlbums.length,
      venue_total_photos: resolvedVenueTotalPhotos,
      aggregated_photo_count: aggregatedPhotoCount,
      photo_count: aggregatedPhotoCount,
      returned_count: 0
    },
    allPhotos: photos,
    warnings,
    debug: {
      linked_shows: linkedShows.map(buildMusicVenuePhotoShowRef),
      skipped_shows: skippedShows,
      album_ids_used: albums.map((album) => album.album_id),
      per_album_photo_counts: perAlbum.map((album) => ({ album_id: album.album_id, count: toIntegerCount(album.count), total: album.total == null ? null : toIntegerCount(album.total), error: album.error || null })),
      venue_total_photos_source: resolvedVenueTotalInfo.source || null,
      venue_total_photos_raw: resolvedVenueTotalInfo.raw == null ? null : String(resolvedVenueTotalInfo.raw),
      venue_total_photos_normalized: toIntegerCount(resolvedVenueTotalInfo.normalized),
      available_venue_row_keys: resolvedVenueTotalInfo.availableVenueRowKeys || [],
      normalized_venue_keys: resolvedVenueTotalInfo.normalizedVenueKeys || [],
      cache_key: cacheKey
    }
  };
  if (!debug) setCachedMusicVenuePhotoAggregation(cacheKey, payload);
  return { ...payload, generated, cache: { hit: false, key: cacheKey } };
}

function buildMusicVenuePhotoAggregationResponse(payload, query = {}) {
  const page = getPageNumber(query.page);
  const limit = getMusicVenuePhotoLimit(query.limit);
  const photos = Array.isArray(payload.allPhotos) ? payload.allPhotos : [];
  const total = photos.length;
  const totalPages = total ? Math.ceil(total / limit) : 0;
  const safePage = Math.min(Math.max(1, page), Math.max(totalPages, 1));
  const offset = (safePage - 1) * limit;
  const returned = photos.slice(offset, offset + limit);
  const response = buildAdminResponse({
    ok: true,
    route: payload.route,
    section: 'music',
    type: 'venue_photo_aggregation',
    generated: payload.generated,
    readOnly: true,
    databaseMutated: false,
    venue: payload.venue,
    summary: {
      ...payload.summary,
      venue_total_photos: toIntegerCount(payload.summary && payload.summary.venue_total_photos),
      aggregated_photo_count: total,
      photo_count: total,
      returned_count: returned.length
    },
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      has_more: safePage < totalPages,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1 && totalPages > 0,
      next_page: safePage < totalPages ? safePage + 1 : null
    },
    photos: returned,
    warnings: payload.warnings || [],
    cache: payload.cache ? { hit: !!payload.cache.hit } : { hit: false }
  });
  if (query.debug === '1') response.debug = payload.debug || {};
  return response;
}

async function handleMusicVenuePhotosRequest(req, res) {
  try {
    if (!String(process.env.DATABASE_URL || '').trim()) {
      throw new Error('Missing DATABASE_URL environment variable.');
    }
    const venueRow = await findMusicVenueForPhotoAggregation(req.params.venue_id);
    if (!venueRow) {
      const generated = new Date();
      return res.status(404).json(buildAdminResponse({
        ok: false,
        route: MUSIC_VENUE_PHOTOS_ROUTE,
        section: 'music',
        type: 'venue_photo_aggregation',
        generated,
        readOnly: true,
        databaseMutated: false,
        error: 'MUSIC_VENUE_NOT_FOUND',
        message: 'Music venue not found.',
        venue: { venue_id: String(req.params.venue_id || '').trim(), venue_name: '', slug: slugifyMusicBandId(req.params.venue_id) },
        summary: { linked_show_count: 0, album_count: 0, available_album_count: 0, venue_total_photos: 0, aggregated_photo_count: 0, photo_count: 0, returned_count: 0 },
        pagination: { page: getPageNumber(req.query.page), limit: getMusicVenuePhotoLimit(req.query.limit), has_more: false },
        photos: [],
        warnings: []
      }));
    }
    const payload = await buildMusicVenuePhotoAggregationPayload(venueRow, req.query || {});
    return res.json(buildMusicVenuePhotoAggregationResponse(payload, req.query || {}));
  } catch (err) {
    return res.status(500).json(buildApiError(MUSIC_VENUE_PHOTOS_ROUTE, err, { source: 'PostgreSQL:music_venues+music_shows', error: 'MUSIC_VENUE_PHOTOS_ERROR' }));
  }
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

async function ensureMusicShowResolverColumns(warnings) {
  if (!String(process.env.DATABASE_URL || '').trim()) return { ok: false, skipped: true, reason: 'DATABASE_URL_NOT_CONFIGURED' };

  try {
    await dbPool.query('ALTER TABLE IF EXISTS music_shows ADD COLUMN IF NOT EXISTS show_url TEXT');
    await dbPool.query("ALTER TABLE IF EXISTS music_shows ADD COLUMN IF NOT EXISTS smug_albums JSONB DEFAULT '[]'::jsonb");
    return { ok: true, columnsEnsured: ['music_shows.show_url', 'music_shows.smug_albums'] };
  } catch (err) {
    const message = `Unable to ensure Music show resolver columns: ${err && err.message ? err.message : String(err)}`;
    if (Array.isArray(warnings)) warnings.push(message);
    else console.warn(message);
    return { ok: false, error: err && err.message ? err.message : String(err), columnsEnsured: [] };
  }
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
         count(*) FILTER (WHERE trim(coalesce(smug_sync_status, '')) = '' OR lower(trim(coalesce(smug_sync_status, ''))) IN ('error', 'unresolved', 'no_source_url', 'no_image_key', 'no_album_key', 'skipped_logo_source', 'skipped_venue_logo_source', 'raw_photo_source_no_album_context'))::int AS unresolved_shows,
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
        `SELECT show_id, name, date, poster, show_url, raw_sheet->>'show_url' AS raw_show_url, raw_sheet->>'poster_url' AS poster_url, smug_sync_status, smug_sync_error
         FROM music_shows
         WHERE trim(coalesce(smug_sync_status, '')) = ''
            OR lower(trim(coalesce(smug_sync_status, ''))) IN ('error', 'unresolved', 'no_source_url', 'no_image_key', 'no_album_key', 'skipped_logo_source', 'skipped_venue_logo_source', 'raw_photo_source_no_album_context')
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
         WHERE trim(coalesce(show_url, '')) = ''
           AND trim(coalesce(raw_sheet->>'show_url', '')) = ''
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
const MUSIC_SMUGMUG_HEALTH_ROUTE = '/api/admin/diagnostics/music/smugmug/health';

function getMusicSmugMugHealthLimit(value, fallback, max) {
  const number = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(1, number));
}

function isMusicSmugMugOAuthConfigured() {
  return [
    'SMUG_ACCESS_TOKEN',
    'SMUG_OAUTH_TOKEN',
    'SMUG_OAUTH_ACCESS_TOKEN',
    'SMUG_REFRESH_TOKEN',
    'SMUG_ACCESS_TOKEN_SECRET',
    'SMUG_API_SECRET'
  ].some((key) => !!String(process.env[key] || '').trim());
}

function buildMusicSmugMugHealthConfig(smugConfig) {
  return {
    configured: !!(smugConfig && smugConfig.configured),
    apiKeyConfigured: !!SMUG_API_KEY,
    nicknamePresent: !!SMUG_NICKNAME_ENV,
    oauthConfigured: isMusicSmugMugOAuthConfigured(),
    tokenConfigured: isMusicSmugMugOAuthConfigured(),
    helperAvailable: typeof fetchSmugJson === 'function',
    requestConcurrency: SMUG_REQUEST_CONCURRENCY,
    missing: smugConfig && Array.isArray(smugConfig.missing) ? smugConfig.missing : []
  };
}

function buildMusicSmugMugHealthAlbumLinkCondition(columns, alias = '') {
  const tablePrefix = alias ? `${alias}.` : '';
  const predicates = [];
  if (columns && columns.has('album_id')) predicates.push(`trim(coalesce(${tablePrefix}album_id, '')) <> ''`);
  if (columns && columns.has('gallery_id')) predicates.push(`trim(coalesce(${tablePrefix}gallery_id, '')) <> ''`);
  if (columns && columns.has('smug_albums')) {
    predicates.push(`jsonb_typeof(${tablePrefix}smug_albums) = 'array' AND jsonb_array_length(${tablePrefix}smug_albums) > 0`);
  }
  return predicates.length ? `(${predicates.join(' OR ')})` : 'false';
}

function buildMusicSmugMugHealthShowSelect(columns, alias = '') {
  const tablePrefix = alias ? `${alias}.` : '';
  return [
    columns.has('show_id') ? `${tablePrefix}show_id AS show_id` : 'NULL AS show_id',
    columns.has('name') ? `${tablePrefix}name AS name` : 'NULL AS name',
    columns.has('date') ? `${tablePrefix}date AS date` : 'NULL AS date',
    columns.has('venue_id') ? `${tablePrefix}venue_id AS venue_id` : 'NULL AS venue_id',
    columns.has('album_id') ? `${tablePrefix}album_id AS album_id` : 'NULL AS album_id',
    columns.has('gallery_id') ? `${tablePrefix}gallery_id AS gallery_id` : 'NULL AS gallery_id',
    columns.has('smug_sync_status') ? `${tablePrefix}smug_sync_status AS smug_sync_status` : 'NULL AS smug_sync_status',
    columns.has('smug_last_synced_at') ? `${tablePrefix}smug_last_synced_at AS smug_last_synced_at` : 'NULL AS smug_last_synced_at'
  ].join(', ');
}

function getMusicSmugMugHealthShowOrderBy(columns, alias = '') {
  const tablePrefix = alias ? `${alias}.` : '';
  if (columns.has('show_date') && columns.has('show_id')) return `${tablePrefix}show_date DESC NULLS LAST, ${tablePrefix}show_id DESC NULLS LAST`;
  if (columns.has('show_date')) return `${tablePrefix}show_date DESC NULLS LAST`;
  if (columns.has('show_id')) return `${tablePrefix}show_id DESC NULLS LAST`;
  return '1';
}

function buildMusicSmugMugHealthAlbumIdExpression(columns, alias = '') {
  const tablePrefix = alias ? `${alias}.` : '';
  if (columns.has('album_id') && columns.has('gallery_id')) return `coalesce(nullif(${tablePrefix}album_id, ''), nullif(${tablePrefix}gallery_id, ''))`;
  if (columns.has('album_id')) return `nullif(${tablePrefix}album_id, '')`;
  if (columns.has('gallery_id')) return `nullif(${tablePrefix}gallery_id, '')`;
  return 'NULL';
}

async function buildMusicSmugMugHealthResponse(query = {}) {
  const generated = new Date();
  const showLimit = getMusicSmugMugHealthLimit(query.show_limit, 25, 100);
  const albumLimit = getMusicSmugMugHealthLimit(query.album_limit, 10, 25);
  const photoLimit = getMusicSmugMugHealthLimit(query.photo_limit, 25, 50);
  const venueLimit = getMusicSmugMugHealthLimit(query.venue_limit, 25, 100);
  const debug = query.debug === '1' || query.debug === 'true';
  const warnings = [];
  const smugConfig = getSmugMugConfigDiagnostics();

  const response = buildAdminResponse({
    route: MUSIC_SMUGMUG_HEALTH_ROUTE,
    generated,
    source: 'postgres+smugmug',
    section: 'music',
    type: 'smugmug_health_diagnostic',
    readOnly: true,
    databaseMutated: false,
    config: buildMusicSmugMugHealthConfig(smugConfig),
    summary: {
      database_connected: false,
      music_show_count: 0,
      shows_with_album_links: 0,
      shows_missing_album_links: 0,
      music_people_count: 0,
      caption_albums_sampled: 0,
      caption_photos_sampled: 0,
      caption_matched_people_count: 0,
      caption_unmatched_token_count: 0,
      music_venue_count: 0,
      venues_with_linked_shows: 0,
      venue_album_links_sampled: 0
    },
    sections: {
      shows: {
        missing_album_links: [],
        sample_linked_shows: []
      },
      people: {
        captionDiagnosticRoute: MUSIC_PEOPLE_CAPTION_INDEX_ROUTE,
        captionScanSampled: false,
        sample_matches: [],
        sample_unmatched_caption_tokens: []
      },
      venues: {
        sample_venue_album_totals: [],
        venues_with_linked_shows_but_no_album_ids: []
      }
    },
    warnings,
    limits: {
      show_limit: showLimit,
      album_limit: albumLimit,
      photo_limit: photoLimit,
      venue_limit: venueLimit,
      debug
    }
  });

  if (!smugConfig.configured) warnings.push(`SmugMug is not configured; missing ${smugConfig.missing.join(', ')}.`);
  (smugConfig.warnings || []).forEach((warning) => warnings.push(`SmugMug: ${warning}`));

  if (!String(process.env.DATABASE_URL || '').trim()) {
    response.ok = false;
    warnings.push('DATABASE_URL is not configured; PostgreSQL-backed SmugMug health checks were skipped.');
    response.warnings = warnings;
    return response;
  }

  try {
    await dbPool.query('SELECT 1');
    response.summary.database_connected = true;
  } catch (err) {
    response.ok = false;
    warnings.push(`Database disconnected: ${getSafeErrorMessage(err)}`);
    response.warnings = warnings;
    return response;
  }

  try {
    const tableNames = ['music_shows', 'music_people', 'music_venues'];
    const existingTables = await getExistingPublicTables(tableNames);
    const columnsByTable = await getExistingPublicColumns(tableNames);
    const showColumns = getSmugMusicTableColumns(columnsByTable, 'music_shows');
    const peopleColumns = getSmugMusicTableColumns(columnsByTable, 'music_people');
    const venueColumns = getSmugMusicTableColumns(columnsByTable, 'music_venues');

    const snapshotTables = await getExistingPublicTables(SMUG_MUSIC_SNAPSHOT_TABLES);
    const snapshotColumns = await getExistingPublicColumns(SMUG_MUSIC_SNAPSHOT_TABLES);
    response.config.snapshotFieldsPresent = buildSmugMusicSnapshotFieldStatus(snapshotTables, snapshotColumns).present;

    if (!existingTables.has('music_shows')) {
      warnings.push('Missing table for Music SmugMug show health: music_shows');
    } else {
      const albumLinkCondition = buildMusicSmugMugHealthAlbumLinkCondition(showColumns);
      const showSelect = buildMusicSmugMugHealthShowSelect(showColumns);
      const showOrderBy = getMusicSmugMugHealthShowOrderBy(showColumns);
      const showCountResult = await dbPool.query(`
        SELECT
          count(*)::int AS total_shows,
          count(*) FILTER (WHERE ${albumLinkCondition})::int AS shows_with_album_links,
          count(*) FILTER (WHERE NOT ${albumLinkCondition})::int AS shows_missing_album_links
        FROM music_shows
      `);
      const showCounts = firstDiagnosticRow(showCountResult);
      response.summary.music_show_count = toIntegerCount(showCounts.total_shows);
      response.summary.shows_with_album_links = toIntegerCount(showCounts.shows_with_album_links);
      response.summary.shows_missing_album_links = toIntegerCount(showCounts.shows_missing_album_links);

      response.sections.shows.sample_linked_shows = await runSmugMusicRowsQuery(
        warnings,
        'Music SmugMug linked show samples',
        `SELECT ${showSelect}
         FROM music_shows
         WHERE ${albumLinkCondition}
         ORDER BY ${showOrderBy}
         LIMIT $1`,
        [showLimit]
      );
      response.sections.shows.missing_album_links = await runSmugMusicRowsQuery(
        warnings,
        'Music SmugMug missing show album samples',
        `SELECT ${showSelect}
         FROM music_shows
         WHERE NOT ${albumLinkCondition}
         ORDER BY ${showOrderBy}
         LIMIT $1`,
        [showLimit]
      );
      if (response.summary.shows_missing_album_links > 0) warnings.push(`${response.summary.shows_missing_album_links} Music shows are missing album_id/gallery_id/smug_albums links.`);
      if (response.summary.shows_missing_album_links > response.sections.shows.missing_album_links.length) warnings.push('Music show missing album-link samples were capped by show_limit.');
    }

    if (!existingTables.has('music_people')) {
      warnings.push('Missing table for Music People caption health: music_people');
    } else {
      const personIdColumn = peopleColumns.has('person_id') ? 'person_id' : (peopleColumns.has('id') ? 'id' : null);
      const personNameColumn = peopleColumns.has('name') ? 'name' : null;
      if (personIdColumn || personNameColumn) {
        const peopleCount = await runSmugMusicCountQuery(warnings, 'Music People count', `SELECT count(*)::int AS count FROM music_people`);
        response.summary.music_people_count = peopleCount;
      } else {
        warnings.push('Missing expected Music People identity columns for caption health.');
      }
    }

    if (debug) {
      try {
        const captionResponse = await buildMusicPeopleCaptionIndexDiagnosticResponse({
          page: 1,
          limit: Math.min(showLimit, 25),
          album_limit: albumLimit,
          photo_limit: photoLimit
        });
        const captionSummary = captionResponse.summary || {};
        response.sections.people.captionScanSampled = true;
        response.summary.caption_albums_sampled = toIntegerCount(captionSummary.total_albums_inspected);
        response.summary.caption_photos_sampled = toIntegerCount(captionSummary.total_photos_inspected);
        response.summary.caption_matched_people_count = toIntegerCount(captionSummary.people_with_indexed_photo_matches);
        response.summary.caption_unmatched_token_count = toIntegerCount(captionSummary.unmatched_caption_tokens);
        response.sections.people.sample_matches = Array.isArray(captionResponse.matches) ? captionResponse.matches.slice(0, 10) : [];
        response.sections.people.sample_unmatched_caption_tokens = Array.isArray(captionResponse.unmatched) ? captionResponse.unmatched.slice(0, 10) : [];
        if (captionSummary.scan_limited) warnings.push('Music People caption scan reached album_limit; use caption-index route for a deeper diagnostic.');
        if (response.summary.caption_unmatched_token_count > 0) warnings.push(`${response.summary.caption_unmatched_token_count} sampled caption tokens did not map to Music People records.`);
      } catch (err) {
        warnings.push(`Unable to sample Music People caption index: ${getSafeErrorMessage(err)}`);
      }
    } else {
      response.sections.people.captionScanSampled = false;
      response.sections.people.captionScanNote = `Pass debug=1 for a capped caption sample, or use ${MUSIC_PEOPLE_CAPTION_INDEX_ROUTE} for the deeper read-only diagnostic.`;
    }

    if (!existingTables.has('music_venues')) {
      warnings.push('Missing table for Music venue aggregation health: music_venues');
    } else {
      response.summary.music_venue_count = await runSmugMusicCountQuery(warnings, 'Music venue count', `SELECT count(*)::int AS count FROM music_venues`);
      const canJoinVenues = existingTables.has('music_shows') && venueColumns.has('venue_key') && showColumns.has('venue_id');
      if (!canJoinVenues) {
        warnings.push('Music venue aggregation health could not join venues to shows; missing music_venues.venue_key or music_shows.venue_id.');
      } else {
        const albumLinkCondition = buildMusicSmugMugHealthAlbumLinkCondition(showColumns, 'ms');
        const albumIdExpression = buildMusicSmugMugHealthAlbumIdExpression(showColumns, 'ms');
        const venuesWithShowsResult = await dbPool.query(`
          SELECT count(*)::int AS count
          FROM (
            SELECT mv.venue_key
            FROM music_venues mv
            JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
            WHERE trim(coalesce(mv.venue_key, '')) <> ''
            GROUP BY mv.venue_key
          ) linked
        `);
        response.summary.venues_with_linked_shows = toIntegerCount(venuesWithShowsResult.rows && venuesWithShowsResult.rows[0] && venuesWithShowsResult.rows[0].count);

        response.sections.venues.sample_venue_album_totals = await runSmugMusicRowsQuery(
          warnings,
          'Music venue album link samples',
          `SELECT
             mv.venue_key AS venue_id,
             mv.venue AS venue_name,
             count(ms.*)::int AS linked_show_count,
             count(*) FILTER (WHERE ${albumLinkCondition})::int AS album_link_count,
             array_remove(array_agg(DISTINCT ${albumIdExpression}), NULL) AS sample_album_ids
           FROM music_venues mv
           JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
           WHERE trim(coalesce(mv.venue_key, '')) <> ''
           GROUP BY mv.venue_key, mv.venue
           ORDER BY album_link_count DESC, linked_show_count DESC, mv.venue ASC
           LIMIT $1`,
          [venueLimit]
        );
        response.summary.venue_album_links_sampled = response.sections.venues.sample_venue_album_totals.reduce((sum, row) => sum + toIntegerCount(row.album_link_count), 0);

        response.sections.venues.venues_with_linked_shows_but_no_album_ids = await runSmugMusicRowsQuery(
          warnings,
          'Music venues with linked shows but no album IDs',
          `SELECT
             mv.venue_key AS venue_id,
             mv.venue AS venue_name,
             count(ms.*)::int AS linked_show_count,
             count(*) FILTER (WHERE ${albumLinkCondition})::int AS album_link_count
           FROM music_venues mv
           JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
           WHERE trim(coalesce(mv.venue_key, '')) <> ''
           GROUP BY mv.venue_key, mv.venue
           HAVING count(ms.*) > 0 AND count(*) FILTER (WHERE ${albumLinkCondition}) = 0
           ORDER BY linked_show_count DESC, mv.venue ASC
           LIMIT $1`,
          [venueLimit]
        );
        if (response.sections.venues.venues_with_linked_shows_but_no_album_ids.length) warnings.push(`${response.sections.venues.venues_with_linked_shows_but_no_album_ids.length} sampled venues have linked shows but no usable album IDs.`);
      }
    }
  } catch (err) {
    response.ok = false;
    warnings.push(`Unable to build Music SmugMug health summary: ${getSafeErrorMessage(err)}`);
  }

  response.warnings = warnings;
  return response;
}

async function handleMusicSmugMugHealthRequest(req, res) {
  try {
    return res.status(200).json(await buildMusicSmugMugHealthResponse(req.query || {}));
  } catch (err) {
    return res.status(500).json(buildAdminError(MUSIC_SMUGMUG_HEALTH_ROUTE, err, {
      source: 'postgres+smugmug',
      section: 'music',
      type: 'smugmug_health_diagnostic',
      error: 'MUSIC_SMUGMUG_HEALTH_ERROR',
      readOnly: true,
      databaseMutated: false
    }));
  }
}
const MUSIC_SMUGMUG_EXCEPTIONS_ROUTE = '/api/admin/diagnostics/music/smugmug/exceptions';

function getMusicSmugMugExceptionLimit(value, fallback, max) {
  return getMusicSmugMugHealthLimit(value, fallback, max);
}

function buildMusicSmugMugExceptionShowRef(row) {
  const bands = getMusicDataAuditArray(row && row.bands)
    .map((band) => {
      if (typeof band === 'string') return band.trim();
      return String(band && (band.band || band.name || band.band_name || '') || '').trim();
    })
    .filter(Boolean);
  return {
    show_id: row && row.show_id != null ? row.show_id : null,
    show_key: String(row && (row.show_url || formatMusicShowUrlDateKey(row.date) || row.show_id || '') || '').trim() || null,
    name: String(row && row.name || '').trim(),
    date: String(row && row.date || '').trim(),
    venue_id: String(row && row.venue_id || '').trim() || null,
    bands,
    album_id: String(row && row.album_id || '').trim() || null,
    gallery_id: String(row && row.gallery_id || '').trim() || null,
    smug_sync_status: String(row && row.smug_sync_status || '').trim() || null
  };
}

function getMusicSmugMugExceptionAlbumRefsFromRow(row) {
  const refs = [];
  const add = (value, source) => {
    const clean = String(value || '').trim();
    if (clean) refs.push({ album_id: clean, source });
  };
  add(row && row.album_id, 'album_id');
  add(row && row.gallery_id, 'gallery_id');
  const albums = Array.isArray(row && row.smug_albums) ? row.smug_albums : getMusicDataAuditArray(row && row.smug_albums);
  albums.forEach((album, index) => add(getMusicPeopleArchiveAlbumKey(album), `smug_albums[${index}]`));
  return refs;
}

function isMusicSmugMugExceptionAlbumIdSuspicious(value) {
  const clean = String(value || '').trim();
  if (!clean) return false;
  if (/^https?:\/\//i.test(clean)) return true;
  if (/[\s\/\\]/.test(clean)) return true;
  return !/^[A-Za-z0-9_-]+$/.test(clean);
}

function buildMusicSmugMugSuspiciousAlbumReason(row) {
  const reasons = [];
  const refs = getMusicSmugMugExceptionAlbumRefsFromRow(row);
  refs.forEach((ref) => {
    if (isMusicSmugMugExceptionAlbumIdSuspicious(ref.album_id)) reasons.push(`${ref.source} has suspicious album id format`);
  });

  if (row && Object.prototype.hasOwnProperty.call(row, 'smug_albums')) {
    const rawAlbums = row.smug_albums;
    if (rawAlbums != null && !Array.isArray(rawAlbums)) reasons.push('smug_albums is not an array');
    if (Array.isArray(rawAlbums)) {
      const status = String(row.smug_sync_status || '').trim().toLowerCase();
      if (rawAlbums.length === 0 && !String(row.album_id || row.gallery_id || '').trim() && ['resolved', 'partial', 'synced'].includes(status)) {
        reasons.push('smug_albums is empty while show is marked synced/resolved');
      }
      rawAlbums.forEach((album, index) => {
        if (!album || typeof album !== 'object' || Array.isArray(album)) reasons.push(`smug_albums[${index}] is not an object`);
        else {
          const albumKey = getMusicPeopleArchiveAlbumKey(album);
          if (!albumKey) reasons.push(`smug_albums[${index}] has no album_id/gallery_id`);
          else if (isMusicSmugMugExceptionAlbumIdSuspicious(albumKey)) reasons.push(`smug_albums[${index}] has suspicious album id format`);
        }
      });
    }
  }

  const seen = new Map();
  refs.forEach((ref) => {
    const key = ref.album_id.toLowerCase();
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(ref.source);
  });
  seen.forEach((sources, key) => {
    if (sources.length > 1) reasons.push(`duplicate album id ${key} appears in ${sources.join(', ')}`);
  });

  return Array.from(new Set(reasons));
}

function normalizeMusicSmugMugExceptionName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildMusicSmugMugExceptionResponseShell(generated, limits) {
  return buildAdminResponse({
    route: MUSIC_SMUGMUG_EXCEPTIONS_ROUTE,
    generated,
    source: 'postgres+smugmug',
    section: 'music',
    type: 'smugmug_relationship_exceptions',
    readOnly: true,
    databaseMutated: false,
    summary: {
      shows_missing_album_links: 0,
      shows_with_suspicious_album_fields: 0,
      venues_with_no_linked_shows: 0,
      venues_with_linked_shows_but_no_album_ids: 0,
      shows_with_unresolved_venue_refs: 0,
      unmatched_caption_token_count: 0,
      duplicate_people_name_count: 0,
      duplicate_venue_key_count: 0,
      duplicate_album_id_warning_count: 0
    },
    exceptions: {
      shows_missing_album_links: [],
      shows_with_suspicious_album_fields: [],
      venues_with_no_linked_shows: [],
      venues_with_linked_shows_but_no_album_ids: [],
      shows_with_unresolved_venue_refs: [],
      people_caption_unmatched_tokens: [],
      duplicate_people_names: [],
      duplicate_venue_keys: [],
      duplicate_album_id_warnings: []
    },
    warnings: [],
    limits
  });
}

async function buildMusicSmugMugExceptionsResponse(query = {}) {
  const generated = new Date();
  const showLimit = getMusicSmugMugExceptionLimit(query.show_limit, 100, 500);
  const venueLimit = getMusicSmugMugExceptionLimit(query.venue_limit, 100, 500);
  const albumLimit = getMusicSmugMugExceptionLimit(query.album_limit, 25, 75);
  const photoLimit = getMusicSmugMugExceptionLimit(query.photo_limit, 25, 50);
  const tokenLimit = getMusicSmugMugExceptionLimit(query.token_limit, 100, 500);
  const debug = query.debug === '1' || query.debug === 'true';
  const limits = { show_limit: showLimit, venue_limit: venueLimit, album_limit: albumLimit, photo_limit: photoLimit, token_limit: tokenLimit, debug };
  const response = buildMusicSmugMugExceptionResponseShell(generated, limits);
  const warnings = response.warnings;
  const smugConfig = getSmugMugConfigDiagnostics();

  if (!smugConfig.configured) warnings.push(`SmugMug is not configured; caption exception sampling is limited. Missing ${smugConfig.missing.join(', ')}.`);
  (smugConfig.warnings || []).forEach((warning) => warnings.push(`SmugMug: ${warning}`));

  if (!String(process.env.DATABASE_URL || '').trim()) {
    response.ok = false;
    warnings.push('DATABASE_URL is not configured; Music SmugMug relationship exceptions could not be checked.');
    return response;
  }

  try {
    await dbPool.query('SELECT 1');
  } catch (err) {
    response.ok = false;
    warnings.push(`Database disconnected: ${getSafeErrorMessage(err)}`);
    return response;
  }

  try {
    const tableNames = ['music_shows', 'music_people', 'music_venues'];
    const existingTables = await getExistingPublicTables(tableNames);
    const columnsByTable = await getExistingPublicColumns(tableNames);
    const showColumns = getSmugMusicTableColumns(columnsByTable, 'music_shows');
    const peopleColumns = getSmugMusicTableColumns(columnsByTable, 'music_people');
    const venueColumns = getSmugMusicTableColumns(columnsByTable, 'music_venues');

    if (!existingTables.has('music_shows')) {
      warnings.push('Missing table: music_shows');
    } else {
      const albumLinkCondition = buildMusicSmugMugHealthAlbumLinkCondition(showColumns);
      const showSelect = [
        buildMusicSmugMugHealthShowSelect(showColumns),
        showColumns.has('show_url') ? 'show_url' : 'NULL AS show_url',
        showColumns.has('bands') ? 'bands' : "'[]'::jsonb AS bands",
        showColumns.has('smug_albums') ? 'smug_albums' : "'[]'::jsonb AS smug_albums",
        showColumns.has('photo_count') ? 'photo_count' : '0::int AS photo_count'
      ].join(', ');
      const showOrderBy = getMusicSmugMugHealthShowOrderBy(showColumns);
      const missingCountResult = await dbPool.query(`SELECT count(*)::int AS count FROM music_shows WHERE NOT ${albumLinkCondition}`);
      response.summary.shows_missing_album_links = toIntegerCount(missingCountResult.rows && missingCountResult.rows[0] && missingCountResult.rows[0].count);
      const missingRows = await dbPool.query(`
        SELECT ${showSelect}
        FROM music_shows
        WHERE NOT ${albumLinkCondition}
        ORDER BY ${showOrderBy}
        LIMIT $1
      `, [showLimit]);
      response.exceptions.shows_missing_album_links = diagnosticRows(missingRows).map((row) => ({
        ...buildMusicSmugMugExceptionShowRef(row),
        reason: 'No usable album_id, gallery_id, or smug_albums entry.'
      }));
      if (response.summary.shows_missing_album_links > response.exceptions.shows_missing_album_links.length) warnings.push('show_limit reached; shows_missing_album_links results are sampled.');

      const candidateRows = await dbPool.query(`
        SELECT ${showSelect}
        FROM music_shows
        WHERE ${albumLinkCondition}
           OR ${showColumns.has('smug_albums') ? 'smug_albums IS NOT NULL' : 'false'}
           OR ${showColumns.has('smug_sync_status') ? "trim(coalesce(smug_sync_status, '')) <> ''" : 'false'}
        ORDER BY ${showOrderBy}
        LIMIT $1
      `, [showLimit]);
      response.exceptions.shows_with_suspicious_album_fields = diagnosticRows(candidateRows)
        .map((row) => {
          const reasons = buildMusicSmugMugSuspiciousAlbumReason(row);
          return reasons.length ? { ...buildMusicSmugMugExceptionShowRef(row), reasons, reason: reasons.join('; ') } : null;
        })
        .filter(Boolean);
      response.summary.shows_with_suspicious_album_fields = response.exceptions.shows_with_suspicious_album_fields.length;
      if (response.exceptions.shows_with_suspicious_album_fields.length >= showLimit) warnings.push('show_limit reached; suspicious album field results may be sampled.');

      const albumRefParts = [];
      const showRefSql = [
        showColumns.has('show_id') ? 'show_id::text' : 'NULL::text',
        showColumns.has('name') ? 'name' : 'NULL::text',
        showColumns.has('date') ? 'date' : 'NULL::text'
      ];
      if (showColumns.has('album_id')) {
        albumRefParts.push(`SELECT ${showRefSql[0]} AS show_id, ${showRefSql[1]} AS name, ${showRefSql[2]} AS date, trim(album_id) AS album_id, 'album_id' AS source FROM music_shows WHERE trim(coalesce(album_id, '')) <> ''`);
      }
      if (showColumns.has('gallery_id')) {
        albumRefParts.push(`SELECT ${showRefSql[0]} AS show_id, ${showRefSql[1]} AS name, ${showRefSql[2]} AS date, trim(gallery_id) AS album_id, 'gallery_id' AS source FROM music_shows WHERE trim(coalesce(gallery_id, '')) <> ''`);
      }
      if (showColumns.has('smug_albums')) {
        albumRefParts.push(`SELECT ${showRefSql[0]} AS show_id, ${showRefSql[1]} AS name, ${showRefSql[2]} AS date, trim(coalesce(album->>'album_id', album->>'albumId', album->>'gallery_id', album->>'galleryId', '')) AS album_id, 'smug_albums' AS source FROM music_shows CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(smug_albums) = 'array' THEN smug_albums ELSE '[]'::jsonb END) album`);
      }
      if (albumRefParts.length) {
        const duplicateAlbumRows = await dbPool.query(`
          WITH album_refs AS (${albumRefParts.join(' UNION ALL ')}),
          clean_refs AS (
            SELECT album_id, source, show_id, name, date, coalesce(show_id, name || '|' || date, album_id) AS show_ref
            FROM album_refs
            WHERE trim(coalesce(album_id, '')) <> ''
          )
          SELECT album_id,
                 count(DISTINCT show_ref)::int AS show_count,
                 jsonb_agg(jsonb_build_object('show_id', show_id, 'name', name, 'date', date, 'source', source) ORDER BY date DESC NULLS LAST, show_id DESC NULLS LAST) AS shows
          FROM clean_refs
          GROUP BY album_id
          HAVING count(DISTINCT show_ref) > 1
          ORDER BY show_count DESC, album_id ASC
          LIMIT $1
        `, [Math.min(tokenLimit, 500)]);
        response.exceptions.duplicate_album_id_warnings = diagnosticRows(duplicateAlbumRows).map((row) => ({
          album_id: row.album_id,
          show_count: toIntegerCount(row.show_count),
          shows: Array.isArray(row.shows) ? row.shows.slice(0, 10) : [],
          reason: 'Album ID appears on more than one Music Show. This may be valid for shared/multi-band albums, so it is a warning only.'
        }));
        response.summary.duplicate_album_id_warning_count = response.exceptions.duplicate_album_id_warnings.length;
        if (response.exceptions.duplicate_album_id_warnings.length >= Math.min(tokenLimit, 500)) warnings.push('token_limit reached; duplicate album ID warnings are sampled.');
      }
    }

    if (existingTables.has('music_venues')) {
      if (existingTables.has('music_shows') && venueColumns.has('venue_key') && showColumns.has('venue_id')) {
        const albumLinkCondition = buildMusicSmugMugHealthAlbumLinkCondition(showColumns, 'ms');
        const noLinkedCount = await dbPool.query(`
          SELECT count(*)::int AS count FROM (
            SELECT mv.venue_key
            FROM music_venues mv
            LEFT JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
            WHERE trim(coalesce(mv.venue_key, '')) <> ''
            GROUP BY mv.venue_key
            HAVING count(ms.*) = 0
          ) rows
        `);
        response.summary.venues_with_no_linked_shows = toIntegerCount(noLinkedCount.rows && noLinkedCount.rows[0] && noLinkedCount.rows[0].count);
        const noLinkedRows = await dbPool.query(`
          SELECT mv.venue_key AS venue_id, mv.venue AS venue_name, 0::int AS linked_show_count, 0::int AS usable_album_count
          FROM music_venues mv
          LEFT JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
          WHERE trim(coalesce(mv.venue_key, '')) <> ''
          GROUP BY mv.venue_key, mv.venue
          HAVING count(ms.*) = 0
          ORDER BY mv.venue ASC NULLS LAST, mv.venue_key ASC
          LIMIT $1
        `, [venueLimit]);
        response.exceptions.venues_with_no_linked_shows = diagnosticRows(noLinkedRows).map((row) => ({ ...row, reason: 'Venue has no linked Music Shows by venue_id.' }));
        if (response.summary.venues_with_no_linked_shows > response.exceptions.venues_with_no_linked_shows.length) warnings.push('venue_limit reached; venues_with_no_linked_shows results are sampled.');

        const linkedNoAlbumsCount = await dbPool.query(`
          SELECT count(*)::int AS count FROM (
            SELECT mv.venue_key
            FROM music_venues mv
            JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
            WHERE trim(coalesce(mv.venue_key, '')) <> ''
            GROUP BY mv.venue_key
            HAVING count(ms.*) > 0 AND count(*) FILTER (WHERE ${albumLinkCondition}) = 0
          ) rows
        `);
        response.summary.venues_with_linked_shows_but_no_album_ids = toIntegerCount(linkedNoAlbumsCount.rows && linkedNoAlbumsCount.rows[0] && linkedNoAlbumsCount.rows[0].count);
        const linkedNoAlbumsRows = await dbPool.query(`
          SELECT mv.venue_key AS venue_id, mv.venue AS venue_name, count(ms.*)::int AS linked_show_count, count(*) FILTER (WHERE ${albumLinkCondition})::int AS usable_album_count
          FROM music_venues mv
          JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
          WHERE trim(coalesce(mv.venue_key, '')) <> ''
          GROUP BY mv.venue_key, mv.venue
          HAVING count(ms.*) > 0 AND count(*) FILTER (WHERE ${albumLinkCondition}) = 0
          ORDER BY linked_show_count DESC, mv.venue ASC NULLS LAST
          LIMIT $1
        `, [venueLimit]);
        response.exceptions.venues_with_linked_shows_but_no_album_ids = diagnosticRows(linkedNoAlbumsRows).map((row) => ({ ...row, reason: 'Venue has linked Music Shows, but none have usable album_id/gallery_id/smug_albums.' }));
        if (response.summary.venues_with_linked_shows_but_no_album_ids > response.exceptions.venues_with_linked_shows_but_no_album_ids.length) warnings.push('venue_limit reached; venues_with_linked_shows_but_no_album_ids results are sampled.');

        const unresolvedVenueCount = await dbPool.query(`
          SELECT count(*)::int AS count
          FROM music_shows ms
          LEFT JOIN music_venues mv ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
          WHERE trim(coalesce(ms.venue_id, '')) <> ''
            AND mv.venue_key IS NULL
        `);
        response.summary.shows_with_unresolved_venue_refs = toIntegerCount(unresolvedVenueCount.rows && unresolvedVenueCount.rows[0] && unresolvedVenueCount.rows[0].count);
        const unresolvedVenueRows = await dbPool.query(`
          SELECT ${buildMusicSmugMugHealthShowSelect(showColumns, 'ms')}, ${showColumns.has('show_url') ? 'ms.show_url AS show_url' : 'NULL AS show_url'}, ${showColumns.has('bands') ? 'ms.bands AS bands' : "'[]'::jsonb AS bands"}
          FROM music_shows ms
          LEFT JOIN music_venues mv ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
          WHERE trim(coalesce(ms.venue_id, '')) <> ''
            AND mv.venue_key IS NULL
          ORDER BY ${getMusicSmugMugHealthShowOrderBy(showColumns, 'ms')}
          LIMIT $1
        `, [showLimit]);
        response.exceptions.shows_with_unresolved_venue_refs = diagnosticRows(unresolvedVenueRows).map((row) => ({
          ...buildMusicSmugMugExceptionShowRef(row),
          reason: 'Show venue_id does not resolve to music_venues.venue_key.'
        }));
        if (response.summary.shows_with_unresolved_venue_refs > response.exceptions.shows_with_unresolved_venue_refs.length) warnings.push('show_limit reached; shows_with_unresolved_venue_refs results are sampled.');
      } else {
        warnings.push('Venue relationship exceptions skipped; missing music_shows.venue_id or music_venues.venue_key.');
      }

      if (venueColumns.has('venue_key')) {
        const duplicateVenueRows = await dbPool.query(`
          SELECT lower(trim(coalesce(venue_key, ''))) AS normalized_key,
                 count(*)::int AS count,
                 jsonb_agg(jsonb_build_object('venue_id', venue_id, 'venue_key', venue_key, 'venue', venue) ORDER BY venue ASC NULLS LAST) AS records
          FROM music_venues
          WHERE trim(coalesce(venue_key, '')) <> ''
          GROUP BY lower(trim(coalesce(venue_key, '')))
          HAVING count(*) > 1
          ORDER BY count DESC, normalized_key ASC
          LIMIT $1
        `, [Math.min(tokenLimit, 500)]);
        const duplicateVenueKeyItems = diagnosticRows(duplicateVenueRows).map((row) => ({
          normalized_key: row.normalized_key,
          count: toIntegerCount(row.count),
          records: Array.isArray(row.records) ? row.records.slice(0, 10) : [],
          reason: 'Duplicate normalized music_venues.venue_key.'
        }));

        const slugRowsResult = await dbPool.query(`SELECT venue_id, venue_key, venue FROM music_venues ORDER BY venue ASC NULLS LAST LIMIT $1`, [Math.max(venueLimit * 5, venueLimit)]);
        const slugMap = new Map();
        diagnosticRows(slugRowsResult).forEach((row) => {
          const slug = slugifyMusicBandId(row.venue_key || row.venue || '');
          if (!slug) return;
          if (!slugMap.has(slug)) slugMap.set(slug, []);
          slugMap.get(slug).push({ venue_id: row.venue_id, venue_key: row.venue_key, venue: row.venue });
        });
        const duplicateSlugItems = Array.from(slugMap.entries())
          .filter(([, rows]) => rows.length > 1)
          .slice(0, Math.min(tokenLimit, 500))
          .map(([slug, rows]) => ({ normalized_key: slug, count: rows.length, records: rows.slice(0, 10), reason: 'Duplicate normalized Music venue slug candidate.' }));
        response.exceptions.duplicate_venue_keys = duplicateVenueKeyItems.concat(duplicateSlugItems);
        response.summary.duplicate_venue_key_count = response.exceptions.duplicate_venue_keys.length;
        if (response.exceptions.duplicate_venue_keys.length >= Math.min(tokenLimit, 500)) warnings.push('token_limit reached; duplicate venue key/slug warnings are sampled.');
      } else {
        warnings.push('Duplicate venue key diagnostics skipped; missing music_venues.venue_key.');
      }
    } else {
      warnings.push('Missing table: music_venues');
    }

    if (existingTables.has('music_people')) {
      if (peopleColumns.has('name')) {
        const personIdExpr = peopleColumns.has('person_id') ? 'person_id' : 'NULL';
        const duplicatePeopleRows = await dbPool.query(`
          SELECT lower(regexp_replace(trim(coalesce(name, '')), '\\s+', ' ', 'g')) AS normalized_name,
                 count(*)::int AS count,
                 jsonb_agg(jsonb_build_object('person_id', ${personIdExpr}, 'name', name) ORDER BY name ASC) AS records
          FROM music_people
          WHERE trim(coalesce(name, '')) <> ''
          GROUP BY lower(regexp_replace(trim(coalesce(name, '')), '\\s+', ' ', 'g'))
          HAVING count(*) > 1
          ORDER BY count DESC, normalized_name ASC
          LIMIT $1
        `, [Math.min(tokenLimit, 500)]);
        response.exceptions.duplicate_people_names = diagnosticRows(duplicatePeopleRows).map((row) => ({
          normalized_name: row.normalized_name,
          count: toIntegerCount(row.count),
          records: Array.isArray(row.records) ? row.records.slice(0, 10) : [],
          reason: 'Duplicate normalized Music People name.'
        }));
        response.summary.duplicate_people_name_count = response.exceptions.duplicate_people_names.length;
        if (response.exceptions.duplicate_people_names.length >= Math.min(tokenLimit, 500)) warnings.push('token_limit reached; duplicate people name warnings are sampled.');
      } else {
        warnings.push('Duplicate people name diagnostics skipped; missing music_people.name.');
      }
    } else {
      warnings.push('Missing table: music_people');
    }

    try {
      const captionResponse = await buildMusicPeopleCaptionIndexDiagnosticResponse({
        page: 1,
        limit: Math.min(tokenLimit, 100),
        album_limit: albumLimit,
        photo_limit: photoLimit
      });
      const captionSummary = captionResponse.summary || {};
      response.summary.unmatched_caption_token_count = toIntegerCount(captionSummary.unmatched_caption_tokens);
      response.exceptions.people_caption_unmatched_tokens = Array.isArray(captionResponse.unmatched)
        ? captionResponse.unmatched.slice(0, Math.min(tokenLimit, 500))
        : [];
      if (captionSummary.scan_limited) warnings.push('album_limit reached; people caption unmatched-token results are sampled.');
      (captionSummary.warnings || []).forEach((warning) => warnings.push(`Caption index: ${warning}`));
      (captionSummary.limitations || []).forEach((warning) => warnings.push(`Caption index: ${warning}`));
    } catch (err) {
      warnings.push(`Unable to sample Music People caption exceptions: ${getSafeErrorMessage(err)}`);
    }
  } catch (err) {
    response.ok = false;
    warnings.push(`Unable to build Music SmugMug relationship exceptions: ${getSafeErrorMessage(err)}`);
  }

  return response;
}

async function handleMusicSmugMugExceptionsRequest(req, res) {
  try {
    return res.status(200).json(await buildMusicSmugMugExceptionsResponse(req.query || {}));
  } catch (err) {
    return res.status(500).json(buildAdminError(MUSIC_SMUGMUG_EXCEPTIONS_ROUTE, err, {
      source: 'postgres+smugmug',
      section: 'music',
      type: 'smugmug_relationship_exceptions',
      error: 'MUSIC_SMUGMUG_EXCEPTIONS_ERROR',
      readOnly: true,
      databaseMutated: false
    }));
  }
}
const MUSIC_SMUGMUG_VERIFY_ROUTE = '/api/admin/diagnostics/music/smugmug/verify';

function getMusicSmugMugVerifyLimit(value, fallback, max) {
  return getMusicSmugMugHealthLimit(value, fallback, max);
}

function createMusicSmugMugVerifySample({ id, name, routeHint }) {
  return {
    status: 'warn',
    name: String(name || '').trim(),
    id: id == null ? '' : String(id),
    route_hint: routeHint || '',
    checks: {
      db_resolved: false,
      relationship_resolved: false,
      album_link_found: false,
      photo_found: false,
      usable_image_url_found: false
    },
    notes: []
  };
}

function hasMusicSmugMugVerifyUsableImageUrl(photo) {
  return !!(photo && (photo.large_url || photo.medium_url || photo.small_url || photo.thumbnail_url));
}

function getMusicSmugMugVerifyPhotoTime(photo) {
  const fields = ['date_time_original', 'date_taken', 'taken_at', 'show_date'];
  for (const field of fields) {
    const value = String(photo && photo[field] || '').trim();
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return { value, source: field, time };
  }
  return null;
}

function finalizeMusicSmugMugVerifySample(sample, options = {}) {
  const requiredBroken = !!options.requiredBroken;
  if (requiredBroken || !sample.checks.db_resolved || !sample.checks.relationship_resolved || !sample.checks.album_link_found) {
    sample.status = 'fail';
  } else if (!sample.checks.photo_found || !sample.checks.usable_image_url_found || sample.notes.length) {
    sample.status = 'warn';
  } else {
    sample.status = 'pass';
  }
  return sample;
}

function getMusicSmugMugVerifyShowRouteHint(row) {
  const key = String(row && (row.show_url || formatMusicShowUrlDateKey(row.date) || row.show_id || '') || '').trim();
  return key ? `/music/shows/${key}` : '';
}

function getMusicSmugMugVerifyBandRouteHint(row) {
  const key = String(row && (row.band_id || slugifyMusicBandId(row.band) || '') || '').trim();
  return key ? `/music/bands/${key}` : '';
}

function getMusicSmugMugVerifyPersonRouteHint(row) {
  const key = String(row && (row.person_id || slugifyMusicBandId(row.name) || '') || '').trim();
  return key ? `/music/people/${key}` : '';
}

function getMusicSmugMugVerifyVenueRouteHint(row) {
  const key = String(row && (row.venue_key || row.venue_id || slugifyMusicBandId(row.venue) || '') || '').trim();
  return key ? `/music/venues/${key}` : '';
}

async function fetchMusicSmugMugVerifyAlbumPhotos(albumId, photoLimit, debug, warnings) {
  const cleanAlbumId = String(albumId || '').trim();
  if (!cleanAlbumId) return { album_id: '', photos: [], total: 0, cacheHit: false, error: 'missing_album_id' };

  const cached = debug ? null : getCachedSmugAlbumPhotos(cleanAlbumId, photoLimit, 1);
  if (cached) {
    return {
      album_id: cleanAlbumId,
      photos: Array.isArray(cached.photos) ? cached.photos : [],
      total: toIntegerCount(cached.total),
      cacheHit: true,
      error: ''
    };
  }

  try {
    const endpoint = `/album/${encodeURIComponent(cleanAlbumId)}!images?count=${photoLimit}&start=1&_accept=application/json&_expand=Image`;
    const json = await fetchSmugJson(endpoint);
    const photos = await buildSmugAlbumPhotoItemsForResponse(getSmugAlbumImages(json).slice(0, photoLimit), debug);
    const pagination = buildSmugAlbumPhotosPagination(json, photos, photoLimit, 1);
    const response = {
      ok: true,
      album_id: cleanAlbumId,
      count: photos.length,
      limit: photoLimit,
      start: 1,
      total: pagination.total,
      has_more: pagination.has_more,
      next_start: pagination.next_start,
      photos
    };
    if (!debug) setCachedSmugAlbumPhotos(cleanAlbumId, photoLimit, 1, response);
    return { album_id: cleanAlbumId, photos, total: pagination.total, cacheHit: false, error: '' };
  } catch (err) {
    const message = getSafeErrorMessage(err);
    if (Array.isArray(warnings)) warnings.push(`Album ${cleanAlbumId} sample fetch failed: ${message}`);
    return { album_id: cleanAlbumId, photos: [], total: 0, cacheHit: false, error: message };
  }
}

async function verifyMusicSmugMugSampleAlbums(albumRefs, photoLimit, debug, warnings) {
  const refs = (Array.isArray(albumRefs) ? albumRefs : []).filter((ref) => ref && ref.album_id);
  for (const ref of refs) {
    const result = await fetchMusicSmugMugVerifyAlbumPhotos(ref.album_id, photoLimit, debug, warnings);
    const usablePhoto = (result.photos || []).find(hasMusicSmugMugVerifyUsableImageUrl) || null;
    if (usablePhoto) {
      return { ...result, photo: usablePhoto, source: ref.source || '' };
    }
  }
  return { album_id: refs[0] ? refs[0].album_id : '', photos: [], total: 0, cacheHit: false, error: refs.length ? 'no_usable_photos_in_sample' : 'missing_album_id' };
}

function buildMusicSmugMugVerifyResponseShell(generated, limits) {
  return buildAdminResponse({
    route: MUSIC_SMUGMUG_VERIFY_ROUTE,
    generated,
    source: 'postgres+smugmug',
    section: 'music',
    type: 'smugmug_sample_verification',
    readOnly: true,
    databaseMutated: false,
    summary: {
      show_samples_checked: 0,
      show_samples_passed: 0,
      band_samples_checked: 0,
      band_samples_passed: 0,
      person_samples_checked: 0,
      person_samples_passed: 0,
      venue_samples_checked: 0,
      venue_samples_passed: 0,
      overall_status: 'warn'
    },
    samples: {
      shows: [],
      bands: [],
      people: [],
      venues: []
    },
    warnings: [],
    recommendedActions: [],
    limits
  });
}

function finalizeMusicSmugMugVerifyResponse(response) {
  const allSamples = ['shows', 'bands', 'people', 'venues'].flatMap((key) => response.samples[key] || []);
  response.summary.show_samples_checked = response.samples.shows.length;
  response.summary.show_samples_passed = response.samples.shows.filter((sample) => sample.status === 'pass').length;
  response.summary.band_samples_checked = response.samples.bands.length;
  response.summary.band_samples_passed = response.samples.bands.filter((sample) => sample.status === 'pass').length;
  response.summary.person_samples_checked = response.samples.people.length;
  response.summary.person_samples_passed = response.samples.people.filter((sample) => sample.status === 'pass').length;
  response.summary.venue_samples_checked = response.samples.venues.length;
  response.summary.venue_samples_passed = response.samples.venues.filter((sample) => sample.status === 'pass').length;

  if (response.ok === false || allSamples.some((sample) => sample.status === 'fail')) response.summary.overall_status = 'fail';
  else if (allSamples.some((sample) => sample.status === 'warn') || response.warnings.length) response.summary.overall_status = 'warn';
  else response.summary.overall_status = 'pass';

  response.recommendedActions = [];
  if (response.summary.overall_status === 'pass') {
    response.recommendedActions.push('Ready to mark SmugMug diagnostics refinement VERIFIED.');
  } else if (response.summary.overall_status === 'warn') {
    response.recommendedActions.push('Ready to move to final gallery matching verification after reviewing warning samples.');
  } else {
    response.recommendedActions.push('Needs another diagnostics fix pass or data cleanup in sheets/DB before gallery matching verification.');
  }
  return response;
}

async function buildMusicSmugMugVerifyResponse(query = {}) {
  const generated = new Date();
  const showSamples = getMusicSmugMugVerifyLimit(query.show_samples, 3, 10);
  const bandSamples = getMusicSmugMugVerifyLimit(query.band_samples, 3, 10);
  const personSamples = getMusicSmugMugVerifyLimit(query.person_samples, 3, 10);
  const venueSamples = getMusicSmugMugVerifyLimit(query.venue_samples, 3, 10);
  const albumLimit = getMusicSmugMugVerifyLimit(query.album_limit, 5, 20);
  const photoLimit = getMusicSmugMugVerifyLimit(query.photo_limit, 5, 20);
  const debug = query.debug === '1' || query.debug === 'true';
  const limits = { show_samples: showSamples, band_samples: bandSamples, person_samples: personSamples, venue_samples: venueSamples, album_limit: albumLimit, photo_limit: photoLimit, debug };
  const response = buildMusicSmugMugVerifyResponseShell(generated, limits);
  const warnings = response.warnings;
  const smugConfig = getSmugMugConfigDiagnostics();

  if (!smugConfig.configured) {
    response.ok = false;
    warnings.push(`SmugMug is not configured; sample photo verification cannot run. Missing ${smugConfig.missing.join(', ')}.`);
  }
  (smugConfig.warnings || []).forEach((warning) => warnings.push(`SmugMug: ${warning}`));

  if (!String(process.env.DATABASE_URL || '').trim()) {
    response.ok = false;
    warnings.push('DATABASE_URL is not configured; Music SmugMug sample verification could not inspect PostgreSQL records.');
    return finalizeMusicSmugMugVerifyResponse(response);
  }

  try {
    await dbPool.query('SELECT 1');
  } catch (err) {
    response.ok = false;
    warnings.push(`Database disconnected: ${getSafeErrorMessage(err)}`);
    return finalizeMusicSmugMugVerifyResponse(response);
  }

  try {
    const tableNames = ['music_shows', 'music_bands', 'music_people', 'music_venues'];
    const existingTables = await getExistingPublicTables(tableNames);
    const columnsByTable = await getExistingPublicColumns(tableNames);
    const showColumns = getSmugMusicTableColumns(columnsByTable, 'music_shows');
    const bandColumns = getSmugMusicTableColumns(columnsByTable, 'music_bands');
    const peopleColumns = getSmugMusicTableColumns(columnsByTable, 'music_people');
    const venueColumns = getSmugMusicTableColumns(columnsByTable, 'music_venues');

    if (existingTables.has('music_shows')) {
      const albumLinkCondition = buildMusicSmugMugHealthAlbumLinkCondition(showColumns);
      const showSelect = [
        buildMusicSmugMugHealthShowSelect(showColumns),
        showColumns.has('show_url') ? 'show_url' : 'NULL AS show_url',
        showColumns.has('bands') ? 'bands' : "'[]'::jsonb AS bands",
        showColumns.has('smug_albums') ? 'smug_albums' : "'[]'::jsonb AS smug_albums"
      ].join(', ');
      const showRows = await dbPool.query(`
        SELECT ${showSelect}
        FROM music_shows
        WHERE ${albumLinkCondition}
        ORDER BY ${getMusicSmugMugHealthShowOrderBy(showColumns)}
        LIMIT $1
      `, [showSamples]);
      for (const row of diagnosticRows(showRows)) {
        const sample = createMusicSmugMugVerifySample({ id: row.show_id, name: row.name, routeHint: getMusicSmugMugVerifyShowRouteHint(row) });
        sample.checks.db_resolved = true;
        sample.checks.relationship_resolved = true;
        const refs = getMusicSmugMugExceptionAlbumRefsFromRow(row).slice(0, albumLimit);
        sample.checks.album_link_found = refs.length > 0;
        if (!refs.length) sample.notes.push('No usable album_id/gallery_id/smug_albums value found.');
        else if (smugConfig.configured) {
          const result = await verifyMusicSmugMugSampleAlbums(refs, photoLimit, debug, warnings);
          sample.album_id_checked = result.album_id || null;
          sample.cache_hit = !!result.cacheHit;
          sample.checks.photo_found = !!(result.photo || (result.photos && result.photos.length));
          sample.checks.usable_image_url_found = !!result.photo;
          if (result.photo) sample.sample_photo = result.photo;
          if (result.error) sample.notes.push(result.error);
        } else {
          sample.notes.push('SmugMug config missing; skipped album photo fetch.');
        }
        response.samples.shows.push(finalizeMusicSmugMugVerifySample(sample));
      }
      if (!response.samples.shows.length) warnings.push('No Music Shows with usable album links were available for sample verification.');
    } else {
      warnings.push('Missing table: music_shows');
    }

    if (existingTables.has('music_bands')) {
      const bandSelect = [
        bandColumns.has('band_id') ? 'band_id' : 'NULL AS band_id',
        bandColumns.has('band') ? 'band' : 'NULL AS band',
        bandColumns.has('region') ? 'region' : 'NULL AS region',
        bandColumns.has('smug_folder') ? 'smug_folder' : 'NULL AS smug_folder',
        bandColumns.has('archived_sets') ? 'archived_sets' : '0::int AS archived_sets',
        bandColumns.has('total_sets') ? 'total_sets' : '0::int AS total_sets',
        bandColumns.has('photo_count') ? 'photo_count' : '0::int AS photo_count'
      ].join(', ');
      const bandWhereParts = [
        bandColumns.has('archived_sets') ? 'coalesce(archived_sets, 0) > 0' : 'false',
        bandColumns.has('total_sets') ? 'coalesce(total_sets, 0) > 0' : 'false',
        bandColumns.has('photo_count') ? 'coalesce(photo_count, 0) > 0' : 'false'
      ];
      const bandRows = await dbPool.query(`
        SELECT ${bandSelect}
        FROM music_bands
        WHERE ${bandWhereParts.join(' OR ')}
        ORDER BY archived_sets DESC NULLS LAST, total_sets DESC NULLS LAST, band ASC NULLS LAST
        LIMIT $1
      `, [bandSamples]);
      const albumLinkCondition = existingTables.has('music_shows') ? buildMusicSmugMugHealthAlbumLinkCondition(showColumns) : 'false';
      for (const row of diagnosticRows(bandRows)) {
        const sample = createMusicSmugMugVerifySample({ id: row.band_id, name: row.band, routeHint: getMusicSmugMugVerifyBandRouteHint(row) });
        sample.checks.db_resolved = true;
        if (!existingTables.has('music_shows') || !showColumns.has('bands')) {
          sample.notes.push('Cannot verify linked shows because music_shows.bands is unavailable.');
          response.samples.bands.push(finalizeMusicSmugMugVerifySample(sample, { requiredBroken: true }));
          continue;
        }
        const linkedShowRows = await dbPool.query(`
          SELECT ${buildMusicSmugMugHealthShowSelect(showColumns)}, ${showColumns.has('show_url') ? 'show_url' : 'NULL AS show_url'}, ${showColumns.has('bands') ? 'bands' : "'[]'::jsonb AS bands"}, ${showColumns.has('smug_albums') ? 'smug_albums' : "'[]'::jsonb AS smug_albums"}
          FROM music_shows
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(bands) = 'array' THEN bands ELSE '[]'::jsonb END) band_item
            WHERE lower(trim(coalesce(band_item->>'band', band_item->>'name', ''))) = lower(trim($1))
          )
          ORDER BY ${getMusicSmugMugHealthShowOrderBy(showColumns)}
          LIMIT $2
        `, [String(row.band || '').trim(), albumLimit]);
        const linkedRows = diagnosticRows(linkedShowRows);
        sample.linked_show_count_sampled = linkedRows.length;
        sample.checks.relationship_resolved = linkedRows.length > 0;
        const albumRefs = linkedRows.flatMap(getMusicSmugMugExceptionAlbumRefsFromRow).slice(0, albumLimit);
        sample.checks.album_link_found = albumRefs.length > 0;
        if (!linkedRows.length) sample.notes.push('No linked Music Shows found for this band sample.');
        else if (!albumRefs.length) sample.notes.push('Linked Music Shows exist, but sampled rows have no usable album links.');
        else if (smugConfig.configured) {
          const result = await verifyMusicSmugMugSampleAlbums(albumRefs, photoLimit, debug, warnings);
          sample.album_id_checked = result.album_id || null;
          sample.cache_hit = !!result.cacheHit;
          sample.checks.photo_found = !!(result.photo || (result.photos && result.photos.length));
          sample.checks.usable_image_url_found = !!result.photo;
          if (result.photo) sample.sample_photo = result.photo;
          if (result.error) sample.notes.push(result.error);
        } else {
          sample.notes.push('SmugMug config missing; skipped album photo fetch.');
        }
        response.samples.bands.push(finalizeMusicSmugMugVerifySample(sample));
      }
      if (!response.samples.bands.length) warnings.push('No Music Bands with archived sets/photo counts were available for sample verification.');
    } else {
      warnings.push('Missing table: music_bands');
    }

    if (existingTables.has('music_people')) {
      let captionResponse = null;
      if (smugConfig.configured) {
        try {
          captionResponse = await buildMusicPeopleCaptionIndexDiagnosticResponse({ page: 1, limit: personSamples, album_limit: albumLimit, photo_limit: photoLimit });
        } catch (err) {
          warnings.push(`Music People caption verification sample failed: ${getSafeErrorMessage(err)}`);
        }
      }
      const matchedPeople = captionResponse && Array.isArray(captionResponse.matches) ? captionResponse.matches.slice(0, personSamples) : [];
      if (matchedPeople.length) {
        matchedPeople.forEach((person) => {
          const sample = createMusicSmugMugVerifySample({ id: person.person_id, name: person.name, routeHint: getMusicSmugMugVerifyPersonRouteHint(person) });
          sample.checks.db_resolved = true;
          sample.checks.relationship_resolved = true;
          sample.checks.album_link_found = Array.isArray(person.source_albums) && person.source_albums.length > 0;
          const photoRefs = Array.isArray(person.sample_photo_refs) ? person.sample_photo_refs : [];
          const photo = photoRefs.find(hasMusicSmugMugVerifyUsableImageUrl) || photoRefs[0] || null;
          sample.checks.photo_found = !!photo;
          sample.checks.usable_image_url_found = !!(photo && hasMusicSmugMugVerifyUsableImageUrl(photo));
          if (photo) sample.sample_photo = photo;
          const datedRefs = photoRefs.map((ref) => getMusicSmugMugVerifyPhotoTime(ref)).filter(Boolean).sort((a, b) => a.time - b.time);
          if (datedRefs.length) {
            sample.first_seen = { value: datedRefs[0].value, source: datedRefs[0].source };
            sample.latest_seen = { value: datedRefs[datedRefs.length - 1].value, source: datedRefs[datedRefs.length - 1].source };
          } else {
            sample.notes.push('No date fields available in sampled matched photo refs.');
          }
          response.samples.people.push(finalizeMusicSmugMugVerifySample(sample));
        });
      } else {
        const personSelect = [
          peopleColumns.has('person_id') ? 'person_id' : 'NULL AS person_id',
          peopleColumns.has('name') ? 'name' : 'NULL AS name'
        ].join(', ');
        const peopleRows = await dbPool.query(`SELECT ${personSelect} FROM music_people WHERE trim(coalesce(name, '')) <> '' ORDER BY name ASC LIMIT $1`, [personSamples]);
        diagnosticRows(peopleRows).forEach((person) => {
          const sample = createMusicSmugMugVerifySample({ id: person.person_id, name: person.name, routeHint: getMusicSmugMugVerifyPersonRouteHint(person) });
          sample.checks.db_resolved = true;
          sample.checks.relationship_resolved = true;
          sample.checks.album_link_found = !!(captionResponse && captionResponse.summary && toIntegerCount(captionResponse.summary.total_albums_inspected) > 0);
          sample.notes.push(smugConfig.configured ? 'No exact semicolon-caption match found in sampled photos.' : 'SmugMug config missing; skipped caption photo sample.');
          response.samples.people.push(finalizeMusicSmugMugVerifySample(sample));
        });
      }
      if (!response.samples.people.length) warnings.push('No Music People records were available for sample verification.');
    } else {
      warnings.push('Missing table: music_people');
    }

    if (existingTables.has('music_venues')) {
      if (!existingTables.has('music_shows') || !venueColumns.has('venue_key') || !showColumns.has('venue_id')) {
        warnings.push('Cannot verify Music Venues because music_venues.venue_key or music_shows.venue_id is unavailable.');
      } else {
        const albumLinkCondition = buildMusicSmugMugHealthAlbumLinkCondition(showColumns, 'ms');
        const venueRows = await dbPool.query(`
          SELECT mv.venue_id, mv.venue_key, mv.venue, mv.city, mv.state, mv.stats, mv.raw_sheet,
                 count(ms.*)::int AS linked_show_count,
                 count(*) FILTER (WHERE ${albumLinkCondition})::int AS usable_album_count
          FROM music_venues mv
          JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
          WHERE trim(coalesce(mv.venue_key, '')) <> ''
          GROUP BY mv.venue_id, mv.venue_key, mv.venue, mv.city, mv.state, mv.stats, mv.raw_sheet
          ORDER BY usable_album_count DESC, linked_show_count DESC, mv.venue ASC NULLS LAST
          LIMIT $1
        `, [venueSamples]);
        for (const row of diagnosticRows(venueRows)) {
          const sample = createMusicSmugMugVerifySample({ id: row.venue_key || row.venue_id, name: row.venue, routeHint: getMusicSmugMugVerifyVenueRouteHint(row) });
          sample.checks.db_resolved = true;
          sample.checks.relationship_resolved = toIntegerCount(row.linked_show_count) > 0;
          sample.checks.album_link_found = toIntegerCount(row.usable_album_count) > 0;
          const venueTotalInfo = getMusicVenueOfficialPhotoTotalInfo(row);
          sample.summary = {
            venue_total_photos: toIntegerCount(venueTotalInfo.value),
            aggregated_photo_count: 0,
            returned_count: 0,
            linked_show_count: toIntegerCount(row.linked_show_count),
            usable_album_count: toIntegerCount(row.usable_album_count)
          };
          if (sample.checks.album_link_found && smugConfig.configured) {
            const linkedShowRows = await dbPool.query(`
              SELECT ${buildMusicSmugMugHealthShowSelect(showColumns)}, ${showColumns.has('show_url') ? 'show_url' : 'NULL AS show_url'}, ${showColumns.has('bands') ? 'bands' : "'[]'::jsonb AS bands"}, ${showColumns.has('smug_albums') ? 'smug_albums' : "'[]'::jsonb AS smug_albums"}
              FROM music_shows
              WHERE lower(trim(coalesce(venue_id, ''))) = lower(trim($1))
                AND ${buildMusicSmugMugHealthAlbumLinkCondition(showColumns)}
              ORDER BY ${getMusicSmugMugHealthShowOrderBy(showColumns)}
              LIMIT $2
            `, [String(row.venue_key || '').trim(), albumLimit]);
            const refs = diagnosticRows(linkedShowRows).flatMap(getMusicSmugMugExceptionAlbumRefsFromRow).slice(0, albumLimit);
            const result = await verifyMusicSmugMugSampleAlbums(refs, photoLimit, debug, warnings);
            sample.album_id_checked = result.album_id || null;
            sample.cache_hit = !!result.cacheHit;
            sample.summary.aggregated_photo_count = result.photos ? result.photos.length : 0;
            sample.summary.returned_count = result.photos ? result.photos.length : 0;
            sample.checks.photo_found = !!(result.photo || (result.photos && result.photos.length));
            sample.checks.usable_image_url_found = !!result.photo;
            if (result.photo) sample.sample_photo = result.photo;
            if (result.error) sample.notes.push(result.error);
          } else if (!sample.checks.album_link_found) {
            sample.notes.push('Linked shows exist, but no usable album IDs are available.');
          } else {
            sample.notes.push('SmugMug config missing; skipped venue photo aggregation sample.');
          }
          response.samples.venues.push(finalizeMusicSmugMugVerifySample(sample));
        }
        if (!response.samples.venues.length) warnings.push('No Music Venues with linked shows were available for sample verification.');
      }
    } else {
      warnings.push('Missing table: music_venues');
    }
  } catch (err) {
    response.ok = false;
    warnings.push(`Unable to build Music SmugMug sample verification: ${getSafeErrorMessage(err)}`);
  }

  return finalizeMusicSmugMugVerifyResponse(response);
}

async function handleMusicSmugMugVerifyRequest(req, res) {
  try {
    return res.status(200).json(await buildMusicSmugMugVerifyResponse(req.query || {}));
  } catch (err) {
    return res.status(500).json(buildAdminError(MUSIC_SMUGMUG_VERIFY_ROUTE, err, {
      source: 'postgres+smugmug',
      section: 'music',
      type: 'smugmug_sample_verification',
      error: 'MUSIC_SMUGMUG_VERIFY_ERROR',
      readOnly: true,
      databaseMutated: false
    }));
  }
}
const MUSIC_SMUGMUG_GALLERY_VERIFY_ROUTE = '/api/admin/diagnostics/music/smugmug/gallery-verification';

function getMusicSmugMugGalleryVerifyLimit(value, fallback, max) {
  return getMusicSmugMugHealthLimit(value, fallback, max);
}

function createMusicSmugMugGallerySample({ id, name, routeHint }) {
  const sample = createMusicSmugMugVerifySample({ id, name, routeHint });
  sample.checks.album_relationship_appears_correct = false;
  sample.checks.caption_match_found = false;
  sample.checks.photo_belongs_to_expected_source = false;
  sample.checks.frontend_route_hint_found = !!sample.route_hint;
  return sample;
}

function finalizeMusicSmugMugGallerySample(sample, options = {}) {
  const requiredBroken = !!options.requiredBroken;
  if (requiredBroken || !sample.checks.db_resolved || !sample.checks.relationship_resolved || !sample.checks.album_link_found) {
    sample.status = 'fail';
  } else if (!sample.checks.photo_found || !sample.checks.usable_image_url_found || sample.notes.length) {
    sample.status = 'warn';
  } else {
    sample.status = 'pass';
  }
  return sample;
}

function buildMusicSmugMugGalleryAlbumRefsFromShow(row) {
  return getMusicSmugMugExceptionAlbumRefsFromRow(row).map((ref) => ({
    ...ref,
    show_id: row && row.show_id != null ? row.show_id : null,
    show_key: String(row && (row.show_url || formatMusicShowUrlDateKey(row.date) || row.show_id || '') || '').trim() || null,
    show_name: String(row && row.name || '').trim(),
    show_date: String(row && row.date || '').trim(),
    venue_id: String(row && row.venue_id || '').trim() || null
  }));
}

function findMusicSmugMugGalleryUsedAlbumRef(refs, albumId) {
  const key = String(albumId || '').trim().toLowerCase();
  return (Array.isArray(refs) ? refs : []).find((ref) => String(ref && ref.album_id || '').trim().toLowerCase() === key) || null;
}

function buildMusicSmugMugGalleryResponseShell(generated, limits) {
  return buildAdminResponse({
    route: MUSIC_SMUGMUG_GALLERY_VERIFY_ROUTE,
    generated,
    source: 'postgres+smugmug',
    section: 'music',
    type: 'gallery_matching_verification',
    readOnly: true,
    databaseMutated: false,
    summary: {
      bands_checked: 0,
      bands_passed: 0,
      shows_checked: 0,
      shows_passed: 0,
      people_checked: 0,
      people_passed: 0,
      venues_checked: 0,
      venues_passed: 0,
      overall_status: 'warn'
    },
    samples: {
      bands: [],
      shows: [],
      people: [],
      venues: []
    },
    warnings: [],
    recommendedActions: [],
    limits
  });
}

function finalizeMusicSmugMugGalleryResponse(response) {
  const allSamples = ['bands', 'shows', 'people', 'venues'].flatMap((key) => response.samples[key] || []);
  response.summary.bands_checked = response.samples.bands.length;
  response.summary.bands_passed = response.samples.bands.filter((sample) => sample.status === 'pass').length;
  response.summary.shows_checked = response.samples.shows.length;
  response.summary.shows_passed = response.samples.shows.filter((sample) => sample.status === 'pass').length;
  response.summary.people_checked = response.samples.people.length;
  response.summary.people_passed = response.samples.people.filter((sample) => sample.status === 'pass').length;
  response.summary.venues_checked = response.samples.venues.length;
  response.summary.venues_passed = response.samples.venues.filter((sample) => sample.status === 'pass').length;

  if (response.ok === false || allSamples.some((sample) => sample.status === 'fail')) response.summary.overall_status = 'fail';
  else if (allSamples.some((sample) => sample.status === 'warn') || response.warnings.length) response.summary.overall_status = 'warn';
  else response.summary.overall_status = 'pass';

  response.recommendedActions = [];
  if (response.summary.overall_status === 'pass') {
    response.recommendedActions.push('Music SmugMug Integration COMPLETE.');
  } else if (response.summary.overall_status === 'warn') {
    response.recommendedActions.push('Music SmugMug Integration COMPLETE with minor warnings.');
  } else {
    response.recommendedActions.push('One additional cleanup pass recommended before marking integration complete.');
  }
  return response;
}

async function buildMusicSmugMugGalleryVerificationResponse(query = {}) {
  const generated = new Date();
  const bandSamples = getMusicSmugMugGalleryVerifyLimit(query.band_samples, 10, 25);
  const showSamples = getMusicSmugMugGalleryVerifyLimit(query.show_samples, 10, 25);
  const personSamples = getMusicSmugMugGalleryVerifyLimit(query.person_samples, 10, 25);
  const venueSamples = getMusicSmugMugGalleryVerifyLimit(query.venue_samples, 10, 25);
  const photoLimit = getMusicSmugMugGalleryVerifyLimit(query.photo_limit, 10, 25);
  const debug = query.debug === '1' || query.debug === 'true';
  const limits = { band_samples: bandSamples, show_samples: showSamples, person_samples: personSamples, venue_samples: venueSamples, photo_limit: photoLimit, debug };
  const response = buildMusicSmugMugGalleryResponseShell(generated, limits);
  const warnings = response.warnings;
  const smugConfig = getSmugMugConfigDiagnostics();

  if (!smugConfig.configured) {
    response.ok = false;
    warnings.push(`SmugMug is not configured; gallery matching verification cannot fetch photos. Missing ${smugConfig.missing.join(', ')}.`);
  }
  (smugConfig.warnings || []).forEach((warning) => warnings.push(`SmugMug: ${warning}`));

  if (!String(process.env.DATABASE_URL || '').trim()) {
    response.ok = false;
    warnings.push('DATABASE_URL is not configured; gallery matching verification could not inspect PostgreSQL records.');
    return finalizeMusicSmugMugGalleryResponse(response);
  }

  try {
    await dbPool.query('SELECT 1');
  } catch (err) {
    response.ok = false;
    warnings.push(`Database disconnected: ${getSafeErrorMessage(err)}`);
    return finalizeMusicSmugMugGalleryResponse(response);
  }

  try {
    const tableNames = ['music_shows', 'music_bands', 'music_people', 'music_venues'];
    const existingTables = await getExistingPublicTables(tableNames);
    const columnsByTable = await getExistingPublicColumns(tableNames);
    const showColumns = getSmugMusicTableColumns(columnsByTable, 'music_shows');
    const bandColumns = getSmugMusicTableColumns(columnsByTable, 'music_bands');
    const peopleColumns = getSmugMusicTableColumns(columnsByTable, 'music_people');
    const venueColumns = getSmugMusicTableColumns(columnsByTable, 'music_venues');

    const showAlbumLinkCondition = existingTables.has('music_shows') ? buildMusicSmugMugHealthAlbumLinkCondition(showColumns) : 'false';
    const showSelect = existingTables.has('music_shows') ? [
      buildMusicSmugMugHealthShowSelect(showColumns),
      showColumns.has('show_url') ? 'show_url' : 'NULL AS show_url',
      showColumns.has('bands') ? 'bands' : "'[]'::jsonb AS bands",
      showColumns.has('smug_albums') ? 'smug_albums' : "'[]'::jsonb AS smug_albums"
    ].join(', ') : '';

    if (existingTables.has('music_shows')) {
      const showRows = await dbPool.query(`
        SELECT ${showSelect}
        FROM music_shows
        WHERE ${showAlbumLinkCondition}
        ORDER BY random()
        LIMIT $1
      `, [showSamples]);
      for (const row of diagnosticRows(showRows)) {
        const sample = createMusicSmugMugGallerySample({ id: row.show_id, name: row.name, routeHint: getMusicSmugMugVerifyShowRouteHint(row) });
        sample.checks.db_resolved = true;
        sample.checks.relationship_resolved = true;
        sample.checks.frontend_route_hint_found = !!sample.route_hint;
        const refs = buildMusicSmugMugGalleryAlbumRefsFromShow(row);
        sample.checks.album_link_found = refs.length > 0;
        if (refs.length && smugConfig.configured) {
          const result = await verifyMusicSmugMugSampleAlbums(refs, photoLimit, debug, warnings);
          const usedRef = findMusicSmugMugGalleryUsedAlbumRef(refs, result.album_id);
          sample.album_id_checked = result.album_id || null;
          sample.linked_show = usedRef ? { show_id: usedRef.show_id, show_key: usedRef.show_key, show_name: usedRef.show_name, show_date: usedRef.show_date } : null;
          sample.checks.album_relationship_appears_correct = !!usedRef;
          sample.checks.photo_belongs_to_expected_source = !!usedRef;
          sample.checks.photo_found = !!(result.photo || (result.photos && result.photos.length));
          sample.checks.usable_image_url_found = !!result.photo;
          if (result.photo) sample.sample_photo = result.photo;
          if (result.error) sample.notes.push(result.error);
        } else if (!refs.length) {
          sample.notes.push('Show has no usable album references.');
        } else {
          sample.notes.push('SmugMug config missing; skipped show gallery photo fetch.');
        }
        response.samples.shows.push(finalizeMusicSmugMugGallerySample(sample));
      }
      if (!response.samples.shows.length) warnings.push('No Music Shows with album links were available for gallery verification.');
    } else {
      warnings.push('Missing table: music_shows');
    }

    if (existingTables.has('music_bands')) {
      if (!bandColumns.has('band')) {
        warnings.push('Band gallery verification skipped; missing music_bands.band.');
      } else {
        const bandSelect = [
          bandColumns.has('band_id') ? 'band_id' : 'NULL AS band_id',
          'band',
          bandColumns.has('region') ? 'region' : 'NULL AS region',
          bandColumns.has('smug_folder') ? 'smug_folder' : 'NULL AS smug_folder',
          bandColumns.has('archived_sets') ? 'archived_sets' : '0::int AS archived_sets',
          bandColumns.has('total_sets') ? 'total_sets' : '0::int AS total_sets',
          bandColumns.has('photo_count') ? 'photo_count' : '0::int AS photo_count'
        ].join(', ');
        const bandArchiveSignals = [
          bandColumns.has('archived_sets') ? 'coalesce(mb.archived_sets, 0) > 0' : 'false',
          bandColumns.has('total_sets') ? 'coalesce(mb.total_sets, 0) > 0' : 'false',
          bandColumns.has('photo_count') ? 'coalesce(mb.photo_count, 0) > 0' : 'false'
        ];
        const linkedShowExists = existingTables.has('music_shows') && showColumns.has('bands')
          ? `EXISTS (SELECT 1 FROM music_shows ms WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ms.bands) = 'array' THEN ms.bands ELSE '[]'::jsonb END) band_item WHERE lower(trim(coalesce(band_item->>'band', band_item->>'name', ''))) = lower(trim(mb.band))))`
          : 'false';
        const bandRows = await dbPool.query(`
          SELECT ${bandSelect}
          FROM music_bands mb
          WHERE trim(coalesce(mb.band, '')) <> ''
            AND (${bandArchiveSignals.join(' OR ')} OR ${linkedShowExists})
          ORDER BY random()
          LIMIT $1
        `, [bandSamples]);
        for (const row of diagnosticRows(bandRows)) {
          const sample = createMusicSmugMugGallerySample({ id: row.band_id, name: row.band, routeHint: getMusicSmugMugVerifyBandRouteHint(row) });
          sample.checks.db_resolved = true;
          sample.checks.frontend_route_hint_found = !!sample.route_hint;
          if (!existingTables.has('music_shows') || !showColumns.has('bands')) {
            sample.notes.push('Cannot verify linked sets because music_shows.bands is unavailable.');
            response.samples.bands.push(finalizeMusicSmugMugGallerySample(sample, { requiredBroken: true }));
            continue;
          }
          const linkedRows = await dbPool.query(`
            SELECT ${showSelect}
            FROM music_shows
            WHERE EXISTS (
              SELECT 1
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(bands) = 'array' THEN bands ELSE '[]'::jsonb END) band_item
              WHERE lower(trim(coalesce(band_item->>'band', band_item->>'name', ''))) = lower(trim($1))
            )
            ORDER BY random()
            LIMIT $2
          `, [String(row.band || '').trim(), photoLimit]);
          const showRowsForBand = diagnosticRows(linkedRows);
          sample.linked_show_count_sampled = showRowsForBand.length;
          sample.checks.relationship_resolved = showRowsForBand.length > 0;
          const refs = showRowsForBand.flatMap(buildMusicSmugMugGalleryAlbumRefsFromShow);
          sample.checks.album_link_found = refs.length > 0;
          if (refs.length && smugConfig.configured) {
            const result = await verifyMusicSmugMugSampleAlbums(refs, photoLimit, debug, warnings);
            const usedRef = findMusicSmugMugGalleryUsedAlbumRef(refs, result.album_id);
            sample.album_id_checked = result.album_id || null;
            sample.linked_show = usedRef ? { show_id: usedRef.show_id, show_key: usedRef.show_key, show_name: usedRef.show_name, show_date: usedRef.show_date } : null;
            sample.checks.album_relationship_appears_correct = !!usedRef;
            sample.checks.photo_belongs_to_expected_source = !!usedRef;
            sample.checks.photo_found = !!(result.photo || (result.photos && result.photos.length));
            sample.checks.usable_image_url_found = !!result.photo;
            if (result.photo) sample.sample_photo = result.photo;
            if (result.error) sample.notes.push(result.error);
          } else if (!showRowsForBand.length) {
            sample.notes.push('No linked Music Shows found for sampled band.');
          } else if (!refs.length) {
            sample.notes.push('Linked shows exist, but no usable album references were found.');
          } else {
            sample.notes.push('SmugMug config missing; skipped band gallery photo fetch.');
          }
          response.samples.bands.push(finalizeMusicSmugMugGallerySample(sample));
        }
        if (!response.samples.bands.length) warnings.push('No Music Bands with linked shows or archive signals were available for gallery verification.');
      }
    } else {
      warnings.push('Missing table: music_bands');
    }

    if (existingTables.has('music_people')) {
      if (!peopleColumns.has('name')) {
        warnings.push('People gallery verification skipped; missing music_people.name.');
      } else {
        const personSelect = [
          peopleColumns.has('person_id') ? 'person_id' : 'NULL AS person_id',
          'name'
        ].join(', ');
        const personRows = await dbPool.query(`
          SELECT ${personSelect}
          FROM music_people
          WHERE trim(coalesce(name, '')) <> ''
          ORDER BY random()
          LIMIT $1
        `, [personSamples]);
        let captionResponse = null;
        const matchByName = new Map();
        if (smugConfig.configured) {
          try {
            captionResponse = await buildMusicPeopleCaptionIndexDiagnosticResponse({ page: 1, limit: 100, album_limit: Math.min(25, Math.max(personSamples, 10)), photo_limit: photoLimit });
            (Array.isArray(captionResponse.matches) ? captionResponse.matches : []).forEach((match) => {
              matchByName.set(normalizeMusicPeopleCaptionIndexName(match.name), match);
            });
          } catch (err) {
            warnings.push(`Music People caption gallery verification sample failed: ${getSafeErrorMessage(err)}`);
          }
        }
        for (const row of diagnosticRows(personRows)) {
          const sample = createMusicSmugMugGallerySample({ id: row.person_id, name: row.name, routeHint: getMusicSmugMugVerifyPersonRouteHint(row) });
          sample.checks.db_resolved = true;
          sample.checks.frontend_route_hint_found = !!sample.route_hint;
          const match = matchByName.get(normalizeMusicPeopleCaptionIndexName(row.name));
          sample.checks.relationship_resolved = !!match;
          sample.checks.caption_match_found = !!match;
          sample.checks.album_link_found = !!(match && Array.isArray(match.source_albums) && match.source_albums.length);
          const photoRefs = match && Array.isArray(match.sample_photo_refs) ? match.sample_photo_refs : [];
          const photo = photoRefs.find(hasMusicSmugMugVerifyUsableImageUrl) || photoRefs[0] || null;
          sample.checks.photo_found = !!photo;
          sample.checks.usable_image_url_found = !!(photo && hasMusicSmugMugVerifyUsableImageUrl(photo));
          sample.checks.photo_belongs_to_expected_source = !!(photo && (photo.show_id || photo.show_name || photo.album_id));
          if (photo) sample.sample_photo = photo;
          const datedRefs = photoRefs.map((ref) => getMusicSmugMugVerifyPhotoTime(ref)).filter(Boolean).sort((a, b) => a.time - b.time);
          if (datedRefs.length) {
            sample.first_seen = { value: datedRefs[0].value, source: datedRefs[0].source };
            sample.latest_seen = { value: datedRefs[datedRefs.length - 1].value, source: datedRefs[datedRefs.length - 1].source };
          } else if (match) {
            sample.notes.push('Caption match found, but sampled photo refs did not include usable date fields.');
          }
          if (!match) sample.notes.push(smugConfig.configured ? 'No exact semicolon-caption match found in sampled photos.' : 'SmugMug config missing; skipped caption match verification.');
          response.samples.people.push(finalizeMusicSmugMugGallerySample(sample, { requiredBroken: false }));
        }
        if (!response.samples.people.length) warnings.push('No Music People records were available for gallery verification.');
      }
    } else {
      warnings.push('Missing table: music_people');
    }

    if (existingTables.has('music_venues')) {
      if (!existingTables.has('music_shows') || !venueColumns.has('venue_key') || !showColumns.has('venue_id')) {
        warnings.push('Venue gallery verification skipped; missing music_venues.venue_key or music_shows.venue_id.');
      } else {
        const albumLinkCondition = buildMusicSmugMugHealthAlbumLinkCondition(showColumns, 'ms');
        const venueRows = await dbPool.query(`
          SELECT mv.venue_id, mv.venue_key, mv.venue, mv.city, mv.state, mv.stats, mv.raw_sheet,
                 count(ms.*)::int AS linked_show_count,
                 count(*) FILTER (WHERE ${albumLinkCondition})::int AS usable_album_count
          FROM music_venues mv
          JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
          WHERE trim(coalesce(mv.venue_key, '')) <> ''
          GROUP BY mv.venue_id, mv.venue_key, mv.venue, mv.city, mv.state, mv.stats, mv.raw_sheet
          ORDER BY random()
          LIMIT $1
        `, [venueSamples]);
        for (const row of diagnosticRows(venueRows)) {
          const sample = createMusicSmugMugGallerySample({ id: row.venue_key || row.venue_id, name: row.venue, routeHint: getMusicSmugMugVerifyVenueRouteHint(row) });
          sample.checks.db_resolved = true;
          sample.checks.relationship_resolved = toIntegerCount(row.linked_show_count) > 0;
          sample.checks.album_link_found = toIntegerCount(row.usable_album_count) > 0;
          sample.checks.frontend_route_hint_found = !!sample.route_hint;
          const venueTotalInfo = getMusicVenueOfficialPhotoTotalInfo(row);
          sample.summary = {
            venue_total_photos: toIntegerCount(venueTotalInfo.value),
            aggregated_photo_count: 0,
            returned_count: 0,
            linked_show_count: toIntegerCount(row.linked_show_count),
            usable_album_count: toIntegerCount(row.usable_album_count)
          };
          if (sample.checks.album_link_found && smugConfig.configured) {
            const linkedRows = await dbPool.query(`
              SELECT ${showSelect}
              FROM music_shows
              WHERE lower(trim(coalesce(venue_id, ''))) = lower(trim($1))
                AND ${buildMusicSmugMugHealthAlbumLinkCondition(showColumns)}
              ORDER BY random()
              LIMIT $2
            `, [String(row.venue_key || '').trim(), photoLimit]);
            const refs = diagnosticRows(linkedRows).flatMap(buildMusicSmugMugGalleryAlbumRefsFromShow);
            const result = await verifyMusicSmugMugSampleAlbums(refs, photoLimit, debug, warnings);
            const usedRef = findMusicSmugMugGalleryUsedAlbumRef(refs, result.album_id);
            sample.album_id_checked = result.album_id || null;
            sample.linked_show = usedRef ? { show_id: usedRef.show_id, show_key: usedRef.show_key, show_name: usedRef.show_name, show_date: usedRef.show_date, venue_id: usedRef.venue_id } : null;
            sample.summary.aggregated_photo_count = result.photos ? result.photos.length : 0;
            sample.summary.returned_count = result.photos ? result.photos.length : 0;
            sample.checks.album_relationship_appears_correct = !!usedRef;
            sample.checks.photo_belongs_to_expected_source = !!(usedRef && normalizeMusicLookupKey(usedRef.venue_id) === normalizeMusicLookupKey(row.venue_key));
            sample.checks.photo_found = !!(result.photo || (result.photos && result.photos.length));
            sample.checks.usable_image_url_found = !!result.photo;
            if (result.photo) sample.sample_photo = result.photo;
            if (result.error) sample.notes.push(result.error);
            if (sample.summary.venue_total_photos > 0 && sample.summary.aggregated_photo_count === 0) sample.notes.push('Venue official total exists, but sampled aggregation did not return photos.');
          } else if (!sample.checks.album_link_found) {
            sample.notes.push('Venue has linked shows, but no usable album IDs in sampled linked shows.');
          } else {
            sample.notes.push('SmugMug config missing; skipped venue aggregation photo fetch.');
          }
          response.samples.venues.push(finalizeMusicSmugMugGallerySample(sample));
        }
        if (!response.samples.venues.length) warnings.push('No Music Venues with linked shows were available for gallery verification.');
      }
    } else {
      warnings.push('Missing table: music_venues');
    }
  } catch (err) {
    response.ok = false;
    warnings.push(`Unable to build Music SmugMug gallery matching verification: ${getSafeErrorMessage(err)}`);
  }

  return finalizeMusicSmugMugGalleryResponse(response);
}

async function handleMusicSmugMugGalleryVerificationRequest(req, res) {
  try {
    return res.status(200).json(await buildMusicSmugMugGalleryVerificationResponse(req.query || {}));
  } catch (err) {
    return res.status(500).json(buildAdminError(MUSIC_SMUGMUG_GALLERY_VERIFY_ROUTE, err, {
      source: 'postgres+smugmug',
      section: 'music',
      type: 'gallery_matching_verification',
      error: 'MUSIC_SMUGMUG_GALLERY_VERIFICATION_ERROR',
      readOnly: true,
      databaseMutated: false
    }));
  }
}
const MUSIC_SMUGMUG_RELATIONSHIP_AUDIT_ROUTE = '/api/admin/diagnostics/music/smugmug/relationship-audit';

function getMusicSmugMugRelationshipAuditLimit(value, fallback, max) {
  return getMusicSmugMugHealthLimit(value, fallback, max);
}

function createMusicSmugMugRelationshipAuditShell(generated, limits) {
  return buildAdminResponse({
    route: MUSIC_SMUGMUG_RELATIONSHIP_AUDIT_ROUTE,
    generated,
    source: 'postgres+smugmug',
    section: 'music',
    type: 'relationship_audit',
    readOnly: true,
    databaseMutated: false,
    summary: {
      bands_reviewed: 0,
      venues_reviewed: 0,
      expected_count: 0,
      warning_count: 0,
      action_needed_count: 0
    },
    bands: [],
    venues: [],
    warnings: [],
    recommendedActions: [],
    limits
  });
}

function addMusicSmugMugRelationshipAuditSummary(summary, severity) {
  if (severity === 'action_needed') summary.action_needed_count += 1;
  else if (severity === 'warning') summary.warning_count += 1;
  else summary.expected_count += 1;
}

function addUniqueMusicSmugMugRelationshipAction(actions, action) {
  const clean = String(action || '').trim();
  if (clean && !actions.includes(clean)) actions.push(clean);
}

function classifyMusicSmugMugBandRelationship(row) {
  const linkedShowCount = toIntegerCount(row && row.linked_show_count);
  const albumCount = toIntegerCount(row && row.album_count);
  const archivedSets = toIntegerCount(row && row.archived_sets);
  const totalSets = toIntegerCount(row && row.total_sets);
  const dbPhotoCount = toIntegerCount(row && row.photo_count);
  const hasArchiveSignal = archivedSets > 0 || totalSets > 0 || dbPhotoCount > 0;

  if (linkedShowCount <= 0) {
    return hasArchiveSignal
      ? { severity: 'warning', reason: 'Band has archive/set/photo indicators but no linked Music Shows were found.', recommended_action: 'Review source sheet relationship.' }
      : { severity: 'expected', reason: 'Legacy or incomplete band record with no linked Music Shows.', recommended_action: 'Legacy record; no action required.' };
  }

  if (albumCount <= 0) {
    return {
      severity: hasArchiveSignal ? 'action_needed' : 'warning',
      reason: 'Band has linked Music Shows, but none have usable album IDs.',
      recommended_action: 'Review SmugMug album mapping.'
    };
  }

  if (dbPhotoCount <= 0) {
    return {
      severity: 'warning',
      reason: 'Band has album-linked shows, but stored band photo_count is zero or unavailable.',
      recommended_action: 'Review SmugMug album mapping.'
    };
  }

  return null;
}

function classifyMusicSmugMugVenueRelationship(row) {
  const linkedShowCount = toIntegerCount(row && row.linked_show_count);
  const albumCount = toIntegerCount(row && row.album_count);
  const venueTotalInfo = getMusicVenueOfficialPhotoTotalInfo(row || {});
  const venueTotalPhotos = toIntegerCount(venueTotalInfo.value);

  if (linkedShowCount <= 0) {
    return venueTotalPhotos > 0
      ? { severity: 'action_needed', reason: 'Venue has an official photo total but no linked Music Shows were found.', recommended_action: 'Missing venue linkage.', venueTotalPhotos }
      : { severity: 'expected', reason: 'Venue has no linked Music Shows and no official photo total signal.', recommended_action: 'Legacy record; no action required.', venueTotalPhotos };
  }

  if (albumCount <= 0) {
    return {
      severity: venueTotalPhotos > 0 ? 'action_needed' : 'warning',
      reason: 'Venue has linked Music Shows, but none have usable album IDs.',
      recommended_action: 'Missing album linkage.',
      venueTotalPhotos
    };
  }

  return null;
}

function buildMusicSmugMugRelationshipFinalClassification(response) {
  if (response.ok === false || response.summary.action_needed_count > 0) return 'One additional cleanup pass recommended';
  if (response.summary.warning_count > 0) return 'Music SmugMug Integration COMPLETE with legacy archive exceptions';
  return 'Music SmugMug Integration COMPLETE';
}

async function maybeSampleMusicSmugMugRelationshipPhotos(albumRefs, photoLimit, debug, smugConfig, warnings) {
  if (!debug) return { checked: false, photo_count: 0, error: 'debug_not_enabled' };
  if (!smugConfig || !smugConfig.configured) return { checked: false, photo_count: 0, error: 'smugmug_not_configured' };
  const result = await verifyMusicSmugMugSampleAlbums(albumRefs, photoLimit, true, warnings);
  return {
    checked: true,
    album_id: result.album_id || null,
    photo_count: Array.isArray(result.photos) ? result.photos.length : 0,
    usable_photo_found: !!result.photo,
    error: result.error || ''
  };
}

async function buildMusicSmugMugRelationshipAuditResponse(query = {}) {
  const generated = new Date();
  const bandLimit = getMusicSmugMugRelationshipAuditLimit(query.band_limit || query.limit, 100, 500);
  const venueLimit = getMusicSmugMugRelationshipAuditLimit(query.venue_limit || query.limit, 100, 500);
  const photoLimit = getMusicSmugMugRelationshipAuditLimit(query.photo_limit, 5, 20);
  const debug = query.debug === '1' || query.debug === 'true';
  const limits = { band_limit: bandLimit, venue_limit: venueLimit, photo_limit: photoLimit, debug };
  const response = createMusicSmugMugRelationshipAuditShell(generated, limits);
  const warnings = response.warnings;
  const smugConfig = getSmugMugConfigDiagnostics();

  if (!smugConfig.configured) warnings.push(`SmugMug is not configured; live photo checks are skipped. Missing ${smugConfig.missing.join(', ')}.`);
  (smugConfig.warnings || []).forEach((warning) => warnings.push(`SmugMug: ${warning}`));

  if (!String(process.env.DATABASE_URL || '').trim()) {
    response.ok = false;
    warnings.push('DATABASE_URL is not configured; Music SmugMug relationship audit could not inspect PostgreSQL records.');
    response.finalClassification = buildMusicSmugMugRelationshipFinalClassification(response);
    return response;
  }

  try {
    await dbPool.query('SELECT 1');
  } catch (err) {
    response.ok = false;
    warnings.push(`Database disconnected: ${getSafeErrorMessage(err)}`);
    response.finalClassification = buildMusicSmugMugRelationshipFinalClassification(response);
    return response;
  }

  try {
    const tableNames = ['music_bands', 'music_shows', 'music_venues'];
    const existingTables = await getExistingPublicTables(tableNames);
    const columnsByTable = await getExistingPublicColumns(tableNames);
    const bandColumns = getSmugMusicTableColumns(columnsByTable, 'music_bands');
    const showColumns = getSmugMusicTableColumns(columnsByTable, 'music_shows');
    const venueColumns = getSmugMusicTableColumns(columnsByTable, 'music_venues');
    const showAlbumCondition = existingTables.has('music_shows') ? buildMusicSmugMugHealthAlbumLinkCondition(showColumns, 'ms') : 'false';
    const showSelect = existingTables.has('music_shows') ? [
      buildMusicSmugMugHealthShowSelect(showColumns, 'ms'),
      showColumns.has('show_url') ? 'ms.show_url AS show_url' : 'NULL AS show_url',
      showColumns.has('bands') ? 'ms.bands AS bands' : "'[]'::jsonb AS bands",
      showColumns.has('smug_albums') ? 'ms.smug_albums AS smug_albums' : "'[]'::jsonb AS smug_albums"
    ].join(', ') : '';

    if (existingTables.has('music_bands') && existingTables.has('music_shows') && bandColumns.has('band') && showColumns.has('bands')) {
      const bandIdExpr = bandColumns.has('band_id') ? 'band_id' : 'NULL::text AS band_id';
      const bandRegionExpr = bandColumns.has('region') ? 'region' : 'NULL::text AS region';
      const bandSmugFolderExpr = bandColumns.has('smug_folder') ? 'smug_folder' : 'NULL::text AS smug_folder';
      const archivedSetsExpr = bandColumns.has('archived_sets') ? 'archived_sets' : '0::int AS archived_sets';
      const totalSetsExpr = bandColumns.has('total_sets') ? 'total_sets' : '0::int AS total_sets';
      const photoCountExpr = bandColumns.has('photo_count') ? 'photo_count' : '0::int AS photo_count';
      const bandRows = await dbPool.query(`
        WITH band_base AS (
          SELECT ${bandIdExpr}, band, ${bandRegionExpr}, ${bandSmugFolderExpr}, ${archivedSetsExpr}, ${totalSetsExpr}, ${photoCountExpr}
          FROM music_bands
          WHERE trim(coalesce(band, '')) <> ''
        ), band_links AS (
          SELECT b.*,
                 count(ms.*)::int AS linked_show_count,
                 count(*) FILTER (WHERE ${showAlbumCondition})::int AS album_count
          FROM band_base b
          LEFT JOIN music_shows ms ON EXISTS (
            SELECT 1
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ms.bands) = 'array' THEN ms.bands ELSE '[]'::jsonb END) band_item
            WHERE lower(trim(coalesce(band_item->>'band', band_item->>'name', ''))) = lower(trim(b.band))
          )
          GROUP BY b.band_id, b.band, b.region, b.smug_folder, b.archived_sets, b.total_sets, b.photo_count
        )
        SELECT *
        FROM band_links
        WHERE linked_show_count = 0 OR album_count = 0 OR coalesce(photo_count, 0) = 0
        ORDER BY CASE WHEN linked_show_count = 0 THEN 0 WHEN album_count = 0 THEN 1 ELSE 2 END, band ASC
        LIMIT $1
      `, [bandLimit]);

      for (const row of diagnosticRows(bandRows)) {
        let classification = classifyMusicSmugMugBandRelationship(row);
        let photoSample = null;
        if (classification && toIntegerCount(row.album_count) > 0 && debug) {
          const linkedShows = await dbPool.query(`
            SELECT ${showSelect}
            FROM music_shows ms
            WHERE EXISTS (
              SELECT 1
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ms.bands) = 'array' THEN ms.bands ELSE '[]'::jsonb END) band_item
              WHERE lower(trim(coalesce(band_item->>'band', band_item->>'name', ''))) = lower(trim($1))
            )
              AND ${showAlbumCondition}
            ORDER BY ${getMusicSmugMugHealthShowOrderBy(showColumns, 'ms')}
            LIMIT $2
          `, [String(row.band || '').trim(), Math.min(5, photoLimit)]);
          const refs = diagnosticRows(linkedShows).flatMap(buildMusicSmugMugGalleryAlbumRefsFromShow);
          photoSample = await maybeSampleMusicSmugMugRelationshipPhotos(refs, photoLimit, debug, smugConfig, warnings);
          if (photoSample.checked && !photoSample.usable_photo_found) {
            classification = { severity: 'action_needed', reason: 'Band has album IDs, but sampled album photos did not produce a usable image URL.', recommended_action: 'Review SmugMug album mapping.' };
          } else if (photoSample.checked && photoSample.usable_photo_found && classification && /photo_count/.test(classification.reason)) {
            classification = null;
          }
        }
        if (!classification) continue;
        const item = {
          band_id: row.band_id == null ? '' : String(row.band_id),
          band_name: String(row.band || '').trim(),
          reason: classification.reason,
          severity: classification.severity,
          linked_show_count: toIntegerCount(row.linked_show_count),
          album_count: toIntegerCount(row.album_count),
          photo_count: photoSample && photoSample.checked ? toIntegerCount(photoSample.photo_count) : toIntegerCount(row.photo_count),
          recommended_action: classification.recommended_action
        };
        if (debug) item.photo_sample = photoSample || { checked: false, reason: 'not_sampled' };
        response.bands.push(item);
        addMusicSmugMugRelationshipAuditSummary(response.summary, item.severity);
        addUniqueMusicSmugMugRelationshipAction(response.recommendedActions, item.recommended_action);
      }
      if (response.bands.length >= bandLimit) warnings.push('band_limit reached; band relationship audit is sampled.');
    } else {
      warnings.push('Band relationship audit skipped; missing music_bands.band, music_shows.bands, or required tables.');
    }

    if (existingTables.has('music_venues') && existingTables.has('music_shows') && venueColumns.has('venue_key') && showColumns.has('venue_id')) {
      const albumCondition = buildMusicSmugMugHealthAlbumLinkCondition(showColumns, 'ms');
      const venueRows = await dbPool.query(`
        SELECT mv.venue_id, mv.venue_key, mv.venue, mv.city, mv.state, mv.stats, mv.raw_sheet,
               count(ms.*)::int AS linked_show_count,
               count(*) FILTER (WHERE ${albumCondition})::int AS album_count
        FROM music_venues mv
        LEFT JOIN music_shows ms ON lower(trim(coalesce(ms.venue_id, ''))) = lower(trim(coalesce(mv.venue_key, '')))
        WHERE trim(coalesce(mv.venue_key, '')) <> ''
        GROUP BY mv.venue_id, mv.venue_key, mv.venue, mv.city, mv.state, mv.stats, mv.raw_sheet
        HAVING count(ms.*) = 0 OR count(*) FILTER (WHERE ${albumCondition}) = 0
        ORDER BY CASE WHEN count(ms.*) = 0 THEN 0 ELSE 1 END, mv.venue ASC NULLS LAST
        LIMIT $1
      `, [venueLimit]);

      for (const row of diagnosticRows(venueRows)) {
        let classification = classifyMusicSmugMugVenueRelationship(row);
        let photoSample = null;
        if (classification && toIntegerCount(row.album_count) > 0 && debug) {
          const linkedShows = await dbPool.query(`
            SELECT ${showSelect}
            FROM music_shows ms
            WHERE lower(trim(coalesce(ms.venue_id, ''))) = lower(trim($1))
              AND ${buildMusicSmugMugHealthAlbumLinkCondition(showColumns, 'ms')}
            ORDER BY ${getMusicSmugMugHealthShowOrderBy(showColumns, 'ms')}
            LIMIT $2
          `, [String(row.venue_key || '').trim(), Math.min(5, photoLimit)]);
          const refs = diagnosticRows(linkedShows).flatMap(buildMusicSmugMugGalleryAlbumRefsFromShow);
          photoSample = await maybeSampleMusicSmugMugRelationshipPhotos(refs, photoLimit, debug, smugConfig, warnings);
          if (photoSample.checked && !photoSample.usable_photo_found) {
            classification = { severity: 'action_needed', reason: 'Venue has album-linked shows, but sampled album photos did not produce a usable image URL.', recommended_action: 'Review SmugMug album mapping.', venueTotalPhotos: getMusicVenueOfficialPhotoTotalInfo(row).value };
          } else if (photoSample.checked && photoSample.usable_photo_found) {
            classification = null;
          }
        }
        if (!classification) continue;
        const item = {
          venue_id: String(row.venue_key || row.venue_id || '').trim(),
          venue_name: String(row.venue || '').trim(),
          reason: classification.reason,
          severity: classification.severity,
          linked_show_count: toIntegerCount(row.linked_show_count),
          album_count: toIntegerCount(row.album_count),
          photo_count: photoSample && photoSample.checked ? toIntegerCount(photoSample.photo_count) : toIntegerCount(classification.venueTotalPhotos),
          recommended_action: classification.recommended_action
        };
        if (debug) item.photo_sample = photoSample || { checked: false, reason: 'not_sampled' };
        response.venues.push(item);
        addMusicSmugMugRelationshipAuditSummary(response.summary, item.severity);
        addUniqueMusicSmugMugRelationshipAction(response.recommendedActions, item.recommended_action);
      }
      if (response.venues.length >= venueLimit) warnings.push('venue_limit reached; venue relationship audit is sampled.');
    } else {
      warnings.push('Venue relationship audit skipped; missing music_venues.venue_key, music_shows.venue_id, or required tables.');
    }

    response.summary.bands_reviewed = response.bands.length;
    response.summary.venues_reviewed = response.venues.length;
    if (!response.recommendedActions.length) response.recommendedActions.push('No relationship cleanup actions found in sampled audit.');
  } catch (err) {
    response.ok = false;
    warnings.push(`Unable to build Music SmugMug relationship audit: ${getSafeErrorMessage(err)}`);
  }

  response.finalClassification = buildMusicSmugMugRelationshipFinalClassification(response);
  return response;
}

async function handleMusicSmugMugRelationshipAuditRequest(req, res) {
  try {
    return res.status(200).json(await buildMusicSmugMugRelationshipAuditResponse(req.query || {}));
  } catch (err) {
    return res.status(500).json(buildAdminError(MUSIC_SMUGMUG_RELATIONSHIP_AUDIT_ROUTE, err, {
      source: 'postgres+smugmug',
      section: 'music',
      type: 'relationship_audit',
      error: 'MUSIC_SMUGMUG_RELATIONSHIP_AUDIT_ERROR',
      readOnly: true,
      databaseMutated: false
    }));
  }
}
const SMUG_MUSIC_SHOW_CLASSIFICATION_BUCKETS = Object.freeze([
  'resolved',
  'pending_archive',
  'awaiting_upload',
  'resolver_error',
  'path_mismatch',
  'cover_missing',
  'legacy_smugmug_error',
  'no_candidate_album',
  'unknown_unresolved'
]);

const SMUG_MUSIC_SHOW_CLASSIFICATION_ACTIONS = Object.freeze({
  resolved: 'No action needed yet.',
  pending_archive: 'Upload/archive photos when ready, then run the Music Shows SmugMug resolver.',
  awaiting_upload: 'Upload the missing SmugMug album for the attempted band/date path, then retry resolver.',
  resolver_error: 'Retry resolver; if it repeats, inspect the SmugMug API error and resolver code path.',
  path_mismatch: 'Check SmugMug folder path, band region, band folder name, and show date mapping.',
  cover_missing: 'Refresh cover metadata or inspect album highlight image availability.',
  legacy_smugmug_error: 'Retry resolver with the current deterministic band/date resolver; old image-key errors are not archive absence proof.',
  no_candidate_album: 'Inspect band/date mapping; resolver could not build a usable album candidate.',
  unknown_unresolved: 'Inspect this record manually before treating it as a resolver bug.'
});

function getSmugMusicShowClassificationSampleLimit(value) {
  const limit = Number(String(value || '').trim());
  if (!Number.isInteger(limit)) return 10;
  return Math.min(25, Math.max(1, limit));
}

function normalizeSmugMusicShowClassificationStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function getSmugMusicShowClassificationAlbums(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
    } catch (err) {
      return [];
    }
  }
  return [];
}

function getUniqueSmugMusicShowClassificationValues(values) {
  const out = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const clean = String(value || '').trim();
    if (clean && !out.includes(clean)) out.push(clean);
  });
  return out;
}

function getSmugMusicShowClassificationAttemptedPaths(albums) {
  return getUniqueSmugMusicShowClassificationValues(
    (Array.isArray(albums) ? albums : []).map((album) => album && album.smug_path)
  );
}

function getSmugMusicShowClassificationAlbumStatuses(albums) {
  return getUniqueSmugMusicShowClassificationValues(
    (Array.isArray(albums) ? albums : []).map((album) => album && album.status)
  );
}

function sanitizeSmugMusicShowClassificationError(value) {
  const clean = String(value || '').replace(/APIKey=[^"&\s]+/gi, 'APIKey=REDACTED').replace(/\s+/g, ' ').trim();
  return clean.length > 260 ? `${clean.slice(0, 260)}...` : clean;
}

function getSmugMusicShowClassificationAction(bucket) {
  return SMUG_MUSIC_SHOW_CLASSIFICATION_ACTIONS[bucket] || SMUG_MUSIC_SHOW_CLASSIFICATION_ACTIONS.unknown_unresolved;
}

function classifySmugMusicShowSnapshotRow(row) {
  const status = normalizeSmugMusicShowClassificationStatus(row && row.smug_sync_status);
  const albums = getSmugMusicShowClassificationAlbums(row && row.smug_albums);
  const attemptedPaths = getSmugMusicShowClassificationAttemptedPaths(albums);
  const albumStatuses = getSmugMusicShowClassificationAlbumStatuses(albums);
  const normalizedAlbumStatuses = albumStatuses.map((item) => normalizeSmugMusicShowClassificationStatus(item));
  const albumId = String(row && row.album_id || '').trim();
  const galleryId = String(row && row.gallery_id || '').trim();
  const coverImageUrl = String(row && row.cover_image_url || '').trim();
  const photoCount = toIntegerCount(row && row.photo_count);
  const syncError = sanitizeSmugMusicShowClassificationError(row && row.smug_sync_error);
  const hasResolvedArchive = !!(albumId || galleryId || photoCount > 0);
  const hasParentFolderMiss = normalizedAlbumStatuses.some((item) => /parent_folder_not_found|folder_not_found/.test(item));
  const hasAlbumNotFound = normalizedAlbumStatuses.some((item) => /album_not_found/.test(item));
  const hasOnlyAlbumNotFound = hasAlbumNotFound && !hasParentFolderMiss;
  const hasDuplicateMatch = normalizedAlbumStatuses.some((item) => /duplicate/.test(item));
  const hasLegacyImageError = /raw_photo_source_no_album_context|no_image_key|no_album_key|\/image\//i.test(`${status} ${syncError}`);

  let bucket = 'unknown_unresolved';
  let reason = 'Unresolved state does not match a known diagnostic pattern.';

  if (hasResolvedArchive) {
    bucket = 'resolved';
    reason = 'Album/gallery snapshot fields are populated.';
  } else if (!status) {
    bucket = 'pending_archive';
    reason = 'No resolver status is stored yet; this record has not been classified by the current resolver.';
  } else if (status === 'no_resolved_band_albums') {
    if (!attemptedPaths.length) {
      bucket = 'no_candidate_album';
      reason = 'Resolver stored no candidate album paths.';
    } else if (hasParentFolderMiss || hasDuplicateMatch) {
      bucket = 'path_mismatch';
      reason = 'Resolver attempted paths, but one or more parent folders or matches did not line up.';
    } else if (hasOnlyAlbumNotFound) {
      bucket = 'awaiting_upload';
      reason = 'Band folders appear usable, but the specific date album was not found.';
    } else {
      bucket = 'unknown_unresolved';
      reason = 'Resolver attempted album paths, but no album resolved.';
    }
  } else if (['missing_date_folder', 'missing_bands', 'no_source_url'].includes(status)) {
    bucket = 'no_candidate_album';
    reason = 'Resolver could not build a deterministic band/date album candidate.';
  } else if (['raw_photo_source_no_album_context', 'no_image_key', 'no_album_key', 'skipped_logo_source', 'skipped_venue_logo_source'].includes(status) || hasLegacyImageError) {
    bucket = 'legacy_smugmug_error';
    reason = 'Stored status/error came from the older image-key/source-url resolver path.';
  } else if (status === 'error') {
    bucket = 'resolver_error';
    reason = 'A resolver error is stored and no archive snapshot fields are populated.';
  } else if (/path|folder|not_found/.test(status)) {
    bucket = 'path_mismatch';
    reason = 'Stored status suggests a SmugMug path or folder mismatch.';
  }

  const coverMissing = hasResolvedArchive && !coverImageUrl;

  return {
    bucket,
    reason,
    recommended_action: getSmugMusicShowClassificationAction(bucket),
    cover_missing: coverMissing,
    cover_missing_action: coverMissing ? getSmugMusicShowClassificationAction('cover_missing') : '',
    stored_status: status,
    attempted_paths: attemptedPaths,
    attempted_path: attemptedPaths[0] || '',
    album_statuses: albumStatuses,
    sync_error: syncError,
    photo_count: photoCount
  };
}

function createSmugMusicShowClassificationBuckets(sampleLimit) {
  const buckets = {};
  SMUG_MUSIC_SHOW_CLASSIFICATION_BUCKETS.forEach((bucket) => {
    buckets[bucket] = {
      count: 0,
      recommended_action: getSmugMusicShowClassificationAction(bucket),
      samples: []
    };
  });
  return buckets;
}

function buildSmugMusicShowClassificationSample(row, classification) {
  return {
    show_id: row && row.show_id != null ? toIntegerCount(row.show_id) : null,
    name: row && row.name ? row.name : '',
    date: row && row.date ? row.date : '',
    bucket: classification.bucket,
    reason: classification.reason,
    recommended_action: classification.recommended_action,
    stored_status: classification.stored_status,
    album_id: row && row.album_id ? row.album_id : '',
    gallery_id: row && row.gallery_id ? row.gallery_id : '',
    photo_count: classification.photo_count,
    cover_image_url_present: !!String(row && row.cover_image_url || '').trim(),
    smug_last_synced_at: formatStatusTimestamp(row && row.smug_last_synced_at),
    attempted_path: classification.attempted_path,
    attempted_paths: classification.attempted_paths.slice(0, 5),
    album_statuses: classification.album_statuses.slice(0, 5),
    smug_sync_error: classification.sync_error
  };
}

function getSmugMusicShowClassificationSelect(columns, columnName, fallbackExpression) {
  return columns.has(columnName) ? columnName : `${fallbackExpression} AS ${columnName}`;
}

async function buildSmugMusicShowClassificationResponse(query = {}) {
  const generated = new Date();
  const route = '/api/admin/diagnostics/music/smugmug-shows/classification';
  const warnings = [];
  const sampleLimit = getSmugMusicShowClassificationSampleLimit(query.sample_limit || query.samples || query.limit);
  const buckets = createSmugMusicShowClassificationBuckets(sampleLimit);
  const response = buildAdminResponse({
    route,
    generated,
    source: 'postgres',
    section: 'music',
    type: 'smug_show_classification',
    readOnly: true,
    databaseMutated: false,
    sampleLimit,
    summary: {
      databaseConnected: false,
      total_shows: 0,
      resolved_count: 0,
      pending_archive_count: 0,
      awaiting_upload_count: 0,
      pending_or_unbuilt_count: 0,
      resolver_error_count: 0,
      path_mismatch_count: 0,
      cover_missing_count: 0,
      legacy_error_count: 0,
      no_candidate_album_count: 0,
      unknown_unresolved_count: 0
    },
    buckets,
    warnings
  });

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('DATABASE_URL is not configured; Music show SmugMug classification skipped.');
    return response;
  }

  const existingTables = await getExistingPublicTables(['music_shows']);
  if (!existingTables.has('music_shows')) {
    response.summary.databaseConnected = true;
    warnings.push('Missing table for Music show SmugMug classification: music_shows');
    return response;
  }

  const columnsByTable = await getExistingPublicColumns(['music_shows']);
  const columns = getSmugMusicTableColumns(columnsByTable, 'music_shows');
  const selectFields = [
    getSmugMusicShowClassificationSelect(columns, 'id', 'NULL::int'),
    getSmugMusicShowClassificationSelect(columns, 'show_id', 'NULL::int'),
    getSmugMusicShowClassificationSelect(columns, 'name', "''::text"),
    getSmugMusicShowClassificationSelect(columns, 'date', "''::text"),
    getSmugMusicShowClassificationSelect(columns, 'gallery_id', "''::text"),
    getSmugMusicShowClassificationSelect(columns, 'album_id', "''::text"),
    getSmugMusicShowClassificationSelect(columns, 'cover_image_url', "''::text"),
    getSmugMusicShowClassificationSelect(columns, 'photo_count', '0::int'),
    getSmugMusicShowClassificationSelect(columns, 'smug_last_synced_at', 'NULL::timestamptz'),
    getSmugMusicShowClassificationSelect(columns, 'smug_sync_status', "''::text"),
    getSmugMusicShowClassificationSelect(columns, 'smug_sync_error', "''::text"),
    getSmugMusicShowClassificationSelect(columns, 'smug_albums', "'[]'::jsonb")
  ];
  const orderBy = columns.has('show_id') ? 'show_id ASC NULLS LAST' : 'name ASC NULLS LAST';
  const result = await dbPool.query(`SELECT ${selectFields.join(', ')} FROM music_shows ORDER BY ${orderBy}`);
  const rows = result.rows || [];

  response.summary.databaseConnected = true;
  response.summary.total_shows = rows.length;

  rows.forEach((row) => {
    const classification = classifySmugMusicShowSnapshotRow(row);
    const sample = buildSmugMusicShowClassificationSample(row, classification);
    const bucket = buckets[classification.bucket] ? classification.bucket : 'unknown_unresolved';
    buckets[bucket].count += 1;
    if (buckets[bucket].samples.length < sampleLimit) buckets[bucket].samples.push(sample);

    if (classification.cover_missing) {
      buckets.cover_missing.count += 1;
      if (buckets.cover_missing.samples.length < sampleLimit) {
        buckets.cover_missing.samples.push({
          ...sample,
          bucket: 'cover_missing',
          reason: 'Album/gallery fields are populated, but cover_image_url is missing.',
          recommended_action: getSmugMusicShowClassificationAction('cover_missing')
        });
      }
    }
  });

  response.summary.resolved_count = buckets.resolved.count;
  response.summary.pending_archive_count = buckets.pending_archive.count;
  response.summary.awaiting_upload_count = buckets.awaiting_upload.count;
  response.summary.pending_or_unbuilt_count = buckets.pending_archive.count + buckets.awaiting_upload.count;
  response.summary.resolver_error_count = buckets.resolver_error.count;
  response.summary.path_mismatch_count = buckets.path_mismatch.count;
  response.summary.cover_missing_count = buckets.cover_missing.count;
  response.summary.legacy_error_count = buckets.legacy_smugmug_error.count;
  response.summary.no_candidate_album_count = buckets.no_candidate_album.count;
  response.summary.unknown_unresolved_count = buckets.unknown_unresolved.count;
  response.summary.cover_missing_is_overlay = true;
  response.summary.statusesRenamed = false;
  response.summary.note = 'This diagnostic classifies existing rows only; it does not update smug_sync_status or write to the database.';
  response.recommendedActions = SMUG_MUSIC_SHOW_CLASSIFICATION_ACTIONS;
  response.warnings = warnings;

  return response;
}
const SMUG_MUSIC_SHOW_REPAIR_DEFAULT_LIMIT = 25;
const SMUG_MUSIC_SHOW_REPAIR_MAX_LIMIT = 100;
const SMUG_MUSIC_SHOW_REPAIR_BUCKETS = Object.freeze(['legacy_smugmug_error', 'cover_missing']);

function getSmugMusicShowRepairLimit(value) {
  const limit = Number(String(value || '').trim());
  if (!Number.isInteger(limit)) return SMUG_MUSIC_SHOW_REPAIR_DEFAULT_LIMIT;
  return Math.min(SMUG_MUSIC_SHOW_REPAIR_MAX_LIMIT, Math.max(1, limit));
}

function isSmugMusicShowRepairDryRun(query = {}) {
  const value = String(query.dry_run == null ? query.dryRun : query.dry_run).trim().toLowerCase();
  return !['false', '0', 'no'].includes(value);
}

function getSmugMusicShowRepairRequestedBuckets(query = {}) {
  const raw = String(query.bucket || query.buckets || '').trim();
  if (!raw) return Array.from(SMUG_MUSIC_SHOW_REPAIR_BUCKETS);
  const requested = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const allowed = requested.filter((item) => SMUG_MUSIC_SHOW_REPAIR_BUCKETS.includes(item));
  return allowed.length ? Array.from(new Set(allowed)) : Array.from(SMUG_MUSIC_SHOW_REPAIR_BUCKETS);
}

function buildSmugMusicShowRepairTargetItem(row, classification) {
  return {
    show_id: row && row.show_id != null ? toIntegerCount(row.show_id) : null,
    name: row && row.name ? row.name : '',
    date: row && row.date ? row.date : '',
    bucket: classification.bucket,
    cover_missing: classification.cover_missing,
    stored_status: classification.stored_status,
    album_id: row && row.album_id ? row.album_id : '',
    gallery_id: row && row.gallery_id ? row.gallery_id : '',
    photo_count: classification.photo_count,
    attempted_paths: classification.attempted_paths.slice(0, 5),
    album_statuses: classification.album_statuses.slice(0, 5),
    reason: classification.reason,
    recommended_action: classification.recommended_action
  };
}

async function getSmugMusicShowRepairCandidateRows(scanLimit) {
  const result = await dbPool.query(`
    SELECT id, show_id, name, date, poster, show_url, raw_sheet, bands, stats,
           gallery_id, album_id, cover_image_url, photo_count, smug_albums,
           smug_last_synced_at, smug_sync_status, smug_sync_error
    FROM music_shows
    WHERE (
        trim(coalesce(album_id, '')) = ''
        AND trim(coalesce(gallery_id, '')) = ''
        AND (
          lower(trim(coalesce(smug_sync_status, ''))) IN ('error', 'raw_photo_source_no_album_context', 'no_image_key', 'no_album_key', 'skipped_logo_source', 'skipped_venue_logo_source')
          OR coalesce(smug_sync_error, '') ILIKE '%/image/%'
          OR coalesce(smug_sync_error, '') ILIKE '%raw_photo_source_no_album_context%'
        )
      )
      OR (
        (
          trim(coalesce(album_id, '')) <> ''
          OR trim(coalesce(gallery_id, '')) <> ''
          OR coalesce(photo_count, 0) > 0
        )
        AND trim(coalesce(cover_image_url, '')) = ''
      )
    ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
    LIMIT $1
  `, [scanLimit]);
  return result.rows || [];
}

function getSmugMusicShowRepairTargets(rows, requestedBuckets, limit) {
  const targets = [];
  const requested = new Set(requestedBuckets);
  for (const row of rows || []) {
    const classification = classifySmugMusicShowSnapshotRow(row);
    let bucket = '';
    if (classification.bucket === 'legacy_smugmug_error' && requested.has('legacy_smugmug_error')) bucket = 'legacy_smugmug_error';
    else if (classification.cover_missing && requested.has('cover_missing')) bucket = 'cover_missing';
    if (!bucket) continue;

    targets.push({ row, bucket, classification });
    if (targets.length >= limit) break;
  }
  return targets;
}

function buildSmugMusicShowRepairMapping(candidate, resolved, lineup) {
  return {
    band: candidate.band,
    band_id: candidate.band_id || '',
    slot: candidate.slot,
    bandViewCount: lineup && lineup.bandViewCount != null ? toIntegerCount(lineup.bandViewCount) : null,
    lineupBand: lineup && lineup.band ? lineup.band : '',
    lineupSlot: lineup && lineup.slot != null ? toIntegerCount(lineup.slot) : null,
    region: candidate.region,
    region_source: candidate.region_source,
    band_folder: candidate.band_folder,
    date_folder: candidate.date_folder,
    smug_path: candidate.smug_path,
    album_id: resolved.album_id || '',
    gallery_id: resolved.gallery_id || '',
    album_url: resolved.album_url || '',
    album_title: resolved.album_title || '',
    photo_count: toIntegerCount(resolved.photo_count),
    cover_image_url: resolved.cover_image_url || '',
    status: resolved.status || 'unresolved',
    endpoint: resolved.endpoint || '',
    api_url_before_api_key: resolved.api_url_before_api_key || '',
    childAlbumCount: resolved.childAlbumCount == null ? null : toIntegerCount(resolved.childAlbumCount),
    duplicateMatchCount: resolved.duplicateMatchCount == null ? null : toIntegerCount(resolved.duplicateMatchCount),
    error: resolved.error || ''
  };
}

async function repairSmugMusicShowLegacyError(row, bandLookup, dryRun) {
  const { dateFolder, candidates, regionFallbackUsed } = getSmugMusicShowAlbumCandidates(row, bandLookup);
  const target = buildSmugMusicShowRepairTargetItem(row, classifySmugMusicShowSnapshotRow(row));

  if (!dateFolder || !candidates.length) {
    return {
      ...target,
      repair_type: 'legacy_smugmug_error',
      dry_run: dryRun,
      would_update: false,
      updated: false,
      status: 'no_candidate_album',
      message: !dateFolder ? 'Missing date folder; no deterministic repair attempted.' : 'Missing band candidates; no deterministic repair attempted.'
    };
  }

  const lineupBands = Array.isArray(row && row.bands) ? row.bands : [];
  const mappings = [];
  for (const candidate of candidates) {
    const lineup = findMusicShowLineupBandForAlbum(candidate, lineupBands);
    const resolved = await resolveSmugAlbumByPath(candidate.smug_path);
    mappings.push(buildSmugMusicShowRepairMapping(candidate, resolved, lineup));
  }

  const resolvedMappings = mappings.filter((mapping) => mapping.album_id && /^resolved/i.test(mapping.status));
  if (!resolvedMappings.length) {
    return {
      ...target,
      repair_type: 'legacy_smugmug_error',
      dry_run: dryRun,
      would_update: false,
      updated: false,
      status: 'still_unresolved',
      message: 'Current deterministic resolver did not find an album; existing legacy error was left unchanged.',
      region_fallback_used: regionFallbackUsed,
      attempted_paths: mappings.map((mapping) => mapping.smug_path).filter(Boolean).slice(0, 10),
      smug_albums: mappings
    };
  }

  const first = resolvedMappings[0];
  const photoCount = resolvedMappings.reduce((total, mapping) => total + toIntegerCount(mapping.photo_count), 0);
  const coverImageUrl = resolvedMappings.map((mapping) => mapping.cover_image_url).find((value) => String(value || '').trim()) || getSmugMusicShowResolvedCoverImageUrl(null, '', row);
  const stats = buildSmugMusicShowStatsSnapshot(row, photoCount);
  let updated = null;

  if (!dryRun) {
    updated = await updateSmugMusicShowSnapshot(row, {
      gallery_id: first.gallery_id || first.album_id,
      album_id: first.album_id,
      cover_image_url: coverImageUrl,
      photo_count: photoCount,
      stats,
      smug_albums: mappings,
      smug_sync_status: 'resolved',
      smug_sync_error: null
    });
  }

  return {
    ...target,
    repair_type: 'legacy_smugmug_error',
    dry_run: dryRun,
    would_update: true,
    updated: !!updated,
    status: dryRun ? 'would_resolve' : (updated ? 'resolved' : 'not_updated'),
    message: dryRun ? 'Dry run found a deterministic album match; no database update was made.' : 'Legacy error replaced with resolved album snapshot.',
    album_id: first.album_id,
    gallery_id: first.gallery_id || first.album_id,
    photo_count: photoCount,
    cover_image_url_present: !!String(coverImageUrl || '').trim(),
    region_fallback_used: regionFallbackUsed,
    attempted_paths: mappings.map((mapping) => mapping.smug_path).filter(Boolean).slice(0, 10),
    resolved_album_count: resolvedMappings.length,
    unresolved_album_count: mappings.length - resolvedMappings.length,
    smug_albums: mappings
  };
}

async function updateSmugMusicShowCoverOnly(row, coverImageUrl) {
  const result = await dbPool.query(`
    UPDATE music_shows
    SET cover_image_url = $2,
        updated_at = NOW()
    WHERE id = $1
      AND trim(coalesce(cover_image_url, '')) = ''
      AND (
        trim(coalesce(album_id, '')) <> ''
        OR trim(coalesce(gallery_id, '')) <> ''
        OR coalesce(photo_count, 0) > 0
      )
    RETURNING id, show_id, name, date, gallery_id, album_id, cover_image_url, photo_count, stats, smug_albums, smug_last_synced_at, smug_sync_status, smug_sync_error
  `, [row.id, coverImageUrl]);
  return result.rows && result.rows[0] ? result.rows[0] : null;
}

async function repairSmugMusicShowMissingCover(row, dryRun) {
  const classification = classifySmugMusicShowSnapshotRow(row);
  const target = buildSmugMusicShowRepairTargetItem(row, { ...classification, bucket: 'cover_missing' });
  const albumId = String(row && (row.album_id || row.gallery_id) || '').trim();

  if (!albumId) {
    return {
      ...target,
      repair_type: 'cover_missing',
      dry_run: dryRun,
      would_update: false,
      updated: false,
      status: 'missing_album_id',
      message: 'Cover repair skipped because the show has no album_id/gallery_id.'
    };
  }

  let metadata = null;
  try {
    metadata = await fetchSmugAlbumMetadata(albumId);
  } catch (err) {
    return {
      ...target,
      repair_type: 'cover_missing',
      dry_run: dryRun,
      would_update: false,
      updated: false,
      status: 'metadata_error',
      message: getSafeErrorMessage(err)
    };
  }

  const coverImageUrl = getSmugAlbumCoverImageUrl(metadata) || '';
  if (!isUsableShowImageUrl(coverImageUrl)) {
    return {
      ...target,
      repair_type: 'cover_missing',
      dry_run: dryRun,
      would_update: false,
      updated: false,
      status: 'cover_still_missing',
      message: 'Album metadata did not include a usable cover image URL.'
    };
  }

  let updated = null;
  if (!dryRun) updated = await updateSmugMusicShowCoverOnly(row, coverImageUrl);

  return {
    ...target,
    repair_type: 'cover_missing',
    dry_run: dryRun,
    would_update: true,
    updated: !!updated,
    status: dryRun ? 'would_update_cover' : (updated ? 'cover_updated' : 'not_updated'),
    message: dryRun ? 'Dry run found a cover image; no database update was made.' : 'cover_image_url updated while preserving existing album/gallery/photo fields.',
    cover_image_url: coverImageUrl
  };
}

async function runSmugMusicShowRepair(query = {}) {
  const generated = new Date();
  const route = '/api/admin/smug/music/shows/repair';
  const warnings = [];
  const dryRun = isSmugMusicShowRepairDryRun(query);
  const limit = getSmugMusicShowRepairLimit(query.limit);
  const requestedBuckets = getSmugMusicShowRepairRequestedBuckets(query);
  const config = getSmugMugConfigDiagnostics();
  const response = buildAdminResponse({
    route,
    generated,
    source: 'smugmug',
    section: 'music',
    type: 'smug_show_repair',
    dry_run: dryRun,
    databaseMutated: false,
    targetBuckets: requestedBuckets,
    limit,
    summary: {
      scanned: 0,
      targeted: 0,
      legacy_targets: 0,
      cover_missing_targets: 0,
      expected_updates: 0,
      records_updated: 0,
      still_unresolved: 0,
      cover_still_missing: 0,
      failed: 0,
      skipped: 0
    },
    results: [],
    warnings,
    classificationRoute: '/api/admin/diagnostics/music/smugmug-shows/classification'
  });

  if (!String(process.env.DATABASE_URL || '').trim()) {
    response.ok = false;
    response.error = 'DATABASE_NOT_CONFIGURED';
    response.message = 'DATABASE_URL is required for Music Show SmugMug repair.';
    return response;
  }

  if (!config.configured) {
    response.ok = false;
    response.error = 'SMUGMUG_NOT_CONFIGURED';
    response.message = 'SMUG_API_KEY and SMUG_NICKNAME are required for Music Show SmugMug repair.';
    response.missing = config.missing;
    return response;
  }

  const snapshotFields = await inspectSmugMusicSnapshotFields(warnings);
  if (!snapshotFields.present) {
    response.ok = false;
    response.error = 'SNAPSHOT_FIELDS_MISSING';
    response.message = 'Music show SmugMug snapshot fields are missing.';
    response.snapshotFields = snapshotFields;
    return response;
  }

  const scanLimit = Math.min(500, Math.max(limit * 5, limit));
  const candidateRows = await getSmugMusicShowRepairCandidateRows(scanLimit);
  const targets = getSmugMusicShowRepairTargets(candidateRows, requestedBuckets, limit);
  const bandLookup = targets.some((target) => target.bucket === 'legacy_smugmug_error')
    ? await getSmugMusicShowBandLookup(targets.map((target) => target.row))
    : new Map();

  response.summary.scanned = candidateRows.length;
  response.summary.targeted = targets.length;
  response.summary.legacy_targets = targets.filter((target) => target.bucket === 'legacy_smugmug_error').length;
  response.summary.cover_missing_targets = targets.filter((target) => target.bucket === 'cover_missing').length;

  const results = await mapWithConcurrency(targets, SMUG_REQUEST_CONCURRENCY, async (target) => {
    try {
      if (target.bucket === 'legacy_smugmug_error') return await repairSmugMusicShowLegacyError(target.row, bandLookup, dryRun);
      if (target.bucket === 'cover_missing') return await repairSmugMusicShowMissingCover(target.row, dryRun);
      return {
        ...buildSmugMusicShowRepairTargetItem(target.row, target.classification),
        dry_run: dryRun,
        would_update: false,
        updated: false,
        status: 'skipped_bucket',
        message: 'Bucket is not part of this repair route.'
      };
    } catch (err) {
      return {
        ...buildSmugMusicShowRepairTargetItem(target.row, target.classification),
        dry_run: dryRun,
        would_update: false,
        updated: false,
        status: 'failed',
        message: getSafeErrorMessage(err)
      };
    }
  });

  response.results = results;
  response.summary.expected_updates = results.filter((item) => item.would_update).length;
  response.summary.records_updated = results.filter((item) => item.updated).length;
  response.summary.still_unresolved = results.filter((item) => item.status === 'still_unresolved').length;
  response.summary.cover_still_missing = results.filter((item) => item.status === 'cover_still_missing').length;
  response.summary.failed = results.filter((item) => item.status === 'failed' || item.status === 'metadata_error').length;
  response.summary.skipped = results.filter((item) => /^missing_|skipped_|not_updated/.test(String(item.status || ''))).length;
  response.databaseMutated = !dryRun && response.summary.records_updated > 0;
  response.message = dryRun
    ? 'Dry run complete. Re-run with dry_run=false to apply only the listed updates.'
    : 'Repair run complete. Only targeted legacy error and cover-missing records were eligible for updates.';
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
        stats = coalesce(stats, '{}'::jsonb) || $8::jsonb,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, band_id, band, gallery_id, album_id, cover_image_url, photo_count, smug_last_synced_at, smug_sync_status, smug_sync_error, stats
  `, [
    row.id,
    snapshot.gallery_id || null,
    snapshot.album_id || null,
    snapshot.cover_image_url || null,
    toIntegerCount(snapshot.photo_count),
    snapshot.smug_sync_status || 'synced',
    snapshot.smug_sync_error || null,
    stringifyDbJson(snapshot.archive_coverage || {})
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

async function discoverSmugMusicBand(row, forceRefresh = false) {
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
      archive_coverage: createEmptyMusicBandArchiveCoverage(),
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
      archive_coverage: createEmptyMusicBandArchiveCoverage(),
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
  const archiveCoverage = await fetchMusicBandArchiveCoverage(row, albums, forceRefresh);
  const coverImageUrl = albums.map(getSmugAlbumCoverImageUrl).find(Boolean) || row.cover_image_url || row.logo_url || null;
  const duplicateMatch = albums.length > 1;
  const updated = await updateSmugMusicBandSnapshot(row, {
    gallery_id: galleryId,
    album_id: albumIds.join(';') || null,
    cover_image_url: coverImageUrl,
    photo_count: photoCount == null ? 0 : photoCount,
    archive_coverage: archiveCoverage,
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
  const archiveCoverage = getMusicBandArchiveCoverageFromStats(row && row.stats);
  return {
    band_id: row && row.band_id ? row.band_id : '',
    band: row && row.band ? row.band : '',
    gallery_id: row && row.gallery_id ? row.gallery_id : null,
    album_id: row && row.album_id ? row.album_id : null,
    cover_image_url: row && row.cover_image_url ? row.cover_image_url : null,
    photo_count: toIntegerCount(row && row.photo_count),
    archive_coverage: Object.keys(archiveCoverage).length ? archiveCoverage : createEmptyMusicBandArchiveCoverage(),
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
      const result = await discoverSmugMusicBand(row, refresh);
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
  return String(value || '').trim();
}

function getBareSmugImageKey(value) {
  return String(value || '').trim().replace(/^i-/i, '');
}

function getSmugImageKeyCandidates(value) {
  const bareKey = getBareSmugImageKey(value);
  return bareKey ? [bareKey] : [];
}
function buildSmugImageDetailEndpointFromSegment(segment) {
  const clean = String(segment || '').trim();
  if (!clean) return '';
  return `/image/${encodeURIComponent(clean)}?_accept=application/json&_verbosity=1&_expand=Image`;
}

function buildSmugImageDetailEndpoints(imageKey) {
  const keyCandidates = getSmugImageKeyCandidates(imageKey);
  const endpointSegments = [];

  keyCandidates.forEach((candidate) => {
    endpointSegments.push(`${candidate}-0`);
  });

  const seen = new Set();
  return endpointSegments
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
  const attemptedImageKeys = getSmugImageKeyCandidates(imageKey);
  const endpoints = buildSmugImageDetailEndpoints(imageKey);
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const json = await fetchSmugJson(endpoint);
      return { json, endpoint, endpoints, attemptedImageKeys };
    } catch (err) {
      lastError = err;
      if (!isSmugHttpStatusError(err, 404)) {
        err.attemptedImageKeys = attemptedImageKeys;
        err.imageEndpointAttempts = endpoints;
        throw err;
      }
    }
  }

  const message = lastError && lastError.message ? lastError.message : 'No SmugMug image detail endpoints were available.';
  const error = new Error(`${message} Tried image endpoints: ${endpoints.join(', ')}`);
  error.attemptedImageKeys = attemptedImageKeys;
  error.imageEndpointAttempts = endpoints;
  error.cause = lastError || undefined;
  throw error;
}

function extractSmugImageKeyFromUrl(url) {
  const clean = String(url || '').trim();
  if (!clean) return '';

  const direct = clean.match(/\b\/i-([A-Za-z0-9]+)\b/i);
  if (direct && direct[1]) return String(direct[1]).trim();

  const fileStyle = clean.match(/\/(?:i-)?([A-Za-z0-9]+)-[A-Za-z0-9]+\.(?:jpe?g|png|gif|webp)(?:\?|#|$)/i);
  if (fileStyle && fileStyle[1]) return String(fileStyle[1]).trim();

  const segmentStyle = clean.match(/\/\d+-(?:i-)?([A-Za-z0-9]+)(?:\/|$)/i);
  if (segmentStyle && segmentStyle[1]) return String(segmentStyle[1]).trim();

  return '';
}
function extractSmugAlbumKeyFromUrl(url) {
  const clean = String(url || '').trim();
  if (!clean) return '';

  const direct = clean.match(/\/album\/([^/?#]+)/i);
  if (direct && direct[1]) {
    try {
      return decodeURIComponent(String(direct[1]).trim());
    } catch (_) {
      return String(direct[1]).trim();
    }
  }

  const queryMatch = clean.match(/[?&]album(?:_id|id|key)?=([^&#]+)/i);
  if (queryMatch && queryMatch[1]) {
    try {
      return decodeURIComponent(String(queryMatch[1]).trim());
    } catch (_) {
      return String(queryMatch[1]).trim();
    }
  }

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

function isSmugRawPhotoCdnUrl(url) {
  const decoded = decodeSmugSourceUrlForChecks(url);
  if (!decoded) return false;
  return /^https?:\/\/photos\.smugmug\.com\/photos\//i.test(decoded);
}

function getSmugMusicShowSourceSkip(candidate) {
  const url = String(candidate && candidate.url || '').trim();
  if (!url) return null;
  if (isSmugMusicShowVenueLogoSourceUrl(url)) {
    return { status: 'skipped_venue_logo_source', field: candidate.field, url };
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

  const chooseCandidate = (candidate, sourceType) => {
    const url = String(candidate.url || '').trim();
    if (!url) return null;
    const skip = getSmugMusicShowSourceSkip({ field: candidate.field, url });
    if (skip) {
      if (skip.status === 'skipped_venue_logo_source' && !skippedVenueLogoSource) skippedVenueLogoSource = skip;
      return null;
    }
    return {
      status: 'selected',
      url,
      field: candidate.field,
      source_type: sourceType,
      poster_fallback: sourceType === 'poster' || isSmugMusicShowPosterField(candidate.field),
      skipped_url: skippedVenueLogoSource ? skippedVenueLogoSource.url : '',
      skipped_field: skippedVenueLogoSource ? skippedVenueLogoSource.field : '',
      skipped_status: skippedVenueLogoSource ? skippedVenueLogoSource.status : ''
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

  return { status: 'no_source_url', url: '', field: '', skipped_url: '', poster_fallback: false };
}
function getSmugMusicShowSourceUrl(row) {
  return getSmugMusicShowSourceSelection(row).url;
}

function buildSmugMusicShowResolveDiagnostic(row, status, extra = {}) {
  const attemptedAlbumPaths = Array.isArray(extra.attempted_album_paths)
    ? extra.attempted_album_paths
    : Array.isArray(extra.album_path_attempts)
      ? extra.album_path_attempts
      : Array.isArray(extra.smug_albums)
        ? extra.smug_albums.map((item) => item && item.smug_path).filter(Boolean)
        : [];
  const hasAlbumPathDiagnostics = attemptedAlbumPaths.length > 0 || Array.isArray(extra.smug_albums);
  const sourceSelection = getSmugMusicShowSourceSelection(row);
  const sourceUrl = hasAlbumPathDiagnostics ? '' : (extra.source_url || sourceSelection.url || sourceSelection.skipped_url || '');
  const extractedImageKey = hasAlbumPathDiagnostics ? '' : (extra.extracted_image_key || extra.image_key || extractSmugImageKeyFromUrl(sourceUrl) || '');
  const attemptedImageKeys = hasAlbumPathDiagnostics
    ? []
    : Array.isArray(extra.attempted_image_keys)
      ? extra.attempted_image_keys
      : (extractedImageKey ? getSmugImageKeyCandidates(extractedImageKey) : []);
  const imageEndpointAttempts = hasAlbumPathDiagnostics
    ? []
    : Array.isArray(extra.image_endpoint_attempts)
      ? extra.image_endpoint_attempts
      : Array.isArray(extra.image_endpoints)
        ? extra.image_endpoints
        : (extractedImageKey ? buildSmugImageDetailEndpoints(extractedImageKey) : []);
  const imageApiUrlAttemptsBeforeApiKey = imageEndpointAttempts.map((endpoint) => buildSmugApiDebugUrl(endpoint));

  return {
    show_id: row && row.show_id != null ? toIntegerCount(row.show_id) : null,
    name: row && row.name ? row.name : '',
    date: row && row.date ? row.date : '',
    status,
    message: extra.message || '',
    date_folder: extra.date_folder || formatMusicShowDateFolder(row && row.date),
    attempted_album_paths: attemptedAlbumPaths,
    album_path_attempts: attemptedAlbumPaths,
    smug_albums: Array.isArray(extra.smug_albums) ? extra.smug_albums : [],
    album_id: extra.album_id || '',
    poster: row && row.poster ? row.poster : '',
    source_url: sourceUrl,
    source_field: hasAlbumPathDiagnostics ? '' : (extra.source_field || sourceSelection.field || sourceSelection.skipped_field || ''),
    image_key: extractedImageKey,
    extracted_image_key: extractedImageKey,
    attempted_image_keys: attemptedImageKeys,
    image_endpoint: hasAlbumPathDiagnostics ? '' : (extra.image_endpoint || imageEndpointAttempts[0] || ''),
    image_endpoint_attempts: imageEndpointAttempts,
    image_api_url_before_api_key: hasAlbumPathDiagnostics ? '' : (extra.image_api_url_before_api_key || imageApiUrlAttemptsBeforeApiKey[0] || ''),
    image_api_url_attempts_before_api_key: imageApiUrlAttemptsBeforeApiKey
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
const SMUG_MUSIC_SHOW_REGION_FALLBACKS = ['Local', 'Regional', 'National', 'International'];

function formatMusicShowDateFolder(value) {
  const parsed = parseMusicShowDate(value);
  if (!parsed || !parsed.iso) return '';
  const [year, month, day] = parsed.iso.split('-');
  return `${month}${day}${String(year || '').slice(-2)}`;
}

function getSmugPathSegments(path) {
  return String(path || '')
    .split('/')
    .map((segment) => String(segment || '').trim())
    .filter(Boolean);
}

function encodeSmugFolderPath(path) {
  return getSmugPathSegments(path).map((segment) => encodeURIComponent(segment)).join('/');
}

function buildSmugMusicBandAlbumPath(region, bandName, dateFolder) {
  const cleanRegion = String(region || '').trim().replace(/^\/+|\/+$/g, '');
  const cleanBand = String(bandName || '').trim().replace(/^\/+|\/+$/g, '');
  const cleanDateFolder = String(dateFolder || '').trim().replace(/^\/+|\/+$/g, '');
  if (!cleanRegion || !cleanBand || !cleanDateFolder) return '';
  return ['Music', 'Archives', 'Bands', cleanRegion, cleanBand, cleanDateFolder].join('/');
}

function buildSmugFolderAlbumsEndpointFromPath(path) {
  return `/folder/user/${encodeURIComponent(SMUG_NICKNAME)}/${encodeSmugFolderPath(path)}!albums?_accept=application/json`;
}

function getSmugAlbumUrl(album, smugPath) {
  const candidates = [
    album && album.WebUri,
    album && album.WebURL,
    album && album.WebUrl,
    album && album.Url,
    album && album.URL,
    album && album.AlbumUrl,
    album && album.AlbumURL
  ];
  const direct = candidates.map((value) => String(value || '').trim()).find((value) => /^https?:\/\//i.test(value));
  if (direct) return direct;
  const path = getSmugPathSegments(smugPath).join('/');
  return path ? `https://${SMUG_NICKNAME}.smugmug.com/${path}` : '';
}

function albumMatchesSmugMusicShowPath(album, smugPath) {
  const expectedPath = getSmugPathSegments(smugPath).join('/');
  const expectedSegment = getSmugPathSegments(smugPath).pop() || '';
  if (!expectedPath || !expectedSegment) return false;

  return getSmugAlbumPathCandidates(album).some((candidate) => {
    const decoded = decodeSmugPathSegment(candidate);
    if (decoded === expectedPath || decoded.endsWith(`/${expectedPath}`)) return true;
    return getLastSmugPathSegment(decoded) === expectedSegment;
  });
}

async function resolveSmugAlbumByPath(smugPath) {
  const segments = getSmugPathSegments(smugPath);
  const albumSegment = segments[segments.length - 1] || '';
  const parentPath = segments.slice(0, -1).join('/');
  const endpoint = buildSmugFolderAlbumsEndpointFromPath(parentPath);
  const apiUrlBeforeApiKey = buildSmugApiDebugUrl(endpoint);

  if (!albumSegment || !parentPath) {
    return {
      status: 'invalid_album_path',
      endpoint,
      api_url_before_api_key: apiUrlBeforeApiKey,
      childAlbumCount: null,
      error: 'Missing album path segment.'
    };
  }

  try {
    const json = await fetchSmugJson(endpoint);
    const albums = getSmugAlbums(json);
    const matches = albums.filter((album) => albumMatchesSmugMusicShowPath(album, smugPath));
    if (!matches.length) {
      return {
        status: 'album_not_found',
        endpoint,
        api_url_before_api_key: apiUrlBeforeApiKey,
        childAlbumCount: albums.length,
        error: `No child album matched ${albumSegment}.`
      };
    }

    const album = matches[0];
    const albumId = getSmugAlbumKey(album);
    if (!albumId) {
      return {
        status: 'no_album_key',
        endpoint,
        api_url_before_api_key: apiUrlBeforeApiKey,
        childAlbumCount: albums.length,
        error: `Matched ${albumSegment}, but the album did not include an AlbumKey.`
      };
    }

    let metadata = album;
    try {
      metadata = await fetchSmugAlbumMetadata(albumId) || album;
    } catch (_) {
      metadata = album;
    }

    const albumPhotoCount = getSmugAlbumImageCount(metadata);
    const photoCount = albumPhotoCount == null ? await getSmugAlbumTotalPhotos(metadata || album) : albumPhotoCount;
    const coverImageUrl = getSmugAlbumCoverImageUrl(metadata || album) || '';

    return {
      status: matches.length > 1 ? 'resolved_duplicate_path_match' : 'resolved',
      endpoint,
      api_url_before_api_key: apiUrlBeforeApiKey,
      childAlbumCount: albums.length,
      duplicateMatchCount: matches.length,
      album_id: albumId,
      gallery_id: albumId,
      album_url: getSmugAlbumUrl(metadata || album, smugPath),
      album_title: getSmugAlbumTitle(metadata || album),
      photo_count: photoCount == null ? 0 : toIntegerCount(photoCount),
      cover_image_url: coverImageUrl
    };
  } catch (err) {
    return {
      status: isSmugHttpStatusError(err, 404) ? 'parent_folder_not_found' : 'error',
      endpoint,
      api_url_before_api_key: apiUrlBeforeApiKey,
      childAlbumCount: null,
      error: getSafeErrorMessage(err)
    };
  }
}

function getMusicShowResolverBandEntries(row) {
  return (Array.isArray(row && row.bands) ? row.bands : [])
    .map((item) => ({
      slot: item && item.slot != null ? toIntegerCount(item.slot) : null,
      band: String(item && item.band || '').trim()
    }))
    .filter((item) => item.band);
}

async function getSmugMusicShowBandLookup(rows) {
  const result = await dbPool.query(`
    SELECT band_id, band, region, smug_folder, stats, raw_sheet
    FROM music_bands
    ORDER BY band ASC, id ASC
  `);
  const lookup = new Map();

  (result.rows || []).forEach((row) => {
    const key = normalizeMusicLookupKey(row.band);
    if (key && !lookup.has(key)) lookup.set(key, row);
  });

  return lookup;
}

function getSmugMusicShowBandRecord(bandLookup, bandName) {
  const key = normalizeMusicLookupKey(bandName);
  return key && bandLookup && bandLookup.has(key) ? bandLookup.get(key) : null;
}

function getSmugMusicShowBandRegion(record) {
  const candidates = [
    record && record.region,
    record && record.stats && record.stats.region,
    record && record.raw_sheet && record.raw_sheet.region
  ];
  return String(candidates.find((value) => String(value || '').trim()) || '').trim();
}

function getSmugMusicShowAlbumCandidates(row, bandLookup) {
  const dateFolder = formatMusicShowDateFolder(row && row.date);
  if (!dateFolder) return { dateFolder: '', candidates: [], regionFallbackUsed: false };

  const candidates = [];
  let regionFallbackUsed = false;

  getMusicShowResolverBandEntries(row).forEach((entry) => {
    const record = getSmugMusicShowBandRecord(bandLookup, entry.band);
    const region = getSmugMusicShowBandRegion(record);
    const bandFolder = String(record && record.smug_folder || entry.band || '').trim();
    const regions = region ? [region] : SMUG_MUSIC_SHOW_REGION_FALLBACKS;
    if (!region) regionFallbackUsed = true;

    regions.forEach((candidateRegion) => {
      const smugPath = buildSmugMusicBandAlbumPath(candidateRegion, bandFolder, dateFolder);
      if (!smugPath) return;
      candidates.push({
        slot: entry.slot,
        band: entry.band,
        band_id: record && record.band_id ? record.band_id : '',
        region: candidateRegion,
        region_source: region ? 'music_bands' : 'fallback',
        band_folder: bandFolder,
        date_folder: dateFolder,
        smug_path: smugPath
      });
    });
  });

  return { dateFolder, candidates, regionFallbackUsed };
}

async function getSmugMusicShowResolveCandidates(limit, refresh) {
  const bandCountSql = "CASE WHEN jsonb_typeof(bands) = 'array' THEN jsonb_array_length(bands) ELSE 0 END";
  const sourceWhere = `(
    trim(coalesce(date, '')) <> ''
    AND ${bandCountSql} > 0
  )`;
  const where = [sourceWhere];

  if (!refresh) {
    where.push(`(
      smug_last_synced_at IS NULL
      OR trim(coalesce(smug_sync_status, '')) = ''
      OR lower(trim(coalesce(smug_sync_status, ''))) IN ('error', 'unresolved', 'missing_media', 'no_source_url', 'no_image_key', 'no_album_key', 'raw_photo_source_no_album_context', 'missing_date_folder', 'missing_bands', 'no_resolved_band_albums', 'album_not_found', 'parent_folder_not_found')
    )`);
  }

  return dbPool.query(`
    SELECT id, show_id, name, date, poster, show_url, raw_sheet, bands, stats, gallery_id, album_id, cover_image_url, photo_count, smug_albums, smug_last_synced_at, smug_sync_status
    FROM music_shows
    WHERE ${where.join(' AND ')}
    ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
    LIMIT $1
  `, [limit]);
}
async function getSmugMusicShowMissingSourceDiagnostics() {
  const bandCountSql = "CASE WHEN jsonb_typeof(bands) = 'array' THEN jsonb_array_length(bands) ELSE 0 END";
  const missingWhere = `
    trim(coalesce(date, '')) = ''
    OR ${bandCountSql} = 0
  `;
  const countResult = await dbPool.query(`SELECT count(*)::int AS count FROM music_shows WHERE ${missingWhere}`);
  const sampleResult = await dbPool.query(`
    SELECT show_id, name, date, poster, show_url, ${bandCountSql} AS band_count
    FROM music_shows
    WHERE ${missingWhere}
    ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
    LIMIT 25
  `);
  return {
    count: toIntegerCount(countResult.rows && countResult.rows[0] && countResult.rows[0].count),
    meaning: 'Missing date or bands required for deterministic Music/Archives/Bands/<Region>/<Band>/<MMDDYY> resolution.',
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
        smug_albums = $9::jsonb,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, show_id, name, date, poster, gallery_id, album_id, cover_image_url, photo_count, stats, smug_albums, smug_last_synced_at, smug_sync_status, smug_sync_error
  `, [
    row.id,
    snapshot.gallery_id || null,
    snapshot.album_id || null,
    snapshot.cover_image_url || null,
    toIntegerCount(snapshot.photo_count),
    snapshot.smug_sync_status || 'resolved',
    snapshot.smug_sync_error || null,
    stringifyDbJson(stats),
    stringifyDbJson(Array.isArray(snapshot.smug_albums) ? snapshot.smug_albums : [])
  ]);
  return result.rows && result.rows[0] ? result.rows[0] : null;
}
async function updateSmugMusicShowSyncError(row, status, error, smugAlbums = null) {
  const result = await dbPool.query(`
    UPDATE music_shows
    SET smug_last_synced_at = NOW(),
        smug_sync_status = $2,
        smug_sync_error = $3,
        smug_albums = COALESCE($4::jsonb, smug_albums),
        updated_at = NOW()
    WHERE id = $1
      AND trim(coalesce(album_id, '')) = ''
      AND trim(coalesce(gallery_id, '')) = ''
    RETURNING id, show_id, name, date, poster, gallery_id, album_id, cover_image_url, photo_count, stats, smug_albums, smug_last_synced_at, smug_sync_status, smug_sync_error
  `, [
    row.id,
    status || 'error',
    getSafeErrorMessage(error),
    Array.isArray(smugAlbums) ? stringifyDbJson(smugAlbums) : null
  ]);
  return result.rows && result.rows[0] ? result.rows[0] : null;
}
async function resolveSmugMusicShowAlbum(row, bandLookup = new Map()) {
  const { dateFolder, candidates, regionFallbackUsed } = getSmugMusicShowAlbumCandidates(row, bandLookup);

  if (!dateFolder) {
    const status = 'missing_date_folder';
    const message = 'Missing or invalid show date for MMDDYY SmugMug album path resolution.';
    const updated = await updateSmugMusicShowSyncError(row, status, new Error(message), []);
    return {
      status,
      updated,
      bandAlbumCandidateCount: 0,
      resolvedBandAlbumCount: 0,
      unresolvedBandAlbumCount: 0,
      regionFallbackUsed: false,
      resolvedMappings: [],
      unresolvedMappings: [],
      diagnostic: buildSmugMusicShowResolveDiagnostic(row, status, {
        date_folder: '',
        attempted_album_paths: [],
        smug_albums: [],
        message
      })
    };
  }

  if (!candidates.length) {
    const status = 'missing_bands';
    const message = 'Missing show bands for SmugMug album path resolution.';
    const updated = await updateSmugMusicShowSyncError(row, status, new Error(message), []);
    return {
      status,
      updated,
      bandAlbumCandidateCount: 0,
      resolvedBandAlbumCount: 0,
      unresolvedBandAlbumCount: 0,
      regionFallbackUsed,
      resolvedMappings: [],
      unresolvedMappings: [],
      diagnostic: buildSmugMusicShowResolveDiagnostic(row, status, {
        date_folder: dateFolder,
        attempted_album_paths: [],
        smug_albums: [],
        message
      })
    };
  }

  // bands[] is show lineup compatibility data; smug_albums[] is resolved SmugMug archive/media album mappings.
  const lineupBands = Array.isArray(row && row.bands) ? row.bands : [];
  const mappings = [];
  for (const candidate of candidates) {
    const lineup = findMusicShowLineupBandForAlbum(candidate, lineupBands);
    const resolved = await resolveSmugAlbumByPath(candidate.smug_path);
    mappings.push({
      band: candidate.band,
      band_id: candidate.band_id || '',
      slot: candidate.slot,
      bandViewCount: lineup && lineup.bandViewCount != null ? toIntegerCount(lineup.bandViewCount) : null,
      lineupBand: lineup && lineup.band ? lineup.band : '',
      lineupSlot: lineup && lineup.slot != null ? toIntegerCount(lineup.slot) : null,
      region: candidate.region,
      region_source: candidate.region_source,
      band_folder: candidate.band_folder,
      date_folder: candidate.date_folder,
      smug_path: candidate.smug_path,
      album_id: resolved.album_id || '',
      gallery_id: resolved.gallery_id || '',
      album_url: resolved.album_url || '',
      album_title: resolved.album_title || '',
      photo_count: toIntegerCount(resolved.photo_count),
      cover_image_url: resolved.cover_image_url || '',
      status: resolved.status || 'unresolved',
      endpoint: resolved.endpoint || '',
      api_url_before_api_key: resolved.api_url_before_api_key || '',
      childAlbumCount: resolved.childAlbumCount == null ? null : toIntegerCount(resolved.childAlbumCount),
      duplicateMatchCount: resolved.duplicateMatchCount == null ? null : toIntegerCount(resolved.duplicateMatchCount),
      error: resolved.error || ''
    });
  }

  const resolvedMappings = mappings.filter((mapping) => mapping.album_id && /^resolved/i.test(mapping.status));
  const unresolvedMappings = mappings.filter((mapping) => !mapping.album_id || !/^resolved/i.test(mapping.status));
  const albumPathAttempts = mappings.map((mapping) => mapping.smug_path).filter(Boolean);

  if (!resolvedMappings.length) {
    const status = 'no_resolved_band_albums';
    const message = 'No Music Show band/date SmugMug album paths resolved.';
    const updated = await updateSmugMusicShowSyncError(row, status, new Error(message), mappings);
    return {
      status,
      updated,
      bandAlbumCandidateCount: mappings.length,
      resolvedBandAlbumCount: 0,
      unresolvedBandAlbumCount: unresolvedMappings.length,
      regionFallbackUsed,
      resolvedMappings: [],
      unresolvedMappings,
      diagnostic: buildSmugMusicShowResolveDiagnostic(row, status, {
        date_folder: dateFolder,
        attempted_album_paths: albumPathAttempts,
        smug_albums: mappings,
        message
      })
    };
  }

  const first = resolvedMappings[0];
  const photoCount = resolvedMappings.reduce((total, mapping) => total + toIntegerCount(mapping.photo_count), 0);
  const coverImageUrl = resolvedMappings.map((mapping) => mapping.cover_image_url).find((value) => String(value || '').trim()) || getSmugMusicShowResolvedCoverImageUrl(null, '', row);
  const stats = buildSmugMusicShowStatsSnapshot(row, photoCount);
  const updated = await updateSmugMusicShowSnapshot(row, {
    gallery_id: first.gallery_id || first.album_id,
    album_id: first.album_id,
    cover_image_url: coverImageUrl,
    photo_count: photoCount,
    stats,
    smug_albums: mappings,
    smug_sync_status: 'resolved',
    smug_sync_error: null
  });

  return {
    status: 'resolved',
    updated,
    bandAlbumCandidateCount: mappings.length,
    resolvedBandAlbumCount: resolvedMappings.length,
    unresolvedBandAlbumCount: unresolvedMappings.length,
    regionFallbackUsed,
    resolvedMappings,
    unresolvedMappings,
    missingCoverImage: !coverImageUrl,
    diagnostic: buildSmugMusicShowResolveDiagnostic(row, 'resolved', {
      date_folder: dateFolder,
      attempted_album_paths: albumPathAttempts,
      smug_albums: mappings,
      album_id: first.album_id,
      message: coverImageUrl ? '' : 'At least one album resolved, but no cover image was available.'
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
    smug_sync_error: row && row.smug_sync_error ? row.smug_sync_error : null,
    smug_albums: Array.isArray(row && row.smug_albums) ? row.smug_albums : []
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
  const bandLookup = await getSmugMusicShowBandLookup(candidates.rows);
  const unresolvedShows = [];
  const skippedLogoSources = [];
  const skippedVenueLogoSources = [];
  const noSourceUrlShows = [];
  const noImageKeyShows = [];
  const noAlbumKeyShows = [];
  const missingCoverImages = [];
  const resolvedMappings = [];
  const unresolvedMappings = [];
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
    band_album_candidates: 0,
    resolved_band_albums: 0,
    unresolved_band_albums: 0,
    shows_with_resolved_album: 0,
    shows_with_no_resolved_albums: 0,
    region_fallback_usage: 0,
    failed: 0,
    recordsUpdated: 0
  };

  await mapWithConcurrency(candidates.rows, SMUG_REQUEST_CONCURRENCY, async (row) => {
    counters.attempted += 1;
    try {
      const result = await resolveSmugMusicShowAlbum(row, bandLookup);
      if (result.updated) {
        counters.recordsUpdated += 1;
        updatedItems.push(buildSmugMusicShowResolveResultItem(result.updated));
      }

      const diagnostic = result.diagnostic || buildSmugMusicShowResolveDiagnostic(row, result.status);
      counters.band_album_candidates += toIntegerCount(result.bandAlbumCandidateCount);
      counters.resolved_band_albums += toIntegerCount(result.resolvedBandAlbumCount);
      counters.unresolved_band_albums += toIntegerCount(result.unresolvedBandAlbumCount);
      if (result.regionFallbackUsed) counters.region_fallback_usage += 1;
      if (Array.isArray(result.resolvedMappings)) resolvedMappings.push(...result.resolvedMappings);
      if (Array.isArray(result.unresolvedMappings)) unresolvedMappings.push(...result.unresolvedMappings);
      if (result.status === 'resolved' || result.status === 'synced') {
        counters.resolved += 1;
        counters.shows_with_resolved_album += 1;
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
        counters.shows_with_no_resolved_albums += 1;
        noSourceUrlShows.push(diagnostic);
        unresolvedShows.push(diagnostic);
      } else if (result.status === 'no_image_key') {
        counters.no_image_key += 1;
        counters.unresolved += 1;
        counters.shows_with_no_resolved_albums += 1;
        noImageKeyShows.push(diagnostic);
        unresolvedShows.push(diagnostic);
      } else if (result.status === 'no_album_key') {
        counters.no_album_key += 1;
        counters.unresolved += 1;
        counters.shows_with_no_resolved_albums += 1;
        noAlbumKeyShows.push(diagnostic);
        unresolvedShows.push(diagnostic);
      } else if (result.status === 'error') {
        counters.failed += 1;
        failures.push(diagnostic);
      } else {
        counters.unresolved += 1;
        counters.shows_with_no_resolved_albums += 1;
        unresolvedShows.push(diagnostic);
      }
    } catch (err) {
      counters.failed += 1;
      const updated = await updateSmugMusicShowSyncError(row, 'error', err);
      if (updated) {
        counters.recordsUpdated += 1;
        updatedItems.push(buildSmugMusicShowResolveResultItem(updated));
      }
      const fallbackCandidates = getSmugMusicShowAlbumCandidates(row, bandLookup);
      failures.push(buildSmugMusicShowResolveDiagnostic(row, 'error', {
        date_folder: fallbackCandidates.dateFolder,
        attempted_album_paths: fallbackCandidates.candidates.map((candidate) => candidate.smug_path),
        message: getSafeErrorMessage(err)
      }));
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
      totalBandAlbumCandidates: counters.band_album_candidates,
      resolvedBandAlbums: counters.resolved_band_albums,
      unresolvedBandAlbums: counters.unresolved_band_albums,
      showsWithAtLeastOneResolvedAlbum: counters.shows_with_resolved_album,
      showsWithNoResolvedAlbums: counters.shows_with_no_resolved_albums,
      regionFallbackUsage: counters.region_fallback_usage,
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
    totalBandAlbumCandidates: counters.band_album_candidates,
    resolvedBandAlbums: counters.resolved_band_albums,
    unresolvedBandAlbums: counters.unresolved_band_albums,
    showsWithAtLeastOneResolvedAlbum: counters.shows_with_resolved_album,
    showsWithNoResolvedAlbums: counters.shows_with_no_resolved_albums,
    regionFallbackUsage: counters.region_fallback_usage,
    recordsUpdated: counters.recordsUpdated,
    diagnostics: {
      missingSource,
      skippedLogoSource: skippedLogoSources.slice(0, 25),
      skippedVenueLogoSource: skippedVenueLogoSources.slice(0, 25),
      noSourceUrl: noSourceUrlShows.slice(0, 25),
      noImageKey: noImageKeyShows.slice(0, 25),
      noAlbumKey: noAlbumKeyShows.slice(0, 25),
      missingCoverImage: missingCoverImages.slice(0, 25),
      deterministicAlbumResolution: {
        strategy: 'band_date_region_album_path',
        resolvedMappings: resolvedMappings.slice(0, 25),
        unresolvedMappings: unresolvedMappings.slice(0, 25)
      },
      fallbackImageResolver: {
        enabled: false,
        attempted: 0,
        failures: [],
        note: 'Poster/image-key fallback is not used after deterministic album-path resolution.'
      },
      resolvedMappings: resolvedMappings.slice(0, 25),
      unresolvedMappings: unresolvedMappings.slice(0, 25),
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

function normalizeMusicBandDiagnosticKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isMalformedMusicBandDiagnosticRecord(row = {}) {
  const band = String(row.band || '').trim();
  if (!isValidMusicBandName(band)) return true;
  if (/^https?:\/\//i.test(band)) return true;
  if (/photos\.smugmug\.com/i.test(band)) return true;
  if (/\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(band)) return true;

  const normalized = normalizeMusicBandDiagnosticKey(band);
  return ['local', 'regional', 'national', 'international'].includes(normalized);
}

function isInvalidMusicBandSmugFolder(value) {
  const folder = String(value || '').trim();
  if (!folder) return false;
  if (/^https?:\/\//i.test(folder)) return true;
  if (/photos\.smugmug\.com/i.test(folder)) return true;
  if (/[\\]/.test(folder)) return true;
  if (folder.includes('..')) return true;
  if (/[\u0000-\u001f]/.test(folder)) return true;
  if (/^[0-9]+$/.test(folder)) return true;

  const normalized = normalizeImportHeaderKey(folder);
  return new Set([
    'archived_sets',
    'total_sets',
    'photo_count',
    'total_photos',
    'band_id',
    'band',
    'name',
    'region',
    'smug_folder',
    'slug_folder',
    'logo_url',
    'status',
    'notes',
    'members',
    'past_members',
    'location',
    'state',
    'country'
  ]).has(normalized);
}

function suggestMusicBandSmugFolder(value) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  if (!clean || isMalformedMusicBandDiagnosticRecord({ band: clean })) return '';

  return clean
    .replace(/[â€™']/g, '')
    .replace(/&/g, ' And ')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getMusicBandSmugFolderDiagnosticLimit(value) {
  const number = Number(String(value || '').trim());
  if (!Number.isInteger(number)) return 100;
  return Math.min(500, Math.max(1, number));
}

function addMusicBandSmugFolderDetail(details, bucket, record, limit) {
  if (!details[bucket]) details[bucket] = [];
  if (details[bucket].length < limit) details[bucket].push(record);
}

function buildMusicBandSourceLookup(rows = []) {
  const byBandId = new Map();
  const byBand = new Map();
  const normalizedRows = [];

  rows.forEach((rawRow) => {
    const row = normalizeMusicBandImportRow(rawRow || {});
    const band = String(getMusicBandName(row) || '').trim();
    const bandId = String(row.band_id || '').trim();
    const generatedBandId = band ? slugifyMusicBandId(band) : '';
    const record = {
      band,
      band_id: bandId,
      generated_band_id: generatedBandId,
      region: String(row.region || '').trim(),
      smug_folder: String(row.smug_folder || row.slug_folder || '').trim(),
      raw: row
    };

    normalizedRows.push(record);
    if (bandId) byBandId.set(normalizeMusicBandDiagnosticKey(bandId), record);
    if (generatedBandId && !byBandId.has(normalizeMusicBandDiagnosticKey(generatedBandId))) {
      byBandId.set(normalizeMusicBandDiagnosticKey(generatedBandId), record);
    }
    if (band && !byBand.has(normalizeMusicBandDiagnosticKey(band))) {
      byBand.set(normalizeMusicBandDiagnosticKey(band), record);
    }
  });

  return { rows: normalizedRows, byBandId, byBand };
}

function findMusicBandSourceRecord(row, sourceLookup) {
  if (!sourceLookup) return null;
  const bandId = normalizeMusicBandDiagnosticKey(row.band_id);
  const band = normalizeMusicBandDiagnosticKey(row.band);
  return (bandId && sourceLookup.byBandId.get(bandId)) ||
    (band && sourceLookup.byBand.get(band)) ||
    null;
}

function getMusicBandSmugFolderRecommendedAction(buckets, sourceRecord, hasFolder) {
  if (buckets.includes('malformed_band_record')) return 'Review/remove stale malformed music_bands row after source-sheet cleanup; do not generate a SmugMug folder.';
  if (buckets.includes('stale_db_only')) return 'Confirm this row is no longer in Music-Bands source, then plan a controlled stale-row cleanup.';
  if (buckets.includes('invalid_smug_folder')) return 'Correct the SmugMug folder value in the Music-Bands source sheet, then rerun the Music Bands import.';
  if (buckets.includes('duplicate_smug_folder')) return 'Review duplicate folder assignments; keep only intentional aliases or correct the source sheet.';
  if (buckets.includes('missing_source_value')) return 'Fill smug_folder in the Music-Bands source sheet after confirming the real SmugMug folder.';
  if (!hasFolder && sourceRecord && sourceRecord.smug_folder) return 'Source has a smug_folder but DB does not; rerun /admin/import/music/bands?refresh=1 after deploy.';
  if (!hasFolder) return 'Confirm the source row and SmugMug folder before adding a value.';
  return 'No action needed.';
}

async function buildMusicBandSmugFolderDiagnosticsResponse(query = {}) {
  const generated = new Date();
  const warnings = [];
  const limit = getMusicBandSmugFolderDiagnosticLimit(query.limit);
  const response = buildAdminResponse({
    route: '/api/admin/diagnostics/music/bands/smug-folder',
    source: 'postgres:music_bands',
    section: 'music',
    type: 'diagnostics',
    category: 'bands',
    diagnostic: 'smug_folder',
    generated,
    source_tabs: {
      bands: buildMusicDiagnosticSourceTabs().bands
    },
    readOnly: true,
    mutated: false,
    limit,
    source_available: false,
    counts: {
      total_db_rows: 0,
      total_source_rows: 0,
      populated: 0,
      missing_source_value: 0,
      duplicate_smug_folder: 0,
      duplicate_smug_folder_values: 0,
      stale_db_only: 0,
      malformed_band_record: 0,
      invalid_smug_folder: 0,
      unknown: 0
    },
    details: {
      missing_source_value: [],
      duplicate_smug_folder: [],
      stale_db_only: [],
      malformed_band_record: [],
      invalid_smug_folder: [],
      unknown: []
    },
    truncated: {},
    warnings
  });

  if (!String(process.env.DATABASE_URL || '').trim()) {
    warnings.push('Missing DATABASE_URL environment variable. Music Bands smug_folder diagnostics require PostgreSQL access.');
    response.ok = false;
    response.error = 'DATABASE_NOT_CONFIGURED';
    return response;
  }

  let existingTables;
  let columnsByTable;
  try {
    existingTables = await getExistingPublicTables(['music_bands']);
    columnsByTable = await getExistingPublicColumns(['music_bands']);
  } catch (err) {
    warnings.push(`Unable to inspect music_bands table: ${getSafeErrorMessage(err)}`);
    response.ok = false;
    response.error = 'TABLE_INSPECTION_FAILED';
    return response;
  }

  if (!existingTables.has('music_bands')) {
    warnings.push('Missing table: music_bands');
    response.ok = false;
    response.error = 'MUSIC_BANDS_TABLE_MISSING';
    return response;
  }

  const requiredColumns = ['id', 'band', 'band_id', 'region', 'smug_folder'];
  const missingColumns = requiredColumns.filter((column) => !hasDiagnosticColumn(columnsByTable, 'music_bands', column));
  if (missingColumns.length) {
    warnings.push(`Missing columns on music_bands: ${missingColumns.join(', ')}`);
    response.ok = false;
    response.error = 'MUSIC_BANDS_COLUMNS_MISSING';
    return response;
  }

  let sourceLookup = null;
  if (SHEET_ID && normalizeSheetGid(process.env[ROUTES['/api/music/bands'].gidEnv])) {
    try {
      const payload = await fetchCsvForRoute('/api/music/bands', ROUTES['/api/music/bands'], query.refresh === '1');
      sourceLookup = buildMusicBandSourceLookup(payload.rows || []);
      response.source_available = true;
      response.counts.total_source_rows = sourceLookup.rows.length;
    } catch (err) {
      warnings.push(`Unable to fetch Music-Bands source sheet for source_present comparison: ${getSafeErrorMessage(err)}`);
    }
  } else {
    warnings.push('Music-Bands source sheet is not configured; source_present is null and stale/source buckets may be incomplete.');
  }

  const result = await runMusicDiagnosticQuery(
    warnings,
    'music bands smug_folder records',
    `SELECT id, band, band_id, region, smug_folder
     FROM music_bands
     ORDER BY lower(trim(coalesce(band, ''))) ASC, id ASC`
  );
  const rows = diagnosticRows(result);
  response.counts.total_db_rows = rows.length;

  const folderCounts = new Map();
  rows.forEach((row) => {
    const folderKey = normalizeMusicBandDiagnosticKey(row.smug_folder);
    if (!folderKey) return;
    folderCounts.set(folderKey, (folderCounts.get(folderKey) || 0) + 1);
  });
  const duplicateFolderKeys = new Set(Array.from(folderCounts.entries()).filter((entry) => entry[1] > 1).map((entry) => entry[0]));
  response.counts.duplicate_smug_folder_values = duplicateFolderKeys.size;

  const detailCounts = {
    missing_source_value: 0,
    duplicate_smug_folder: 0,
    stale_db_only: 0,
    malformed_band_record: 0,
    invalid_smug_folder: 0,
    unknown: 0
  };

  rows.forEach((row) => {
    const hasFolder = !!String(row.smug_folder || '').trim();
    if (hasFolder) response.counts.populated += 1;

    const sourceRecord = findMusicBandSourceRecord(row, sourceLookup);
    const sourcePresent = sourceLookup ? !!sourceRecord : null;
    const folderKey = normalizeMusicBandDiagnosticKey(row.smug_folder);
    const duplicate = !!folderKey && duplicateFolderKeys.has(folderKey);
    const malformed = isMalformedMusicBandDiagnosticRecord(row);
    const invalidFolder = isInvalidMusicBandSmugFolder(row.smug_folder);
    const sourceMissingFolder = !!sourceRecord && !String(sourceRecord.smug_folder || '').trim();
    const buckets = [];

    if (hasFolder && !invalidFolder) buckets.push('populated');
    if (!hasFolder && sourceRecord && sourceMissingFolder && !malformed) buckets.push('missing_source_value');
    if (duplicate) buckets.push('duplicate_smug_folder');
    if (sourceLookup && !sourceRecord) buckets.push('stale_db_only');
    if (malformed) buckets.push('malformed_band_record');
    if (invalidFolder) buckets.push('invalid_smug_folder');
    if (!buckets.some((bucket) => bucket !== 'populated') && !hasFolder) buckets.push('unknown');

    const issueBuckets = buckets.filter((bucket) => bucket !== 'populated');
    const detail = {
      id: row.id,
      band: row.band || '',
      band_id: row.band_id || '',
      region: row.region || '',
      smug_folder: row.smug_folder || '',
      source_present: sourcePresent,
      source_smug_folder: sourceRecord ? sourceRecord.smug_folder : null,
      suggested_smug_folder: suggestMusicBandSmugFolder(row.band),
      buckets,
      reason: issueBuckets.length
        ? issueBuckets.join(', ')
        : 'smug_folder is populated and no obvious issue was detected.',
      recommended_action: getMusicBandSmugFolderRecommendedAction(buckets, sourceRecord, hasFolder)
    };

    if (buckets.includes('missing_source_value')) {
      detailCounts.missing_source_value += 1;
      addMusicBandSmugFolderDetail(response.details, 'missing_source_value', detail, limit);
    }
    if (buckets.includes('duplicate_smug_folder')) {
      detailCounts.duplicate_smug_folder += 1;
      addMusicBandSmugFolderDetail(response.details, 'duplicate_smug_folder', detail, limit);
    }
    if (buckets.includes('stale_db_only')) {
      detailCounts.stale_db_only += 1;
      addMusicBandSmugFolderDetail(response.details, 'stale_db_only', detail, limit);
    }
    if (buckets.includes('malformed_band_record')) {
      detailCounts.malformed_band_record += 1;
      addMusicBandSmugFolderDetail(response.details, 'malformed_band_record', detail, limit);
    }
    if (buckets.includes('invalid_smug_folder')) {
      detailCounts.invalid_smug_folder += 1;
      addMusicBandSmugFolderDetail(response.details, 'invalid_smug_folder', detail, limit);
    }
    if (buckets.includes('unknown')) {
      detailCounts.unknown += 1;
      addMusicBandSmugFolderDetail(response.details, 'unknown', detail, limit);
    }
  });

  Object.assign(response.counts, detailCounts);
  Object.entries(detailCounts).forEach(([bucket, count]) => {
    response.truncated[bucket] = count > ((response.details[bucket] || []).length);
  });

  response.summary = {
    needs_source_sheet_cleanup: response.counts.missing_source_value,
    needs_duplicate_review: response.counts.duplicate_smug_folder_values,
    needs_stale_row_review: response.counts.stale_db_only,
    needs_malformed_row_review: response.counts.malformed_band_record,
    invalid_populated_values: response.counts.invalid_smug_folder,
    recommended_next_action: 'Review details, update Music-Bands source sheet for legitimate missing/duplicate smug_folder values, then rerun the existing Music Bands import manually.'
  };

  return response;
}

async function handleMusicBandSmugFolderDiagnosticsRequest(req, res) {
  try {
    const response = await buildMusicBandSmugFolderDiagnosticsResponse(req.query || {});
    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json(buildAdminError('/api/admin/diagnostics/music/bands/smug-folder', err, {
      source: 'postgres:music_bands',
      section: 'music',
      type: 'diagnostics',
      category: 'bands',
      error: 'MUSIC_BANDS_SMUG_FOLDER_DIAGNOSTICS_ERROR'
    }));
  }
}
const MUSIC_DATA_AUDIT_ROUTE = '/api/admin/diagnostics/music/data-audit';
const MUSIC_DATA_AUDIT_AREAS = ['bands', 'shows', 'people', 'venues', 'smugmug', 'relationships'];

function getMusicDataAuditLimit(value) {
  const number = Number(String(value || '').trim());
  if (!Number.isInteger(number)) return 25;
  return Math.min(100, Math.max(1, number));
}

function createMusicDataAuditCategories() {
  const out = {};
  MUSIC_DATA_AUDIT_AREAS.forEach((area) => {
    out[area] = { totalIssues: 0, critical: 0, warning: 0, info: 0, issueTypes: {}, metrics: {} };
  });
  return out;
}

function addMusicDataAuditIssue(state, issue) {
  const severity = ['critical', 'warning', 'info'].includes(String(issue.severity || '').toLowerCase()) ? String(issue.severity).toLowerCase() : 'warning';
  const area = MUSIC_DATA_AUDIT_AREAS.includes(String(issue.area || '').toLowerCase()) ? String(issue.area).toLowerCase() : 'relationships';
  const issueType = String(issue.issue_type || 'unknown').trim() || 'unknown';
  const item = { id: issue.id || `music-audit-${++state.seq}`, severity, area, issue_type: issueType, title: issue.title || issueType, record_type: issue.record_type || area, record_id: issue.record_id == null ? '' : String(issue.record_id), record_name: issue.record_name || '', reason: issue.reason || '', recommended_action: issue.recommended_action || 'Review manually.', source_route: issue.source_route || MUSIC_DATA_AUDIT_ROUTE, status: 'open' };
  if (issue.details != null) item.details = issue.details;
  state.issues.push(item);
  state.summary.totalIssues += 1;
  state.summary[severity] += 1;
  state.categories[area].totalIssues += 1;
  state.categories[area][severity] += 1;
  state.categories[area].issueTypes[issueType] = (state.categories[area].issueTypes[issueType] || 0) + 1;
}

function getMusicDataAuditArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (typeof value === 'string' && value.trim()) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : []; } catch (_) { return []; }
  }
  return [];
}

function getMusicDataAuditObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (_) { return {}; }
  }
  return {};
}

function classifyMusicDataAuditPoster(value) {
  const poster = String(value || '').trim();
  if (!poster) return { type: 'missing_poster', reason: 'poster is blank' };
  let parsed;
  try { parsed = new URL(poster); } catch (_) { return { type: 'malformed_poster_url', reason: 'poster is not an absolute URL' }; }
  const host = String(parsed.hostname || '').toLowerCase();
  const smug = host === 'photos.smugmug.com' || host.endsWith('.smugmug.com');
  const imageLike = /\.(jpe?g|png|gif|webp|avif)(\?.*)?$/i.test(parsed.pathname || '') || /\/(Th|Ti|S|M|L|XL|X2|X3|O)\//i.test(parsed.pathname || '');
  if (!['http:', 'https:'].includes(parsed.protocol)) return { type: 'malformed_poster_url', reason: 'poster uses an unsupported protocol' };
  if (isVenueLogoUrl(poster) || (typeof isSmugMusicShowLogoSourceUrl === 'function' && isSmugMusicShowLogoSourceUrl(poster))) return { type: 'logo_poster_placeholder', reason: 'poster points to logo/non-show media' };
  if (!smug) return { type: 'unexpected_poster_source', reason: `poster uses unexpected domain: ${host}` };
  if (!imageLike) return { type: 'non_image_poster_url', reason: 'poster does not look like a direct image asset' };
  return { type: 'valid_poster', reason: 'SmugMug direct image URL' };
}

function addMusicDataAuditTableMissingIssue(state, tableName, area) {
  addMusicDataAuditIssue(state, { severity: 'critical', area, issue_type: 'table_missing', title: `${tableName} table is missing`, record_type: 'table', record_id: tableName, record_name: tableName, reason: `Required table ${tableName} is not present.`, recommended_action: 'Check database initialization/migrations before data cleanup.' });
}

function finalizeMusicDataAuditResponse(state, generated, page, limit) {
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const issues = state.issues.slice().sort((a, b) => (severityOrder[a.severity] - severityOrder[b.severity]) || a.area.localeCompare(b.area) || a.issue_type.localeCompare(b.issue_type) || a.record_name.localeCompare(b.record_name, undefined, { numeric: true, sensitivity: 'base' }));
  const totalIssues = issues.length;
  const totalPages = totalIssues ? Math.ceil(totalIssues / limit) : 0;
  const safePage = Math.min(Math.max(1, page), Math.max(totalPages, 1));
  const offset = (safePage - 1) * limit;
  return buildAdminResponse({ ok: state.ok, route: MUSIC_DATA_AUDIT_ROUTE, source: 'postgres', section: 'music', type: 'data_audit', generated, readOnly: true, databaseMutated: false, summary: state.summary, categories: state.categories, pagination: { page: safePage, limit, totalIssues, totalPages, hasNextPage: safePage < totalPages, hasPrevPage: safePage > 1 && totalPages > 0 }, issues: issues.slice(offset, offset + limit), recommendedActions: state.recommendedActions, warnings: state.summary.warnings });
}

async function buildMusicDataAuditResponse(query = {}) {
  const generated = new Date();
  const page = getPageNumber(query.page);
  const limit = getMusicDataAuditLimit(query.limit);
  const state = { ok: true, seq: 0, issues: [], categories: createMusicDataAuditCategories(), summary: { databaseConnected: false, totalIssues: 0, critical: 0, warning: 0, info: 0, tables: { music_bands: false, music_shows: false, music_people: false, music_venues: false }, warnings: [] }, recommendedActions: { bands: 'Clean Music-Bands source values, then rerun existing imports manually.', shows: 'Fix Music-Shows metadata in the source sheet; do not use logo assets as show posters.', people: 'Fill missing person IDs, names, and categories in Music-People.', venues: 'Fill missing venue IDs, names, locations, and statuses in Music-Venue.', smugmug: 'Use SmugMug buckets to separate pending uploads from resolver/path issues.', relationships: 'Fix missing or unmatched IDs before building frontend drilldowns.' } };
  if (!String(process.env.DATABASE_URL || '').trim()) { state.ok = false; state.summary.warnings.push('DATABASE_URL is not configured; Music data audit requires PostgreSQL access.'); return finalizeMusicDataAuditResponse(state, generated, page, limit); }
  try { await dbPool.query('SELECT 1'); state.summary.databaseConnected = true; } catch (err) { state.ok = false; state.summary.warnings.push(`Database disconnected: ${getSafeErrorMessage(err)}`); return finalizeMusicDataAuditResponse(state, generated, page, limit); }
  const existingTables = await getExistingPublicTables(MUSIC_DIAGNOSTIC_TABLES);
  MUSIC_DIAGNOSTIC_TABLES.forEach((tableName) => { state.summary.tables[tableName] = existingTables.has(tableName); });
  if (!existingTables.has('music_bands')) addMusicDataAuditTableMissingIssue(state, 'music_bands', 'bands');
  if (!existingTables.has('music_shows')) addMusicDataAuditTableMissingIssue(state, 'music_shows', 'shows');
  if (!existingTables.has('music_people')) addMusicDataAuditTableMissingIssue(state, 'music_people', 'people');
  if (!existingTables.has('music_venues')) addMusicDataAuditTableMissingIssue(state, 'music_venues', 'venues');

  if (existingTables.has('music_bands')) {
    const folderAudit = await buildMusicBandSmugFolderDiagnosticsResponse({ limit: 500, refresh: query.refresh });
    state.categories.bands.metrics.smug_folder = folderAudit.counts || {};
    ['missing_source_value', 'duplicate_smug_folder', 'stale_db_only', 'malformed_band_record', 'invalid_smug_folder', 'unknown'].forEach((bucket) => {
      const rows = folderAudit.details && Array.isArray(folderAudit.details[bucket]) ? folderAudit.details[bucket] : [];
      rows.forEach((row) => addMusicDataAuditIssue(state, { severity: bucket === 'stale_db_only' ? 'info' : 'warning', area: 'bands', issue_type: bucket, title: `Music Band ${bucket.replace(/_/g, ' ')}`, record_type: 'music_band', record_id: row.band_id || row.id || row.band, record_name: row.band || '', reason: row.reason || bucket, recommended_action: row.recommended_action || 'Review Music-Bands source data.', source_route: '/api/admin/diagnostics/music/bands/smug-folder', details: row }));
    });
    const bandResult = await dbPool.query(`SELECT id, band, band_id, region, personnel FROM music_bands ORDER BY lower(trim(coalesce(band, ''))) ASC, id ASC`);
    const allowedRegions = new Set(['local', 'regional', 'national', 'international']);
    const bandNames = new Set();
    let missingRegion = 0, nonCanonicalRegion = 0, personnelOverlap = 0;
    for (const row of bandResult.rows || []) {
      if (String(row.band || '').trim()) bandNames.add(normalizeMusicBandDiagnosticKey(row.band));
      const region = String(row.region || '').trim();
      if (!region) { missingRegion += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'bands', issue_type: 'missing_region', title: 'Music Band missing region', record_type: 'music_band', record_id: row.band_id || row.id, record_name: row.band || '', reason: 'region is blank; SmugMug band discovery depends on region.', recommended_action: 'Fill region using Local, Regional, National, or International.', source_route: '/api/admin/diagnostics/music/bands' }); }
      else if (!allowedRegions.has(region.toLowerCase())) { nonCanonicalRegion += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'bands', issue_type: 'noncanonical_region', title: 'Music Band has non-canonical region', record_type: 'music_band', record_id: row.band_id || row.id, record_name: row.band || '', reason: `region is '${region}', expected Local, Regional, National, or International.`, recommended_action: 'Normalize region in Music-Bands source sheet.', source_route: '/api/admin/diagnostics/music/bands' }); }
      const personnel = getMusicDataAuditObject(row.personnel);
      const members = Array.isArray(personnel.members) ? personnel.members : [];
      const past = Array.isArray(personnel.past_members) ? personnel.past_members : [];
      const memberKeys = new Set(members.map((m) => normalizeMusicBandDiagnosticKey(m && m.name)).filter(Boolean));
      past.forEach((m) => { const key = normalizeMusicBandDiagnosticKey(m && m.name); if (key && memberKeys.has(key)) { personnelOverlap += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'bands', issue_type: 'current_past_personnel_overlap', title: 'Music Band current/past personnel overlap', record_type: 'music_band', record_id: row.band_id || row.id, record_name: row.band || '', reason: `${m.name || key} appears in both personnel.members[] and personnel.past_members[].`, recommended_action: 'Inspect Music-Bands source fields and preserve the correct bucket.', source_route: '/api/admin/diagnostics/music/bands' }); } });
    }
    state.categories.bands.metrics.region = { missingRegion, nonCanonicalRegion };
    state.categories.bands.metrics.personnel = { currentPastOverlap: personnelOverlap };
    state._bandNames = bandNames;
  }

  let venueIds = new Set();
  if (existingTables.has('music_venues')) {
    const venueResult = await dbPool.query(`SELECT venue_id, venue_key, venue, city, state, status FROM music_venues ORDER BY lower(trim(coalesce(venue, ''))) ASC, venue_id ASC`);
    const metrics = { totalVenues: 0, missingIds: 0, missingNames: 0, missingCity: 0, missingState: 0, missingStatus: 0 };
    for (const row of venueResult.rows || []) {
      metrics.totalVenues += 1;
      const publicId = String(row.venue_key || row.venue_id || '').trim();
      if (publicId) venueIds.add(normalizeMusicBandDiagnosticKey(publicId));
      if (!publicId) { metrics.missingIds += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'venues', issue_type: 'missing_venue_id', title: 'Music Venue missing venue_id', record_type: 'music_venue', record_id: row.venue || '', record_name: row.venue || '', reason: 'venue_id/venue_key is blank.', recommended_action: 'Fill venue_id so Music Shows can join to it.', source_route: '/api/admin/diagnostics/music/venues' }); }
      if (!String(row.venue || '').trim()) { metrics.missingNames += 1; addMusicDataAuditIssue(state, { severity: 'critical', area: 'venues', issue_type: 'missing_venue_name', title: 'Music Venue missing name', record_type: 'music_venue', record_id: publicId, record_name: '', reason: 'venue name is blank.', recommended_action: 'Fill venue name in Music-Venue source data.', source_route: '/api/admin/diagnostics/music/venues' }); }
      if (!String(row.city || '').trim()) { metrics.missingCity += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'venues', issue_type: 'missing_venue_city', title: 'Music Venue missing city', record_type: 'music_venue', record_id: publicId, record_name: row.venue || '', reason: 'city is blank.', recommended_action: 'Fill city in Music-Venue source data.', source_route: '/api/admin/diagnostics/music/venues' }); }
      if (!String(row.state || '').trim()) { metrics.missingState += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'venues', issue_type: 'missing_venue_state', title: 'Music Venue missing state', record_type: 'music_venue', record_id: publicId, record_name: row.venue || '', reason: 'state is blank.', recommended_action: 'Fill state in Music-Venue source data.', source_route: '/api/admin/diagnostics/music/venues' }); }
      if (!String(row.status || '').trim()) { metrics.missingStatus += 1; addMusicDataAuditIssue(state, { severity: 'info', area: 'venues', issue_type: 'missing_venue_status', title: 'Music Venue missing status', record_type: 'music_venue', record_id: publicId, record_name: row.venue || '', reason: 'status is blank.', recommended_action: 'Fill venue status if lifecycle filtering is needed.', source_route: '/api/admin/diagnostics/music/venues' }); }
    }
    state.categories.venues.metrics = metrics;
  }

  if (existingTables.has('music_people')) {
    const peopleResult = await dbPool.query(`SELECT person_id, name, category FROM music_people ORDER BY name ASC, person_id ASC`);
    const metrics = { totalPeople: 0, missingIds: 0, missingNames: 0, missingCategory: 0 };
    for (const row of peopleResult.rows || []) {
      metrics.totalPeople += 1;
      if (row.person_id == null || String(row.person_id).trim() === '') { metrics.missingIds += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'people', issue_type: 'missing_person_id', title: 'Music Person missing person_id', record_type: 'music_person', record_id: row.name || '', record_name: row.name || '', reason: 'person_id is blank.', recommended_action: 'Fill person_id in Music-People source data.', source_route: '/api/admin/diagnostics/music/people' }); }
      if (!String(row.name || '').trim()) { metrics.missingNames += 1; addMusicDataAuditIssue(state, { severity: 'critical', area: 'people', issue_type: 'missing_person_name', title: 'Music Person missing name', record_type: 'music_person', record_id: row.person_id == null ? '' : String(row.person_id), record_name: '', reason: 'name is blank.', recommended_action: 'Fill name in Music-People source data.', source_route: '/api/admin/diagnostics/music/people' }); }
      if (!String(row.category || '').trim()) { metrics.missingCategory += 1; addMusicDataAuditIssue(state, { severity: 'info', area: 'people', issue_type: 'missing_person_category', title: 'Music Person missing category', record_type: 'music_person', record_id: row.person_id == null ? '' : String(row.person_id), record_name: row.name || '', reason: 'category is blank.', recommended_action: 'Fill category if this person should participate in performer/fallen diagnostics.', source_route: '/api/admin/diagnostics/music/people' }); }
    }
    state.categories.people.metrics = metrics;
  }

  if (existingTables.has('music_shows')) {
    const showResult = await dbPool.query(`SELECT show_id, name, date, poster, show_url, venue_id, venue, bands, gallery_id, album_id, cover_image_url, photo_count, smug_last_synced_at, smug_sync_status, smug_sync_error, smug_albums FROM music_shows ORDER BY show_id ASC NULLS LAST`);
    const rows = showResult.rows || [];
    const posterCounts = new Map();
    rows.forEach((row) => { const key = normalizeMusicBandDiagnosticKey(row.poster); if (key) posterCounts.set(key, (posterCounts.get(key) || 0) + 1); });
    const duplicatePosters = new Set(Array.from(posterCounts.entries()).filter((entry) => entry[1] > 1).map((entry) => entry[0]));
    const showMetrics = { totalShows: rows.length, missingPoster: 0, suspiciousPoster: 0, duplicatePosterRecords: 0, missingShowUrl: 0, missingBands: 0, missingVenueId: 0, invalidVenueId: 0, unmatchedLineupBands: 0 };
    const smugMetrics = { resolved: 0, pending_archive: 0, awaiting_upload: 0, resolver_error: 0, path_mismatch: 0, cover_missing: 0, legacy_smugmug_error: 0, no_candidate_album: 0, unknown_unresolved: 0 };
    const bandNames = state._bandNames || new Set();
    for (const row of rows) {
      const rid = row.show_id == null ? row.name : row.show_id;
      const poster = String(row.poster || '').trim();
      const posterClass = classifyMusicDataAuditPoster(poster);
      if (posterClass.type === 'missing_poster') { showMetrics.missingPoster += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'shows', issue_type: 'missing_poster', title: 'Music Show missing poster', record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: 'poster is blank.', recommended_action: 'Add a show-source SmugMug image URL if one exists.', source_route: '/api/music/shows/db' }); }
      else if (posterClass.type !== 'valid_poster') { showMetrics.suspiciousPoster += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'shows', issue_type: posterClass.type, title: 'Music Show suspicious poster', record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: posterClass.reason, recommended_action: 'Replace poster with valid show-source SmugMug media or leave blank until known.', source_route: '/api/music/shows/db', details: { poster } }); }
      const posterKey = normalizeMusicBandDiagnosticKey(poster);
      if (posterKey && duplicatePosters.has(posterKey)) { showMetrics.duplicatePosterRecords += 1; addMusicDataAuditIssue(state, { severity: 'info', area: 'shows', issue_type: 'duplicate_poster', title: 'Music Show duplicate poster URL', record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: 'poster URL is used by more than one show.', recommended_action: 'Review duplicate poster usage; shared multi-day posters may be intentional.', source_route: '/api/music/shows/db', details: { poster, duplicate_count: posterCounts.get(posterKey) || 0 } }); }
      if (!String(row.show_url || '').trim()) { showMetrics.missingShowUrl += 1; addMusicDataAuditIssue(state, { severity: 'info', area: 'shows', issue_type: 'missing_show_url', title: 'Music Show missing show_url', record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: 'show_url is blank.', recommended_action: 'Rerun Music Shows import after fallback generation deploy, or fill explicit show_url only when needed.', source_route: '/api/music/shows/db' }); }
      const bands = getMusicDataAuditArray(row.bands);
      if (!bands.length) { showMetrics.missingBands += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'shows', issue_type: 'missing_bands', title: 'Music Show missing bands[]', record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: 'bands[] is empty; SmugMug show album resolver requires lineup bands.', recommended_action: 'Add structured band lineup data in Music-Shows source rows.', source_route: '/api/music/shows/db' }); }
      bands.forEach((band) => { const bandName = String(band.band || '').trim(); if (bandName && bandNames.size && !bandNames.has(normalizeMusicBandDiagnosticKey(bandName))) { showMetrics.unmatchedLineupBands += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'relationships', issue_type: 'unmatched_show_lineup_band', title: 'Music Show lineup band is not in Music-Bands', record_type: 'music_show_band', record_id: `${rid}:${bandName}`, record_name: bandName, reason: `${bandName} is referenced by a show lineup but does not exactly match music_bands.band.`, recommended_action: 'Add/fix Music-Bands source row or correct the show lineup spelling.', source_route: '/api/admin/relationships/music', details: { show_id: row.show_id, show_name: row.name, date: row.date, slot: band.slot == null ? null : toIntegerCount(band.slot) } }); } });
      const venueId = String(row.venue_id || '').trim();
      if (!venueId) { showMetrics.missingVenueId += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'shows', issue_type: 'missing_venue_id', title: 'Music Show missing venue_id', record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: 'venue_id is blank; venue relationship cannot be joined.', recommended_action: 'Fill venue_id in Music-Shows using Music-Venue venue_id.', source_route: '/api/admin/relationships/music' }); }
      else if (venueIds.size && !venueIds.has(normalizeMusicBandDiagnosticKey(venueId))) { showMetrics.invalidVenueId += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'relationships', issue_type: 'invalid_venue_id', title: 'Music Show venue_id does not match Music-Venue', record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: `${venueId} does not match music_venues.venue_key/venue_id.`, recommended_action: 'Import Music-Venues first, then correct venue_id in Music-Shows if still unmatched.', source_route: '/api/admin/relationships/music', details: { venue_id: venueId, venue: row.venue || '' } }); }
      const classification = classifySmugMusicShowSnapshotRow(row);
      smugMetrics[classification.bucket] = (smugMetrics[classification.bucket] || 0) + 1;
      if (classification.bucket !== 'resolved') addMusicDataAuditIssue(state, { severity: classification.bucket === 'pending_archive' || classification.bucket === 'awaiting_upload' ? 'info' : (classification.bucket === 'resolver_error' ? 'critical' : 'warning'), area: 'smugmug', issue_type: classification.bucket, title: `Music Show SmugMug ${classification.bucket.replace(/_/g, ' ')}`, record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: classification.reason, recommended_action: classification.recommended_action, source_route: '/api/admin/diagnostics/music/smugmug-shows/classification', details: { date: row.date || '', stored_status: classification.stored_status, attempted_paths: classification.attempted_paths.slice(0, 5), album_statuses: classification.album_statuses.slice(0, 5), smug_sync_error: classification.sync_error } });
      if (classification.cover_missing) { smugMetrics.cover_missing += 1; addMusicDataAuditIssue(state, { severity: 'warning', area: 'smugmug', issue_type: 'cover_missing', title: 'Music Show SmugMug cover missing', record_type: 'music_show', record_id: rid, record_name: row.name || '', reason: 'Album/gallery fields are populated, but cover_image_url is missing.', recommended_action: classification.cover_missing_action || getSmugMusicShowClassificationAction('cover_missing'), source_route: '/api/admin/diagnostics/music/smugmug-shows/classification' }); }
    }
    state.categories.shows.metrics = showMetrics;
    state.categories.smugmug.metrics = smugMetrics;
  }
  delete state._bandNames;
  return finalizeMusicDataAuditResponse(state, generated, page, limit);
}

async function handleMusicDataAuditRequest(req, res) {
  try { return res.status(200).json(await buildMusicDataAuditResponse(req.query || {})); }
  catch (err) { return res.status(500).json(buildAdminError(MUSIC_DATA_AUDIT_ROUTE, err, { source: 'postgres', section: 'music', type: 'data_audit', error: 'MUSIC_DATA_AUDIT_ERROR' })); }
}
const MUSIC_PEOPLE_CAPTION_INDEX_ROUTE = '/api/admin/diagnostics/music/people/caption-index';
const musicPeopleCaptionIndexAlbumCache = new Map();
const MUSIC_PEOPLE_CAPTION_INDEX_CACHE_TTL_MS = 1000 * 60 * 10;

function getMusicPeopleCaptionIndexLimit(value) {
  const number = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(number)) return 25;
  return Math.min(100, Math.max(1, number));
}

function getMusicPeopleCaptionIndexAlbumLimit(value) {
  const number = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(number)) return 10;
  return Math.min(25, Math.max(1, number));
}

function getMusicPeopleCaptionIndexPhotoLimit(value) {
  const number = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(number)) return 25;
  return Math.min(50, Math.max(1, number));
}

function normalizeMusicPeopleCaptionIndexName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function splitMusicPeopleCaptionIndexTokens(caption) {
  return String(caption || '')
    .split(';')
    .map((part) => String(part || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function getMusicPeopleCaptionIndexAlbumCacheKey(albumId, photoLimit) {
  return `music_people_caption_index:v1:${albumId}:${photoLimit}`;
}

function getCachedMusicPeopleCaptionIndexAlbumPhotos(albumId, photoLimit) {
  const hit = musicPeopleCaptionIndexAlbumCache.get(getMusicPeopleCaptionIndexAlbumCacheKey(albumId, photoLimit));
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > MUSIC_PEOPLE_CAPTION_INDEX_CACHE_TTL_MS) {
    musicPeopleCaptionIndexAlbumCache.delete(getMusicPeopleCaptionIndexAlbumCacheKey(albumId, photoLimit));
    return null;
  }
  return hit.photos;
}

function setCachedMusicPeopleCaptionIndexAlbumPhotos(albumId, photoLimit, photos) {
  musicPeopleCaptionIndexAlbumCache.set(getMusicPeopleCaptionIndexAlbumCacheKey(albumId, photoLimit), {
    fetchedAt: Date.now(),
    photos
  });
}

function buildMusicPeopleCaptionIndexPhotoRef(album, photo) {
  const show = album && album.show ? album.show : {};
  return {
    album_id: String(album && album.album_id || '').trim() || null,
    gallery_id: String(album && (album.gallery_id || album.album_id) || '').trim() || null,
    image_key: String(photo && photo.image_key || '').trim() || null,
    caption: String(photo && photo.caption || '').trim(),
    thumbnail_url: String(photo && photo.thumbnail_url || '').trim() || null,
    show_id: show && show.show_id != null ? String(show.show_id) : null,
    show_name: String(show && show.name || '').trim() || null,
    show_date: String(show && (show.show_date || show.date) || '').trim() || null,
    band: String(album && album.band || '').trim() || null,
    slot: album && album.slot != null ? toIntegerCount(album.slot) : null
  };
}

async function fetchMusicPeopleCaptionIndexAlbumPhotos(albumId, photoLimit, state) {
  const cleanAlbumId = String(albumId || '').trim();
  if (!cleanAlbumId) return [];
  const cached = getCachedMusicPeopleCaptionIndexAlbumPhotos(cleanAlbumId, photoLimit);
  if (cached) {
    state.summary.cache_hits += 1;
    return cached;
  }
  state.summary.cache_misses += 1;
  const endpoint = `/album/${encodeURIComponent(cleanAlbumId)}!images?count=${photoLimit}&start=1&_accept=application/json&_expand=Image`;
  const json = await fetchSmugJson(endpoint);
  const photos = getSmugAlbumImages(json).slice(0, photoLimit).map((image) => buildSmugAlbumPhotoItem(image));
  setCachedMusicPeopleCaptionIndexAlbumPhotos(cleanAlbumId, photoLimit, photos);
  return photos;
}

function addMusicPeopleCaptionIndexAlbum(albumMap, show, album, source) {
  const albumId = getMusicPeopleArchiveAlbumKey(album);
  if (!albumId || albumMap.has(albumId)) return;
  albumMap.set(albumId, {
    album_id: albumId,
    gallery_id: String(album && (album.gallery_id || album.galleryId || albumId) || '').trim(),
    band: String(album && album.band || '').trim() || null,
    slot: album && album.slot != null ? toIntegerCount(album.slot) : null,
    source,
    show
  });
}

function collectMusicPeopleCaptionIndexAlbums(rows) {
  const albumMap = new Map();
  (Array.isArray(rows) ? rows : []).forEach((show) => {
    const smugAlbums = getMusicDataAuditArray(show && show.smug_albums);
    smugAlbums.forEach((album) => addMusicPeopleCaptionIndexAlbum(albumMap, show, album, 'smug_albums'));
    const directAlbumId = String(show && (show.album_id || show.gallery_id) || '').trim();
    if (directAlbumId && !albumMap.has(directAlbumId)) {
      albumMap.set(directAlbumId, {
        album_id: directAlbumId,
        gallery_id: String(show && (show.gallery_id || directAlbumId) || '').trim(),
        band: null,
        slot: null,
        source: 'music_shows.album_id',
        show
      });
    }
  });
  return Array.from(albumMap.values());
}

function createMusicPeopleCaptionIndexResponseShell(generated, page, limit, albumLimit, photoLimit) {
  return {
    ok: true,
    route: MUSIC_PEOPLE_CAPTION_INDEX_ROUTE,
    source: 'postgres+smugmug',
    section: 'music',
    type: 'people_caption_index_diagnostic',
    generated,
    readOnly: true,
    databaseMutated: false,
    summary: {
      database_connected: false,
      smugmug_configured: false,
      total_people: 0,
      total_albums_available: 0,
      total_albums_inspected: 0,
      total_photos_inspected: 0,
      photos_with_captions: 0,
      caption_tokens_parsed: 0,
      matched_caption_tokens: 0,
      unmatched_caption_tokens: 0,
      people_with_indexed_photo_matches: 0,
      people_with_zero_matches: 0,
      duplicate_people_name_keys: 0,
      scan_limited: false,
      album_limit: albumLimit,
      photo_limit: photoLimit,
      cache_hits: 0,
      cache_misses: 0,
      warnings: [],
      limitations: []
    },
    matches: [],
    unmatched: [],
    recommendedActions: [
      'Use this diagnostic to validate semicolon-caption tagging before adding permanent storage.',
      'Fix unmatched caption tokens in SmugMug captions or Music-People source names; matching is exact normalized name only.',
      'Increase album_limit/photo_limit carefully for a broader sample, but keep the route diagnostic-only.'
    ]
  };
}

function paginateMusicPeopleCaptionIndex(items, page, limit) {
  const total = Array.isArray(items) ? items.length : 0;
  const totalPages = total ? Math.ceil(total / limit) : 0;
  const safePage = Math.min(Math.max(1, page), Math.max(totalPages, 1));
  const offset = (safePage - 1) * limit;
  return {
    page: safePage,
    limit,
    total,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1 && totalPages > 0,
    items: (Array.isArray(items) ? items : []).slice(offset, offset + limit)
  };
}

function finalizeMusicPeopleCaptionIndexResponse(state, page, limit) {
  const matchItems = Array.from(state.matchMap.values())
    .map((entry) => ({
      person_id: entry.person_id,
      name: entry.name,
      matched_photo_count: entry.photoKeys.size,
      matched_caption_token_count: entry.token_count,
      sample_photo_refs: entry.samples.slice(0, 5),
      source_albums: Array.from(entry.albumIds).sort()
    }))
    .sort((a, b) => b.matched_photo_count - a.matched_photo_count || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const unmatchedItems = Array.from(state.unmatchedMap.values())
    .map((entry) => ({
      token: entry.token,
      normalized_token: entry.normalized_token,
      count: entry.count,
      sample_photo_refs: entry.samples.slice(0, 5),
      recommended_action: 'Add/confirm a Music-People row or correct the semicolon caption token; matching is exact normalized name only.'
    }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token, undefined, { sensitivity: 'base' }));
  state.summary.people_with_indexed_photo_matches = matchItems.length;
  state.summary.people_with_zero_matches = Math.max(0, state.summary.total_people - matchItems.length);
  const matchesPage = paginateMusicPeopleCaptionIndex(matchItems, page, limit);
  const unmatchedPage = paginateMusicPeopleCaptionIndex(unmatchedItems, page, limit);
  return buildAdminResponse({
    ok: state.ok,
    route: state.route,
    source: state.source,
    section: state.section,
    type: state.type,
    generated: state.generated,
    readOnly: true,
    databaseMutated: false,
    summary: state.summary,
    pagination: {
      page: matchesPage.page,
      limit,
      matches: {
        total: matchesPage.total,
        totalPages: matchesPage.totalPages,
        hasNextPage: matchesPage.hasNextPage,
        hasPrevPage: matchesPage.hasPrevPage
      },
      unmatched: {
        total: unmatchedPage.total,
        totalPages: unmatchedPage.totalPages,
        hasNextPage: unmatchedPage.hasNextPage,
        hasPrevPage: unmatchedPage.hasPrevPage
      }
    },
    matches: matchesPage.items,
    unmatched: unmatchedPage.items,
    recommendedActions: state.recommendedActions
  });
}

async function buildMusicPeopleCaptionIndexDiagnosticResponse(query = {}) {
  const generated = new Date();
  const page = getPageNumber(query.page);
  const limit = getMusicPeopleCaptionIndexLimit(query.limit);
  const albumLimit = getMusicPeopleCaptionIndexAlbumLimit(query.album_limit);
  const photoLimit = getMusicPeopleCaptionIndexPhotoLimit(query.photo_limit);
  const state = createMusicPeopleCaptionIndexResponseShell(generated, page, limit, albumLimit, photoLimit);
  state.matchMap = new Map();
  state.unmatchedMap = new Map();
  state.ok = true;

  if (!String(process.env.DATABASE_URL || '').trim()) {
    state.ok = false;
    state.summary.limitations.push('DATABASE_URL is not configured; cannot inspect Music People or Music Shows records.');
    return finalizeMusicPeopleCaptionIndexResponse(state, page, limit);
  }

  try { await dbPool.query('SELECT 1'); state.summary.database_connected = true; }
  catch (err) {
    state.ok = false;
    state.summary.limitations.push(`Database disconnected: ${getSafeErrorMessage(err)}`);
    return finalizeMusicPeopleCaptionIndexResponse(state, page, limit);
  }

  const existingTables = await getExistingPublicTables(['music_people', 'music_shows']);
  const columnsByTable = await getExistingPublicColumns(['music_people', 'music_shows']);
  const missingTables = ['music_people', 'music_shows'].filter((table) => !existingTables.has(table));
  if (missingTables.length) {
    state.ok = false;
    state.summary.limitations.push(`Missing required table(s): ${missingTables.join(', ')}.`);
    return finalizeMusicPeopleCaptionIndexResponse(state, page, limit);
  }
  const requiredPeopleColumns = ['person_id', 'name'];
  const requiredShowColumns = ['show_id', 'name', 'date', 'album_id', 'gallery_id', 'smug_albums'];
  const missingColumns = [];
  requiredPeopleColumns.forEach((column) => { if (!hasDiagnosticColumn(columnsByTable, 'music_people', column)) missingColumns.push(`music_people.${column}`); });
  requiredShowColumns.forEach((column) => { if (!hasDiagnosticColumn(columnsByTable, 'music_shows', column)) missingColumns.push(`music_shows.${column}`); });
  if (missingColumns.length) {
    state.ok = false;
    state.summary.limitations.push(`Missing required column(s): ${missingColumns.join(', ')}.`);
    return finalizeMusicPeopleCaptionIndexResponse(state, page, limit);
  }

  const peopleResult = await dbPool.query(`SELECT person_id, name FROM music_people ORDER BY lower(trim(coalesce(name, ''))) ASC, person_id ASC`);
  const peopleRows = peopleResult.rows || [];
  state.summary.total_people = peopleRows.length;
  const peopleByName = new Map();
  peopleRows.forEach((row) => {
    const name = String(row.name || '').trim().replace(/\s+/g, ' ');
    const key = normalizeMusicPeopleCaptionIndexName(name);
    if (!key) return;
    if (!peopleByName.has(key)) peopleByName.set(key, []);
    peopleByName.get(key).push({ person_id: row.person_id == null ? '' : String(row.person_id), name });
  });
  state.summary.duplicate_people_name_keys = Array.from(peopleByName.values()).filter((rows) => rows.length > 1).length;

  const showResult = await dbPool.query(`
    SELECT show_id, name, date, show_date, gallery_id, album_id, smug_albums
    FROM music_shows
    WHERE (
      (jsonb_typeof(smug_albums) = 'array' AND jsonb_array_length(smug_albums) > 0)
      OR trim(coalesce(album_id, '')) <> ''
      OR trim(coalesce(gallery_id, '')) <> ''
    )
    ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST
  `);
  const albums = collectMusicPeopleCaptionIndexAlbums(showResult.rows || []);
  state.summary.total_albums_available = albums.length;
  const sampledAlbums = albums.slice(0, albumLimit);
  state.summary.total_albums_inspected = sampledAlbums.length;
  state.summary.scan_limited = albums.length > sampledAlbums.length;

  const smugConfig = getSmugMugConfigDiagnostics();
  state.summary.smugmug_configured = smugConfig.configured;
  if (!smugConfig.configured) {
    state.summary.limitations.push(`SmugMug is not configured; missing ${smugConfig.missing.join(', ')}.`);
    return finalizeMusicPeopleCaptionIndexResponse(state, page, limit);
  }

  await mapWithConcurrency(sampledAlbums, SMUG_REQUEST_CONCURRENCY, async (album) => {
    let photos = [];
    try { photos = await fetchMusicPeopleCaptionIndexAlbumPhotos(album.album_id, photoLimit, state); }
    catch (err) {
      state.summary.warnings.push(`Album ${album.album_id} scan failed: ${getSafeErrorMessage(err)}`);
      return;
    }
    state.summary.total_photos_inspected += photos.length;
    photos.forEach((photo) => {
      const caption = String(photo && photo.caption || '').trim();
      if (!caption) return;
      state.summary.photos_with_captions += 1;
      const ref = buildMusicPeopleCaptionIndexPhotoRef(album, photo);
      splitMusicPeopleCaptionIndexTokens(caption).forEach((token) => {
        const key = normalizeMusicPeopleCaptionIndexName(token);
        if (!key) return;
        state.summary.caption_tokens_parsed += 1;
        const people = peopleByName.get(key) || [];
        if (people.length) {
          state.summary.matched_caption_tokens += 1;
          people.forEach((person) => {
            const personKey = person.person_id || person.name;
            if (!state.matchMap.has(personKey)) {
              state.matchMap.set(personKey, { person_id: person.person_id, name: person.name, photoKeys: new Set(), token_count: 0, samples: [], albumIds: new Set() });
            }
            const entry = state.matchMap.get(personKey);
            entry.token_count += 1;
            const photoKey = `${ref.album_id || ''}:${ref.image_key || ''}:${caption}`;
            entry.photoKeys.add(photoKey);
            if (entry.samples.length < 5) entry.samples.push(ref);
            if (ref.album_id) entry.albumIds.add(ref.album_id);
          });
        } else {
          state.summary.unmatched_caption_tokens += 1;
          if (!state.unmatchedMap.has(key)) state.unmatchedMap.set(key, { token, normalized_token: key, count: 0, samples: [] });
          const entry = state.unmatchedMap.get(key);
          entry.count += 1;
          if (entry.samples.length < 5) entry.samples.push(ref);
        }
      });
    });
  });

  return finalizeMusicPeopleCaptionIndexResponse(state, page, limit);
}

async function handleMusicPeopleCaptionIndexDiagnosticRequest(req, res) {
  try {
    return res.status(200).json(await buildMusicPeopleCaptionIndexDiagnosticResponse(req.query || {}));
  } catch (err) {
    return res.status(500).json(buildAdminError(MUSIC_PEOPLE_CAPTION_INDEX_ROUTE, err, { source: 'postgres+smugmug', section: 'music', type: 'people_caption_index_diagnostic', error: 'MUSIC_PEOPLE_CAPTION_INDEX_ERROR' }));
  }
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

app.get(MUSIC_SMUGMUG_HEALTH_ROUTE, handleMusicSmugMugHealthRequest);
app.get(MUSIC_SMUGMUG_EXCEPTIONS_ROUTE, handleMusicSmugMugExceptionsRequest);
app.get(MUSIC_SMUGMUG_VERIFY_ROUTE, handleMusicSmugMugVerifyRequest);
app.get(MUSIC_SMUGMUG_GALLERY_VERIFY_ROUTE, handleMusicSmugMugGalleryVerificationRequest);
app.get(MUSIC_SMUGMUG_RELATIONSHIP_AUDIT_ROUTE, handleMusicSmugMugRelationshipAuditRequest);

async function handleSmugMusicShowClassificationRequest(req, res) {
  try {
    return res.json(await buildSmugMusicShowClassificationResponse(req.query || {}));
  } catch (err) {
    return res.status(500).json(buildAdminError(req.path || '/api/admin/diagnostics/music/smugmug-shows/classification', err, {
      source: 'postgres',
      section: 'music',
      type: 'smug_show_classification',
      error: 'SMUG_SHOW_CLASSIFICATION_ERROR'
    }));
  }
}

app.get([
  '/api/admin/diagnostics/music/smugmug-shows/classification',
  '/admin/smug/music/shows/classification',
  '/api/admin/smug/music/shows/classification'
], handleSmugMusicShowClassificationRequest);

async function handleSmugMusicShowRepairRequest(req, res) {
  let importLock = null;
  try {
    const dryRun = isSmugMusicShowRepairDryRun(req.query || {});
    if (!dryRun && !getConfiguredAdminSecrets().length) {
      return res.status(503).json(buildAdminAccessError(
        req,
        'ADMIN_PROTECTION_NOT_CONFIGURED',
        'Set ADMIN_TOKEN or ADMIN_PASSWORD before running Music Show SmugMug repair with dry_run=false.'
      ));
    }

    const lockAttempt = await acquireImportLock({
      section: 'music',
      category: 'smug_shows_repair',
      owner: getImportLockOwner(),
      meta: {
        route: req.path || '/api/admin/smug/music/shows/repair',
        dry_run: dryRun,
        limit: getSmugMusicShowRepairLimit((req.query || {}).limit),
        buckets: getSmugMusicShowRepairRequestedBuckets(req.query || {})
      }
    });

    if (lockAttempt && lockAttempt.acquired === false) {
      return res.status(409).json(buildAdminResponse({
        ok: false,
        route: req.path || '/api/admin/smug/music/shows/repair',
        source: 'smugmug',
        section: 'music',
        type: 'smug_show_repair',
        locked: true,
        message: 'Music Show SmugMug repair already running',
        lock: lockAttempt.lock
      }));
    }

    importLock = lockAttempt && lockAttempt.lock ? lockAttempt.lock : null;
    const response = await runSmugMusicShowRepair(req.query || {});
    const released = await releaseImportLock(importLock && importLock.id, response.ok ? 'completed' : 'failed', {
      completedAt: new Date().toISOString(),
      status: response.ok ? 'completed' : 'failed',
      route: req.path || '/api/admin/smug/music/shows/repair',
      dry_run: response.dry_run,
      recordsUpdated: response.summary ? response.summary.records_updated : 0
    });
    if (released) response.importLock = released;
    return res.status(response.ok ? 200 : 400).json(response);
  } catch (err) {
    const released = await releaseImportLock(importLock && importLock.id, 'failed', {
      completedAt: new Date().toISOString(),
      status: 'failed',
      error: getSafeErrorMessage(err),
      route: req.path || '/api/admin/smug/music/shows/repair'
    });
    const errorResponse = buildAdminError(req.path || '/api/admin/smug/music/shows/repair', err, {
      source: 'smugmug',
      section: 'music',
      type: 'smug_show_repair',
      error: 'SMUG_SHOW_REPAIR_ERROR'
    });
    if (released) errorResponse.importLock = released;
    return res.status(500).json(errorResponse);
  }
}

app.get([
  '/api/admin/smug/music/shows/repair',
  '/admin/smug/music/shows/repair'
], handleSmugMusicShowRepairRequest);
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

app.get('/api/admin/diagnostics/music/people/caption-index', async (req, res) => {
  return handleMusicPeopleCaptionIndexDiagnosticRequest(req, res);
});

app.get('/api/admin/diagnostics/music/data-audit', async (req, res) => {
  return handleMusicDataAuditRequest(req, res);
});

app.get('/api/admin/diagnostics/music/bands/smug-folder', async (req, res) => {
  return handleMusicBandSmugFolderDiagnosticsRequest(req, res);
});

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

app.get('/api/admin/diagnostics/wrestling/people/photo-aggregation', async (req, res) => {
  return handleWrestlingPeoplePhotoAggregationDiagnosticRequest(req, res);
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

app.get('/api/music/smugmug/albums/:album_id/photos', async (req, res) => {
  return handleMusicSmugAlbumPhotosRequest(req, res);
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

app.get('/api/music/people/db/:personId', async (req, res) => {
  return handleMusicPersonDbDetailRequest(req, res);
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

app.get('/api/music/venues/:venue_id/photos', async (req, res) => {
  return handleMusicVenuePhotosRequest(req, res);
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
        const archiveCoverageBandRef = getMusicBandArchiveCoverageRequestRef(req.query);
        if (archiveCoverageBandRef) {
          return res.json(await buildMusicBandArchiveCoverageResponse(payload, archiveCoverageBandRef, forceRefresh));
        }
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

















































