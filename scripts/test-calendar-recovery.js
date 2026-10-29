'use strict';

// CAL-06C: real, disposable PostgreSQL only. Launch with CAL-06A manage.ps1 Check.
// No .env, db.js, server.js, migrations, live Todoist, or production fallback.
// Reuses CAL-06B synthetic fixtures; worker configuration travels over private IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { testConfig, openTestDatabase } = require('./calendar-test-db');
const { fixture, task } = require('./test-calendar-postgres');
const { withDbLock } = require('../todoist-auth');
const { INTERVAL_MS, EVENT_KEYS } = require('../todoist-calendar');

const DATABASE = 'vmpix_calendar_test_7b2545df';
const ROLE = 'cal06a_owner_7b2545df';
const NAMESPACE = 1447904076;
const BASE_NOW = Date.parse('2026-10-01T12:00:00Z');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const workers = new Set();
const pools = new Set();
const servers = new Set();

async function until(check, milliseconds = 5000) {
  const deadline = performance.now() + milliseconds;
  do { if (await check()) return; await sleep(20); } while (performance.now() < deadline);
  throw Error('BOUNDED_TEST_WAIT_EXPIRED');
}

async function guardedPool(max = 3) {
  const config = testConfig(process.env, max);
  assert.equal(config.database, DATABASE); assert.equal(config.user, ROLE);
  const { pool, identity } = await openTestDatabase({ max });
  try { assert.equal(identity.version_num, 170011); }
  catch (error) { await pool.end(); throw error; }
  pools.add(pool);
  return pool;
}

async function endPool(pool) {
  if (pools.delete(pool)) await pool.end();
}

function observedPool(pool, state = {}) {
  state.queries = []; state.checkouts = []; state.transactions = [];
  return {
    async connect() {
      const client = await pool.connect();
      const checkout = { pid: client.processID, releases: 0, queries: 0 };
      state.checkouts.push(checkout);
      return {
        on: (...args) => client.on(...args), once: (...args) => client.once(...args),
        removeListener: (...args) => client.removeListener(...args),
        release: destroy => { checkout.releases++; assert.equal(checkout.releases, 1); client.release(destroy); },
        async query(args, values) {
          const sql = (typeof args === 'string' ? args : args.text).replace(/\s+/g, ' ').trim();
          checkout.queries++;
          state.queries.push({ sql, pid: client.processID, timeout: args.query_timeout });
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) state.transactions.push(sql);
          const result = await client.query(args, values);
          if (state.afterQuery) await state.afterQuery({ sql, client, result });
          return result;
        }
      };
    }
  };
}

function assertPublic(result, status) {
  assert.equal(result.body.status, status);
  assert.equal(result.httpStatus, ['ready', 'empty'].includes(status) ? 200 : 503);
  assert.equal(result.body.timezone, 'America/New_York');
  if (!['ready', 'empty'].includes(status)) {
    assert.equal(result.cache, 'no-store'); assert.deepEqual(result.body.events, []);
  }
  for (const event of result.body.events) assert.deepEqual(Object.keys(event).sort(), [...EVENT_KEYS].sort());
  for (const value of ['PRIVATE-', 'synthetic-access', 'synthetic-refresh', 'encrypted_tokens',
    'credential_version', 'postgres:', 'SELECT ', 'UPDATE ', 'project_id']) assert(!JSON.stringify(result.body).includes(value));
}

