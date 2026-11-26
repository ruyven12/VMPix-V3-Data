'use strict';

const REASONS = new Set(['configuration_missing', 'album_limit_reached', 'photo_page_limit_reached',
  'pagination_incomplete', 'source_check_failed', 'provider_request_failed', 'preparation_invalidated', 'persistence_failed', 'persistence_invalid']);
const failure = code => Object.assign(new Error(code), { code });
const safeReason = error => REASONS.has(error?.code) ? error.code : 'preparation_failed';
const safeAlbum = value => typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value) ? value : null;
const emptyState = () => ({ status: 'preparing', reason: 'not_prepared', started_at: null, completed_at: null,
  finished_at: null, failed_at: null, last_progress_at: null, albums_processed: 0, total_albums: null,
  pages_processed: 0, albums_from_cache: 0, failed_album_id: null });

// One lifecycle per prepared population, never per response page.
function createMusicPeopleReadiness({ ttlMs, now = Date.now, describe = () => null }) {
  let generation = 0, cache = null, pending = null;
  let state = emptyState();
  const read = () => cache?.value || null;
  const needsRefresh = () => !!cache && now() - cache.at >= ttlMs;
  function restore(value) {
    const saved = describe(value);
    const at = Date.parse(saved?.verifiedAt);
    if (pending || !saved || !Number.isFinite(at)) return false;
    generation = Math.max(generation, saved.generation);
    cache = { value, at, generation: saved.generation };
    state = { ...emptyState(), ...saved.coverage, status: 'ready', reason: null, completed_at: saved.verifiedAt, finished_at: saved.verifiedAt };
    return true;
  }
  function invalidate(reason = 'source_changed', { resetError = false } = {}) {
    generation++; cache = null;
    if (state.status !== 'error' || resetError) state = { ...emptyState(), reason };
  }
  function snapshot(value) {
    const current = read(), authoritative = !!current && value === current;
    const saved = authoritative ? describe(current) : null;
    return { ...state, status: authoritative ? 'ready' : state.status, reason: authoritative ? null : state.reason,
      completed_at: authoritative ? new Date(cache.at).toISOString() : state.completed_at,
      generation: authoritative ? cache.generation : generation, authoritative,
      stale: authoritative && needsRefresh(), refreshing: authoritative && !!pending,
      refresh_status: authoritative ? state.status : null,
      refresh_reason: authoritative && state.status === 'error' ? state.reason : null,
      refresh_retry_allowed: authoritative && state.status === 'error' && !pending,
      source_fingerprint: saved?.fingerprint || null,
      active: !!pending, retry_allowed: !authoritative && state.status === 'error' && !pending,
      elapsed_ms: state.started_at ? Math.max(0, (state.finished_at ? Date.parse(state.finished_at) : now()) - Date.parse(state.started_at)) : 0,
      scope: 'linked_music_show_albums', expires_at: cache ? new Date(cache.at + ttlMs).toISOString() : null };
  }
  function fail(reason, { preserveCache = false } = {}) {
    if (preserveCache) generation++;
    else invalidate(reason);
    state = { ...state, status: 'error', reason, failed_at: new Date(now()).toISOString() };
  }
  function prepare(build, { retry = false, refresh = false } = {}) {
    const current = read();
    if (current && !refresh && !needsRefresh()) return Promise.resolve(current);
    if (pending) return pending;
    if (state.status === 'error' && !retry) return Promise.resolve(current || new Map());
    if (current || state.status === 'error') generation++;
    const version = generation;
    state = { ...emptyState(), status: 'preparing', reason: 'building', started_at: new Date(now()).toISOString(),
      attempt_generation: version };
    const progress = update => {
      if (version === generation) state = { ...state, ...update, last_progress_at: new Date(now()).toISOString() };
    };
    const control = {
      generation: version, startedAt: state.started_at,
      progress: () => ({ total_albums: state.total_albums, albums_processed: state.albums_processed,
        pages_processed: state.pages_processed, albums_from_cache: state.albums_from_cache }),
      resumeProgress: coverage => progress({ total_albums: coverage.total_albums, albums_processed: coverage.albums_processed,
        pages_processed: coverage.pages_processed, albums_from_cache: coverage.albums_from_cache }),
      isCancelled: () => version !== generation || state.status === 'error',
      setAlbumsTotal: total => progress({ total_albums: total }),
      albumProcessed: () => progress({ albums_processed: state.albums_processed + 1 }),
      pageProcessed: () => progress({ pages_processed: state.pages_processed + 1 }),
      albumCached: () => progress({ albums_from_cache: state.albums_from_cache + 1 }),
      failure(error, albumId) {
        if (version === generation && state.status !== 'error') state = { ...state, status: 'error',
          reason: safeReason(error), failed_album_id: safeAlbum(albumId), failed_at: new Date(now()).toISOString() };
      }
    };
    const run = Promise.resolve().then(() => build(control)).then(value => {
      if (version !== generation || state.status === 'error') return read() || new Map();
      const saved = describe(value), verified = Date.parse(saved?.verifiedAt);
      const at = Number.isFinite(verified) ? verified : now();
      cache = { value, at, generation: saved?.generation ?? version };
      generation = Math.max(generation, cache.generation);
      state = { ...state, status: 'ready', reason: null, completed_at: new Date(at).toISOString(),
        finished_at: new Date(now()).toISOString() };
      return value;
    }).catch(error => {
      control.failure(error);
      return read() || new Map();
    }).finally(() => {
      if (pending === run) {
        pending = null;
        if (version === generation || state.status === 'error') state = { ...state, finished_at: new Date(now()).toISOString() };
      }
    });
    pending = run;
    return run;
  }
  return { read, snapshot, prepare, invalidate, fail, restore, needsRefresh };
}

