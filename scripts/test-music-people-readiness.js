'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createMusicPeopleReadiness, createMusicPeoplePreparationGate, runMusicPeopleAlbumWorkers,
  musicPeopleAlbumPage } = require('../music-people-readiness');
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function loadFunction(ctx, name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert(start >= 0, name);
  const rest = source.slice(start), next = rest.slice(1).search(/\n(?:async )?function /);
  vm.runInContext(next < 0 ? rest : rest.slice(0, next + 1), ctx);
}
function fixture() {
  let time = 10000, version = 'v1', builds = 0, failDb = false;
  let build = async () => new Map([['1', { photo_count: 3 }]]);
  const readiness = createMusicPeopleReadiness({ ttlMs: 1000, now: () => time });
  const ctx = vm.createContext({ Map, Set, Date, Promise, setTimeout, clearTimeout, createMusicPeopleReadiness,
    musicPeopleAlbumPage, musicPeoplePreparationGate: createMusicPeoplePreparationGate(),
    process: { env: { DATABASE_URL: 'synthetic' } }, SMUG_API_KEY: 'synthetic',
    MUSIC_PEOPLE_ARCHIVE_CACHE_TTL_MS: 1000, MUSIC_PEOPLE_ARCHIVE_REQUEST_WAIT_MS: 0,
    MUSIC_PEOPLE_ARCHIVE_MAX_PHOTO_PAGES_PER_ALBUM: 2, MUSIC_PEOPLE_ARCHIVE_PHOTOS_PAGE_LIMIT: 2,
    musicPeopleReadiness: readiness, musicPeopleSourceVersion: null, musicPeopleSourceCheck: null, musicPeopleSourceGeneration: 0,
    smugMusicPersonArchiveRelationshipCache: new Map(), smugMusicPeopleArchiveAlbumPhotosCache: new Map(),
    smugMusicPeopleArchiveAlbumPhotosInFlight: new Map(),
    dbPool: { query: async sql => {
      assert(!/\b(UPDATE|INSERT|DELETE|ALTER|CREATE)\b/.test(sql));
      if (failDb) throw Error('private detail');
      if (sql.includes('AS people')) return { rows: [{ people: version, shows: version }] };
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 2 }] };
      return { rows: [{ person_id: 1, name: 'Person One', stats: { photo_count: 9 } },
        { person_id: 2, name: 'Person Two', stats: { photo_count: 8 } }] };
    } },
    buildMusicPeopleArchiveRelationshipsForPeople: async () => { builds++; return build(); },
    getCanonicalCount: n => Math.max(0, Number(n) || 0), toIntegerCount: n => Number(n) || 0,
    getClampedLimit: n => Number(n) || 25, getPageNumber: n => Number(n) || 1,
    buildMusicPeopleDbQueryOptions: () => ({ values: [], whereSql: '', orderBySql: 'name', filters: {}, sort: {} }),
    buildPaginationMeta: (page, limit, total, count) => ({ count, totalPages: 1, hasNextPage: false, hasPrevPage: page > 1 }),
    formatEasternGeneratedTime: () => '', buildListMeta: x => x, buildApiError: () => ({ ok: false }),
    getSmugAlbumImages: json => json.Response?.AlbumImage || [], buildSmugAlbumPhotoItem: image => image,
    buildSmugAlbumPhotosPagination: (json, images, limit, start) => ({ has_more: start + images.length - 1 < json.Response.Pages.Total,
      next_start: start + images.length }), fetchSmugJson: async () => { throw Error('provider'); }
  });
  for (const name of ['checkMusicPeopleRelationshipSource', 'buildMusicPeopleArchiveRelationships',
    'getCachedMusicPeopleArchiveRelationships', 'getMusicPeopleArchiveRelationshipsForRequest',
    'shouldIncludeMusicPeopleArchive', 'shouldUseCachedMusicPeopleArchive', 'getMusicPeopleArchiveRelationshipsForListRequest',
    'getMusicPersonArchiveRelationship', 'createEmptyMusicPersonArchivePayload', 'buildMusicPersonDbApiItem',
    'fetchMusicPeopleArchiveAlbumPhotos', 'handleMusicPeopleDbRequest', 'getMusicStatsNumber', 'addMusicCanonicalAliases',
    'getCanonicalNullableString']) {
    loadFunction(ctx, name);
  }
  return { ctx, readiness, builds: () => builds, advance: () => { time += 1001; },
    changeSource: () => { version += 'x'; }, failDb: value => { failDb = value; }, build: fn => { build = fn; } };
}

