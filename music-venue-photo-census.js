'use strict';

const crypto = require('node:crypto');
const DEFINITION = 'music_venue_unique_photographs_v1';
const key = value => typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value.trim()) ? value.trim() : '';
const normalized = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const array = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return Array.isArray(value) ? value : null;
};
const imageKey = value => key(typeof value === 'string' ? value.replace(/^i-/i, '') : value);
const integer = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function albumIds(show) {
  return [...new Set([show.album_id, show.gallery_id,
    ...(array(show.smug_albums) || []).flatMap(a => [a?.album_id, a?.gallery_id])].map(key).filter(Boolean))];
}

// Membership is proved by stored resolved set mappings plus an exact provider path.
// Shared cross-venue albums are ambiguous: never count their entire contents.
function buildPlan(venue, shows, dateFolder) {
  const venueId = String(venue.venue_key || venue.venue_id || '').trim();
  const aliases = new Set([venueId, String(venue.venue_id ?? '')].map(normalized).filter(Boolean));
  const linked = shows.filter(s => aliases.has(normalized(s.venue_id)));
  const ambiguous = shows.filter(s => !normalized(s.venue_id) && normalized(s.venue) === normalized(venue.venue));
  const issues = [];
  const albums = new Map();
  const issue = (reason, show, albumId) => issues.push({ reason, ...(show ? { show_id: show.show_id } : {}),
    ...(albumId ? { album_id: albumId } : {}) });
  ambiguous.forEach(s => issue('show_missing_stable_venue_id', s));
  for (const show of linked) {
    const mappings = array(show.smug_albums);
    const bands = array(show.bands);
    const folder = dateFolder(show.date);
    if (!mappings?.length || !bands?.length || !folder) {
      issue('show_missing_verified_set_mappings', show);
      continue;
    }
    const verified = [];
    for (const mapping of mappings) {
      const id = key(mapping?.album_id) || key(mapping?.gallery_id);
      const path = typeof mapping?.smug_path === 'string' ? mapping.smug_path : '';
      const parts = path.split('/');
      const band = bands.find(b => b && normalized(b.band) === normalized(mapping?.band) &&
        (mapping.slot == null || b.slot == null || String(mapping.slot) === String(b.slot)));
      if (!id || !['resolved', 'resolved_duplicate_path_match'].includes(mapping.status) ||
          Number(mapping.duplicateMatchCount || 1) > 1 || !band ||
          (mapping.album_id && mapping.album_id !== id) || (mapping.gallery_id && mapping.gallery_id !== id) ||
          parts.length !== 6 || parts.slice(0, 3).join('/') !== 'Music/Archives/Bands' ||
          !['Local', 'Regional', 'National', 'International'].includes(parts[3]) ||
          !parts[4] || /[?#\\]/.test(path) || parts[5] !== folder) {
        issue('unverified_album_mapping', show, id);
        continue;
      }
      verified.push({ ...mapping, album_id: id });
      const existing = albums.get(id);
      if (existing && existing.path !== path) issue('album_path_collision', show, id);
      else if (!existing) albums.set(id, { album_id: id, path, show_ids: [] });
      if (albums.has(id)) albums.get(id).show_ids.push(show.show_id);
    }
    for (const band of bands) {
      if (!band || !verified.some(m => normalized(m.band) === normalized(band.band) &&
          (m.slot == null || band.slot == null || String(m.slot) === String(band.slot)))) {
        issue('lineup_album_unresolved', show);
      }
    }
    for (const id of albumIds(show)) {
      if (!verified.some(m => m.album_id === id)) issue('album_without_verified_mapping', show, id);
    }
  }
  const selectedIds = new Set(linked.flatMap(albumIds));
  const references = shows.filter(s => albumIds(s).some(id => selectedIds.has(id)));
  for (const show of references) {
    if (!aliases.has(normalized(show.venue_id))) {
      for (const id of albumIds(show).filter(id => selectedIds.has(id))) issue('album_shared_outside_venue', show, id);
    }
  }
  const sourceFingerprint = fingerprint({ venueId, venueName: venue.venue, linked, ambiguous, references });
  return { venue_id: venueId, linked_show_count: linked.length, albums: [...albums.values()], issues, sourceFingerprint };
}

function providerPath(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)smugmug\.com$/i.test(url.hostname)) return '';
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  } catch { return ''; }
}

