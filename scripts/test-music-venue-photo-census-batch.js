'use strict';

// All provider calls, sessions, leases and persistence are synthetic. Never import server.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { DEFINITION, buildPlan, createMusicVenuePhotoCensus } = require('../music-venue-photo-census');
const { normalizeBatchOptions, planMusicVenueCensusBatch, withMusicVenueCensusGate,
  createMusicVenuePhotoCensusBatch } = require('../music-venue-photo-census-batch');

const LOST = { venue_id: 1, venue_key: 'mv_lost_valley_brewing', venue: 'Lost Valley Brewing' };
const AURA = { venue_id: 2, venue_key: 'mv_aura', venue: 'Aura' };
const folder = () => '112025';
function show(id, venue = LOST, album = 'LostAlbum') {
  return { show_id: id, venue_id: venue.venue_key, venue: venue.venue, name: 'Recorded event',
    date: '11/20/25', album_id: album, gallery_id: album, bands: [{ band: 'RecordedBand', slot: 1 }],
    smug_albums: [{ album_id: album, gallery_id: album, band: 'RecordedBand', slot: 1,
      status: 'resolved', smug_path: 'Music/Archives/Bands/Local/RecordedBand/112025' }] };
}
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const issue = (code, status) => Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
const isError = (code, status) => error => error && error.code === code && (!status || error.status === status);
const writeSQL = text => /^(?:INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE)\b/i.test(text.trim());
const photoKey = venue => 'venue_photos:' + encodeURIComponent(venue.venue_key) + ':verified';
const attemptKey = venue => 'venue_photos:' + encodeURIComponent(venue.venue_key) + ':attempt';
const journalKey = id => 'venue_photo_census_batch:' + id;