function runtimeFixture() {
  const f = fixture(), routes = new Map();
  const start = require('../package.json').scripts.start;
  assert.equal(start, 'node server-runtime.js');
  f.ctx.app = { get(route, handler) {
    assert(!routes.has(route), 'runtime must not shadow the canonical route');
    routes.set(route, handler);
  } };
  // Execute the real npm-start entrypoint, isolating server startup side effects.
  // Its server dependency installs the actual route declarations and handlers
  // against the existing mocked DB/provider fixture, never migrations or sockets.
  let loads = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('../server-runtime.js'), 'utf8'), {
    require(id) {
      assert.equal(id, './server'); loads++;
      for (const name of ['slugifyMusicBandId', 'handleMusicPersonDbDetailRequest']) loadFunction(f.ctx, name);
      const declarations = source.match(/app\.get\('\/api\/music\/people\/db(?:\/:personId)?', async \(req, res\) => \{[\s\S]*?\n\}\);/g);
      assert.equal(declarations.length, 2);
      vm.runInContext(declarations.join('\n'), f.ctx);
    }
  }, { filename: 'server-runtime.js' });
  assert.equal(loads, 1);
  f.request = async (query = {}, personId = '1', route = '/api/music/people/db/:personId') => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(value) { this.value = value; } };
    await routes.get(route)({ params: { personId }, query }, res);
    return { status: res.statusCode, body: res.value };
  };
  return f;
}

test('npm start detail preserves the three-photo Map, complete readiness and legacy envelope', async () => {
  const f = runtimeFixture();
  const photos = [1, 2, 3].map(n => ({ image_key: `fixture${n}` }));
  const shows = [{ show_id: 1 }];
  f.build(async () => new Map([['1', { photo_count: 3, matched_photos: photos, tagged_shows: shows,
    show_count: 1, set_count: 2, event_count: 1, first_seen: '2001-01-01', latest_seen: '2002-01-01' }]]));
  const { status, body } = await f.request();
  assert.equal(status, 200); assert.equal(body.ok, true);
  assert.equal(body.photo_count, 3); assert.equal(body.data.photo_count, 3);
  assert.deepEqual(body.matched_photos, photos); assert.deepEqual(body.data.matched_photos, photos);
  assert.equal(body.verified_photo_count, 3); assert.equal(body.photo_count_status, 'verified');
  assert.equal(body.photo_count_source, 'relationship_cache');
  const state = f.ctx.smugMusicPersonArchiveRelationshipCache.get('1');
  const expected = state.snapshot(state.read());
  assert.deepEqual(body.relationship_readiness, expected);
  for (const field of ['route', 'source', 'generatedAt', 'generatedTime', 'person_id', 'name', 'category',
    'aliases', 'bands', 'instruments', 'photo_count', 'event_count', 'show_count', 'set_count',
    'first_seen', 'latest_seen', 'matched_photos', 'tagged_shows', 'data']) assert(field in body, field);
  assert.equal(body.first_seen, '2001-01-01'); assert.equal(body.latest_seen, '2002-01-01');
  assert.equal(body.show_count, 1); assert.equal(body.set_count, 2);
  await f.request(); assert.equal(f.builds(), 1);
});

