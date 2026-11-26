'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const storeModule = require('../music-people-relationship-store');
const { createMusicPeopleReadiness } = require('../music-people-readiness');
const { databasePool, disconnected } = require('./db-resilience-fixture');
const { projectSource, readSource, createMusicPeopleRelationshipStore, describeRelationships } = storeModule;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const empty = photos => ({ photo_count: photos, set_count: 0, show_count: 0, event_count: 0,
  gallery_id: null, album_id: null, cover_image_url: null, first_seen: null, first_seen_date_time_original: null,
  first_seen_display: null, latest_seen: null, latest_seen_date_time_original: null, latest_seen_display: null,
  matched_photos: [], tagged_shows: [] });

function database() {
  const db = { people: [{ person_id: 1, name: 'Person One', aliases: [] }, { person_id: 2, name: 'Person Two', aliases: [] }],
    shows: [{ id: 1, show_id: 'show1', name: 'Show', show_date: '2026-01-02', album_id: 'AlbumA', smug_albums: [] }],
    data: null, log: [], mode: null, failRead: false, beforeCommit: null };
  let tail = Promise.resolve();
  const query = async (sql, params = [], tx = null) => {
    db.log.push(sql);
    if (/^BEGIN/.test(sql)) { tx.repeatable = sql.includes('REPEATABLE READ'); tx.initial = db.data; return { rows: [] }; }
    if (sql.includes('pg_advisory_xact_lock')) {
      const previous = tail; tail = new Promise(resolve => { tx.unlock = resolve; });
      await previous; return { rows: [] };
    }
    if (sql.includes('AS people') && sql.includes('AS shows')) {
      if (db.failRead) throw Error('private source read');
      return { rows: [{ people: db.people, shows: db.shows }] };
    }
    if (/^INSERT INTO stats_snapshots/.test(sql)) {
      tx.staged = JSON.parse(params[1]); tx.wrote = true; return { rows: [] };
    }
    if (sql === 'COMMIT') {
      if (db.beforeCommit && tx.wrote) await db.beforeCommit();
      if (db.mode === 'before') throw Error('commit was not admitted');
      if (tx.wrote) db.data = tx.staged;
      tx.unlock?.(); tx.unlock = null;
      if (db.mode === 'after') throw Error('acknowledgement lost');
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') { tx.unlock?.(); tx.unlock = null; return { rows: [] }; }
    if (sql.includes('SELECT data FROM stats_snapshots')) {
      if (db.failRead) throw Error('private snapshot read');
      const data = tx?.repeatable ? tx.initial : db.data;
      return { rows: data ? [{ data }] : [] };
    }
    if (sql.includes('count(*)::int AS total') && sql.includes('music_people')) return { rows: [{ total: db.people.length }] };
    if (sql.includes('FROM music_people')) return { rows: db.people.map(row => ({ ...row, category: 'performers', stats: { photo_count: 999 }, bands: [], associations: [] })) };
    return { rows: [], rowCount: 0 }; // Existing bootstrap DDL reaches only this inert fake.
  };
  db.query = (sql, params) => query(sql, params);
  db.connect = async () => {
    const tx = {};
    return { query: (sql, params) => query(sql, params, tx), release() { tx.unlock?.(); } };
  };
  return db;
}

test('fingerprint covers actual identity and album inputs, including SQL Date values', () => {
  const db = database(), base = projectSource(db.people, db.shows);
  const dated = projectSource(db.people, [{ ...db.shows[0], show_date: new Date('2026-01-02T00:00:00Z') }]);
  assert.equal(base.fingerprint, dated.fingerprint);
  assert.notEqual(base.fingerprint, projectSource(db.people, [{ ...db.shows[0], show_date: new Date('2026-01-03T00:00:00Z') }]).fingerprint);
  for (const change of [{ name: 'Renamed' }, { aliases: ['Another name'] }, { person_id: 3 }])
    assert.notEqual(base.fingerprint, projectSource([{ ...db.people[0], ...change }, db.people[1]], db.shows).fingerprint);
  assert.notEqual(base.fingerprint, projectSource(db.people, [{ ...db.shows[0], smug_albums: [{ album_id: 'Changed' }] }]).fingerprint);
});

test('publish persists only final whitelist, known-zero identities and completed coverage; restore keeps original time', async () => {
  const db = database(), store = createMusicPeopleRelationshipStore({ db, now: () => 2000 }), input = await readSource(db);
  const value = empty(3); value.raw_sheet = { password: 'legacy-private-marker' };
  await store.publish({ source: input, value: new Map([['1', value]]), generation: 7, startedAt: new Date(1000).toISOString(),
    coverage: { total_albums: 2, albums_processed: 2, pages_processed: 4, albums_from_cache: 1 } });
  assert(!JSON.stringify(db.data).includes('legacy-private-marker'));
  const restored = await createMusicPeopleRelationshipStore({ db, now: () => 999999 }).load(input);
  assert.equal(restored.get('1').photo_count, 3); assert.equal(restored.get('2').photo_count, 0);
  assert.equal(describeRelationships(restored).verifiedAt, new Date(2000).toISOString());
  assert.equal(describeRelationships(restored).coverage.pages_processed, 4);
  const life = createMusicPeopleReadiness({ ttlMs: 1000, now: () => 999999, describe: describeRelationships });
  assert(life.restore(restored)); const state = life.snapshot(restored);
  assert.equal(state.completed_at, new Date(2000).toISOString()); assert.equal(state.stale, true); assert.equal(state.authoritative, true);
  assert.equal(state.albums_processed, 2);
});

test('present malformed Map values and numeric keys cannot fabricate verified zero', async () => {
  for (const value of [new Map([[1, empty(2)]]), new Map([['1', null]]), new Map([['1', false]])]) {
    const db = database(), store = createMusicPeopleRelationshipStore({ db });
    await assert.rejects(store.publish({ source: await readSource(db), value, generation: 0 }), { code: 'persistence_invalid' });
    assert.equal(db.data, null);
  }
});

test('source recheck and failed writes preserve the prior durable row', async () => {
  const db = database(), store = createMusicPeopleRelationshipStore({ db, now: () => 5000 });
  let input = await readSource(db);
  await store.publish({ source: input, value: new Map([['1', empty(3)]]), generation: 0 });
  const prior = db.data;
  db.people[0] = { ...db.people[0], aliases: ['Changed'] };
  await assert.rejects(store.publish({ source: input, value: new Map([['1', empty(9)]]), generation: 1 }), { code: 'preparation_invalidated' });
  assert.equal(db.data, prior); assert.equal(await store.load(await readSource(db)), null);
  db.people[0].aliases = []; input = await readSource(db); db.mode = 'before';
  await assert.rejects(store.publish({ source: input, value: new Map([['1', empty(9)]]), generation: 1 }), { code: 'persistence_failed' });
  assert.equal(db.data, prior);
  assert(db.log.some(sql => sql.includes("lock_timeout = '3000ms'"))); assert(db.log.some(sql => sql.includes("statement_timeout = '10000ms'")));
});

test('older concurrent completion observes the post-lock committed envelope and cannot replace it', async () => {
  const db = database(), store = createMusicPeopleRelationshipStore({ db, now: () => 4000 }), input = await readSource(db);
  const held = deferred(); db.beforeCommit = () => held.promise;
  const newer = store.publish({ source: input, value: new Map([['1', empty(8)]]), generation: 1, startedAt: new Date(2000).toISOString() });
  await tick();
  const older = store.publish({ source: input, value: new Map([['1', empty(2)]]), generation: 0, startedAt: new Date(1000).toISOString() });
  await tick(); held.resolve(); await newer;
  assert.equal((await older).get('1').photo_count, 8); assert.equal(db.data.relationships[0][1].photo_count, 8);
  assert.equal(db.log.filter(sql => sql.startsWith('INSERT INTO stats_snapshots')).length, 1);
  assert(db.log.filter(sql => sql.startsWith('BEGIN')).every(sql => sql.includes('READ COMMITTED')));
});

test('lost COMMIT acknowledgement is reconciled from durable data without another provider build', async () => {
  const db = database(), store = createMusicPeopleRelationshipStore({ db, now: () => 3000 }), input = await readSource(db);
  const life = createMusicPeopleReadiness({ ttlMs: 1000, now: () => 3000, describe: describeRelationships }); let builds = 0;
  db.mode = 'after';
  await life.prepare(control => { builds++; return store.publish({ source: input, value: new Map([['1', empty(6)]]),
    generation: control.generation, startedAt: control.startedAt }); });
  assert.equal(life.read(), null); assert.equal(life.snapshot().status, 'error'); assert(db.data.complete);
  db.mode = null; assert(life.restore(await store.load(input)));
  await life.prepare(() => { builds++; throw Error('must not scan'); }, { retry: true });
  assert.equal(builds, 1); assert.equal(life.read().get('1').photo_count, 6);
});

test('stale refresh failures preserve authority and cannot automatically restart every GET', async () => {
  let now = 1000, builds = 0; const db = database(), store = createMusicPeopleRelationshipStore({ db, now: () => now });
  const map = await store.publish({ source: await readSource(db), value: new Map([['1', empty(4)]]), generation: 0 });
  const life = createMusicPeopleReadiness({ ttlMs: 1000, now: () => now, describe: describeRelationships }); life.restore(map); now = 3000;
  await life.prepare(() => { builds++; throw Error('failed refresh'); }, { refresh: true });
  for (let n = 0; n < 3; n++) await life.prepare(() => { builds++; }, { refresh: true });
  const state = life.snapshot(map); assert.equal(builds, 1); assert.equal(state.status, 'ready'); assert.equal(state.authoritative, true);
  assert.equal(state.completed_at, new Date(1000).toISOString()); assert.equal(state.refresh_retry_allowed, true); assert.equal(state.retry_allowed, false);
});

function loadFunction(ctx, name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  const rest = source.slice(start), next = rest.slice(1).search(/\n(?:async )?function /);
  vm.runInContext(next < 0 ? rest : rest.slice(0, next + 1), ctx);
}
test('generic stats payloads and health exclude only the private population namespace', async () => {
  const exclusion = "NOT (section = 'music' AND category = 'people' AND snapshot_key = 'relationship_population:v1')";
  const ctx = vm.createContext({ process: { env: { DATABASE_URL: 'synthetic' } }, Set, String,
    ensureStatsSnapshotsTable: async () => true, getExistingPublicTables: async () => new Set(['stats_snapshots']),
    buildStatsSnapshotApiItem: row => row, createEmptyStatsHealth: () => ({}), firstDiagnosticRow: r => r.rows[0],
    toIntegerCount: Number, formatStatusTimestamp: v => v, console,
    dbPool: { query: async sql => {
      assert(sql.includes(exclusion));
      return { rows: sql.includes('max(generated_at)') ? [{ snapshots: 1, last_rebuilt_at: 'summary-time' }] : [{ snapshot_key: 'ordinary_summary' }] };
    } } });
  ['getLatestStatsSnapshots', 'getAdminOverviewStatsSummary', 'buildStatsHealth'].forEach(name => loadFunction(ctx, name));
  assert.equal((await ctx.getLatestStatsSnapshots()).length, 1);
  assert.equal((await ctx.getAdminOverviewStatsSummary([])).count, 1);
  assert.equal((await ctx.buildStatsHealth()).snapshots, 1);
});

async function boot(db, provider = async () => ({ Response: { AlbumImage: [], Pages: { Total: 0, Start: 1 } } })) {
  let app, listened = false, providerCalls = 0, serverLoads = 0;
  const listening = deferred();
  const noop = () => {};
  const express = () => {
    app = new Proxy({ routes: new Map(), locals: {}, get(route, ...handlers) { this.routes.set(route, handlers.at(-1)); return this; },
      listen(_port, callback) { listened = true; callback(); listening.resolve(); return { close: noop }; } },
    { get(target, key) { return key in target ? target[key] : () => app; } });
    return app;
  };
  express.json = express.urlencoded = express.static = () => noop;
  const auth = { censusBatchCors: noop, controlPlaneCors: noop, authorizeSession: async () => false };
  const environment = { DATABASE_URL: 'synthetic-test-only', SMUG_API_KEY: 'synthetic-test-only', SMUG_NICKNAME: 'synthetic-user', PORT: '0' };
  const root = path.dirname(require.resolve('../server.js'));
  let ctx;
  const fakeRequire = id => {
    if (id === './server') { serverLoads++; vm.runInContext(source, ctx, { filename: 'server.js' }); return {}; }
    if (id === './db') return db;
    if (id === 'express') return express;
    if (id === 'fs') return { ...fs, existsSync: file => String(file).endsWith('.env') ? false : fs.existsSync(file) };
    if (id === './music-people-readiness' || id === './music-people-relationship-store') return require('../' + id.slice(2));
    if (id === './v3-admin-auth') return { createV3AdminAuthRouter: () => auth };
    if (id === './todoist-calendar') return { createCalendar: () => ({ config: { configured: false }, start: noop, publicHandler: noop, diagnosticsHandler: noop }) };
    if (id === './contact') return { createContactRouter: () => noop };
    if (id.startsWith('./')) return new Proxy({}, { get: () => noop });
    assert(['path', 'crypto', 'async_hooks'].includes(id), 'unapproved bootstrap dependency: ' + id);
    return require(id);
  };
  ctx = vm.createContext({ require: fakeRequire, __dirname: root, __filename: path.join(root, 'server-runtime.js'),
    module: { exports: {} }, exports: {}, Buffer, URL, URLSearchParams, Map, Set, Date, Promise, AbortSignal, AbortController,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    console: { log: noop, warn: noop, error: noop },
    process: { env: environment, once: noop, on: noop, pid: 1, uptime: () => 0 },
    fetch: async () => { providerCalls++; return { ok: true, json: () => provider() }; } });
  assert.equal(require('../package.json').scripts.start, 'node server-runtime.js');
  vm.runInContext(fs.readFileSync(require.resolve('../server-runtime.js'), 'utf8'), ctx, { filename: 'server-runtime.js' });
  let startupTimer;
  try {
    await Promise.race([listening.promise, new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(Error('mock startup did not listen')), 1000);
    })]);
    await vm.runInContext('musicPeopleSourceCheck', ctx);
  } finally { clearTimeout(startupTimer); }
  for (let n = 0; n < 15; n++) await tick();
  assert(listened); assert.equal(serverLoads, 1);
  return { ctx, calls: () => providerCalls, publicResponse: () => vm.runInContext("buildMusicPeoplePublicDbResponse()", ctx), async request(route, query = {}) {
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await app.routes.get(route)({ query, params: { personId: '1' } }, res);
    return res.body;
  } };
}

