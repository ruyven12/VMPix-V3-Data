'use strict';

// One lifecycle per prepared population, never per response page.
function createMusicPeopleReadiness({ ttlMs, now = Date.now }) {
  let generation = 0, cache = null, pending = null;
  let state = { status: 'preparing', reason: 'not_prepared', started_at: null, completed_at: null };
  function invalidate(reason = 'source_changed') {
    generation++; cache = null; pending = null;
    state = { status: 'preparing', reason, started_at: null, completed_at: null };
  }
  function read() {
    if (cache && now() - cache.at >= ttlMs) invalidate('cache_expired');
    return cache?.value || null;
  }
  function snapshot(value) {
    const current = read();
    return { ...state, generation, authoritative: !!current && value === current,
      scope: 'linked_music_show_albums', expires_at: cache ? new Date(cache.at + ttlMs).toISOString() : null };
  }
  function fail(reason) {
    invalidate(reason);
    state = { ...state, status: 'error' };
  }
  function prepare(build) {
    const current = read();
    if (current) return Promise.resolve(current);
    if (pending) return pending;
    const version = generation;
    state = { status: 'preparing', reason: 'building', started_at: new Date(now()).toISOString(), completed_at: null };
    const run = Promise.resolve().then(build).then(value => {
      if (version !== generation) return new Map();
      cache = { value, at: now() };
      state = { ...state, status: 'ready', reason: null, completed_at: new Date(now()).toISOString() };
      return value;
    }).catch(error => {
      if (version === generation) state = { ...state, status: 'error', reason:
        ['configuration_missing', 'album_limit_reached', 'photo_page_limit_reached', 'pagination_incomplete',
          'source_check_failed', 'provider_request_failed'].includes(error?.code) ? error.code : 'preparation_failed' };
      return new Map();
    }).finally(() => { if (pending === run) pending = null; });
    pending = run;
    return run;
  }
  return { read, snapshot, prepare, invalidate, fail };
}

module.exports = { createMusicPeopleReadiness };