test('npm start detail exposes preparing after an invalidated in-flight result, never stale photos', async () => {
  const f = runtimeFixture(), gate = deferred(); f.build(() => gate.promise);
  const request = f.request(); await tick();
  assert.equal(f.ctx.smugMusicPersonArchiveRelationshipCache.get('1').snapshot().status, 'preparing');
  f.changeSource(); await f.ctx.checkMusicPeopleRelationshipSource();
  gate.resolve(new Map([['1', { photo_count: 99 }]]));
  const { body } = await request;
  assert.equal(body.relationship_readiness.status, 'preparing');
  assert.equal(body.relationship_readiness.authoritative, false);
  assert.equal(body.photo_count_status, 'unavailable'); assert.equal(body.verified_photo_count, null);
  assert.equal(body.photo_count, 9); assert.equal(body.photo_count_source, 'stored_fallback');
  assert.equal(body.matched_photos.length, 0);
});

test('npm start detail keeps errors sticky and forwards intentional Retry to the lifecycle', async () => {
  const f = runtimeFixture(); f.build(async () => { throw Error('private provider details'); });
  const failed = (await f.request()).body;
  assert.equal(failed.relationship_readiness.status, 'error');
  assert.equal(failed.relationship_readiness.retry_allowed, true);
  assert.equal(failed.photo_count_status, 'unavailable');
  assert(!JSON.stringify(failed).includes('private provider'));
  f.build(async () => new Map([['1', { photo_count: 3 }]]));
  assert.equal((await f.request()).body.relationship_readiness.status, 'error');
  assert.equal(f.builds(), 1);
  const recovered = (await f.request({ retry_relationships: '1' })).body;
  assert.equal(recovered.relationship_readiness.status, 'ready');
  assert.equal(recovered.relationship_readiness.authoritative, true);
  assert.equal(recovered.photo_count, 3); assert.equal(f.builds(), 2);
});

test('npm start list and detail share verified zero and readiness contracts', async () => {
  const f = runtimeFixture(); f.build(async () => new Map());
  const detail = (await f.request()).body;
  await f.ctx.buildMusicPeopleArchiveRelationships();
  const list = (await f.request({ archive: 'cached' }, '', '/api/music/people/db')).body;
  for (const payload of [detail, list]) {
    assert.equal(payload.relationship_readiness.status, 'ready');
    assert.equal(payload.relationship_readiness.authoritative, true);
  }
  assert.deepEqual(Object.keys(detail.relationship_readiness).sort(), Object.keys(list.relationship_readiness).sort());
  for (const person of [detail.data, list.data[0]]) {
    assert.equal(person.photo_count, 0); assert.equal(person.verified_photo_count, 0);
    assert.equal(person.photo_count_status, 'verified'); assert.equal(person.photo_count_source, 'relationship_cache');
  }
  assert.equal(detail.photo_count, 0); assert.equal(detail.verified_photo_count, 0);
});

test('npm start detail preserves ID validation, missing record and DB failure responses', async () => {
  const f = runtimeFixture();
  assert.equal((await f.request({}, '')).status, 400);
  f.ctx.dbPool.query = async () => ({ rows: [] });
  const missing = await f.request();
  assert.equal(missing.status, 404); assert.equal(missing.body.error, 'MUSIC_PERSON_NOT_FOUND');
  f.ctx.dbPool.query = async () => { throw Error('private DB details'); };
  const failed = await f.request(); assert.equal(failed.status, 500); assert.equal(failed.body.ok, false);
  assert.equal(f.builds(), 0);
});

test('cold, delayed, concurrent and warm requests share population preparation, never a timer-derived ready', async () => {
  const f = fixture(), gate = deferred(); f.build(() => gate.promise);
  const first = await f.ctx.getMusicPeopleArchiveRelationshipsForRequest();
  const second = await f.ctx.getMusicPeopleArchiveRelationshipsForRequest();
  assert.equal(f.readiness.snapshot(first).status, 'preparing');
  assert.equal(f.readiness.snapshot(second).authoritative, false); assert.equal(f.builds(), 1);
  gate.resolve(new Map([['1', { photo_count: 3 }]])); await tick();
  const warm = await f.ctx.getMusicPeopleArchiveRelationshipsForRequest();
  assert.equal(f.readiness.snapshot(warm).status, 'ready'); assert.equal(f.readiness.snapshot(warm).authoritative, true);
  assert.equal(f.builds(), 1);
});