test('REAL npm-start bootstrap restores once and List/Detail share original verified values without provider access', async () => {
  const db = database(), store = createMusicPeopleRelationshipStore({ db, now: () => Date.now() - 1000 });
  await store.publish({ source: await readSource(db), value: new Map([['1', empty(3)]]), generation: 4 });
  const verifiedAt = db.data.verified_at; db.log = [];
  const runtime = await boot(db, async () => { throw Error('provider forbidden on restore'); });
  const list = await runtime.request('/api/music/people/db', { archive: 'cache', limit: 100, page: 1 });
  const detail = await runtime.request('/api/music/people/db/:personId', { archive: 'cache' });
  assert.equal(list.relationship_readiness.completed_at, verifiedAt); assert.equal(detail.relationship_readiness.completed_at, verifiedAt);
  assert.equal(list.data[0].verified_photo_count, 3); assert.equal(list.data[1].verified_photo_count, 0);
  assert.equal(detail.verified_photo_count, 3); assert.equal(runtime.calls(), 0);
  assert.equal(db.log.filter(sql => sql.includes('SELECT data FROM stats_snapshots')).length, 1);
});

test('REAL bootstrap never awaits provider before listen; uncertain commit Retry reconciles without rescan', async () => {
  const db = database(), held = deferred(); db.mode = 'after';
  const runtime = await boot(db, () => held.promise); assert.equal(runtime.calls(), 1);
  held.resolve({ Response: { AlbumImage: [], Pages: { Total: 0, Start: 1 } } });
  for (let n = 0; n < 10; n++) await tick();
  assert(db.data?.complete); db.mode = null;
  const detail = await runtime.request('/api/music/people/db/:personId', { retry_relationships: '1' });
  assert.equal(detail.relationship_readiness.authoritative, true); assert.equal(detail.verified_photo_count, 0);
  assert.equal(runtime.calls(), 1);
});