async function scan(plan, { fetchJson, getImages, now = Date.now, deadline = now() + 90000,
  maxAlbums = 100, maxPages = 100, pageSize = 200 }) {
  const issues = [...plan.issues];
  const coverage = { linked_show_count: plan.linked_show_count, album_count: plan.albums.length,
    albums_scanned: 0, pages_fetched: 0, image_records_examined: 0, photographs_examined: 0,
    videos_excluded: 0, duplicates_removed: 0 };
  const keys = new Set();
  // Reuse the provider helper, but never let a stalled request publish a result.
  async function request(endpoint) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('scan_deadline_reached');
    let timer;
    try { return await Promise.race([fetchJson(endpoint), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('scan_deadline_reached')), remaining);
    })]); } finally { clearTimeout(timer); }
  }
  if (plan.albums.length > maxAlbums) issues.push({ reason: 'album_scan_limit_reached' });
  // Do not perform external reads for relationships already known to be ambiguous.
  if (!issues.length) for (const album of plan.albums) {
    try {
      const metadata = await request(`/album/${album.album_id}?_accept=application/json`);
      const object = metadata?.Response?.Album || metadata?.Album;
      if (key(object?.AlbumKey) !== album.album_id || providerPath(object?.WebUri) !== album.path) {
        throw new Error('provider_album_attribution_mismatch');
      }
      let start = 1, expectedTotal = null, finished = false;
      const seenInAlbum = new Set();
      for (let page = 0; page < maxPages; page++) {
        const json = await request(`/album/${album.album_id}!images?count=${pageSize}&start=${start}&_accept=application/json&_expand=Image`);
        coverage.pages_fetched++;
        const response = json?.Response || json;
        const pages = response?.Pages;
        const total = integer(pages?.Total);
        if (total === null || integer(pages?.Start) !== start) throw new Error('pagination_unverifiable');
        if (expectedTotal !== null && total !== expectedTotal) throw new Error('album_changed_during_scan');
        expectedTotal = total;
        const raw = response?.AlbumImage ?? response?.AlbumImages ?? response?.Images ?? response?.images;
        if (raw == null && total !== 0) throw new Error('image_page_missing');
        const images = getImages(json);
        if (images.length > pageSize || (images.length === 0 && start <= total) || start - 1 + images.length > total) {
          throw new Error('pagination_incomplete');
        }
        coverage.image_records_examined += images.length;
        for (const item of images) {
          const image = item?.Image || item;
          const id = imageKey(image?.ImageKey || item?.ImageKey);
          if (!id) throw new Error('missing_stable_image_identity');
          if (seenInAlbum.has(id)) throw new Error('repeated_image_across_album_pages');
          seenInAlbum.add(id);
          const video = image?.IsVideo ?? item?.IsVideo;
          if ([true, 'true', 1, '1'].includes(video)) { coverage.videos_excluded++; continue; }
          if (![false, 'false', 0, '0'].includes(video)) throw new Error('unknown_media_type');
          coverage.photographs_examined++;
          if (keys.has(id)) coverage.duplicates_removed++;
          keys.add(id);
        }
        const consumed = start - 1 + images.length;
        if (consumed === total) {
          if (pages.NextPage) throw new Error('unexpected_next_page');
          finished = true;
          break;
        }
        if (!pages.NextPage) throw new Error('next_page_missing');
        // Construct the next request locally; never follow a provider-supplied URL.
        start = consumed + 1;
      }
      if (!finished) throw new Error('page_scan_limit_reached');
      coverage.albums_scanned++;
    } catch (error) {
      const safe = new Set(['scan_deadline_reached', 'provider_album_attribution_mismatch', 'pagination_unverifiable',
        'album_changed_during_scan', 'image_page_missing', 'pagination_incomplete', 'missing_stable_image_identity',
        'repeated_image_across_album_pages', 'unknown_media_type', 'unexpected_next_page', 'next_page_missing', 'page_scan_limit_reached']);
      issues.push({ album_id: album.album_id, reason: safe.has(error.message) ? error.message : 'provider_request_failed' });
      if (now() >= deadline) break;
    }
  }
  const complete = issues.length === 0 && coverage.albums_scanned === plan.albums.length;
  const scannedAt = new Date(now()).toISOString();
  return { definition: DEFINITION, venue_id: plan.venue_id, total: complete ? keys.size : null,
    status: complete ? 'complete' : 'incomplete', complete, scannedAt, verifiedAt: complete ? scannedAt : null,
    sourceFingerprint: plan.sourceFingerprint, coverage, issues,
    provenance: { source: 'SmugMug album image pages', attribution: 'resolved_set_exact_path_exclusive_venue',
      identity: 'case_sensitive_ImageKey_without_optional_i_prefix',
      albums: plan.albums.map(a => ({ ...a, show_ids: [...new Set(a.show_ids)] })) } };
}