class StagedDb {
  constructor({ venues = [LOST, AURA], shows = [show(1), show(2, AURA, 'AuraAlbum')] } = {}) {
    this.venues = clone(venues); this.shows = clone(shows); this.rows = new Map();
    this.clients = []; this.log = []; this.commits = []; this.gate = null;
    this.outOfGateWrites = []; this.leaseValid = true; this.failCommit = null;
    this.beforeCensusCommit = null; this.connectOverride = null;
  }
  async connect() {
    if (this.connectOverride) return this.connectOverride();
    const c = new EventEmitter();
    Object.assign(c, { id: this.clients.length + 1, tx: null, pending: [], readOnly: false,
      lost: false, released: false, destroy: false });
    c.query = (sql, values) => this.queryOn(c, sql, values);
    c.release = destroy => {
      c.released = true; c.destroy = !!destroy;
      if (c.tx) { c.tx = null; c.pending = []; }
      if (this.gate === c) this.gate = null;
    };
    this.clients.push(c); return c;
  }
  async query(sql, values) {
    const c = await this.connect();
    try { return await c.query(sql, values); } finally { c.release(); }
  }
  drop(c = this.gate) {
    assert(c, 'an owned client must exist before simulating connection loss');
    c.lost = true; c.tx = null; c.pending = [];
    if (this.gate === c) this.gate = null;
    if (c.listenerCount('error')) c.emit('error', issue('synthetic_connection_lost'));
  }
  async queryOn(c, query, suppliedValues) {
    const text = typeof query === 'string' ? query : query.text;
    const values = suppliedValues || query.values || [];
    this.log.push({ client: c.id, text, values: clone(values), tx: !!c.tx, healthy: !c.lost });
    if (c.lost) {
      if (writeSQL(text)) this.outOfGateWrites.push(text);
      throw issue('synthetic_connection_lost');
    }
    if (/^BEGIN\b/.test(text)) {
      assert.equal(c.tx, null, 'nested transaction is not allowed');
      c.tx = new Map([...this.rows].map(([key, row]) => [key, clone(row)]));
      c.pending = []; c.readOnly = /READ ONLY/.test(text); return { rows: [] };
    }
    if (/^ROLLBACK\b/.test(text)) { c.tx = null; c.pending = []; c.readOnly = false; return { rows: [] }; }
    if (/^COMMIT\b/.test(text)) {
      assert(c.tx, 'COMMIT must own an open transaction');
      const census = c.pending.some(key => key.startsWith('venue_photos:'));
      if (census && this.beforeCensusCommit) await this.beforeCensusCommit(c);
      const loss = census ? this.failCommit : null;
      if (loss) this.failCommit = null;
      if (loss === 'before') { this.drop(c); throw issue('synthetic_commit_ack_lost'); }
      this.rows = c.tx; c.tx = null; c.readOnly = false;
      this.commits.push({ client: c.id, keys: [...c.pending], rows: new Map([...this.rows].map(([key, row]) => [key, clone(row)])) });
      c.pending = [];
      if (loss === 'after') { this.drop(c); throw issue('synthetic_commit_ack_lost'); }
      return { rows: [] };
    }
    if (/pg_try_advisory_lock/.test(text)) {
      const acquired = !this.gate || this.gate === c;
      if (acquired) this.gate = c;
      return { rows: [{ acquired }] };
    }
    if (/pg_advisory_unlock/.test(text)) {
      const released = this.gate === c;
      if (released) this.gate = null;
      return { rows: [{ released }] };
    }
    if (/^LOCK TABLE/.test(text)) { assert(c.tx); assert.equal(c.readOnly, false); return { rows: [] }; }
    if (/SELECT id FROM import_locks/.test(text)) {
      if (text.includes('operationId')) {
        const lease = this.activeLease;
        const active = lease && lease.status === 'running' && lease.meta?.operationId === values[0] &&
          Date.parse(lease.expires_at) > (this.clock ? this.clock() : Date.now());
        return { rows: active ? [{ id: lease.id }] : [] };
      }
      return { rows: this.leaseValid ? [{ id: 7 }] : [] };
    }
    if (/SELECT venue_id.*FROM music_venues/.test(text)) {
      const rows = /WHERE venue_id =/.test(text) ? this.venues.filter(v => String(v.venue_id) === String(values[0])) : this.venues;
      return { rows: clone(rows) };
    }
    if (/SELECT show_id.*FROM music_shows/s.test(text)) return { rows: clone(this.shows) };
    if (/^SELECT .*FROM stats_snapshots/s.test(text)) {
      let rows = [...(c.tx || this.rows)].map(([snapshot_key, row]) => ({ snapshot_key, ...clone(row) }));
      if (/snapshot_key = ANY/.test(text)) rows = rows.filter(row => values[0].includes(row.snapshot_key));
      else if (/snapshot_key = \$1/.test(text)) rows = rows.filter(row => row.snapshot_key === values[0]);
      else if (/snapshot_key LIKE/.test(text)) {
        const withBatches = text.includes('venue_photo_census_batch:');
        rows = rows.filter(row => row.snapshot_key.startsWith('venue_photos:') || withBatches && row.snapshot_key.startsWith('venue_photo_census_batch:'));
      }
      return { rows };
    }
    if (/^INSERT INTO stats_snapshots/.test(text)) {
      if (this.gate !== c || c.readOnly) { this.outOfGateWrites.push(text); throw issue('synthetic_out_of_gate_write'); }
      const [key, serialized, generated_at, meta] = values;
      const row = { data: typeof serialized === 'string' ? JSON.parse(serialized) : clone(serialized),
        generated_at, meta: typeof meta === 'string' ? JSON.parse(meta) : clone(meta || {}) };
      (c.tx || this.rows).set(key, row);
      if (c.tx) c.pending.push(key);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Unmodeled SQL: ' + text);
  }
}
function seedVerified(db, venue, total, now, age = 0) {
  const plan = buildPlan(venue, db.shows, folder);
  const stamp = new Date(now - age).toISOString();
  const data = { definition: DEFINITION, venue_id: venue.venue_key, sourceFingerprint: plan.sourceFingerprint,
    total, complete: true, status: 'complete', scannedAt: stamp, verifiedAt: stamp, issues: [] };
  for (const suffix of ['attempt', 'verified']) db.rows.set('venue_photos:' + encodeURIComponent(venue.venue_key) + ':' + suffix,
    { data: clone(data), meta: {}, generated_at: stamp });
  return clone(data);
}
function setup(options = {}) {
  const db = options.db || new StagedDb(options);
  let time = Date.now(); db.clock = () => time;
  const calls = [], lease = { acquired: 0, released: 0, outOfGateRelease: 0 };
  let concurrent = 0, maximumConcurrent = 0;
  const getImages = json => json.Response.AlbumImage || [];
  const fetchJson = async (endpoint, runtime) => {
    calls.push(endpoint); concurrent++; maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    try {
      const u = new URL('https://fixture.invalid' + endpoint);
      const album = u.pathname.split('/')[2].split('!')[0];
      if (options.provider) {
        const intercepted = await options.provider(endpoint, runtime, { db, advance: ms => { time += ms; } });
        if (intercepted !== undefined) return intercepted;
      }
      if (!u.pathname.includes('!images')) return { Response: { Album: { AlbumKey: album,
        WebUri: 'https://fixture.smugmug.com/Music/Archives/Bands/Local/RecordedBand/112025' } } };
      const images = (options.photos?.[album] || ['Common', album + 'Only']).map(ImageKey => ({ Image: { ImageKey, IsVideo: false } }));
      const start = Number(u.searchParams.get('start')), count = Number(u.searchParams.get('count'));
      return { Response: { AlbumImage: images.slice(start - 1, start - 1 + count),
        Pages: { Total: images.length, Start: start, ...(start - 1 + count < images.length ? { NextPage: 'present' } : {}) } } };
    } finally { concurrent--; }
  };
  const svc = createMusicVenuePhotoCensusBatch({
    db, dateFolder: folder, fetchJson, owner: 'synthetic-owner', now: () => time,
    sleep: async (ms, signal) => { if (signal?.aborted) throw issue('cancelled'); time += ms; },
    acquireImportLock: async input => { lease.acquired++;
      const result = options.acquire ? options.acquire() : { acquired: true, lock: { id: 7, expires_at: new Date(time + 120000).toISOString() } };
      if (result.acquired && !result.bypassed && result.lock?.id) db.activeLease = { ...result.lock, status: 'running', meta: clone(input.meta) };
      return result; },
    releaseImportLock: async (id, status) => { lease.released++;
      if (!db.gate || db.gate.lost) lease.outOfGateRelease++;
      if (db.activeLease && String(db.activeLease.id) === String(id)) db.activeLease.status = status;
      return options.release ? options.release(id, status) : { id, status }; },
    createService: options.createService || ((ownedDb, pacedFetch) => createMusicVenuePhotoCensus({ db: ownedDb,
      fetchJson: pacedFetch, getImages, dateFolder: folder }))
  });
  return { db, svc, calls, lease, now: () => time, advance: ms => { time += ms; },
    maxConcurrent: () => maximumConcurrent };
}
const exec = (id, overrides = {}) => ({ mode: 'execute', confirm: true, operationId: id, ...overrides });
function assertDry(db, calls, lease) {
  assert.equal(calls.length, 0); assert.equal(lease.acquired, 0); assert.equal(lease.released, 0);
  assert.equal(db.rows.size, 0); assert.equal(db.gate, null);
  assert(db.log.every(q => /^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)/.test(q.text)));
  assert(!db.log.some(q => /advisory|FOR UPDATE|LOCK TABLE|set_config|SET /i.test(q.text)));
}