test('source invalidation drains obsolete work before allowing rebuilding', async () => {
  const f = fixture(), gate = deferred(); f.build(() => gate.promise);
  await f.ctx.getMusicPeopleArchiveRelationshipsForRequest();
  f.changeSource(); await f.ctx.checkMusicPeopleRelationshipSource();
  f.build(async () => new Map([['1', { photo_count: 7 }]]));
  const waiting = f.ctx.buildMusicPeopleArchiveRelationships();
  assert.equal(f.builds(), 1);
  gate.resolve(new Map([['1', { photo_count: 99 }]])); await tick();
  await waiting;
  assert.equal(f.readiness.read(), null);
  await f.ctx.buildMusicPeopleArchiveRelationships();
  assert.equal(f.readiness.read().get('1').photo_count, 7);
  assert.equal(f.readiness.snapshot(f.readiness.read()).status, 'ready');
});

test('TTL invalidation is preparing until new work finishes', async () => {
  const f = fixture(); await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  f.advance(); assert.equal(f.readiness.snapshot().status, 'preparing'); assert.equal(f.readiness.read(), null);
  await f.ctx.buildMusicPeopleArchiveRelationships(); assert.equal(f.readiness.snapshot().status, 'ready');
});

test('failed preparation stays visible to polling, then recovers only with explicit retry', async () => {
  const f = fixture(); f.build(async () => { throw Error('secret provider payload'); });
  await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  assert.equal(f.readiness.snapshot().status, 'error'); assert.equal(f.readiness.snapshot().reason, 'preparation_failed');
  assert(!JSON.stringify(f.readiness.snapshot()).includes('secret'));
  f.build(async () => new Map());
  await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  assert.equal(f.builds(), 1); assert.equal(f.readiness.snapshot().status, 'error');
  await f.ctx.getMusicPeopleArchiveRelationshipsForRequest({ retry_relationships: '1' }); await tick();
  assert.equal(f.readiness.snapshot(f.readiness.read()).authoritative, true);
});

test('fallback zero stays unavailable; verified absence becomes true zero without changing identity/recency', async () => {
  const f = fixture(), row = { person_id: 2, name: 'Person Two', stats: { photo_count: 0, first_seen: '2001-01-01' } };
  const unknown = f.ctx.buildMusicPersonDbApiItem(row);
  assert.equal(unknown.photo_count, 0); assert.equal(unknown.photo_count_status, 'unavailable');
  assert.equal(unknown.verified_photo_count, null);
  assert.equal(unknown.photo_count_source, 'stored_fallback');
  assert.equal(f.ctx.buildMusicPersonDbApiItem({ person_id: 3 }).photo_count_source, 'none');
  await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  const ready = f.ctx.buildMusicPersonDbApiItem(row, f.readiness.read());
  assert.equal(ready.photo_count, 0); assert.equal(ready.photo_count_status, 'verified'); assert.equal(ready.verified_photo_count, 0);
  assert.equal(ready.name, row.name); assert.equal(ready.first_seen, row.stats.first_seen);
  assert.equal(f.ctx.buildMusicPersonDbApiItem({ person_id: 1 }, f.readiness.read()).photo_count, 3);
});

test('pagination exposes identical population readiness and keeps existing response fields', async () => {
  const f = fixture(); await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  const responses = await Promise.all([1, 2].map(async page => {
    const res = { json(value) { this.value = value; }, status() { return this; } };
    await f.ctx.handleMusicPeopleDbRequest({ query: { page, archive: 'cached' } }, res); return res.value;
  }));
  assert.deepEqual(responses[0].relationship_readiness, responses[1].relationship_readiness);
  for (const response of responses) {
    assert.equal(response.ok, true); assert.equal(response.total, 2); assert(Array.isArray(response.data));
    assert.equal(response.relationship_readiness.status, 'ready');
    assert(response.data.every(person => person.photo_count_status === 'verified'));
  }
  const excluded = await f.ctx.getMusicPeopleArchiveRelationshipsForListRequest({});
  assert.equal(excluded.size, 0); assert.equal(f.readiness.snapshot(excluded).authoritative, false);
});

