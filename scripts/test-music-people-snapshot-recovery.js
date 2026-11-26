'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync, gunzipSync } = require('node:zlib');
const crypto = require('node:crypto');
const { createMusicPeopleRelationshipStore, readSource, describeRelationships } = require('../music-people-relationship-store');
const { databasePool, empty, disconnected, tick } = require('./db-resilience-fixture');

async function fixture(t) {
  const f = databasePool(); t.after(() => f.pool.end());
  f.events = [];
  f.store = createMusicPeopleRelationshipStore({ db: f.pool, report: event => f.events.push(event) });
  f.source = await readSource(f.pool);
  f.publish = value => f.store.publish({ source: f.source, value: new Map([['1', value]]), generation: 1 });
  return f;
}
function photos(n) {
  return Array.from({ length: n }, (_, i) => ({ image_key: `i-${i}`, caption: 'Person One; Person Two',
    thumbnail_url: `https://photos.smugmug.com/photos/i-${i}/0/${'a'.repeat(80)}/Th/i-${i}-Th.jpg`,
    large_url: `https://photos.smugmug.com/photos/i-${i}/0/${'a'.repeat(80)}/X3/i-${i}-X3.jpg`,
    show_id: 'show1', album_id: 'AlbumA', date_taken: '2026-01-02T12:00:00Z' }));
}

test('large 910-person population publishes bounded compressed JSON and restores losslessly', async t => {
  const f = await fixture(t);
  f.state.people = Array.from({ length: 910 }, (_, i) => ({ person_id: i + 1, name: `Person ${i + 1}`, aliases: [] }));
  const source = await readSource(f.pool), value = new Map(), images = photos(160);
  for (let i = 1; i <= 910; i++) value.set(String(i), { ...empty(160), matched_photos: images.slice(0, 24),
    tagged_shows: [{ show_id: 'show1', tagged_photo_count: 160, matched_photos: images.map(photo => ({ ...photo })) }] });
  const result = await f.store.publish({ source, value, generation: 0,
    coverage: { total_albums: 494, albums_processed: 494, pages_processed: 496, albums_from_cache: 0 } });
  assert.equal(f.state.data.storage_format, 'gzip_json_v1');
  const metrics = f.events.at(-1);
  assert(metrics.json_bytes < 2 * 1024 * 1024);
  assert(metrics.stored_bytes < 8 * 1024 * 1024);
  assert(metrics.stored_bytes < metrics.json_bytes / 10);
  assert.equal(result.size, 910); assert.equal(result.get('910').tagged_shows[0].matched_photos.length, 160);
  assert.equal(result.get('1').tagged_shows[0].matched_photos[159].large_url, images[159].large_url);
  const restored = await f.store.load(source);
  assert.deepEqual(restored, result);
  assert.equal(f.pool.totalCount - f.pool.idleCount, 0);
  t.diagnostic(JSON.stringify({ synthetic: true, people: 910, photo_relationships: 145600,
    process_peak_rss_kib: process.resourceUsage().maxRSS, ...metrics }));
});

test('packed corruption, unsupported codec and decompression bounds never restore authority', async t => {
  const f = await fixture(t); await f.publish({ ...empty(1000), matched_photos: photos(1000) });
  const good = f.state.data;
  for (const mutation of [
    { sha256: '0'.repeat(64) }, { json_bytes: 1 }, { json_bytes: 129 * 1024 * 1024 },
    { payload: 'not-gzip' }, { storage_format: 'unknown' }
  ]) {
    f.state.data = { ...good, ...mutation };
    await assert.rejects(f.store.load(f.source), { code: 'persistence_invalid' });
  }
  f.state.data = good;
  assert.equal((await f.store.load(f.source)).get('1').photo_count, 1000);
});

test('payload above the uncompressed safety cap is rejected before connection checkout', async t => {
  const f = await fixture(t), count = f.state.releases.length;
  await assert.rejects(f.publish({ ...empty(1), matched_photos: [{ caption: 'x'.repeat(129 * 1024 * 1024) }] }), { code: 'persistence_invalid' });
  assert.equal(f.state.releases.length, count); assert.equal(f.state.data, null);
  assert.equal(f.events.at(-1).stage, 'encode');
});

test('transaction readback corruption rolls back and retains last known good snapshot', async t => {
  const f = await fixture(t); await f.publish(empty(3)); const old = f.state.data;
  f.state.hook = (sql, client, when) => {
    if (when === 'after' && sql.startsWith('INSERT')) client.tx.staged = { invalid: true };
  };
  await assert.rejects(f.publish(empty(4)), { code: 'persistence_invalid' });
  assert.equal(f.state.data, old); assert.equal(f.events.at(-1).stage, 'transaction_readback');
  assert(f.state.log.includes('ROLLBACK'));
});