test('captured albums preserve original newest-show ownership for duplicate album mappings', async () => {
  assert(storeModule.SHOWS_SQL.includes('ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST, id DESC'));
  const shows = [{ id: 2, show_date: '2026-02-01', album_id: 'Shared' }, { id: 1, show_date: '2026-01-01', album_id: 'Shared' }];
  const captured = projectSource(database().people, shows);
  const ctx = vm.createContext({ Map, MUSIC_PEOPLE_ARCHIVE_MAX_ALBUMS: 1000, dbPool: { query() { throw Error('must use captured source'); } },
    collectMusicPeopleArchiveShowAlbums: show => [{ album_id: show.album_id, show }] });
  loadFunction(ctx, 'getMusicPeopleArchiveAlbumsForScan');
  assert.equal((await ctx.getMusicPeopleArchiveAlbumsForScan(captured.shows))[0].show.id, 2);
});

test('public response and item-default readiness suppress reassigned identity payloads', async () => {
  const db = database(), store = createMusicPeopleRelationshipStore({ db, now: () => Date.now() - 1000 });
  const archived = { ...empty(12), event_count: 7, show_count: 7, set_count: 9, matched_photos: [{ image_key: 'old-person-photo' }] };
  await store.publish({ source: await readSource(db), value: new Map([['1', archived]]), generation: 0 });
  const runtime = await boot(db);
  const original = db.query;
  db.query = async (sql, params) => {
    const result = await original(sql, params);
    if (sql.includes('FROM music_people') && !sql.includes('AS people') && !sql.includes('count(*)')) {
      return { rows: result.rows.map(row => ({ ...row, name: 'Reassigned Identity', stats: { photo_count: 0, event_count: 1, show_count: 1, set_count: 2 } })) };
    }
    return result;
  };
  const response = await runtime.publicResponse();
  assert.equal(response.relationship_readiness.authoritative, false);
  assert(response.data.every(row => row.verified_photo_count === null && !row.matched_photos?.length));
  const item = vm.runInContext("buildMusicPersonDbApiItem({person_id:1,name:'Reassigned Identity',stats:{photo_count:0}}, musicPeopleReadiness.read())", runtime.ctx);
  assert.equal(item.verified_photo_count, null); assert.equal(item.photo_count, 0); assert(!item.matched_photos?.length);
});