test('default preview and execute default are read-only snapshots, with no journal, gate, lease or provider effects', async () => {
  const x = setup();
  const p = await x.svc.preview(); assert.equal(p.mode, 'dry-run'); assert.equal(p.databaseMutated, false);
  assert.equal(p.totals.selected, 2); assertDry(x.db, x.calls, x.lease);
  const q = await x.svc.execute({}); assert.equal(q.mode, 'dry-run'); assertDry(x.db, x.calls, x.lease);
});
test('execute requires explicit confirmation, stable operation ID and bounded options', () => {
  assert.equal(normalizeBatchOptions({}).limit, 5);
  assert.equal(normalizeBatchOptions({}).budgetSeconds, 120);
  for (const input of [{ mode: 'execute' }, { mode: 'execute', confirm: true },
    { mode: 'execute', confirm: false, operationId: 'x' }, { limit: 11 }, { limit: 0 },
    { budgetSeconds: 301 }, { budgetSeconds: 9 }, { maxAgeHours: 0 }, { forceRefresh: 'true' },
    { venueIds: ['../wrong'] }, { operationId: '../wrong' }]) {
    assert.throws(() => normalizeBatchOptions(input), error => error.status === 400);
  }
  assert.deepEqual(normalizeBatchOptions({ venueIds: ['mv_aura', 'mv_aura'] }).venueIds, ['mv_aura']);
});
test('identical venue rows are deduplicated once, while conflicting stable identities are unavailable', async () => {
  const same = setup({ venues: [LOST, clone(LOST)], shows: [show(1)] });
  const p = await same.svc.preview(); assert.equal(p.venues.length, 1); assert.equal(p.totals.selected, 1);
  const collision = setup({ venues: [LOST, { ...AURA, venue_key: LOST.venue_key }], shows: [show(1)] });
  const q = await collision.svc.preview(); assert.equal(q.totals.selected, 0);
  assert(q.venues.every(row => row.category === 'unavailable' && row.reasons.includes('ambiguous_venue_identity')));
});
test('full Shows relationships reject shared, missing-ID and unresolved membership without inventing zero', async () => {
  const shared = setup({ shows: [show(1), show(2, AURA, 'LostAlbum')] });
  const p = await shared.svc.preview(); assert.equal(p.totals.selected, 0);
  const missing = setup({ venues: [LOST], shows: [{ ...show(1), venue_id: null }] });
  const q = await missing.svc.preview(); assert.equal(q.totals.selected, 0); assert.equal(q.venues[0].category, 'unavailable');
  const unresolved = setup({ venues: [LOST], shows: [{ ...show(1), smug_albums: [] }] });
  assert.equal((await unresolved.svc.preview()).totals.selected, 0);
});
test('fresh verified457 skips, TTL expiration selects, and forceRefresh overrides freshness', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] });
  seedVerified(x.db, LOST, 457, x.now());
  const p = await x.svc.preview(); assert.equal(p.venues[0].category, 'skipped'); assert.equal(p.totals.selected, 0);
  const skipped = await x.svc.execute(exec('skip-fresh')); assert.equal(x.calls.length, 0);
  assert.equal(skipped.results[0].status, 'skipped'); assert.equal(x.db.rows.get(photoKey(LOST)).data.total, 457);
  assert.equal((await x.svc.preview({ forceRefresh: true })).totals.selected, 1);
  const forced = await x.svc.execute(exec('force-fresh', { forceRefresh: true }));
  assert.equal(forced.results[0].status, 'success'); assert.equal(forced.results[0].total, 2);
  x.advance(24 * 3600000); assert.equal((await x.svc.preview()).totals.selected, 1);
});
test('two eligible venues scan sequentially with isolated totals and one global gate/lease', async () => {
  const x = setup(); const r = await x.svc.execute(exec('two-venues'));
  assert.equal(r.status, 'completed'); assert.equal(r.results.filter(row => row.status === 'success').length, 2);
  assert.deepEqual(r.results.filter(row => row.status === 'success').map(row => row.total), [2, 2]);
  assert.equal(x.maxConcurrent(), 1); assert.equal(x.lease.acquired, 1); assert.equal(x.lease.released, 1);
  assert.equal(x.db.rows.get(photoKey(LOST)).data.total, 2); assert.equal(x.db.rows.get(photoKey(AURA)).data.total, 2);
  assert.equal(x.db.outOfGateWrites.length, 0); assert.equal(x.lease.outOfGateRelease, 0);
});
test('a verified venue with no Shows publishes true zero without provider calls', async () => {
  const x = setup({ venues: [LOST], shows: [] }); const r = await x.svc.execute(exec('true-zero'));
  assert.equal(r.results[0].total, 0); assert.equal(r.results[0].status, 'success');
  assert.equal(x.calls.length, 0); assert.equal(x.db.rows.get(photoKey(LOST)).data.total, 0);
});
test('journal and census become visible together only at COMMIT', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] });
  let observed = false;
  x.db.beforeCensusCommit = c => {
    observed = true; assert.equal(x.db.rows.has(photoKey(LOST)), false);
    assert.equal(x.db.rows.get(journalKey('atomic')).data.inflight.venue_id, LOST.venue_key);
    assert(c.tx.has(photoKey(LOST)));
    assert.equal(c.tx.get(journalKey('atomic')).data.inflight, null);
    assert.equal(c.tx.get(journalKey('atomic')).data.results[0].total, 2);
  };
  const r = await x.svc.execute(exec('atomic')); assert.equal(r.status, 'completed'); assert(observed);
  const commit = x.db.commits.find(c => c.keys.includes(photoKey(LOST)));
  assert(commit); assert(commit.keys.includes(attemptKey(LOST))); assert(commit.keys.includes(journalKey('atomic')));
});
test('provider missing pagination produces incomplete, never an estimate, and preserves verified457', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)], provider: endpoint => endpoint.includes('!images') ?
    { Response: { AlbumImage: [{ Image: { ImageKey: 'Sample', IsVideo: false } }] } } : undefined });
  const prior = seedVerified(x.db, LOST, 457, x.now());
  const r = await x.svc.execute(exec('incomplete', { forceRefresh: true }));
  assert.equal(r.results[0].status, 'incomplete'); assert.equal(r.results[0].total, null);
  assert.deepEqual(x.db.rows.get(photoKey(LOST)).data, prior);
  assert.equal(x.db.rows.get(attemptKey(LOST)).data.complete, false);
});
for (const status of [401, 403, 429]) test('provider' + status + ' halts safely with bounded attempts and no second venue', async () => {
  const x = setup({ provider: () => { throw Object.assign(new Error('private synthetic key never public'), { status }); } });
  const r = await x.svc.execute(exec('provider-' + status));
  assert.equal(r.status, 'stopped'); assert.equal(r.stopReason, status === 429 ? 'provider_limited' : 'provider_authorization_failed');
  assert.equal(x.calls.length, status === 429 ? 3 : 1); assert(x.calls.every(url => url.includes('LostAlbum')));
  assert(r.results.some(row => row.venue_id === AURA.venue_key && row.status === 'not_processed'));
  assert(!JSON.stringify(r).includes('private synthetic'));
});
test('Retry-After beyond bounded policy stops instead of waiting or retrying', async () => {
  const x = setup({ provider: () => { throw Object.assign(Error('rate'), { status: 429, retryAfterMs: 5001 }); } });
  const r = await x.svc.execute(exec('retry-after')); assert.equal(r.stopReason, 'provider_limited'); assert.equal(x.calls.length, 1);
});
test('network timeouts have at most three attempts and expose only safe incomplete results', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)], provider: () => { throw issue('ETIMEDOUT private'); } });
  const r = await x.svc.execute(exec('network-timeout')); assert.equal(x.calls.length, 3);
  assert.equal(r.results[0].status, 'incomplete'); assert.equal(r.results[0].total, null);
  assert(!JSON.stringify(r).includes('ETIMEDOUT private'));
});
test('repeat operation ID reads durable result without scans; a changed scope is409', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] }); const options = exec('repeat');
  await x.svc.execute(options); const calls = x.calls.length, leases = x.lease.acquired, writes = x.db.log.filter(q => writeSQL(q.text)).length;
  const repeat = await x.svc.execute(options); assert.equal(repeat.replayed, true); assert.equal(repeat.status, 'completed');
  assert.equal(x.calls.length, calls); assert.equal(x.lease.acquired, leases);
  assert.equal(x.db.log.filter(q => writeSQL(q.text)).length, writes);
  await assert.rejects(x.svc.execute({ ...options, limit: 1 }), isError('operation_id_conflict', 409));
});
for (const loss of ['before', 'after']) test('ambiguous COMMIT loss ' + loss + ' commit preserves atomic state and never auto-replays', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] });
  const prior = seedVerified(x.db, LOST, 457, x.now()); x.db.failCommit = loss;
  const options = exec('commit-' + loss, { forceRefresh: true });
  await assert.rejects(x.svc.execute(options)); const calls = x.calls.length;
  assert.equal(x.db.rows.get(photoKey(LOST)).data.total, loss === 'after' ? 2 : prior.total);
  const journal = x.db.rows.get(journalKey(options.operationId)).data;
  if (loss === 'after') { assert.equal(journal.inflight, null); assert.equal(journal.results[0].total, 2); }
  else { assert.equal(journal.inflight.venue_id, LOST.venue_key); assert.deepEqual(x.db.rows.get(photoKey(LOST)).data, prior); }
  x.advance(121000); // The crashed session's import lease has naturally expired.
  const repeat = await x.svc.execute(options);
  assert.equal(repeat.requiresReconciliation, loss === 'before');
  assert.equal(x.calls.length, calls); assert.equal(x.db.outOfGateWrites.length, 0); assert.equal(x.lease.outOfGateRelease, 0);
  if (loss === 'before') {
    const next = await x.svc.execute(exec('new-after-' + loss, { forceRefresh: true }));
    const blocked = next.results.find(row => row.venue_id === LOST.venue_key);
    assert.equal(blocked.status, 'unavailable');
    assert(blocked.reasons.includes('prior_operation_requires_reconciliation'));
    assert.equal(x.calls.length, calls);
  } else {
    assert.equal(repeat.status, 'interrupted');
    assert.equal(repeat.results.find(row => row.venue_id === LOST.venue_key).total, 2);
  }
});
test('held-client loss cannot borrow another writer or release the import lease outside the gate', async () => {
  let lost = false;
  const x = setup({ venues: [LOST], shows: [show(1)], provider: (endpoint, runtime, { db }) => {
    if (!lost) { lost = true; db.drop(); throw issue('lost provider'); }
  } });
  await assert.rejects(x.svc.execute(exec('lost-gate'))); assert.equal(x.db.outOfGateWrites.length, 0);
  assert.equal(x.lease.outOfGateRelease, 0); assert.equal(x.db.rows.has(photoKey(LOST)), false);
  assert(x.db.clients.some(c => c.destroy));
});
test('global advisory mutex serializes single-venue and batch callers', async () => {
  const x = setup(), hold = deferred(), ready = deferred();
  const first = withMusicVenueCensusGate(x.db, async owned => { assert.equal(typeof owned.query, 'function'); ready.resolve(); await hold.promise; });
  await ready.promise;
  await assert.rejects(x.svc.execute(exec('busy')), isError('census_operation_active', 409));
  assert.equal(x.calls.length, 0); assert.equal(x.lease.acquired, 0);
  hold.resolve(); await first; assert.equal(x.db.gate, null);
});
test('connection acquisition deadline releases a late client without locking or writes', async () => {
  const db = new StagedDb(), client = await db.connect(), pending = deferred(); db.connectOverride = () => pending.promise;
  await assert.rejects(withMusicVenueCensusGate(db, () => { throw Error('must not run'); }, { timeoutMs: 5 }), isError('census_connection_timeout'));
  pending.resolve(client); await tick(); assert.equal(client.released, true); assert.equal(client.destroy, true);
  assert.equal(db.log.length, 0);
});
test('import lease bypass and refusal fail before journals or provider calls', async () => {
  for (const acquired of [{ acquired: false }, { acquired: true, bypassed: true, lock: { id: 7 } }, { acquired: true, lock: { id: 7, expires_at: 'invalid' } }]) {
    const x = setup({ acquire: () => acquired });
    await assert.rejects(x.svc.execute(exec('lease-refusal')), error => [409, 503].includes(error.status));
    assert.equal(x.calls.length, 0); assert.equal(x.db.rows.size, 0); assert.equal(x.lease.released, 0);
  }
});
test('pre-aborted operation never acquires import lease or calls provider', async () => {
  const x = setup(), controller = new AbortController(); controller.abort();
  await assert.rejects(x.svc.execute(exec('already-cancelled'), { signal: controller.signal }), isError('cancelled'));
  assert.equal(x.calls.length, 0); assert.equal(x.lease.acquired, 0); assert.equal(x.db.rows.size, 0);
});
test('absolute budget stops further venues after time is consumed by provider work', async () => {
  const x = setup({ provider: (endpoint, runtime, { advance }) => { advance(8000); } });
  const r = await x.svc.execute(exec('budget', { budgetSeconds: 10 }));
  assert.equal(r.status, 'stopped'); assert.equal(r.stopReason, 'batch_deadline_reached');
  assert(x.calls.every(endpoint => endpoint.includes('LostAlbum')));
  assert(r.results.some(row => row.venue_id === AURA.venue_key && row.status === 'not_processed'));
});