async function httpHarness(app) {
  const web = express(); web.get('/api/calendar', app.publicHandler);
  const server = await new Promise((resolve, reject) => {
    const instance = web.listen(0, '127.0.0.1', () => resolve(instance)); instance.once('error', reject);
  });
  servers.add(server);
  return {
    async read() {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/calendar`, { signal: AbortSignal.timeout(8000) });
      return { httpStatus: response.status, body: await response.json(), cache: response.headers.get('cache-control'),
        elapsedMs: Math.round(performance.now() - started) };
    },
    async close() { servers.delete(server); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  };
}

function childEnvironment() {
  // Deliberately exclude DATABASE_URL, PG*, NODE_OPTIONS, production OAuth, etc.
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'LOCALAPPDATA', 'Path',
    'TEST_DATABASE_URL', 'CALENDAR_TEST_MODE'].filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]).concat([['NODE_ENV', 'test']]));
}

async function startWorker(options) {
  const child = fork(__filename, ['--worker'], { windowsHide: true, env: childEnvironment(),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let sequence = 0, exited = false;
  const pending = new Map(), notifications = [];
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('TEST_WORKER_EXITED')); }
    pending.clear(); resolve({ code, signal });
  }));
  child.on('message', message => {
    if (message.event) notifications.push(message);
    const waiter = pending.get(message.id);
    if (waiter) {
      clearTimeout(waiter.timer); pending.delete(message.id);
      if (message.error) waiter.reject(Error('TEST_WORKER_FAILED'));
      else waiter.resolve(message.result);
    }
  });
  child.on('error', () => { /* Pending commands have bounded rejection/exit handling. */ });
  const worker = {
    pid: child.pid,
    call(command, values = {}) {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => {
        if (exited) { reject(Error('TEST_WORKER_EXITED')); return; }
        const timer = setTimeout(() => { pending.delete(id); reject(Error('TEST_WORKER_DEADLINE')); }, 12000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, command, ...values }, error => {
          if (error && pending.delete(id)) { clearTimeout(timer); reject(Error('TEST_WORKER_CHANNEL')); }
        });
      });
      promise.catch(() => {}); // A deliberately killed in-flight worker is observed immediately.
      return promise;
    },
    async held() {
      await until(() => notifications.some(item => item.event === 'held'));
      return notifications.find(item => item.event === 'held');
    },
    async kill() {
      if (!exited) child.kill('SIGKILL');
      await exit; workers.delete(worker);
    },
    async close() {
      let failed = false;
      if (!exited) {
        try { await worker.call('shutdown'); }
        catch { failed = true; child.kill('SIGKILL'); }
      }
      const outcome = await exit; workers.delete(worker);
      assert.equal(failed, false, 'Graceful worker cleanup must complete');
      assert.equal(outcome.code, 0, 'An unexpected worker exit must fail the test');
      assert(!notifications.some(item => item.event === 'unhandled'));
    }
  };
  workers.add(worker);
  try { await worker.call('initialize', { options }); return worker; }
  catch (error) { await worker.kill(); throw error; }
}

async function workerMain() {
  let pool, f, resume, state, mode, identity, terminating = false;
  const send = message => { if (process.connected) process.send(message); };
  const hold = (phase, signal) => new Promise((resolve, reject) => {
    const finish = error => { signal?.removeEventListener('abort', abort); resume = null; error ? reject(error) : resolve(); };
    const abort = () => finish(Error('SYNTHETIC_CANCELLED'));
    resume = () => finish();
    signal?.addEventListener('abort', abort, { once: true });
    send({ event: 'held', phase, pid: identity });
  });
  const stats = () => ({ taskCalls: f.requests.filter(value => value === '/api/v1/tasks').length,
    updates: state.queries.filter(q => q.sql.startsWith('UPDATE calendar_publication_snapshot SET events =')).length,
    transactions: state.transactions,
    acquired: state.queries.filter(q => q.sql.startsWith('SELECT pg_try_advisory_lock')).map(q => q.pid),
    unlocked: state.queries.filter(q => q.sql.startsWith('SELECT pg_advisory_unlock')).map(q => q.pid) });
  process.on('message', async message => {
    try {
      let result;
      if (message.command === 'initialize') {
        assert(!pool);
        pool = await guardedPool(2); state = {}; mode = message.options.mode || 'normal';
        state.afterQuery = async ({ sql, client, result: queryResult }) => {
          if (sql.startsWith('SELECT pg_try_advisory_lock') && queryResult.rows[0].locked) identity = client.processID;
          if (sql.startsWith('UPDATE calendar_publication_snapshot SET events =')) {
            if (mode === 'hold-transaction') { identity = client.processID; await hold('transaction'); }
            if (mode === 'fail-transaction') throw Error('SYNTHETIC_PUBLICATION_FAILURE');
          }
        };
        f = fixture(observedPool(pool, state), { env: message.options.env, now: message.options.now });
        f.pages = async (url, options) => {
          // The refresh lock is held throughout this synthetic upstream barrier.
          if (mode === 'hold-scan') {
            identity = state.queries.find(q => q.sql.startsWith('UPDATE calendar_publication_snapshot SET refresh_status')).pid;
            await hold('scan', options.signal);
          }
          if (mode === 'rate-limit') return Response.json({ error_extra: { retry_after: 900 } }, { status: 429 });
          if (mode === 'upstream-failure') return Response.json({ private: 'PRIVATE-UPSTREAM' }, { status: 500 });
          return { results: message.options.empty ? [] : [task({ id: message.options.eventId || 'cal06cWorker' })], next_cursor: null };
        };
        result = { ready: true };
      } else if (message.command === 'refresh') {
        result = { refresh: await f.app.refresh(), stats: stats() };
      } else if (message.command === 'read') result = await f.app.readPublic();
      else if (message.command === 'decrypt') {
        const value = await f.app.auth.getAccessToken();
        result = { syntheticTokenValid: value.token.startsWith('cal06b-synthetic-access-') };
      } else if (message.command === 'resume') { resume?.(); result = { resumed: true }; }
      else if (message.command === 'cancel') { await f.app.stop(); result = { stopped: true }; }
      else if (message.command === 'shutdown') {
        terminating = true; resume?.(); if (f) await f.app.stop(); if (pool) await endPool(pool);
        result = { stopped: true };
      } else throw Error('UNSUPPORTED_TEST_COMMAND');
      send({ id: message.id, result });
      if (terminating) setImmediate(() => process.disconnect());
    } catch { send({ id: message.id, error: 'TEST_WORKER_FAILED' }); }
  });
  process.on('disconnect', () => { if (!terminating) process.exit(1); });
  process.on('unhandledRejection', () => { send({ event: 'unhandled' }); process.exit(1); });
}

async function main() {
  let pool = await guardedPool(3), passed = 0, f;
  const unhandled = [], measurements = {};
  const rejection = reason => unhandled.push(reason?.code || 'UNHANDLED');
  process.on('unhandledRejection', rejection);
  const run = async (name, work) => {
    try { await work(); passed++; console.log(`PASS ${passed}: ${name}`); }
    catch (error) {
      const line = String(error.stack || '').split('\n').find(value => value.includes('test-calendar-recovery.js:'));
      console.error(`FAIL: ${name}; code=${/^[A-Z0-9_]{1,40}$/.test(error.code || '') ? error.code : 'TEST_FAILURE'}; ${line?.trim() || 'no test line'}`);
      throw Error('CAL06C_TEST_FAILED');
    }
  };
  const snapshot = async () => (await pool.query(`SELECT events, verified_at, published_at, valid_until,
    credential_version, policy_version FROM calendar_publication_snapshot WHERE id = 1`)).rows[0];
  const persisted = async () => ({ snapshot: (await pool.query('SELECT * FROM calendar_publication_snapshot WHERE id = 1')).rows[0],
    credentials: (await pool.query('SELECT * FROM todoist_oauth_credentials WHERE id = 1')).rows[0] });
  const lockOwners = async () => (await pool.query(`SELECT pid FROM pg_locks WHERE locktype = 'advisory'
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = $1`, [NAMESPACE])).rows.map(row => row.pid);
  const noLocks = async () => { await until(async () => (await lockOwners()).length === 0); };
  const seed = async (empty = false) => {
    await pool.query('DELETE FROM calendar_publication_snapshot');
    await pool.query('DELETE FROM todoist_oauth_credentials');
    f = fixture(pool);
    const start = await f.app.auth.beginAuthorization();
    await f.app.auth.completeAuthorization({ state: new URL(start.authorization_url).searchParams.get('state'), code: 'cal06c-synthetic' });
    f.pages = () => ({ results: empty ? [] : [task({ id: 'cal06cBaseline' })], next_cursor: null });
    assert.equal((await f.app.refresh()).status, 'success');
    await noLocks();
  };
  const worker = options => startWorker({ env: f.env, now: BASE_NOW + INTERVAL_MS, ...options });
  const afterWorker = async (options, work) => {
    const instance = await worker(options);
    try { return await work(instance); } finally { await instance.close(); }
  };
  const waitSessionGone = async pid => until(async () => !(await pool.query(
    'SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND datname = $2', [pid, DATABASE])).rows.length);
  const manage = async action => {
    const root = path.join(process.env.LOCALAPPDATA, 'VMPixCalendarTest', 'cal06a-pg17');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'instance.json'), 'utf8'));
    assert.equal(manifest.root, root); assert.equal(manifest.database, DATABASE);
    assert.equal(manifest.host, '127.0.0.1'); assert.equal(manifest.port, 55432);
    assert(['Start', 'Stop', 'Restart'].includes(action));
    // CAL-06A management uses PowerShell 7's Process exit handling. Windows
    // PowerShell 5.1 can report failure after a successful pg_ctl action.
    // Ignore inherited pipes: a background postgres process can keep execFile's
    // captured stdout open after its management process has already exited.
    await new Promise((resolve, reject) => {
      const control = spawn('pwsh.exe',
        ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'manage.ps1'), '-Action', action],
        { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { control.kill(); reject(Error('TEST_MANAGEMENT_TIMEOUT')); }, 35000);
      control.once('error', () => { clearTimeout(timer); reject(Error('TEST_MANAGEMENT_START_FAILED')); });
      control.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('TEST_MANAGEMENT_FAILED')); });
    });
  };
  const restart = async () => {
    const before = (await pool.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started;
    await endPool(pool); await manage('Restart'); pool = await guardedPool(3);
    const after = (await pool.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started;
    assert(after > before); measurements.postgresRestarts = (measurements.postgresRestarts || 0) + 1;
  };
  try {
    await run('approved PostgreSQL target and preserved Calendar tables verified before writes', async () => {
      const tables = (await pool.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)).rows.map(row => row.table_name);
      assert.deepEqual(tables, ['calendar_publication_snapshot', 'todoist_oauth_credentials']);
      await noLocks();
    });
    await run('session owns advisory lock across transactions; competing connection cannot unlock it', async () => {
      const state = {}, db = observedPool(pool, state);
      let owner;
      assert.equal(await withDbLock(db, 1, async client => {
        owner = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await client.query('BEGIN'); await client.query('COMMIT');
        assert.deepEqual(await lockOwners(), [owner]);
        const competitor = await pool.connect();
        try {
          assert.notEqual(competitor.processID, owner);
          assert.equal((await competitor.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [NAMESPACE, 1])).rows[0].acquired, false);
          assert.equal((await competitor.query('SELECT pg_advisory_unlock($1,$2) AS released', [NAMESPACE, 1])).rows[0].released, false);
          assert.deepEqual(await lockOwners(), [owner]);
        } finally { competitor.release(); }
        return 'owned';
      }), 'owned');
      assert.equal(state.queries.find(q => q.sql.startsWith('SELECT pg_advisory_unlock')).pid, owner);
      await noLocks();
      assert.equal(await withDbLock(pool, 1, async () => 'next owner'), 'next owner');
      await noLocks();
    });
    await run('failed operation releases its session lock and permits a subsequent owner', async () => {
      await assert.rejects(withDbLock(pool, 1, async () => { throw Error('SYNTHETIC_OPERATION_FAILURE'); }), error => error.code === 'DATABASE');
      await noLocks();
      assert.equal(await withDbLock(pool, 1, async () => true), true);
    });
    await run('separate refresh processes serialize one publication; competitor cannot renew freshness', async () => {
      await seed(); const before = await snapshot();
      const first = await worker({ mode: 'hold-transaction', eventId: 'cal06cWinner' });
      const second = await worker({ eventId: 'cal06cLoser' });
      try {
        assert.notEqual(first.pid, second.pid);
        const pending = first.call('refresh'); const held = await first.held();
        assert.deepEqual(await lockOwners(), [held.pid]);
        const competing = await second.call('refresh');
        assert.equal(competing.refresh.status, 'busy'); assert.equal(competing.stats.taskCalls, 0); assert.equal(competing.stats.updates, 0);
        assert.deepEqual(await snapshot(), before);
        await first.call('resume'); const winner = await pending;
        assert.equal(winner.refresh.status, 'success'); assert.equal(winner.stats.taskCalls, 1); assert.equal(winner.stats.updates, 1);
        assert.deepEqual(winner.stats.transactions, ['BEGIN', 'COMMIT']);
        assert.deepEqual(winner.stats.acquired, winner.stats.unlocked.slice().reverse());
        const committed = await snapshot();
        assert.equal(committed.events[0].event_id, 'cal06cWinner');
        const later = await second.call('refresh'); assert.equal(later.refresh.status, 'waiting');
        assert.equal(later.stats.taskCalls, 0); assert.deepEqual(await snapshot(), committed);
      } finally { await first.close(); await second.close(); }
      await noLocks();
    });
    await run('failed publication rolls back, persists cadence, and a new worker recovers when due', async () => {
      await seed(); const before = await snapshot();
      await afterWorker({ mode: 'fail-transaction' }, async instance => {
        const result = await instance.call('refresh'); assert.equal(result.refresh.status, 'failed');
        assert.deepEqual(result.stats.transactions, ['BEGIN', 'ROLLBACK']);
      });
      assert.deepEqual(await snapshot(), before); await noLocks();
      await afterWorker({}, async instance => {
        const result = await instance.call('refresh'); assert.equal(result.refresh.status, 'waiting'); assert.equal(result.stats.taskCalls, 0);
      });
      await afterWorker({ now: BASE_NOW + 2 * INTERVAL_MS, eventId: 'cal06cRecovery' }, async instance => {
        assert.equal((await instance.call('refresh')).refresh.status, 'success');
      });
      assert.equal((await snapshot()).events[0].event_id, 'cal06cRecovery');
    });
    for (const mode of ['hold-scan', 'hold-transaction']) {
      await run(`terminated worker during ${mode} releases lock and preserves committed snapshot`, async () => {
        await seed(); const before = await snapshot(); const instance = await worker({ mode });
        try {
          const pending = instance.call('refresh'); const held = await instance.held();
          assert.deepEqual(await snapshot(), before);
          await instance.kill(); await assert.rejects(pending);
          await waitSessionGone(held.pid); await noLocks();
          assert.deepEqual(await snapshot(), before);
        } finally { await instance.kill(); }
        await afterWorker({}, async next => {
          const result = await next.call('refresh'); assert.equal(result.refresh.status, 'waiting'); assert.equal(result.stats.taskCalls, 0);
        });
        await afterWorker({ now: BASE_NOW + 2 * INTERVAL_MS }, async next => {
          assert.equal((await next.call('refresh')).refresh.status, 'success');
        });
      });
    }
    await run('terminated database session cannot resume and overwrite a newer worker publication', async () => {
      await seed(); const old = await worker({ mode: 'hold-scan', eventId: 'cal06cObsolete' });
      try {
        const pending = old.call('refresh'); const held = await old.held();
        const result = await pool.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
          WHERE pid = $1 AND datname = $2 AND usename = $3 AND application_name = 'vmpix-calendar-isolated-test'
          AND pid <> pg_backend_pid()`, [held.pid, DATABASE, ROLE]);
        assert.equal(result.rows[0]?.terminated, true); await waitSessionGone(held.pid); await noLocks();
        await afterWorker({ now: BASE_NOW + 2 * INTERVAL_MS, eventId: 'cal06cNewer' }, async next => {
          assert.equal((await next.call('refresh')).refresh.status, 'success');
        });
        const newer = await snapshot(); await old.call('resume');
        assert.equal((await pending).refresh.status, 'failed'); assert.deepEqual(await snapshot(), newer);
        assert.equal(newer.events[0].event_id, 'cal06cNewer');
      } finally { await old.close(); }
    });
    await run('graceful cancellation aborts synthetic upstream work and releases the refresh lock', async () => {
      await seed(); const before = await snapshot();
      await afterWorker({ mode: 'hold-scan' }, async instance => {
        const pending = instance.call('refresh'); await instance.held();
        await instance.call('cancel'); const result = await pending;
        assert.equal(result.refresh.status, 'failed'); assert.equal(result.stats.updates, 0);
      });
      assert.deepEqual(await snapshot(), before); await noLocks();
    });
    await run('real pool exhaustion bounds three HTTP requests; late checkouts run no SQL and release exactly once', async () => {
      await seed(); const testPool = await guardedPool(1);
      // Match the shared pool's unbounded driver acquisition, ONLY on this guarded
      // test pool. Otherwise its own 3000ms timeout could mask the Calendar fix.
      testPool.options.connectionTimeoutMillis = 0;
      const state = {}, local = fixture(observedPool(testPool, state), { env: f.env });
      const http = await httpHarness(local.app); let occupied = await testPool.connect();
      try {
        const responses = await Promise.all([http.read(), http.read(), http.read()]);
        measurements.acquisitionMs = responses.map(result => result.elapsedMs);
        for (const result of responses) {
          assertPublic(result, 'unavailable'); assert(result.elapsedMs >= 2900 && result.elapsedMs < 5000);
        }
        assert.equal(testPool.waitingCount, 3); assert.equal(state.queries.length, 0);
        occupied.release(); occupied = null;
        await until(() => state.checkouts.length === 3 && state.checkouts.every(c => c.releases === 1));
        assert.equal(state.queries.length, 0); assert.equal(testPool.waitingCount, 0);
        assert.equal(testPool.totalCount, 1); assert.equal(testPool.idleCount, 1);
        assertPublic(await http.read(), 'ready');
        assert.equal(state.queries.length, 1); assert.equal(state.queries[0].timeout, 3000);
        assert(state.checkouts.every(c => c.releases === 1));
        assert.equal(local.requests.length, 0);
      } finally { occupied?.release(); await http.close(); await local.app.stop(); await endPool(testPool); }
    });
    await run('independent 3000ms SQL execution timeout survives real table contention and recovers', async () => {
      await seed(); const testPool = await guardedPool(1), state = {};
      const local = fixture(observedPool(testPool, state), { env: f.env }), http = await httpHarness(local.app);
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN'); await blocker.query('LOCK TABLE calendar_publication_snapshot IN ACCESS EXCLUSIVE MODE');
        const result = await http.read(); measurements.queryTimeoutMs = result.elapsedMs;
        assertPublic(result, 'unavailable'); assert(result.elapsedMs >= 2900 && result.elapsedMs < 5000);
        assert.equal(state.queries[0].timeout, 3000); assert.equal(state.checkouts[0].releases, 1);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      try { assertPublic(await http.read(), 'ready'); assert(state.checkouts.every(c => c.releases === 1)); }
      finally { await http.close(); await local.app.stop(); await endPool(testPool); }
    });
    await run('database stop/start and worker restart preserve fresh publication, credentials, and schedule', async () => {
      await seed(); const before = await persisted();
      const startTime = (await pool.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started;
      const dynamicDb = { connect: () => pool.connect() };
      const local = fixture(dynamicDb, { env: f.env }), http = await httpHarness(local.app);
      try {
        assertPublic(await http.read(), 'ready');
        await endPool(pool); await manage('Stop');
        assertPublic(await http.read(), 'unavailable');
        await manage('Start'); pool = await guardedPool(3);
        assert((await pool.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started > startTime);
        measurements.postgresRestarts = (measurements.postgresRestarts || 0) + 1;
        assert.deepEqual(await persisted(), before);
        assertPublic(await http.read(), 'ready');
        await afterWorker({ now: BASE_NOW + 1000 }, async instance => {
          assertPublic(await instance.call('read'), 'ready');
          assert.equal((await instance.call('decrypt')).syntheticTokenValid, true);
          const result = await instance.call('refresh'); assert.equal(result.refresh.status, 'waiting');
          assert.equal(result.refresh.delay, INTERVAL_MS - 1000); assert.equal(result.stats.taskCalls, 0);
        });
        assert.deepEqual(await persisted(), before);
      } finally { await http.close(); await local.app.stop(); }
    });
    await run('verified empty publication survives PostgreSQL and worker restart without a new scan', async () => {
      await seed(true); const before = await persisted(); await restart();
      assert.deepEqual(await persisted(), before);
      await afterWorker({ now: BASE_NOW + 1000 }, async instance => {
        assertPublic(await instance.call('read'), 'empty');
        const result = await instance.call('refresh'); assert.equal(result.refresh.status, 'waiting'); assert.equal(result.stats.taskCalls, 0);
      });
    });
    await run('body-only 900-second backoff persists through database and process restarts with exact deadline', async () => {
      await seed(); const before = await snapshot();
      await afterWorker({ mode: 'rate-limit' }, async instance => {
        const result = await instance.call('refresh'); assert.equal(result.refresh.code, 'RATE_LIMIT');
        assert.equal(result.refresh.delay, 900000); assert.equal(result.stats.taskCalls, 1);
      });
      const stored = await persisted(); assert.deepEqual(await snapshot(), before);
      const errorTime = BASE_NOW + INTERVAL_MS;
      assert.equal(stored.snapshot.next_attempt_at.getTime(), errorTime + 900000);
      await restart(); assert.deepEqual(await persisted(), stored);
      for (const elapsed of [0, 300000, 899999]) {
        await afterWorker({ now: errorTime + elapsed }, async instance => {
          assertPublic(await instance.call('read'), 'stale');
          const result = await instance.call('refresh'); assert.equal(result.refresh.status, 'waiting');
          assert.equal(result.refresh.delay, 900000 - elapsed); assert.equal(result.stats.taskCalls, 0);
        });
      }
      assert.deepEqual(await snapshot(), before);
      await afterWorker({ now: errorTime + 900000, eventId: 'cal06cAfterBackoff' }, async instance => {
        assert.equal((await instance.call('refresh')).refresh.status, 'success'); assertPublic(await instance.call('read'), 'ready');
      });
      assert.equal((await snapshot()).events[0].event_id, 'cal06cAfterBackoff');
      measurements.providerBackoffMs = 900000;
    });
    await run('PostgreSQL restart during an open publication transaction rolls back and releases session locks', async () => {
      await seed(); const before = await snapshot(); const instance = await worker({ mode: 'hold-transaction' });
      try {
        const pending = instance.call('refresh'); await instance.held();
        await restart(); assert.deepEqual(await snapshot(), before); await noLocks();
        await instance.call('resume'); assert.equal((await pending).refresh.status, 'failed');
        assert.deepEqual(await snapshot(), before);
      } finally { await instance.close(); }
      await afterWorker({ now: BASE_NOW + 2 * INTERVAL_MS }, async next => {
        assert.equal((await next.call('refresh')).refresh.status, 'success'); assertPublic(await next.call('read'), 'ready');
      });
    });
    await run('all workers, HTTP servers, locks, clients, and temporary fixture rows are cleaned up', async () => {
      await noLocks(); assert.equal(workers.size, 0); assert.equal(servers.size, 0);
      assert.equal(pool.waitingCount, 0); assert.equal(pool.totalCount, pool.idleCount);
      const databaseClients = (await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname = $1
        AND usename = $2`, [DATABASE, ROLE])).rows;
      assert.equal(databaseClients.length, pool.totalCount, 'No orphaned worker sessions may remain');
      assert.equal(unhandled.length, 0);
      await pool.query('DELETE FROM calendar_publication_snapshot'); await pool.query('DELETE FROM todoist_oauth_credentials');
    });
    console.log(JSON.stringify({ passed, failed: 0, database: DATABASE, postgres: '17.11',
      realDatabase: true, separateWorkerProcesses: true, todoist: 'synthetic responses only', measurements,
      retained: 'unchanged Calendar schema; empty synthetic tables', productionAccess: false }));
  } finally {
    for (const instance of [...workers]) await instance.kill();
    for (const server of [...servers]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const active of [...pools]) await endPool(active);
    process.removeListener('unhandledRejection', rejection);
  }
}

if (require.main === module) {
  if (process.argv.includes('--worker')) workerMain().catch(() => process.exit(1));
  else main().catch(() => { console.error('CAL06C_STOPPED: see named check; production fallback is forbidden.'); process.exitCode = 1; });
}