// Person-detail and population scans share this in-process gate. Waiting scans
// cannot start provider work while an earlier generation is still draining.
function createMusicPeoplePreparationGate() {
  let pending = null;
  return async (work, control) => {
    while (pending) { try { await pending; } catch (_) {} }
    if (control.isCancelled()) throw failure('preparation_invalidated');
    const run = Promise.resolve().then(work);
    pending = run;
    try { return await run; } finally { if (pending === run) pending = null; }
  };
}

async function runMusicPeopleAlbumWorkers(albums, concurrency, mapper, control) {
  let next = 0, firstError = null;
  control.setAlbumsTotal(albums.length);
  const worker = async () => {
    while (!firstError && !control.isCancelled() && next < albums.length) {
      const album = albums[next++];
      try {
        await mapper(album, control);
        if (!control.isCancelled()) control.albumProcessed();
      } catch (error) {
        if (!firstError) { firstError = error; control.failure(error, album.album_id); }
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, albums.length) }, worker));
  if (firstError) throw firstError;
  if (control.isCancelled()) throw failure('preparation_invalidated');
}

// Never infer a complete album from a short page or a missing pagination object.
function musicPeopleAlbumPage(json, images, { albumId, start, limit, previousTotal }) {
  const response = json && (json.Response || json), pages = response?.Pages;
  const rawTotal = pages?.Total ?? pages?.total;
  const total = typeof rawTotal === 'number' || typeof rawTotal === 'string' && /^\d+$/.test(rawTotal) ? Number(rawTotal) : NaN;
  if (!Number.isSafeInteger(total) || total < 0 || previousTotal != null && total !== previousTotal ||
      !Array.isArray(images) || images.length > limit || start - 1 + images.length > total ||
      (pages.Start ?? pages.start) != null && Number(pages.Start ?? pages.start) !== start ||
      images.length === 0 && start - 1 < total) throw failure('pagination_incomplete');
  const nextStart = start + images.length, hasMore = nextStart - 1 < total;
  const next = pages.NextPage || pages.nextPage;
  if (next) {
    try {
      const url = new URL(next, 'https://api.smugmug.com');
      if (!hasMore || url.origin !== 'https://api.smugmug.com' ||
          ![`/api/v2/album/${albumId}!images`, `/album/${albumId}!images`].includes(url.pathname) ||
          url.searchParams.getAll('start').length !== 1 || Number(url.searchParams.get('start')) !== nextStart) throw Error();
    } catch (_) { throw failure('pagination_incomplete'); }
  }
  return { total, has_more: hasMore, next_start: hasMore ? nextStart : null };
}

module.exports = { createMusicPeopleReadiness, createMusicPeoplePreparationGate, runMusicPeopleAlbumWorkers, musicPeopleAlbumPage };
