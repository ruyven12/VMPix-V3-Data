'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createMusicPeopleReadiness } = require('../music-people-readiness');
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let time = 10000, version = 'v1', builds = 0, failDb = false;
  let build = async () => new Map([['1', { photo_count: 3 }]]);
  const readiness = createMusicPeopleReadiness({ ttlMs: 1000, now: () => time });
  const ctx = vm.createContext({ Map, Set, Date, Promise, setTimeout, clearTimeout, createMusicPeopleReadiness,
    process: { env: { DATABASE_URL: 'synthetic' } }, SMUG_API_KEY: 'synthetic',
    MUSIC_PEOPLE_ARCHIVE_CACHE_TTL_MS: 1000, MUSIC_PEOPLE_ARCHIVE_REQUEST_WAIT_MS: 0,
    MUSIC_PEOPLE_ARCHIVE_MAX_PHOTO_PAGES_PER_ALBUM: 2, SMUG_ALBUM_PHOTOS_MAX_LIMIT: 2,
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
    const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
    assert(start >= 0, name);
    const rest = source.slice(start), next = rest.slice(1).search(/\n(?:async )?function /);
    vm.runInContext(next < 0 ? rest : rest.slice(0, next + 1), ctx);
  }
  return { ctx, readiness, builds: () => builds, advance: () => { time += 1001; },
    changeSource: () => { version += 'x'; }, failDb: value => { failDb = value; }, build: fn => { build = fn; } };
}

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

test('source invalidation rejects an obsolete completion and allows rebuilding', async () => {
  const f = fixture(), gate = deferred(); f.build(() => gate.promise);
  await f.ctx.getMusicPeopleArchiveRelationshipsForRequest();
  f.changeSource(); await f.ctx.checkMusicPeopleRelationshipSource();
  f.build(async () => new Map([['1', { photo_count: 7 }]]));
  await f.ctx.buildMusicPeopleArchiveRelationships();
  gate.resolve(new Map([['1', { photo_count: 99 }]])); await tick();
  assert.equal(f.readiness.read().get('1').photo_count, 7);
  assert.equal(f.readiness.snapshot(f.readiness.read()).status, 'ready');
});

test('TTL invalidation is preparing until new work finishes', async () => {
  const f = fixture(); await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  f.advance(); assert.equal(f.readiness.snapshot().status, 'preparing'); assert.equal(f.readiness.read(), null);
  await f.ctx.buildMusicPeopleArchiveRelationships(); assert.equal(f.readiness.snapshot().status, 'ready');
});

test('failed preparation reports sanitized error, then recovers on a subsequent request', async () => {
  const f = fixture(); f.build(async () => { throw Error('secret provider payload'); });
  await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  assert.equal(f.readiness.snapshot().status, 'error'); assert.equal(f.readiness.snapshot().reason, 'preparation_failed');
  assert(!JSON.stringify(f.readiness.snapshot()).includes('secret'));
  f.build(async () => new Map()); await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
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
  f.failDb(false); await f.ctx.getMusicPeopleArchiveRelationshipsForRequest(); await tick();
  assert.equal(f.readiness.snapshot().status, 'ready');
});

test('album failures and page limits are not cached as verified empty albums', async () => {
  const f = fixture();
  await assert.rejects(f.ctx.fetchMusicPeopleArchiveAlbumPhotos('album'), { code: 'provider_request_failed' });
  assert.equal(f.ctx.smugMusicPeopleArchiveAlbumPhotosCache.size, 0);
  f.ctx.fetchSmugJson = async () => ({ Response: { AlbumImage: [{ image_key: 'a' }, { image_key: 'b' }], Pages: { Total: 100 } } });
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