function routeHarness({ secrets = [], tokens = [], service, configured = true, databaseConfigured = true } = {}) {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const a = source.indexOf('// Legacy-only batch control'), b = source.indexOf('\nconst v3AdminAuthRouter =', a);
  assert(a >= 0 && b > a);
  let handlers, factories = 0, parses = 0, sessionValidations = 0;
  const operations = [];
  const mockService = service || {
    preview: async input => { operations.push(['preview', input]); return { ok: true, mode: 'dry-run', databaseMutated: false }; },
    execute: async input => { operations.push(['execute', input]); const options = normalizeBatchOptions(input);
      return { ok: true, mode: options.mode, databaseMutated: options.mode === 'execute' }; },
    status: async id => { operations.push(['status', id]); return { ok: true, operationId: id }; }
  };
  const context = vm.createContext({
    AbortController, process: { env: { DATABASE_URL: databaseConfigured ? 'postgres://fixture.invalid/not-connected' : '' } },
    console: { warn() {}, error() {}, log() {} },
    app: { use: (route, ...values) => { assert.equal(route, '/api/admin/music/venue-photo-census/batches'); handlers = values; } },
    allowCors: (req, res, next) => next(),
    express: { json: () => (req, res, next) => { parses++; next(); } },
    getConfiguredAdminSecrets: () => secrets, getRequestAdminTokens: () => tokens,
    adminTokenMatches: (token, expected) => expected.includes(token),
    musicVenuePhotoCensusBatchService: () => { factories++; return mockService; },
    isSmugMugConfigured: () => configured,
    v3AdminAuthRouter: { authorizeSession: () => { sessionValidations++; throw Error('session validator must not run'); } }
  });
  vm.runInContext(source.slice(a, b), context);
  return {
    operations,
    counts: () => ({ factories, parses, sessionValidations }),
    async request({ method = 'GET', path = '/', body, query = {}, session = true } = {}) {
      const req = Object.assign(new EventEmitter(), { method, path, body, query });
      const res = Object.assign(new EventEmitter(), {
        locals: { v3AdminSessionAuthorized: session }, code: 200, writableEnded: false,
        set() {}, status(code) { this.code = code; return this; },
        json(value) { this.body = value; this.writableEnded = true; return this; }
      });
      let allowed = false;
      await handlers[1](req, res, () => { allowed = true; });
      if (allowed) {
        await handlers[2](req, res, () => {});
        await handlers[3](req, res);
      }
      return res;
    }
  };
}
test('batch route denies missing or invalid legacy secret before parsing, factory, or V3 session validation', async () => {
  for (const config of [{ secrets: [], tokens: ['synthetic-session'] },
    { secrets: ['synthetic-legacy'], tokens: ['invalid-session-token'] }]) {
    const route = routeHarness(config);
    const res = await route.request({ method: 'POST', body: { mode: 'execute', confirm: true }, session: true });
    assert.equal(res.code, 401); assert.equal(res.body.error, 'admin_required');
    assert.deepEqual(route.counts(), { factories: 0, parses: 0, sessionValidations: 0 });
    assert.equal(route.operations.length, 0);
  }
});
test('authorized route GET, POST default, and status remain read-only without explicit execution confirmation', async () => {
  const route = routeHarness({ secrets: ['legacy'], tokens: ['legacy'] });
  const get = await route.request({ query: { forceRefresh: 'false' } });
  assert.equal(get.body.mode, 'dry-run'); assert.equal(route.operations[0][0], 'preview');
  assert.equal(route.operations[0][1].forceRefresh, false);
  const post = await route.request({ method: 'POST', body: {} });
  assert.equal(post.body.mode, 'dry-run'); assert.equal(post.body.databaseMutated, false);
  const status = await route.request({ path: '/operation-one' }); assert.equal(status.body.operationId, 'operation-one');
  const denied = await route.request({ method: 'POST', body: { mode: 'execute', operationId: 'operation-one' } });
  assert.equal(denied.code, 400); assert.equal(denied.body.error, 'execution_confirmation_required');
  assert.equal(route.counts().sessionValidations, 0);
});
test('execute route requires provider configuration and returns safe errors without raw detail', async () => {
  const secret = 'SYNTHETIC_PRIVATE_CREDENTIAL_05E3I';
  const route = routeHarness({ secrets: ['legacy'], tokens: ['legacy'], configured: false });
  const res = await route.request({ method: 'POST', body: exec('blocked') });
  assert.equal(res.code, 503); assert.equal(res.body.error, 'provider_unavailable'); assert.equal(route.operations.length, 0);
  const failing = routeHarness({ secrets: ['legacy'], tokens: ['legacy'], service: {
    preview: async () => { throw Object.assign(Error(secret), { code: secret, status: 503 }); }
  } });
  const failure = await failing.request();
  assert.equal(failure.code, 503); assert.equal(failure.body.error, 'venue_photo_census_batch_unavailable');
  assert(!JSON.stringify(failure.body).includes(secret));
});
test('unused source credentials and provider errors never leak to preview, result, status, or stored journals', async () => {
  const secret = 'SYNTHETIC_UNUSED_CREDENTIAL_05E3I';
  const row = show(1); row.smug_albums[0].url = 'https://fixture.invalid/?private=' + secret;
  const x = setup({ venues: [LOST], shows: [row], provider: () => { throw Error(secret); } });
  const preview = await x.svc.preview(); const result = await x.svc.execute(exec('secrets')); const status = await x.svc.status('secrets');
  for (const value of [preview, result, status, ...[...x.db.rows].filter(([key]) => key.startsWith('venue_photo_census_batch:')).map(([, row]) => row)]) {
    assert(!JSON.stringify(value).includes(secret));
  }
});
test('persisted extra journal fields and nested result credentials are whitelisted away', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] });
  await x.svc.execute(exec('sanitized-status'));
  const row = x.db.rows.get(journalKey('sanitized-status'));
  const secret = 'SYNTHETIC_PERSISTED_PRIVATE_05E3I';
  row.data.extraSecret = secret; row.data.parameters.extraSecret = secret;
  row.data.results[0].debug = { extraSecret: secret }; row.data.inflight = { venue_id: LOST.venue_key, extraSecret: secret };
  const value = await x.svc.status('sanitized-status');
  assert(!JSON.stringify(value).includes(secret));
  assert.equal(value.results[0].venue_id, LOST.venue_key);
});
test('absolute cancellation interrupts current work and prevents following venues', async () => {
  const controller = new AbortController();
  const x = setup({ provider: () => { controller.abort(); throw issue('synthetic_cancelled'); } });
  const result = await x.svc.execute(exec('mid-cancel'), { signal: controller.signal });
  assert.equal(result.stopReason, 'cancelled'); assert(x.calls.every(url => url.includes('LostAlbum')));
  assert.equal(x.db.rows.has(photoKey(AURA)), false); assert.equal(x.db.outOfGateWrites.length, 0);
});
test('status of an absent operation is404 and performs no provider, gate or writes', async () => {
  const x = setup(); await assert.rejects(x.svc.status('not-created'), isError('batch_not_found', 404));
  assertDry(x.db, x.calls, x.lease);
});


