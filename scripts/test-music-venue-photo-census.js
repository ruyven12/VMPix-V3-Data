'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DEFINITION, buildPlan, scan, project, createMusicVenuePhotoCensus } = require('../music-venue-photo-census');

const venue = { venue_id: 1, venue_key: 'mv_lost_valley_brewing', venue: 'Lost Valley Brewing' };
const dateFolder = value => ({ '10/24/25': '102425', '10/20/23': '102023' })[value] || '';
function show(id = 234, ids = ['J7WcRw', 'GNWWh6', 'fTCfTz'], venueId = venue.venue_key, date = '10/24/25') {
  return { show_id: id, venue_id: venueId, venue: venue.venue, date,
    bands: ids.map((_, i) => ({ band: `Band${i}`, slot: i + 1 })),
    album_id: ids[0], gallery_id: ids[0],
    smug_albums: ids.map((album_id, i) => ({ album_id, gallery_id: album_id, band: `Band${i}`, slot: i + 1,
      status: 'resolved', smug_path: `Music/Archives/Bands/Local/Band${i}/${dateFolder(date)}` })) };
}
const source = [show(), show(213, ['RQwWQB', 'T9K876', '6zrDjP'], venue.venue_key, '10/20/23')];
const img = (ImageKey, IsVideo = false) => ({ Image: { ImageKey, IsVideo } });
const page = (items, Total = items.length, Start = 1, NextPage) => ({ Response: { AlbumImage: items,
  Pages: { Total, Start, ...(NextPage ? { NextPage } : {}) } } });
const getImages = json => json.Response.AlbumImage || [];
function provider(plan, photos, override) {
  const calls = [];
  const fetchJson = async endpoint => {
    calls.push(endpoint);
    const parsed = new URL('https://example.test' + endpoint);
    const id = parsed.pathname.split('/')[2].split('!')[0];
    if (!parsed.pathname.includes('!images')) return { Response: { Album: { AlbumKey: id,
      WebUri: 'https://vmpix.smugmug.com/' + plan.albums.find(a => a.album_id === id).path } } };
    const start = Number(parsed.searchParams.get('start'));
    if (override) return override(id, start);
    const count = Number(parsed.searchParams.get('count'));
    const all = photos[id] || [];
    return page(all.slice(start - 1, start - 1 + count), all.length, start, start + count <= all.length ? 'next' : null);
  };
  return { fetchJson, calls, getImages };
}

test('Lost Valley six-album fixture: all pages, distinct relationships, cross-album image dedupe (synthetic photos)', async () => {
  const plan = buildPlan(venue, source, dateFolder);
  assert.equal(plan.albums.length, 6);
  const photos = Object.fromEntries(plan.albums.map((a, i) => [a.album_id, [img('Common'), img(`Unique${i}`)]]));
  const api = provider(plan, photos);
  const result = await scan(plan, { ...api, pageSize: 1 });
  assert.equal(result.complete, true);
  assert.equal(result.total, 7);
  assert.equal(result.coverage.image_records_examined, 12);
  assert.equal(result.coverage.duplicates_removed, 5);
  assert.equal(result.coverage.pages_fetched, 12);
  assert.equal(result.coverage.albums_scanned, 6);
  assert.equal(api.calls.length, 18);
});

test('same venue shared album is scanned once; second venue counts are isolated', async () => {
  const rows = [show(1, ['A']), show(2, ['A']), show(3, ['B', 'C'], 'mv_second')];
  const first = buildPlan(venue, rows, dateFolder);
  const second = buildPlan({ venue_id: 2, venue_key: 'mv_second', venue: 'Second' }, rows, dateFolder);
  assert.equal(first.albums.length, 1);
  const a = await scan(first, provider(first, { A: [img('i-Shared')] }));
  const b = await scan(second, provider(second, { B: [img('Shared'), img('Other')], C: [img('Third')] }));
  assert.equal(a.total, 1); assert.equal(b.total, 3);
  assert.equal(project(second, [{ snapshot_key: 'x:attempt', data: a }]).total, null);
});

test('mixed cross-venue album fails attribution before any provider request', async () => {
  const plan = buildPlan(venue, [show(1, ['A']), show(2, ['A'], 'another-venue')], dateFolder);
  const api = provider(plan, {});
  const result = await scan(plan, api);
  assert.equal(result.total, null); assert.equal(result.complete, false);
  assert.ok(result.issues.some(i => i.reason === 'album_shared_outside_venue'));
  assert.equal(api.calls.length, 0);
});

