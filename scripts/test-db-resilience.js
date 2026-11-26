'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { guardClient, installPoolSafety, retryDatabaseRead } = require('../db-resilience');
const { createMusicPeopleRelationshipStore, readSource, describeRelationships } = require('../music-people-relationship-store');
const { createMusicPeopleReadiness } = require('../music-people-readiness');
const { databasePool, disconnected, empty, tick } = require('./db-resilience-fixture');
async function fixture(t) {
  const f = databasePool(); t.after(() => f.pool.end());
  f.store = createMusicPeopleRelationshipStore({ db: f.pool });
  f.source = await readSource(f.pool);
  f.publish = (n = 3) => f.store.publish({ source: f.source, value: new Map([['1', empty(n)]]), generation: n });
  return f;
}

test('idle disconnect and late events are contained; discarded clients do not exhaust the pool', async t => {
  const { pool, state } = await fixture(t);
  const client = state.clients[0];
  assert.equal(pool.idleCount, 1);
  assert.doesNotThrow(() => client.emit('error', disconnected()));
  assert.doesNotThrow(() => client.emit('error', disconnected()));
  await tick(); assert.equal(pool.totalCount, 0);
  await readSource(pool); assert.equal(pool.idleCount, 1); assert.equal(state.clients.length, 2);
  assert(state.warnings.includes('idle_disconnect'));
  assert(!JSON.stringify(state.warnings).includes('private'));
});

test('checked-out disconnect rejects pending and future queries; release destroys exactly once', async t => {
  const { pool, state } = await fixture(t), client = await pool.connect();
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  state.hook = () => gate;
  const pending = client.query('SELECT 1');
  const rejected = assert.rejects(pending, { code: 'DATABASE_CONNECTION_LOST' });
  client.emit('error', disconnected()); await rejected;
  await assert.rejects(client.query('COMMIT'), { code: 'DATABASE_CONNECTION_LOST' });
  client.release(); unblock(); await tick();
  assert.equal(pool.totalCount, 0); assert.equal(state.releases.filter(r => r.client === client).length, 2);
  assert.equal(state.releases.at(-1).error, true);
  assert.throws(() => client.release(), /already been released/);
});

test('callback checkout/query and healthy reuse retain callback semantics without listener leaks', async t => {
  const { pool } = await fixture(t);
  installPoolSafety(pool);
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve, reject) => pool.connect((error, client, release) => {
      if (error) return reject(error);
      assert.equal(client.listenerCount('error'), 1);
      client.query('SELECT 1', error => { release(error); error ? reject(error) : resolve(); });
    }));
  }
  assert.equal(pool.totalCount, 1); assert.equal(pool.idleCount, 1); assert.equal(pool.waitingCount, 0);
});

test('reused query configs preserve callbacks and promise results', async t => {
  const { pool } = await fixture(t), client = await pool.connect();
  try {
    let calls = 0;
    const config = { text: 'SELECT 1', values: [], callback: error => { assert.ifError(error); calls++; } };
    const callback = config.callback;
    client.query(config); await tick(); client.query(config); await tick();
    assert.equal(calls, 2); assert.equal(config.callback, callback);
    const promiseConfig = { text: 'SELECT 1' };
    assert.deepEqual(await client.query(promiseConfig), { rows: [], rowCount: 0 });
    assert.equal(promiseConfig.callback, undefined);
  } finally { client.release(); }
});

test('actual pg.Client asynchronous error rejects its queued query without uncaught events', async () => {
  const client = guardClient(new Client());
  const pending = assert.rejects(client.query('SELECT 1'), { code: 'DATABASE_CONNECTION_LOST' });
  client._handleErrorEvent(disconnected()); // Driver fault injection, never connect a socket.
  await pending; await tick();
  assert.doesNotThrow(() => client.emit('error', disconnected()));
  await client.end();
});

test('checked-out transaction disconnect between queries cannot commit or return to the idle pool', async t => {
  const f = await fixture(t), client = await f.pool.connect();
  await client.query('BEGIN');
  assert.doesNotThrow(() => client.emit('error', disconnected()));
  await assert.rejects(client.query('COMMIT'), { code: 'DATABASE_CONNECTION_LOST' });
  assert(!f.state.log.includes('COMMIT'));
  client.release(false); await tick();
  assert.equal(f.pool.totalCount, 0); assert.equal(f.pool.waitingCount, 0);
});

test('end without an error event rejects pending work and releases a failed connection', async t => {
  const f = await fixture(t), client = await f.pool.connect();
  let unblock; f.state.hook = () => new Promise(resolve => { unblock = resolve; });
  const pending = assert.rejects(client.query('SELECT 1'), { code: 'DATABASE_CONNECTION_LOST' });
  await tick(); client.emit('end'); await pending;
  client.release(); unblock(); await tick(); assert.equal(f.pool.totalCount, 0);
});