test('status proves exact active operation lease before reporting a running job interrupted', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] });
  await x.svc.execute(exec('active-status'));
  const stored = x.db.rows.get(journalKey('active-status')).data;
  stored.status = 'running'; stored.finishedAt = null; stored.inflight = null;
  x.db.activeLease = { id: 7, status: 'running', meta: { operationId: 'active-status' }, expires_at: new Date(x.now() + 120000).toISOString() };
  const start = x.db.log.length;
  const active = await x.svc.status('active-status'); assert.equal(active.status, 'running');
  assert(x.db.log.slice(start).every(q => !writeSQL(q.text) && !/advisory|FOR UPDATE/.test(q.text)));
  stored.inflight = { venue_id: LOST.venue_key, beforeSnapshot: 'a'.repeat(64), startedAt: new Date(x.now()).toISOString() };
  const working = await x.svc.status('active-status'); assert.equal(working.status, 'running');
  assert.equal(working.requiresReconciliation, false);
  x.db.activeLease.meta.operationId = 'different-operation';
  const inactive = await x.svc.status('active-status'); assert.equal(inactive.status, 'uncertain');
  assert.equal(inactive.requiresReconciliation, true);
  stored.inflight = null;
  assert.equal((await x.svc.status('active-status')).status, 'interrupted');
});
test('persisted malformed canonical identities are not serialized as raw objects or credentials', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] }); await x.svc.execute(exec('malformed-status'));
  const secret = 'SYNTHETIC_BAD_ID_PRIVATE_05E3I', job = x.db.rows.get(journalKey('malformed-status')).data;
  job.results.push({ venue_id: { extraSecret: secret }, status: 'success', total: 999 });
  job.parameters.venueIds = [LOST.venue_key, { extraSecret: secret }];
  const result = await x.svc.status('malformed-status');
  assert(!JSON.stringify(result).includes(secret));
  const invalid = result.results.find(row => row.venue_id === null);
  assert(invalid); assert.equal(invalid.status, 'unavailable'); assert.equal(invalid.total, null);
  assert(invalid.reasons.includes('invalid_venue_identity'));
  assert.equal(result.summary.successes, 1);
});
test('eligible limit bounds selected scans and reports remaining verified candidates without provider work', async () => {
  const x = setup(); const p = await x.svc.preview({ limit: 1 });
  assert.equal(p.totals.eligible, 2); assert.equal(p.totals.selected, 1);
  const r = await x.svc.execute(exec('one-limit', { limit: 1 }));
  assert.equal(r.results.filter(row => row.status === 'success').length, 1);
  assert(r.results.some(row => row.venue_id === AURA.venue_key && row.status === 'not_processed'));
  assert(x.calls.every(endpoint => endpoint.includes('LostAlbum')));
});
test('status read cannot replay a checkpoint or change its stored journal status', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] });
  await x.svc.execute(exec('read-checkpoint')); const job = x.db.rows.get(journalKey('read-checkpoint')).data;
  job.status = 'running'; job.inflight = null; job.finishedAt = null;
  const saved = clone(job), calls = x.calls.length;
  const status = await x.svc.status('read-checkpoint');
  assert.equal(status.status, 'interrupted'); assert.deepEqual(x.db.rows.get(journalKey('read-checkpoint')).data, saved);
  assert.equal(x.calls.length, calls);
});