test('source DB failures invalidate ready results without making the People payload fail', async () => {
  const f = fixture(); await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  f.failDb(true); const map = await f.ctx.getMusicPeopleArchiveRelationshipsForRequest();
  assert.equal(map.size, 0); assert.equal(f.readiness.snapshot(map).status, 'error');
  assert.equal(f.readiness.snapshot(map).reason, 'source_check_failed');
  f.failDb(false); await f.ctx.getMusicPeopleArchiveRelationshipsForRequest({ retry_relationships: '1' }); await tick();
  assert.equal(f.readiness.snapshot().status, 'ready');
});

test('album failures and page limits are not cached as verified empty albums', async () => {
  const f = fixture();
  await assert.rejects(f.ctx.fetchMusicPeopleArchiveAlbumPhotos('album'), { code: 'provider_request_failed' });
  assert.equal(f.ctx.smugMusicPeopleArchiveAlbumPhotosCache.size, 0);
  f.ctx.fetchSmugJson = async endpoint => ({ Response: { AlbumImage: [{ image_key: endpoint + 'a' }, { image_key: endpoint + 'b' }], Pages: { Total: 100 } } });
  await assert.rejects(f.ctx.fetchMusicPeopleArchiveAlbumPhotos('album'), { code: 'photo_page_limit_reached' });
  assert.equal(f.ctx.smugMusicPeopleArchiveAlbumPhotosCache.size, 0);
  f.ctx.fetchSmugJson = async () => ({ Response: { AlbumImage: [], Pages: { Total: 0 } } });
  assert.equal((await f.ctx.fetchMusicPeopleArchiveAlbumPhotos('album')).length, 0);
});

test('single-person readiness has verified zero and does not falsely ready the global population', async () => {
  const f = fixture(); f.build(async () => new Map());
  const map = await f.ctx.getMusicPersonArchiveRelationship({ person_id: 2, name: 'Person Two' });
  const status = f.ctx.smugMusicPersonArchiveRelationshipCache.get('2').snapshot(map);
  assert.equal(status.status, 'ready'); assert.equal(status.authoritative, true);
  assert.equal(f.ctx.buildMusicPersonDbApiItem({ person_id: 2 }, map, status).verified_photo_count, 0);
  assert.equal(f.readiness.snapshot().status, 'preparing');
});

function albumPage(total, start, count, albumId = 'AlbumA') {
  const images = Array.from({ length: Math.min(count, Math.max(0, total - start + 1)) }, (_, i) =>
    ({ image_key: albumId + (start + i), caption: 'Person One' }));
  return { Response: { AlbumImage: images, Pages: { Total: total, Start: start,
    ...(start - 1 + images.length < total ? {
      NextPage: `/api/v2/album/${albumId}!images?start=${start + images.length}&count=${count}`
    } : {}) } } };
}
function scanningFixture(albums = ['AlbumA']) {
  const f = fixture();
  Object.assign(f.ctx, { MUSIC_PEOPLE_ARCHIVE_PHOTOS_PAGE_LIMIT: 200, MUSIC_PEOPLE_ARCHIVE_MAX_PHOTO_PAGES_PER_ALBUM: 8,
    SMUG_REQUEST_CONCURRENCY: 2, runMusicPeopleAlbumWorkers,
    createMusicPeopleArchivePersonMatchers: () => [{ person_id: '1', matchNames: ['Person One'] }],
    getMusicPeopleArchiveAlbumsForScan: async () => albums.map(album_id => ({ album_id })),
    captionMatchesPersonName: (caption, name) => caption === name,
    addMusicPeopleArchiveMatch: (map, id) => map.set(id, { photo_count: (map.get(id)?.photo_count || 0) + 1 }),
    finalizeMusicPeopleArchiveRelationships: map => map });
  loadFunction(f.ctx, 'buildMusicPeopleArchiveRelationshipsForPeople');
  return f;
}