test('verified empty archive and verified empty album are zero, missing linkage is not', async () => {
  const empty = buildPlan(venue, [], dateFolder);
  assert.equal((await scan(empty, provider(empty, {}))).total, 0);
  const plan = buildPlan(venue, [show(1, ['A'])], dateFolder);
  assert.equal((await scan(plan, provider(plan, {}))).total, 0);
  const missing = buildPlan(venue, [{ ...show(1, ['A']), smug_albums: [] }], dateFolder);
  assert.equal((await scan(missing, provider(missing, {}))).total, null);
});

for (const [reason, respond] of Object.entries({
  missing_page: (_, start) => start === 1 ? page([img('A')], 2, 1, 'next') : page([], 2, 2),
  failure: () => { throw new Error('private provider error with API key'); },
  identity: () => page([{ Image: { IsVideo: false } }]),
  unknown_media: () => page([{ Image: { ImageKey: 'A' } }]),
  repeated_page: (_, start) => page([img('A')], 2, start, start === 1 ? 'next' : null),
  changing_total: (_, start) => page([img(`I${start}`)], start === 1 ? 2 : 3, start, 'next'),
  missing_next: () => page([img('A')], 2),
  absent_metadata: () => ({ Response: { AlbumImage: [img('A')] } })
})) test(`incomplete ${reason} never publishes a numeric count`, async () => {
  const plan = buildPlan(venue, [show(1, ['A'])], dateFolder);
  const result = await scan(plan, provider(plan, {}, respond));
  assert.equal(result.total, null); assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /private provider error/);
});

test('exact provider album path/key required; no date-only match', async () => {
  const plan = buildPlan(venue, [show(1, ['A'])], dateFolder);
  const result = await scan(plan, { getImages, fetchJson: async () => ({ Response: { Album: {
    AlbumKey: 'A', WebUri: 'https://vmpix.smugmug.com/Music/Other/102425'
  } } }) });
  assert.equal(result.total, null);
  assert.equal(result.coverage.pages_fetched, 0);
});

test('gallery-only verified mapping is supported; unresolved lineup or ambiguous date path is unavailable', async () => {
  const row = show(1, ['A']);
  row.album_id = null; row.smug_albums[0].album_id = null;
  const valid = buildPlan(venue, [row], dateFolder);
  assert.equal((await scan(valid, provider(valid, { A: [img('Photo')] }))).total, 1);
  row.bands.push({ band: 'Missing Band', slot: 2 });
  assert.ok(buildPlan(venue, [row], dateFolder).issues.some(i => i.reason === 'lineup_album_unresolved'));
  row.bands.pop(); row.smug_albums[0].smug_path = 'Music/Archives/Bands/Local/Band0/102023';
  assert.ok(buildPlan(venue, [row], dateFolder).issues.some(i => i.reason === 'unverified_album_mapping'));
});

test('videos excluded, image keys preserve case and normalize optional prefix', async () => {
  const plan = buildPlan(venue, [show(1, ['A', 'B'])], dateFolder);
  const result = await scan(plan, provider(plan, { A: [img('i-Key'), img('key'), img('Video', true)], B: [img('Key')] }));
  assert.equal(result.total, 2);
  assert.equal(result.coverage.videos_excluded, 1);
  assert.equal(result.coverage.duplicates_removed, 1);
});

test('caps and deadline are incomplete rather than estimates', async () => {
  const plan = buildPlan(venue, [show(1, ['A'])], dateFolder);
  const api = provider(plan, { A: [img('A'), img('B')] });
  assert.equal((await scan(plan, { ...api, maxPages: 1, pageSize: 1 })).total, null);
  assert.equal((await scan(plan, { ...api, maxAlbums: 0 })).total, null);
  assert.equal((await scan(plan, { ...api, deadline: 0 })).total, null);
});