function project(plan, rows) {
  const attempt = rows.find(r => r.snapshot_key.endsWith(':attempt'))?.data;
  const verified = rows.find(r => r.snapshot_key.endsWith(':verified'))?.data;
  const current = attempt?.definition === DEFINITION && attempt.venue_id === plan.venue_id ? attempt : null;
  const fresh = current?.sourceFingerprint === plan.sourceFingerprint && !plan.issues.length;
  const valid = fresh && current.complete === true && current.status === 'complete' &&
    Number.isSafeInteger(current.total) && current.total >= 0 && Number.isFinite(Date.parse(current.verifiedAt));
  return { definition: DEFINITION, venue_id: plan.venue_id, total: valid ? current.total : null,
    status: valid ? 'complete' : current ? (fresh ? 'incomplete' : 'stale') : 'unavailable', complete: !!valid,
    verifiedAt: valid ? current.verifiedAt : null, lastVerifiedAt: verified?.verifiedAt || null,
    scannedAt: current?.scannedAt || null, coverage: current?.coverage || null,
    issues: plan.issues.length ? plan.issues : current?.issues || [], provenance: current?.provenance || null };
}

function createMusicVenuePhotoCensus({ db, fetchJson, getImages, dateFolder }) {
  const source = async client => (await client.query(`SELECT show_id, name, date, venue_id, venue,
    album_id, gallery_id, bands, smug_albums FROM music_shows ORDER BY show_id`)).rows;
  const snapshotKey = id => `venue_photos:${encodeURIComponent(id)}`;
  async function read(venue) {
    const plan = buildPlan(venue, await source(db), dateFolder);
    try {
      const rows = (await db.query(`SELECT snapshot_key, data FROM stats_snapshots
        WHERE section = 'music' AND category = 'venues' AND snapshot_key = ANY($1::text[])`,
      [[`${snapshotKey(plan.venue_id)}:attempt`, `${snapshotKey(plan.venue_id)}:verified`]])).rows;
      return project(plan, rows);
    } catch { return { ...project(plan, []), issues: [{ reason: 'snapshot_storage_unavailable' }] }; }
  }
  async function refresh(venue, lock) {
    if (!lock?.id || !Number.isFinite(Date.parse(lock.expires_at))) throw new Error('active_lock_required');
    const plan = buildPlan(venue, await source(db), dateFolder);
    const result = await scan(plan, { fetchJson, getImages,
      deadline: Math.min(Date.now() + 90000, Date.parse(lock.expires_at) - 5000) });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const lease = await client.query("SELECT id FROM import_locks WHERE id = $1 AND status = 'running' AND expires_at > NOW() FOR UPDATE", [lock.id]);
      if (!lease.rows.length) throw new Error('refresh_lock_expired');
      await client.query('LOCK TABLE music_shows, music_venues IN SHARE MODE');
      const freshVenue = (await client.query('SELECT venue_id, venue_key, venue FROM music_venues WHERE venue_id = $1', [venue.venue_id])).rows[0];
      const freshPlan = freshVenue && buildPlan(freshVenue, await source(client), dateFolder);
      if (!freshPlan || freshPlan.sourceFingerprint !== result.sourceFingerprint) {
        result.total = null; result.complete = false; result.status = 'incomplete'; result.verifiedAt = null;
        result.issues.push({ reason: 'venue_relationships_changed_during_scan' });
      }
      for (const suffix of result.complete ? ['attempt', 'verified'] : ['attempt']) {
        await client.query(`INSERT INTO stats_snapshots (section, category, snapshot_key, data, generated_at, meta)
          VALUES ('music', 'venues', $1, $2::jsonb, $3, $4::jsonb)
          ON CONFLICT (section, category, snapshot_key) DO UPDATE SET data = EXCLUDED.data,
            generated_at = EXCLUDED.generated_at, meta = EXCLUDED.meta`,
        [`${snapshotKey(plan.venue_id)}:${suffix}`, JSON.stringify(result), result.scannedAt,
          JSON.stringify({ operation: 'venue_photo_census', definition: DEFINITION })]);
      }
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  return { read, refresh };
}

module.exports = { DEFINITION, buildPlan, scan, project, createMusicVenuePhotoCensus };