test('REAL startup with db.js pool has no checkout during provider scan and survives an idle disconnect', async t => {
  const f = databasePool(), held = deferred(); t.after(() => f.pool.end());
  const runtime = await boot(f.pool, () => held.promise);
  try {
    assert.equal(runtime.calls(), 1);
    assert.equal(f.pool.totalCount - f.pool.idleCount, 0);
    const preparing = await runtime.request('/api/music/people/db', { archive: 'cache' });
    assert.equal(preparing.relationship_readiness.authoritative, false);
    assert.equal(preparing.relationship_readiness.status, 'preparing');
    f.state.clients.at(-1).emit('error', disconnected()); await tick();
    held.resolve({ Response: { AlbumImage: [], Pages: { Total: 0, Start: 1 } } });
    for (let n = 0; n < 30 && !f.state.data; n++) await tick();
    const ready = await runtime.request('/api/music/people/db/:personId');
    assert.equal(ready.relationship_readiness.authoritative, true);
    assert.equal(ready.verified_photo_count, 0); assert.equal(runtime.calls(), 1);
    assert.equal(f.pool.totalCount - f.pool.idleCount, 0); assert.equal(f.pool.waitingCount, 0);
  } finally { held.resolve({ Response: { AlbumImage: [], Pages: { Total: 0, Start: 1 } } }); }
});