test('postcommit readback failure does not replay write or publish false authority; restore recovers', async t => {
  const f = await fixture(t); let committed = false;
  f.state.hook = (sql, client, when) => {
    if (sql === 'COMMIT' && when === 'after') committed = true;
    if (committed && sql.includes('SELECT data') && when === 'before') client.emit('error', disconnected());
  };
  await assert.rejects(f.publish(empty(6)), { code: 'persistence_failed' });
  assert.equal(f.events.at(-1).stage, 'durable_readback'); assert.equal(f.events.at(-1).commit_acknowledged, true);
  assert.equal(f.state.log.filter(sql => sql.startsWith('INSERT')).length, 1);
  f.state.hook = null; await tick();
  assert.equal((await f.store.load(f.source)).get('1').photo_count, 6);
});

test('publication diagnostics report only stage, safe code and sizes, never raw database text', async t => {
  const f = await fixture(t);
  f.state.hook = sql => {
    if (sql.startsWith('INSERT')) throw Object.assign(Error('password=private-token query=secret'), { code: '42501' });
  };
  await assert.rejects(f.publish(empty(1)), { code: 'persistence_failed' });
  const event = f.events.at(-1);
  assert.equal(event.stage, 'upsert'); assert.equal(event.code, '42501'); assert(event.json_bytes > 0);
  assert(!JSON.stringify(f.events).includes('secret')); assert(!JSON.stringify(f.events).includes('private-token'));
});

test('compressed snapshot validates inner source and identity fingerprints after checksum', async t => {
  const f = await fixture(t); await f.publish(empty(1));
  const raw = { ...f.state.data, source_fingerprint: 'wrong' }, json = JSON.stringify(raw);
  f.state.data = { storage_format: 'gzip_json_v1', json_bytes: Buffer.byteLength(json),
    sha256: crypto.createHash('sha256').update(json).digest('hex'), payload: gzipSync(json).toString('base64') };
  assert.equal(await f.store.load(f.source), null);
  assert.equal(describeRelationships(null), null);
});

test('oversized incompressible storage is rejected before checking out a writer', async t => {
  const f = await fixture(t), releases = f.state.releases.length;
  const caption = crypto.randomBytes(7 * 1024 * 1024).toString('base64');
  await assert.rejects(f.publish({ ...empty(1), matched_photos: [{ caption }] }), { code: 'persistence_invalid' });
  assert.equal(f.state.releases.length, releases); assert.equal(f.state.data, null);
});

test('async disconnect retains sanitized SQLSTATE for publication diagnostics', async t => {
  const f = await fixture(t);
  f.state.hook = (sql, client, when) => {
    if (sql.startsWith('INSERT') && when === 'before')
      client.emit('error', Object.assign(Error('secret connection details'), { code: '57P01' }));
  };
  await assert.rejects(f.publish(empty(1)), { code: 'persistence_failed' });
  assert.equal(f.events.at(-1).database_code, '57P01'); assert.equal(f.events.at(-1).stage, 'upsert');
  assert(!JSON.stringify(f.events).includes('secret'));
});

test('photo table preserves ordering, repeated refs and differing metadata for the same image key', async t => {
  const f = await fixture(t), images = photos(300);
  images[1] = { ...images[0], show_id: 'different-show', caption: 'Different Caption' };
  images[2] = { ...images[0] };
  await f.publish({ ...empty(300), matched_photos: images });
  const restored = (await f.store.load(f.source)).get('1').matched_photos;
  assert.equal(restored.length, 300);
  assert.equal(restored[0].image_key, restored[1].image_key);
  assert.equal(restored[1].show_id, 'different-show'); assert.equal(restored[1].caption, 'Different Caption');
  assert.deepEqual(restored[0], restored[2]);
  assert.equal(restored[299].image_key, images[299].image_key);
});

test('invalid indexed photo reference is rejected even with a valid transport checksum', async t => {
  const f = await fixture(t); await f.publish({ ...empty(300), matched_photos: photos(300) });
  const data = JSON.parse(gunzipSync(Buffer.from(f.state.data.payload, 'base64')).toString());
  data.relationships[0][1].matched_photos[0] = data.photos.length;
  const json = JSON.stringify(data);
  f.state.data = { storage_format: 'gzip_json_v1', json_bytes: Buffer.byteLength(json),
    sha256: crypto.createHash('sha256').update(json).digest('hex'), payload: gzipSync(json).toString('base64') };
  await assert.rejects(f.store.load(f.source), { code: 'persistence_invalid' });
});