test('failed rollback is discarded even when a shared transaction owner calls release without an error', async t => {
  const f = await fixture(t), client = await f.pool.connect();
  await client.query('BEGIN');
  f.state.hook = sql => { if (sql === 'ROLLBACK') throw Error('rollback failed'); };
  await assert.rejects(client.query('ROLLBACK'), { code: 'DATABASE_CONNECTION_LOST' });
  client.release(); await tick(); assert.equal(f.pool.totalCount, 0);
});

for (const phase of ['source', 'snapshot']) test(`${phase} read retries one disconnected connection and recovers`, async t => {
  const f = await fixture(t); await f.publish();
  let faults = 0;
  f.state.hook = (sql, client, when) => {
    if (when === 'before' && sql.includes(phase === 'source' ? 'AS people' : 'SELECT data') && faults++ === 0)
      client.emit('error', disconnected());
  };
  const value = phase === 'source' ? await readSource(f.pool) : await f.store.load(f.source);
  assert(value); assert.equal(faults, 2); assert.equal(f.pool.totalCount, 1); assert.equal(f.pool.idleCount, 1);
});

test('read recovery is bounded and never retries semantic errors', async t => {
  const f = await fixture(t); let attempts = 0;
  f.state.hook = (sql, client, when) => { if (when === 'before') { attempts++; client.emit('error', disconnected()); } };
  await assert.rejects(readSource(f.pool), { code: 'DATABASE_CONNECTION_LOST' });
  assert.equal(attempts, 2); await tick(); assert.equal(f.pool.totalCount, 0);
  attempts = 0;
  await assert.rejects(retryDatabaseRead(() => { attempts++; throw Object.assign(Error(), { code: '42501' }); }));
  assert.equal(attempts, 1);
});

for (const phase of ['BEGIN', 'source', 'snapshot', 'write', 'COMMIT']) {
  test(`publication disconnect at ${phase} preserves prior snapshot, drains client and recovers`, async t => {
    const f = await fixture(t); const old = await f.publish(3), prior = f.state.data;
    const life = createMusicPeopleReadiness({ ttlMs: 1000, describe: describeRelationships }); life.restore(old);
    const matches = sql => phase === 'source' ? sql.includes('AS people') : phase === 'snapshot' ? sql.includes('FOR UPDATE')
      : phase === 'write' ? sql.startsWith('INSERT') : sql.startsWith(phase);
    let faults = 0;
    f.state.hook = (sql, client, when) => { if (when === 'before' && matches(sql)) { faults++; client.emit('error', disconnected()); } };
    await life.prepare(() => f.publish(9), { refresh: true });
    assert.equal(faults, 1); assert.equal(f.state.data, prior); assert.equal(life.read(), old);
    assert.equal(life.snapshot(old).refresh_status, 'error'); assert.equal(life.snapshot(old).refresh_retry_allowed, true);
    await tick(); assert.equal(f.pool.totalCount, 0);
    f.state.hook = null;
    await life.prepare(() => f.publish(9), { retry: true, refresh: true });
    assert.equal(life.read().get('1').photo_count, 9); assert.equal(f.pool.idleCount, 1);
    assert.equal((await f.store.load(f.source)).get('1').photo_count, 9);
  });
}

test('COMMIT acknowledgement loss is never replayed or reported ready; durable reconciliation recovers', async t => {
  const f = await fixture(t); let commits = 0;
  f.state.hook = (sql, client, when) => { if (sql === 'COMMIT' && when === 'after') { commits++; client.emit('error', disconnected()); } };
  const life = createMusicPeopleReadiness({ ttlMs: 1000, describe: describeRelationships });
  await life.prepare(() => f.publish(3));
  assert.equal(life.snapshot().status, 'error'); assert.equal(life.read(), null);
  assert.equal(f.state.data.complete, true); assert.equal(commits, 1);
  f.state.hook = null; assert(life.restore(await f.store.load(f.source)));
  assert.equal(life.snapshot(life.read()).authoritative, true); assert.equal(life.read().get('1').photo_count, 3);
});

test('acquisition failures are sanitized, bounded and publication does not leak clients', async t => {
  const f = await fixture(t);
  f.state.clients[0].emit('error', disconnected()); await tick(); f.state.acquireFailures = 2;
  await assert.rejects(readSource(f.pool), { code: 'ECONNRESET' }); assert.equal(f.pool.totalCount, 0);
  f.state.acquireFailures = 1;
  await assert.rejects(f.publish(), { code: 'persistence_failed' }); assert.equal(f.pool.totalCount, 0);
  await f.publish(); assert.equal(f.pool.totalCount, 1); assert.equal(f.pool.idleCount, 1);
  assert.equal(f.pool.options.connectionTimeoutMillis, 10000);
});

test('SQL rollback failure discards the connection without replacing the prior snapshot', async t => {
  const f = await fixture(t); await f.publish(); const prior = f.state.data;
  f.state.hook = sql => {
    if (sql.startsWith('INSERT')) throw Object.assign(Error('write denied'), { code: '42501' });
    if (sql === 'ROLLBACK') throw Error('rollback unavailable');
  };
  await assert.rejects(f.publish(9), { code: 'persistence_failed' });
  assert.equal(f.state.data, prior); await tick(); assert.equal(f.pool.totalCount, 0);
});