test('REAL startup restores List/Detail after pool replacement and never re-enumerates provider', async t => {
  const f = databasePool(), store = createMusicPeopleRelationshipStore({ db: f.pool });
  await store.publish({ source: await readSource(f.pool), value: new Map([['1', empty(3)]]), generation: 1 });
  const verified = f.state.data.verified_at; await f.pool.end();
  const restarted = databasePool(f.state); t.after(() => restarted.pool.end());
  const runtime = await boot(restarted.pool, () => { throw Error('provider must not run'); });
  const list = await runtime.request('/api/music/people/db', { archive: 'cache' });
  restarted.state.clients.at(-1).emit('error', disconnected()); await tick();
  const detail = await runtime.request('/api/music/people/db/:personId');
  assert.equal(list.data[0].verified_photo_count, 3); assert.equal(detail.verified_photo_count, 3);
  assert.equal(list.relationship_readiness.completed_at, verified);
  assert.equal(detail.relationship_readiness.completed_at, verified);
  assert.equal(runtime.calls(), 0); assert.equal(restarted.pool.totalCount - restarted.pool.idleCount, 0);
});

test('REAL runtime publication disconnect stays non-authoritative until intentional Retry succeeds', async t => {
  const f = databasePool(); t.after(() => f.pool.end());
  let writes = 0;
  f.state.hook = (sql, client, when) => {
    if (sql.startsWith('INSERT INTO stats_snapshots') && when === 'before') { writes++; client.emit('error', disconnected()); }
  };
  const runtime = await boot(f.pool);
  for (let n = 0; n < 30 && !writes; n++) await tick();
  const failed = await runtime.request('/api/music/people/db/:personId');
  assert.equal(failed.relationship_readiness.status, 'error');
  assert.equal(failed.relationship_readiness.authoritative, false);
  assert.equal(failed.verified_photo_count, null); assert.equal(f.state.data, null);
  await runtime.request('/api/music/people/db', { archive: 'cache' }); assert.equal(writes, 1);
  f.state.hook = null;
  const recovered = await runtime.request('/api/music/people/db/:personId', { retry_relationships: '1' });
  assert.equal(recovered.relationship_readiness.authoritative, true);
  assert.equal(recovered.verified_photo_count, 0); assert.equal(runtime.calls(), 1);
  assert.equal(f.pool.totalCount - f.pool.idleCount, 0);
});