test('missing requested IDs and exact duplicate rows do not inflate discovered inventory', async () => {
  const x = setup({ venues: [LOST, clone(LOST), AURA] });
  const p = await x.svc.preview({ venueIds: [LOST.venue_key, 'mv_not_archived'] });
  assert.equal(p.totals.discovered, 2); assert.equal(p.totals.sourceRows, 3); assert.equal(p.totals.duplicateVenueRows, 1);
  assert.equal(p.venues.filter(row => row.venue_id === LOST.venue_key).length, 1);
  const absent = p.venues.find(row => row.venue_id === 'mv_not_archived');
  assert.equal(absent.category, 'unavailable'); assert.deepEqual(absent.reasons, ['venue_not_found']);
  assert.equal(x.calls.length, 0);
});
test('existing single-venue POST cannot bypass an unresolved batch checkpoint', async () => {
  const { assertMusicVenueCensusReconciled, createCensusRequestScope } = require('../music-venue-photo-census-batch');
  const db = new StagedDb({ venues: [LOST], shows: [show(1)] });
  db.rows.set(journalKey('unresolved-single'), { data: { status: 'running', inflight: { venue_id: LOST.venue_key } }, meta: {} });
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const a = source.indexOf('// Explicit census refresh only;'), b = source.indexOf("app.get('/api/music/venues/db'", a);
  assert(a >= 0 && b > a); const routes = {}; let providers = 0, scans = 0, leases = 0;
  const context = vm.createContext({
    process: { env: { DATABASE_URL: 'postgres://fixture.invalid/not-connected' } },
    dbPool: db, withMusicVenueCensusGate, assertMusicVenueCensusReconciled, createCensusRequestScope,
    app: { get: (path, fn) => { routes[path] = fn; }, post: (path, fn) => { routes[path] = fn; } },
    getConfiguredAdminSecrets: () => ['legacy'], getRequestAdminTokens: () => ['legacy'], adminTokenMatches: () => true,
    isSmugMugConfigured: () => true, findMusicVenueForPhotoAggregation: async () => LOST,
    getImportLockOwner: () => 'synthetic-owner',
    acquireImportLock: async () => { leases++; return { acquired: true, lock: { id: 7, expires_at: new Date(Date.now() + 120000).toISOString() } }; },
    releaseImportLock: async (id, status) => ({ id, status }),
    fetchSmugJson: async () => { providers++; throw Error('must not enumerate'); },
    getSmugAlbumImages: () => [], formatMusicShowDateFolder: folder,
    createMusicVenuePhotoCensus: () => ({ refresh: async () => { scans++; return { complete: true, total: 999 }; } })
  });
  vm.runInContext(source.slice(a, b), context);
  const res = { locals: { v3AdminSessionAuthorized: true }, code: 200, set() {}, status(n) { this.code = n; return this; },
    json(value) { this.body = value; return this; } };
  await routes['/api/admin/music/venues/:venue_id/photo-census']({ params: { venue_id: LOST.venue_key } }, res);
  assert.equal(res.code, 409); assert.equal(res.body.error, 'prior_operation_requires_reconciliation');
  assert.equal(providers, 0); assert.equal(scans, 0); assert.equal(leases, 0); assert.equal(db.outOfGateWrites.length, 0);
  assert.equal(db.gate, null);
});
test('provider drain keeps the advisory gate until the original in-flight promise settles', async () => {
  const { createCensusRequestScope } = require('../music-venue-photo-census-batch');
  const db = new StagedDb(), raw = deferred(), started = deferred(); let scope, closed = false;
  const first = withMusicVenueCensusGate(db, async (owned, signal) => {
    scope = createCensusRequestScope({ fetchJson: async () => { started.resolve(); return raw.promise; },
      signal, deadline: Date.now() + 1000 });
    const work = scope.fetchJson('/album/Fixture?_accept=application/json');
    await started.promise; await scope.close(); closed = true; await work;
  });
  await started.promise; await tick();
  assert.equal(scope.closed, true); assert.equal(closed, false); assert(db.gate);
  await assert.rejects(withMusicVenueCensusGate(db, () => { throw Error('must not run concurrently'); }), isError('census_operation_active', 409));
  raw.resolve({ Response: { Album: { AlbumKey: 'Fixture' } } }); await first;
  assert.equal(closed, true); assert.equal(db.gate, null);
});
test('expired request scope refuses provider work without creating an in-flight request', async () => {
  const { createCensusRequestScope } = require('../music-venue-photo-census-batch'); let requests = 0;
  const scope = createCensusRequestScope({ fetchJson: async () => { requests++; }, deadline: Date.now() - 1 });
  await assert.rejects(scope.fetchJson('/album/Fixture'), isError('cancelled'));
  await scope.close(); assert.equal(requests, 0);
});
test('expired import lease before snapshot transaction rolls back and preserves prior verified total', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] });
  const prior = seedVerified(x.db, LOST, 457, x.now()); x.db.leaseValid = false;
  const result = await x.svc.execute(exec('expired-lease', { forceRefresh: true }));
  assert.equal(result.requiresReconciliation, true);
  assert.deepEqual(x.db.rows.get(photoKey(LOST)).data, prior);
  assert.equal(x.db.commits.some(c => c.keys.includes(photoKey(LOST))), false);
});
test('batch record with a future verified timestamp is due rather than silently fresh', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)] }); seedVerified(x.db, LOST, 457, x.now(), -3600000);
  const p = await x.svc.preview(); assert.equal(p.totals.selected, 1); assert.equal(p.venues[0].freshnessDue, true);
});