test('large mostly distinct photograph population retains all full-size URLs', async t => {
  const f = await fixture(t), images = photos(50000);
  const value = { ...empty(50000), matched_photos: images.slice(0, 24),
    tagged_shows: [{ show_id: 'show1', tagged_photo_count: 50000, matched_photos: images }] };
  const restored = await f.publish(value);
  assert.equal(restored.get('1').tagged_shows[0].matched_photos.length, 50000);
  assert.equal(restored.get('1').tagged_shows[0].matched_photos[49999].large_url, images[49999].large_url);
  assert(f.events.at(-1).stored_bytes < 8 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ synthetic: true, distinct_photos: 50000, ...f.events.at(-1) }));
});


test('mixed production-shaped 910-person population reports compact sizes and isolated memory', async t => {
  const f = await fixture(t), baseline = process.memoryUsage();
  const peopleCount = 910, eligibleCount = 472, photoCount = 16000, showCount = 245, albumCount = 494;
  f.state.people = Array.from({ length: peopleCount }, (_, i) => ({ person_id: i + 1, name: `Fixture Person ${i + 1}`, aliases: i % 7 ? [] : [`Fixture Alias ${i + 1}`] }));
  const albumShows = [];
  f.state.shows = Array.from({ length: showCount }, (_, i) => ({ id: i + 1, show_id: `fixture-show-${i + 1}`,
    name: `Fixture Performance ${i + 1}`, show_date: `2026-${String(i % 12 + 1).padStart(2, '0')}-${String(i % 25 + 1).padStart(2, '0')}`,
    smug_albums: Array.from({ length: i < 4 ? 3 : 2 }, () => {
      const album = albumShows.push(i);
      return { album_id: `FixtureAlbum${album}`, gallery_id: `FixtureGallery${album}` };
    }) }));
  assert.equal(albumShows.length, albumCount);
  const records = Array.from({ length: peopleCount }, () => []);
  const digest = text => crypto.createHash('sha256').update(text).digest('hex');
  for (let i = 0; i < photoCount; i++) {
    const album = i % albumCount, show = albumShows[album], ordinal = Math.floor(i / albumCount);
    const members = Array.from({ length: 8 }, (_, n) => (show * 19 + (ordinal + n * 3) % 24) % eligibleCount);
    const key = `fixture-image-${i}`, token = digest('url:' + i);
    const date = new Date(Date.parse(f.state.shows[show].show_date + 'T18:00:00Z') + ordinal * 1000).toISOString();
    const base = `https://photos.smugmug.com/Fixture-${show + 1}/i-${key}/0/${token}`;
    const photo = { image_key: key,
      caption: members.map(n => f.state.people[n].name).join('; ') + ' | ' + digest('caption-a:' + i) + digest('caption-b:' + i),
      date_taken: date, taken_at: date, date_time_original: date,
      thumbnail_url: `${base}/Th/${key}-Th.jpg`, small_url: `${base}/S/${key}-S.jpg`,
      medium_url: `${base}/M/${key}-M.jpg`, large_url: `${base}/X3/${key}-X3.jpg`,
      album_id: `FixtureAlbum${album + 1}`, gallery_id: `FixtureGallery${album + 1}`,
      show_id: f.state.shows[show].show_id, show_key: f.state.shows[show].show_id,
      show_title: f.state.shows[show].name, show_name: f.state.shows[show].name,
      show_date: f.state.shows[show].show_date, venue: `Fixture Venue ${show % 23}`, location: `Fixture City ${show % 17}, ME` };
    // Real matching creates a distinct per-person record; do not make the input
    // artificially cheap by sharing the same photo object across all people.
    members.forEach(n => records[n].push({ ...photo }));
  }
  const value = new Map();
  for (let n = 0; n < peopleCount; n++) {
    const images = records[n].sort((a, b) => b.date_time_original.localeCompare(a.date_time_original) || b.image_key.localeCompare(a.image_key));
    const groups = new Map();
    for (const photo of images) {
      if (!groups.has(photo.show_id)) groups.set(photo.show_id, { show_id: photo.show_id, show_key: photo.show_key,
        show_title: photo.show_title, album_id: photo.album_id, gallery_id: photo.gallery_id,
        title: photo.show_title, date: photo.show_date, venue: photo.venue, location: photo.location, matched_photos: [] });
      groups.get(photo.show_id).matched_photos.push(photo);
    }
    const tagged = [...groups.values()].map(show => ({ ...show, tagged_photo_count: show.matched_photos.length }));
    const first = images.at(-1), last = images[0];
    value.set(String(n + 1), { ...empty(images.length), set_count: new Set(images.map(p => p.album_id)).size,
      show_count: groups.size, event_count: groups.size, gallery_id: last?.gallery_id || null, album_id: last?.album_id || null,
      cover_image_url: last?.thumbnail_url || null, first_seen: first?.date_time_original || null,
      first_seen_date_time_original: first?.date_time_original || null, first_seen_display: first?.date_time_original || null,
      latest_seen: last?.date_time_original || null, latest_seen_date_time_original: last?.date_time_original || null,
      latest_seen_display: last?.date_time_original || null, matched_photos: images.slice(0, 24), tagged_shows: tagged });
  }
  // Exact byte count of the expanded relationship array without allocating one
  // giant legacy JSON string. Per-person JSON is bounded by this fixture.
  let expandedBytes = 2 + value.size - 1, references = 0;
  for (const entry of value) {
    expandedBytes += Buffer.byteLength(JSON.stringify(entry));
    references += entry[1].matched_photos.length + entry[1].tagged_shows.reduce((sum, show) => sum + show.matched_photos.length, 0);
  }
  const preparedMemory = process.memoryUsage(), source = await readSource(f.pool);
  const result = await f.store.publish({ source, value, generation: 0,
    coverage: { total_albums: albumCount, albums_processed: albumCount, pages_processed: albumCount, albums_from_cache: 0 } });
  const publishedMemory = process.memoryUsage(), restored = await f.store.load(source), restoredMemory = process.memoryUsage();
  assert.equal(result.size, peopleCount); assert.equal([...result.values()].filter(row => row.photo_count > 0).length, eligibleCount);
  assert.equal(result.get('910').photo_count, 0);
  assert.deepEqual(restored, result);
  for (const id of ['1', '137', '472']) {
    assert.equal(restored.get(id).photo_count, value.get(id).photo_count);
    assert.deepEqual(restored.get(id).tagged_shows, value.get(id).tagged_shows);
  }
  const metrics = f.events.at(-1);
  assert.equal(f.state.data.storage_format, 'gzip_json_v1');
  assert(metrics.json_bytes < expandedBytes); assert(metrics.stored_bytes < 8 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ synthetic: true, isolated_node_only_not_postgres: true, people: peopleCount,
    matched_people: eligibleCount, shows: showCount, albums: albumCount, distinct_photos: photoCount,
    distinct_per_person_records: photoCount * 8, photo_references: references,
    legacy_expanded_relationship_bytes: expandedBytes, indexed_json_bytes: metrics.json_bytes, stored_bytes: metrics.stored_bytes,
    rss_baseline_bytes: baseline.rss, rss_after_fixture_bytes: preparedMemory.rss,
    rss_after_publish_bytes: publishedMemory.rss, rss_after_restore_bytes: restoredMemory.rss,
    process_peak_rss_kib: process.resourceUsage().maxRSS,
    heap_after_fixture_bytes: preparedMemory.heapUsed, heap_after_publish_bytes: publishedMemory.heapUsed,
    heap_after_restore_bytes: restoredMemory.heapUsed, heap_limit_bytes: require('node:v8').getHeapStatistics().heap_size_limit }));
});