test('REAL runtime snapshot-read interruption recovers once and source failure withholds authority until verified', async t => {
  const f = databasePool(), store = createMusicPeopleRelationshipStore({ db: f.pool }); t.after(() => f.pool.end());
  await store.publish({ source: await readSource(f.pool), value: new Map([['1', empty(3)]]), generation: 0 });
  let reads = 0;
  f.state.hook = (sql, client, when) => {
    if (sql.includes('SELECT data FROM stats_snapshots') && when === 'before' && reads++ === 0) client.emit('error', disconnected());
  };
  const runtime = await boot(f.pool); assert.equal(reads, 2); assert.equal(runtime.calls(), 0);
  f.state.hook = (sql, client, when) => {
    if (sql.includes('AS people') && when === 'before') client.emit('error', disconnected());
  };
  const failed = await runtime.request('/api/music/people/db/:personId');
  assert.equal(failed.relationship_readiness.authoritative, false); assert.equal(failed.verified_photo_count, null);
  f.state.hook = null;
  const recovered = await runtime.request('/api/music/people/db/:personId', { retry_relationships: '1' });
  assert.equal(recovered.verified_photo_count, 3); assert.equal(runtime.calls(), 0);
});

test('REAL runtime source invalidation reloads the matching durable generation, not the old restore promise', async t => {
  const f = databasePool(), store = createMusicPeopleRelationshipStore({ db: f.pool }); t.after(() => f.pool.end());
  await store.publish({ source: await readSource(f.pool), value: new Map([['1', empty(3)]]), generation: 0 });
  const runtime = await boot(f.pool);
  f.state.people[0] = { ...f.state.people[0], aliases: ['New exact alias'] };
  await store.publish({ source: await readSource(f.pool), value: new Map([['1', empty(8)]]), generation: 1 });
  const detail = await runtime.request('/api/music/people/db/:personId');
  assert.equal(detail.verified_photo_count, 8); assert.equal(detail.relationship_readiness.authoritative, true);
  assert.equal(runtime.calls(), 0);
});