test('provider scope deadline aborts an in-flight synthetic transport and drains cleanup', { timeout: 2000 }, async () => {
  const { createCensusRequestScope } = require('../music-venue-photo-census-batch'); let requests = 0, observedAbort = false;
  const scope = createCensusRequestScope({ deadline: Date.now() + 100,
    fetchJson: async (endpoint, { signal }) => {
      requests++;
      return new Promise((resolve, reject) => {
        const onAbort = () => { observedAbort = true; reject(issue('synthetic_transport_aborted')); };
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      });
    } });
  await assert.rejects(scope.fetchJson('/album/Fixture'), isError('synthetic_transport_aborted'));
  await scope.close(); assert.equal(requests, 1); assert.equal(observedAbort, true); assert.equal(scope.closed, true);
});
test('incorrect import lease release acknowledgement fails safely without replaying committed work', async () => {
  const x = setup({ venues: [LOST], shows: [show(1)], release: () => ({ id: 7, status: 'running' }) });
  await assert.rejects(x.svc.execute(exec('release-mismatch')), isError('import_lock_release_failed'));
  const calls = x.calls.length, repeated = await x.svc.execute(exec('release-mismatch'));
  assert.equal(repeated.replayed, true); assert.equal(x.calls.length, calls);
  assert.equal(x.db.rows.get(photoKey(LOST)).data.total, 2);
});


test('missing DATABASE_URL rejects every authorized batch mode before factory or connection fallback', async () => {
  for (const request of [{ method: 'GET' }, { method: 'GET', path: '/existing-operation' },
    { method: 'POST', body: {} }, { method: 'POST', body: exec('no-database') }]) {
    const route = routeHarness({ secrets: ['legacy'], tokens: ['legacy'], databaseConfigured: false });
    const response = await route.request(request);
    assert.equal(response.code, 503); assert.equal(response.body.error, 'database_unavailable');
    assert.equal(route.counts().factories, 0); assert.equal(route.counts().sessionValidations, 0);
    assert.equal(route.operations.length, 0);
  }
});

