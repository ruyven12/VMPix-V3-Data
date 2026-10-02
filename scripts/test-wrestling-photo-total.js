const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Evaluate the actual helpers without starting the server or connecting to external services.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, name);
  const rest = source.slice(start);
  const end = rest.indexOf('\n}');
  assert.notEqual(end, -1, name);
  return rest.slice(0, end + 2);
}
const aggregateSource = source.slice(
  source.indexOf('// Wrestling archive photo totals:'),
  source.indexOf('async function rebuildStatsSnapshot(')
);
function harness(overrides = {}) {
  const context = vm.createContext({
    crypto, process: { env: { DATABASE_URL: 'test-only' } },
    SMUG_REQUEST_CONCURRENCY: 2, SMUG_WRESTLING_MATCH_PHOTOS_PAGE_LIMIT: 200,
    getIntegerEnv: (_name, fallback) => fallback,
    getWrestlingShowAlbumIdCandidates: (row) => row.album_id ? [row.album_id] : [],
    getWrestlingShowPhotoSourceUrls: (row) => row.album_url ? [row.album_url] : [],
    resolveSmugWrestlingAlbumIdFromSourceUrl: async () => '',
    resolveSmugWrestlingMatchAlbum: async (match) => ({ albumId: match.album_id || '' }),
    fetchSmugJson: async () => { throw new Error('Unexpected network request'); },
    dbPool: { query: async () => { throw new Error('Unexpected DB query'); } },
    ...overrides
  });
  vm.runInContext(['getSmugAlbumImages', 'getSmugNestedField', 'getSmugNestedRawField', 'mapWithConcurrency']
    .map(functionSource).join('\n') + '\n' + aggregateSource, context);
  return context;
}
const image = (ImageKey, extra = {}) => ({ Image: { ImageKey, IsVideo: false, ...extra } });
const page = (images, total = images.length, start = 1, next = false) => ({
  Response: { AlbumImage: images, Pages: { Total: total, Start: start, ...(next ? { NextPage: 'next' } : {}) } }
});
const rows = [{ show_id: 1, matches: [{ match_url: 'Match-1', album_id: 'AlbumA' }] }];
const run = (context, data = rows) => context.buildWrestlingArchivePhotoAggregate(data, Date.now() + 60000);

test('canonical ImageKey strips optional prefix, preserves case, rejects URLs', () => {
  const { canonicalWrestlingArchiveImageKey: key } = harness();
  assert.equal(key(' i-AbC123 '), 'AbC123');
  assert.equal(key('AbC123'), 'AbC123');
  assert.notEqual(key('abc123'), key('AbC123'));
  assert.equal(key('https://example.test/i-AbC123'), '');
  assert.equal(key(null), '');
});

test('global deduplication, repeated album mappings, videos, and caption independence', async () => {
  const calls = [];
  const context = harness({ fetchSmugJson: async (url) => {
    calls.push(url);
    return url.includes('/AlbumA!')
      ? page([image('i-AbC'), image('abc'), image('Video', { IsVideo: true })])
      : page([image('AbC'), image('Other')]);
  } });
  const result = await run(context, [
    { show_id: 1, poster: 'display-only', matches: [{ album_id: 'AlbumA' }, { album_id: 'AlbumB' }] },
    { show_id: 2, matches: [{ album_id: 'AlbumA' }] }
  ]);
  assert.equal(result.status, 'complete');
  assert.equal(result.photosTotal, 3);
  assert.equal(result.coverage.matchesExamined, 3);
  assert.equal(result.coverage.albumsDiscovered, 2);
  assert.equal(result.coverage.rawImageReferences, 5);
  assert.equal(result.coverage.videosExcluded, 1);
  assert.equal(result.coverage.duplicateImageReferences, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.startsWith('/album/')));
});