for (const total of [0, 200, 216, 235, 1600]) test(`complete ${total}-photo album uses bounded 200-item pages and authoritative counts`, async () => {
  const f = scanningFixture(); let calls = 0;
  f.ctx.fetchSmugJson = async endpoint => {
    calls++;
    const url = new URL(endpoint, 'https://fixture.invalid');
    assert.equal(url.searchParams.get('count'), '200');
    return albumPage(total, Number(url.searchParams.get('start')), 200);
  };
  await f.ctx.checkMusicPeopleRelationshipSource();
  const map = await f.ctx.buildMusicPeopleArchiveRelationships();
  const diagnostic = f.readiness.snapshot(map);
  assert.equal(diagnostic.status, 'ready'); assert.equal(diagnostic.authoritative, true);
  assert.equal(f.ctx.buildMusicPersonDbApiItem({ person_id: 1 }, map).verified_photo_count, total);
  assert.equal(calls, Math.max(1, Math.ceil(total / 200)));
  assert.equal(diagnostic.pages_processed, calls); assert.equal(diagnostic.albums_processed, 1);
  assert.equal(diagnostic.total_albums, 1); assert.equal(diagnostic.active, false);
  assert(diagnostic.last_progress_at); assert(diagnostic.finished_at); assert.equal(diagnostic.failed_album_id, null);
  await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); assert.equal(calls, diagnostic.pages_processed);
});

test('page-cap failure remains visible under concurrent polling; an explicit retry recovers', async () => {
  const f = scanningFixture(); let total = 1601, calls = 0;
  f.ctx.fetchSmugJson = async endpoint => {
    calls++; return albumPage(total, Number(new URL(endpoint, 'https://fixture.invalid').searchParams.get('start')), 200);
  };
  await f.ctx.checkMusicPeopleRelationshipSource();
  await f.ctx.buildMusicPeopleArchiveRelationships();
  const error = f.readiness.snapshot();
  assert.equal(error.status, 'error'); assert.equal(error.reason, 'photo_page_limit_reached');
  assert.equal(error.failed_album_id, 'AlbumA'); assert.equal(error.pages_processed, 8);
  assert.equal(error.albums_processed, 0); assert.equal(error.retry_allowed, true);
  assert.equal(f.ctx.smugMusicPeopleArchiveAlbumPhotosCache.size, 0);
  await Promise.all(Array.from({ length: 5 }, () => f.ctx.getMusicPeopleArchiveRelationshipsForListRequest({ archive: 'cached' })));
  assert.equal(calls, 8); assert.deepEqual(f.readiness.snapshot(), error);
  total = 235;
  await Promise.all(Array.from({ length: 5 }, () => f.ctx.getMusicPeopleArchiveRelationshipsForListRequest({ archive: 'cached', retry_relationships: '1' })));
  await tick();
  const map = f.readiness.read();
  assert.equal(f.readiness.snapshot(map).status, 'ready'); assert.equal(map.get('1').photo_count, 235);
  assert.equal(calls, 10); assert.equal(f.readiness.snapshot(map).generation, error.generation + 1);
});

test('failure stops queue assignment, drains the other worker, and refuses retry during cleanup', async () => {
  const f = scanningFixture(['AlbumA', 'AlbumB', 'AlbumC']), held = deferred(); const calls = [];
  f.ctx.fetchSmugJson = async endpoint => {
    calls.push(endpoint);
    if (endpoint.includes('AlbumA')) throw Error('private provider response');
    return held.promise;
  };
  await f.ctx.checkMusicPeopleRelationshipSource();
  const run = f.ctx.buildMusicPeopleArchiveRelationships(); await tick();
  const error = f.readiness.snapshot();
  assert.equal(error.status, 'error'); assert.equal(error.active, true); assert.equal(error.retry_allowed, false);
  assert.equal(error.failed_album_id, 'AlbumA'); assert.equal(error.reason, 'provider_request_failed');
  assert.equal(error.finished_at, null);
  const retryWhileDraining = f.ctx.buildMusicPeopleArchiveRelationships({ retry: true }); await tick();
  assert.equal(calls.length, 2); assert(!calls.some(url => url.includes('AlbumC')));
  held.resolve(albumPage(235, 1, 200, 'AlbumB')); await run; await retryWhileDraining;
  assert.equal(calls.length, 2); // No next page after the peer failed.
  assert.equal(f.readiness.snapshot().active, false); assert.equal(f.readiness.snapshot().retry_allowed, true);
  assert.equal(f.readiness.snapshot().pages_processed, 1);
  assert.equal(f.ctx.smugMusicPeopleArchiveAlbumPhotosCache.size, 0);
  assert(!JSON.stringify(f.readiness.snapshot()).includes('private'));
});