function database(rows = source) {
  const snapshots = new Map(), queries = [];
  let changed = false;
  const db = {
    connect: async () => ({ query: db.query, release() {} }),
    query: async (sql, args) => {
      queries.push(sql);
      if (sql.startsWith('SELECT show_id')) return { rows: changed ? [] : rows };
      if (sql.startsWith('SELECT venue_id')) return { rows: [venue] };
      if (sql.startsWith('SELECT id FROM import_locks')) return { rows: [{ id: 7 }] };
      if (sql.startsWith('SELECT snapshot_key')) return { rows: [...snapshots].filter(([k]) => args[0].includes(k)).map(([snapshot_key, data]) => ({ snapshot_key, data })) };
      if (sql.startsWith('INSERT INTO stats_snapshots')) snapshots.set(args[0], JSON.parse(args[1]));
      return { rows: [] };
    }
  };
  return { db, queries, snapshots, change: () => { changed = true; } };
}
const lock = () => ({ id: 7, expires_at: new Date(Date.now() + 120000).toISOString() });
test('snapshot refresh persists, read has no provider/write calls, incomplete attempt hides but preserves last verified snapshot', async () => {
  const plan = buildPlan(venue, source, dateFolder), storage = database();
  const api = provider(plan, Object.fromEntries(plan.albums.map(a => [a.album_id, [img('Common')]])));
  let fail = false;
  const service = createMusicVenuePhotoCensus({ db: storage.db, getImages, dateFolder,
    fetchJson: async e => { if (fail) throw new Error('offline'); return api.fetchJson(e); } });
  const first = await service.refresh(venue, lock());
  assert.equal(first.total, 1);
  const requests = api.calls.length, queryStart = storage.queries.length;
  assert.equal((await service.read(venue)).total, 1);
  assert.equal(api.calls.length, requests);
  assert.ok(storage.queries.slice(queryStart).every(q => q.startsWith('SELECT')));
  fail = true;
  await service.refresh(venue, lock());
  const read = await service.read(venue);
  assert.equal(read.status, 'incomplete'); assert.equal(read.total, null);
  assert.equal(read.lastVerifiedAt, first.verifiedAt);
  assert.equal(storage.snapshots.get('venue_photos:mv_lost_valley_brewing:verified').total, 1);
  storage.change();
  assert.equal((await service.read(venue)).status, 'stale');
  assert.ok(!storage.queries.some(q => /CREATE|ALTER|DELETE|TRUNCATE/.test(q)));
});

test('relationship race cannot save a verified snapshot', async () => {
  const rows = [show(1, ['A'])], plan = buildPlan(venue, rows, dateFolder), storage = database(rows);
  const api = provider(plan, {});
  const service = createMusicVenuePhotoCensus({ db: storage.db, getImages, dateFolder,
    fetchJson: async e => { const r = await api.fetchJson(e); storage.change(); return r; } });
  const result = await service.refresh(venue, lock());
  assert.equal(result.total, null);
  assert.equal(storage.snapshots.size, 1);
  assert.ok(result.issues.some(i => i.reason === 'venue_relationships_changed_during_scan'));
});

test('expired persistence lease rolls back without publishing; missing snapshot storage reads unavailable', async () => {
  const rows = [show(1, ['A'])], plan = buildPlan(venue, rows, dateFolder), storage = database(rows);
  const original = storage.db.query;
  storage.db.query = async (sql, args) => {
    if (sql.startsWith('SELECT id FROM import_locks')) return { rows: [] };
    if (sql.startsWith('SELECT snapshot_key')) throw new Error('missing storage');
    return original(sql, args);
  };
  const service = createMusicVenuePhotoCensus({ db: storage.db, dateFolder, ...provider(plan, {}) });
  await assert.rejects(service.refresh(venue, lock()), /refresh_lock_expired/);
  assert.equal(storage.snapshots.size, 0);
  assert.ok(storage.queries.includes('ROLLBACK'));
  const response = await service.read(venue);
  assert.equal(response.total, null); assert.equal(response.complete, false);
  assert.equal(response.issues[0].reason, 'snapshot_storage_unavailable');
});

test('public route and admin gate are isolated; missing DB is safe', async () => {
  const text = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const snippet = text.slice(text.indexOf('// Explicit census refresh only;'), text.indexOf("app.get('/api/music/venues/db'"));
  const routes = {}, context = vm.createContext({ process: { env: {} },
    app: { get: (p, fn) => { routes[p] = fn; }, post: (p, fn) => { routes[p] = fn; } },
    getConfiguredAdminSecrets: () => [], getRequestAdminTokens: () => [],
    findMusicVenueForPhotoAggregation: () => { throw new Error('must not reach DB'); } });
  vm.runInContext(snippet, context);
  const res = { locals: {}, set() {}, status(s) { this.code = s; return this; }, json(body) { this.body = body; return this; } };
  await routes['/api/music/venues/:venue_id/photo-census']({ params: { venue_id: venue.venue_key } }, res);
  assert.equal(res.code, 503); assert.equal(res.body.photo_census.total, null);
  await routes['/api/admin/music/venues/:venue_id/photo-census']({}, res);
  assert.equal(res.code, 401);
  assert.doesNotMatch(snippet, /ensureStatsSnapshotsTable|app\.get\('\/api\/admin/);
});