test('enumerates every page with 1-based start and accepts a verified empty album', async () => {
  const calls = [];
  const context = harness({ fetchSmugJson: async (url) => {
    calls.push(url);
    return calls.length === 1 ? page([image('A')], 2, 1, true) : page([image('B')], 2, 2);
  } });
  const result = await run(context);
  assert.equal(result.photosTotal, 2);
  assert.equal(result.coverage.imagePagesFetched, 2);
  assert.match(calls[1], /start=2&/);
  const empty = await run(harness({ fetchSmugJson: async () => page([]) }));
  assert.equal(empty.status, 'complete');
  assert.equal(empty.photosTotal, 0);
});

test('incomplete pages, page caps, duplicate pages, changing totals and failures cannot publish a total', async () => {
  const cases = [
    { fetchSmugJson: async () => ({ Response: { AlbumImage: [image('A')] } }) },
    { fetchSmugJson: async () => page([image('A')], 2) },
    { fetchSmugJson: async () => page([image('A')], 2, 1, true), getIntegerEnv: () => 1 },
    { fetchSmugJson: async () => { throw new Error('private API key must not escape'); } },
    { fetchSmugJson: async (url) => url.includes('start=1&') ? page([image('A')], 2, 1, true) : page([image('A')], 2, 2) },
    { fetchSmugJson: async (url) => url.includes('start=1&') ? page([image('A')], 2, 1, true) : page([image('B')], 3, 2) }
  ];
  for (const overrides of cases) {
    const result = await run(harness(overrides));
    assert.equal(result.status, 'partial');
    assert.equal(result.photosTotal, null);
    assert.equal(result.coverage.albumsFailed, 1);
    assert.doesNotMatch(JSON.stringify(result), /private API key/);
  }
});

test('unknown media, missing image keys and unresolved mappings stay explicit and partial', async () => {
  const context = harness({ fetchSmugJson: async () => page([image(''), { ImageKey: 'A' }]) });
  const result = await run(context);
  assert.equal(result.coverage.missingImageKeys, 1);
  assert.equal(result.coverage.unknownMediaTypes, 1);
  assert.equal(result.photosTotal, null);
  const unresolved = await run(harness(), [{ show_id: 1, matches: [{ match_url: 'Match-1' }] }]);
  assert.equal(unresolved.coverage.matchesUnresolved, 1);
  assert.equal(unresolved.coverage.showsUnresolved, 1);
  assert.equal(unresolved.status, 'partial');
});

test('unknown is null, verified zero is zero, and partial refresh retains verified count and timestamp', () => {
  const { projectWrestlingArchivePhotoTotals: project } = harness();
  assert.equal(project().photosTotal, null);
  assert.equal(project().status, 'unavailable');
  const verified = { snapshot_key: 'photos_verified', data: {
    definition: 'unique_wrestling_image_keys_v1', status: 'complete', photosTotal: 0, calculatedAt: 'earlier'
  } };
  assert.equal(project([verified]).photosTotal, 0);
  verified.data.photosTotal = 123;
  const attempt = { snapshot_key: 'photos_attempt', data: {
    status: 'partial', calculatedAt: 'later', coverage: { uniqueCanonicalImageKeys: 10 }
  } };
  const projected = project([verified, attempt]);
  assert.equal(projected.photosTotal, 123);
  assert.equal(projected.calculatedAt, 'earlier');
  assert.equal(projected.status, 'stale');
  assert.equal(projected.lastAttempt.observedUniquePhotos, 10);
  assert.equal(project([attempt]).photosTotal, null);
  assert.equal(project([{ snapshot_key: 'photos_attempt', data: { status: 'complete' } }]).status, 'unavailable');
});