test('person and population scans cannot overlap provider work', async () => {
  const f = scanningFixture(), held = deferred(); let calls = 0;
  f.ctx.fetchSmugJson = async () => { calls++; return held.promise; };
  await f.ctx.checkMusicPeopleRelationshipSource();
  const global = f.ctx.buildMusicPeopleArchiveRelationships(); await tick();
  const person = f.ctx.getMusicPersonArchiveRelationship({ person_id: 1, name: 'Person One' }); await tick();
  assert.equal(calls, 1);
  held.resolve(albumPage(200, 1, 200)); await global; await person;
  assert.equal(calls, 1); // The serialized person scan reuses the completed album cache.
});

test('invalidation during a page fetch drains old work and cannot repopulate the album cache', async () => {
  const f = scanningFixture(), held = deferred(); let calls = 0;
  f.ctx.fetchSmugJson = async () => { calls++; return held.promise; };
  await f.ctx.checkMusicPeopleRelationshipSource();
  const old = f.ctx.buildMusicPeopleArchiveRelationships(); await tick();
  f.changeSource(); await f.ctx.checkMusicPeopleRelationshipSource();
  const waiting = f.ctx.buildMusicPeopleArchiveRelationships(); assert.equal(calls, 1);
  held.resolve(albumPage(235, 1, 200)); await old; await waiting;
  assert.equal(f.ctx.smugMusicPeopleArchiveAlbumPhotosCache.size, 0); assert.equal(f.readiness.read(), null);
  f.ctx.fetchSmugJson = async () => { calls++; return albumPage(200, 1, 200); };
  await f.ctx.buildMusicPeopleArchiveRelationships();
  assert.equal(calls, 2); assert.equal(f.readiness.snapshot().status, 'ready');
});

test('pagination rejects missing totals, changed totals, wrong starts and unsafe/cyclic next-page links', () => {
  const good = albumPage(235, 1, 200), images = good.Response.AlbumImage;
  const check = json => musicPeopleAlbumPage(json, images, { albumId: 'AlbumA', start: 1, limit: 200, previousTotal: null });
  for (const change of [p => delete p.Total, p => p.Total = -1, p => p.Start = 201,
    p => p.NextPage = 'https://other.invalid/api/v2/album/AlbumA!images?start=201',
    p => p.NextPage = '/api/v2/album/AlbumA!images?start=1',
    p => p.NextPage = '/api/v2/album/Other!images?start=201']) {
    const json = structuredClone(good); change(json.Response.Pages);
    assert.throws(() => check(json), { code: 'pagination_incomplete' });
  }
  assert.throws(() => musicPeopleAlbumPage(good, images, { albumId: 'AlbumA', start: 1, limit: 200, previousTotal: 236 }),
    { code: 'pagination_incomplete' });
  const withoutNext = structuredClone(good); delete withoutNext.Response.Pages.NextPage;
  assert.equal(check(withoutNext).next_start, 201); // An explicit Total still confirms more work.
});