test('gzip output is bounded before base64 or writer checkout without a large fixture', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), realZlib = require('node:zlib');
  const source = fs.readFileSync(require.resolve('../music-people-relationship-store'), 'utf8');
  let bound = 0, connects = 0;
  const ctx = vm.createContext({ module: { exports: {} }, exports: {}, Buffer, URL, Map, Set, Date, Promise,
    console: { warn() {} }, require(id) {
      if (id === 'node:zlib') return { ...realZlib, gzip(_input, options, callback) {
        bound = options.maxOutputLength;
        callback(Object.assign(Error('bounded compressor output'), { code: 'ERR_BUFFER_TOO_LARGE' }));
      } };
      if (id === './db-resilience') return require('../db-resilience');
      return require(id);
    } });
  vm.runInContext(source, ctx);
  const module = ctx.module.exports, people = [{ person_id: 1, name: 'Fixture Person', aliases: [] }];
  const input = module.projectSource(people, []), store = module.createMusicPeopleRelationshipStore({
    db: { connect() { connects++; throw Error('must not check out writer'); } }, report() {} });
  await assert.rejects(store.publish({ source: input, value: new Map([['1', { ...empty(300), matched_photos: photos(300) }]]),
    generation: 0 }), { code: 'persistence_invalid' });
  assert(bound > 6 * 1024 * 1024 - 1024 && bound < 6 * 1024 * 1024);
  assert.equal(connects, 0);
});