test('transaction writes verified key only on completeness; source changes and expired locks are safe', async () => {
  for (const mode of ['complete', 'partial', 'changed', 'expired']) {
    const writes = [];
    const statements = [];
    let released = false;
    const context = harness({ dbPool: { connect: async () => ({
      query: async (sql, args) => {
        statements.push(sql);
        if (sql.includes('SELECT id FROM import_locks')) return { rows: mode === 'expired' ? [] : [{ id: 1 }] };
        if (sql.includes('SELECT * FROM wrestling_shows')) return { rows: mode === 'changed' ? [] : rows };
        if (sql.startsWith('INSERT INTO stats_snapshots')) writes.push(args[0]);
        return { rows: [] };
      },
      release: () => { released = true; }
    }) } });
    const result = {
      status: mode === 'partial' ? 'partial' : 'complete', photosTotal: 12,
      sourceFingerprint: context.wrestlingArchivePhotoSourceFingerprint(rows),
      coverage: { issueCount: 0 }, issues: [], calculatedAt: new Date().toISOString()
    };
    if (mode === 'expired') {
      await assert.rejects(context.persistWrestlingArchivePhotoAggregate(result, { id: 1 }), /expired/);
      assert.deepEqual(writes, []);
      assert.ok(statements.includes('ROLLBACK'));
    } else {
      await context.persistWrestlingArchivePhotoAggregate(result, { id: 1 });
      assert.deepEqual(writes, mode === 'complete' ? ['photos_attempt', 'photos_verified'] : ['photos_attempt']);
      assert.ok(statements.includes('COMMIT'));
      if (mode === 'changed') assert.equal(result.photosTotal, null);
    }
    assert.ok(released);
  }
});

test('public stats reads snapshots only, preserves existing totals, and handles absent snapshot table', async () => {
  let snapshotReads = 0;
  const statsSource = functionSource('buildWrestlingShowsDbStatsResponse');
  const overrides = { toIntegerCount: (value) => Number(value) || 0, formatEasternGeneratedTime: () => 'test' };
  for (const [name] of statsSource.matchAll(/getWrestling\w+Sql(?=\()/g)) overrides[name] = () => "'[]'::jsonb";
  const context = harness({ ...overrides, dbPool: { query: async (sql) => {
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
    if (sql.includes('FROM stats_snapshots')) {
      snapshotReads++;
      return { rows: [{ snapshot_key: 'photos_verified', data: {
        definition: 'unique_wrestling_image_keys_v1', status: 'complete', photosTotal: 123
      } }] };
    }
    return { rows: [{ shows_total: 47, matches_total: 369 }] };
  } } });
  vm.runInContext(statsSource, context);
  const response = await context.buildWrestlingShowsDbStatsResponse();
  assert.equal(response.totals.showsTotal, 47);
  assert.equal(response.totals.matchesTotal, 369);
  assert.equal(response.photoTotals.photosTotal, 123);
  assert.equal(snapshotReads, 1);
  const absent = await harness().readWrestlingArchivePhotoTotals();
  assert.equal(absent.photosTotal, null);
  assert.equal(absent.status, 'unavailable');
});

test('refresh requires explicit auth and a real lock; failed persistence releases lock as failed', async () => {
  for (const mode of ['no_credentials', 'unauthorized', 'busy', 'bypassed', 'persist_failed']) {
    let enumerations = 0;
    let releasedStatus;
    const context = harness({
      getConfiguredAdminSecrets: () => mode === 'no_credentials' ? [] : ['test'],
      getRequestAdminTokens: () => mode === 'unauthorized' ? [] : ['test'],
      adminTokenMatches: () => true, isSmugMugConfigured: () => true,
      getImportLockOwner: () => 'test',
      acquireImportLock: async () => ({ acquired: mode !== 'busy', bypassed: mode === 'bypassed',
        lock: { id: 1, expires_at: new Date(Date.now() + 60000).toISOString() } }),
      ensureStatsSnapshotsTable: async () => true,
      releaseImportLock: async (_id, status) => { releasedStatus = status; }
    });
    context.readWrestlingArchivePhotoSource = async () => rows;
    context.buildWrestlingArchivePhotoAggregate = async () => { enumerations++; return { status: 'complete' }; };
    context.persistWrestlingArchivePhotoAggregate = async () => { throw new Error('DB failure'); };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await context.handleWrestlingArchivePhotoRefresh({}, res);
    assert.equal(res.body.ok, false);
    assert.equal(enumerations, mode === 'persist_failed' ? 1 : 0);
    if (mode === 'persist_failed') assert.equal(releasedStatus, 'failed');
    if (mode === 'busy') assert.equal(res.code, 409);
  }
  assert.ok(source.includes("app.post('/api/admin/stats/rebuild/wrestling/photos', handleWrestlingArchivePhotoRefresh)"));
});