test('a missing or repeated album page never publishes partial counts', async () => {
  for (const kind of ['missing', 'repeated', 'changed_total']) {
    const f = scanningFixture();
    f.ctx.fetchSmugJson = async endpoint => {
      const start = Number(new URL(endpoint, 'https://fixture.invalid').searchParams.get('start'));
      if (start === 1) return albumPage(235, 1, 200);
      if (kind === 'missing') return { Response: { Pages: { Total: 235, Start: 201 }, AlbumImage: [] } };
      if (kind === 'changed_total') return albumPage(236, 201, 200);
      const repeated = albumPage(235, 201, 200);
      repeated.Response.AlbumImage = albumPage(35, 1, 200).Response.AlbumImage;
      return repeated;
    };
    await f.ctx.checkMusicPeopleRelationshipSource(); await f.ctx.buildMusicPeopleArchiveRelationships();
    assert.equal(f.readiness.snapshot().status, 'error'); assert.equal(f.readiness.snapshot().reason, 'pagination_incomplete');
    assert.equal(f.ctx.smugMusicPeopleArchiveAlbumPhotosCache.size, 0); assert.equal(f.readiness.read(), null);
  }
});

test('source invalidation cannot silently clear a sticky failure', async () => {
  const f = fixture(); f.build(async () => { throw Error('failure'); });
  await f.ctx.checkMusicPeopleRelationshipSource(); await f.ctx.buildMusicPeopleArchiveRelationships();
  f.changeSource();
  await f.ctx.getMusicPeopleArchiveRelationshipsForListRequest({ archive: 'cached' });
  assert.equal(f.readiness.snapshot().status, 'error'); assert.equal(f.builds(), 1);
  for (const retry_relationships of ['0', 'true', '', undefined])
    await f.ctx.getMusicPeopleArchiveRelationshipsForListRequest({ archive: 'cached', retry_relationships });
  assert.equal(f.builds(), 1);
  f.build(async () => new Map());
  await f.ctx.getMusicPeopleArchiveRelationshipsForListRequest({ archive: 'cached', retry_relationships: '1' });
  await tick(); assert.equal(f.readiness.snapshot().status, 'ready'); assert.equal(f.builds(), 2);
});

test('elapsed and progress diagnostics advance while active and freeze after cleanup', async () => {
  let now = 1000, control;
  const state = createMusicPeopleReadiness({ ttlMs: 10000, now: () => now }), held = deferred();
  const run = state.prepare(async c => { control = c; c.setAlbumsTotal(2); await held.promise; return new Map(); });
  await tick(); now = 1200; control.pageProcessed(); control.albumProcessed();
  const progress = state.snapshot();
  assert.equal(progress.elapsed_ms, 200); assert.equal(progress.pages_processed, 1);
  assert.equal(progress.albums_processed, 1); assert.equal(progress.total_albums, 2);
  assert.equal(progress.last_progress_at, new Date(1200).toISOString());
  now = 1300; control.failure(Error('private secret'), 'https://private.invalid/token');
  assert.equal(state.snapshot().failed_album_id, null); assert.equal(state.snapshot().reason, 'preparation_failed');
  assert.equal(state.snapshot().retry_allowed, false);
  now = 1400; held.resolve(); await run;
  now = 9000; assert.equal(state.snapshot().elapsed_ms, 400); assert.equal(state.snapshot().retry_allowed, true);
  assert.equal(state.read(), null);
});

test('single-person retries are also intentional and leave the global population untouched', async () => {
  const f = fixture(), row = { person_id: 2, name: 'Person Two' };
  f.build(async () => { throw Error('failure'); });
  await f.ctx.getMusicPersonArchiveRelationship(row);
  await f.ctx.getMusicPersonArchiveRelationship(row);
  assert.equal(f.builds(), 1);
  const state = f.ctx.smugMusicPersonArchiveRelationshipCache.get('2');
  assert.equal(state.snapshot().status, 'error');
  f.build(async () => new Map());
  const map = await f.ctx.getMusicPersonArchiveRelationship(row, { retry_relationships: '1' });
  assert.equal(f.builds(), 2); assert.equal(state.snapshot(map).authoritative, true);
  assert.equal(f.readiness.snapshot().status, 'preparing');
});
