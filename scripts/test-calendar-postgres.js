'use strict';

// CAL-06B: real PostgreSQL, synthetic Todoist only. Run through CAL-06A manage.ps1
// -Action Check -TestScript <this file>. Never load .env, db.js, or server.js.
// Only the two allowlisted Calendar tables in the exact disposable database may
// be created/reset. No worker-concurrency, exhaustion, or production tests here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { testConfig, openTestDatabase } = require('./calendar-test-db');
const { createCalendar, EVENT_KEYS, INTERVAL_MS, POLICY_VERSION } = require('../todoist-calendar');
const { PROJECT_ID } = require('../todoist-auth');

const TABLES = ['calendar_publication_snapshot', 'todoist_oauth_credentials'];
const BASE_NOW = Date.parse('2026-10-01T12:00:00Z');
const task = (overrides = {}) => ({ id: 'cal06bA', project_id: PROJECT_ID,
  content: 'Synthetic Calendar Concert', checked: false, is_deleted: false,
  parent_id: null, labels: ['public-confirmed'],
  due: { date: '2026-11-14', timezone: null, is_recurring: false },
  description: 'Location: Synthetic Hall, Example City\nPrivate: PRIVATE-NOTE\nPublic: Synthetic public description.',
  assignee_id: 'PRIVATE-ASSIGNEE', comments: ['PRIVATE-COMMENT'], ...overrides });

function calendarSchema() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  return TABLES.map(name => {
    const matches = [...source.matchAll(new RegExp(`^CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?^\\);`, 'gm'))];
    assert.equal(matches.length, 1, 'Calendar DDL must be uniquely isolatable');
    assert.equal((matches[0][0].match(/;/g) || []).length, 1, 'Only one CREATE statement is allowed');
    return matches[0][0];
  });
}

// All queries still execute on real pg clients. The optional hook injects a
// failure or performs a committed-data read between UPDATE and COMMIT. It never
// supplies fake database results or starts a second refresh worker.
function observedDatabase(pool, state) {
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        on: (...args) => client.on(...args),
        once: (...args) => client.once(...args),
        removeListener: (...args) => client.removeListener(...args),
        release: (...args) => client.release(...args),
        async query(args, values) {
          const sql = (typeof args === 'string' ? args : args.text).replace(/\s+/g, ' ').trim();
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) state.transactions.push(sql);
          const result = await client.query(args, values);
          if (sql.startsWith('UPDATE calendar_publication_snapshot SET events =') && state.afterReplacement) {
            const hook = state.afterReplacement;
            state.afterReplacement = null;
            await hook(client);
          }
          return result;
        }
      };
    }
  };
}

function fixture(db, { env: suppliedEnv, now: initialNow = BASE_NOW } = {}) {
  let now = initialNow, tokenSequence = 0;
  const f = { logs: [], requests: [], pages: () => ({ results: [task()], next_cursor: null }),
    now: () => now, advance: ms => { now += ms; } };
  // Explicit injected configuration, never inherited production configuration.
  // This inert URL only satisfies configured-state validation; db is the guarded
  // test pool. Encryption keys/tokens are synthetic and are never logged.
  const env = suppliedEnv || { TODOIST_CALENDAR_ENABLED: '1', TODOIST_CALENDAR_PUBLIC_ENABLED: 'true', DATABASE_URL: 'postgres://fixture.invalid/not-connected',
    TODOIST_CLIENT_ID: 'cal06b-synthetic-client', TODOIST_CLIENT_SECRET: 'cal06b-synthetic-secret',
    TODOIST_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    TODOIST_REDIRECT_URI: 'https://fixture.invalid/api/calendar/oauth/callback', NODE_ENV: 'test' };
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    f.requests.push(url.pathname); // No authorization headers, bodies, or credentials.
    if (url.href === 'https://api.todoist.com/oauth/access_token') {
      assert.equal(options.method, 'POST');
      tokenSequence += 1;
      return Response.json({ access_token: `cal06b-synthetic-access-${tokenSequence}`,
        refresh_token: `cal06b-synthetic-refresh-${tokenSequence}`,
        token_type: 'Bearer', scope: 'data:read', expires_in: 86400 });
    }
    assert.equal(url.origin, 'https://api.todoist.com');
    assert.equal(url.pathname, '/api/v1/tasks');
    assert.equal(url.searchParams.get('project_id'), PROJECT_ID);
    assert.equal(url.searchParams.get('limit'), '50');
    const body = await f.pages(url, options);
    return body instanceof Response ? body : Response.json(body);
  };
  f.app = createCalendar({ db, env, fetchImpl, clock: f.now,
    logger: { info: (...args) => f.logs.push(args) },
    setTimer: () => { throw Error('BACKGROUND_SCHEDULER_NOT_ALLOWED'); }, clearTimer: () => {} });
  // start() is deliberately never called; only explicitly requested test refreshes.
  f.env = env; // CAL-06C shares only this synthetic configuration with test workers.
  return f;
}

async function main() {
  const config = testConfig(); // Reject absent/remote configuration before connecting.
  assert.equal(config.database, 'vmpix_calendar_test_7b2545df');
  assert.equal(config.user, 'cal06a_owner_7b2545df');
  const ddl = calendarSchema(); // Refuse ambiguous DDL before any mutation.
  const { pool, identity } = await openTestDatabase();
  let server, poolEnded = false, f, passed = 0;
  const state = { transactions: [], afterReplacement: null };
  const db = observedDatabase(pool, state);
  const run = async (name, work) => {
    try { await work(); passed += 1; console.log(`PASS ${passed}: ${name}`); }
    catch (error) {
      // Assertions can contain rows/tokens. Report only a safe code and stack line.
      const line = String(error.stack || '').split('\n').find(item => item.includes('test-calendar-postgres.js:'));
      console.error(`FAIL: ${name}; code=${/^[A-Z0-9_]{1,40}$/.test(error.code || '') ? error.code : 'TEST_FAILURE'}; ${line?.trim() || 'no test line'}`);
      throw Error('CAL06B_TEST_FAILED');
    }
  };
  const tables = async () => (await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)).rows.map(row => row.table_name);
  const applySchema = async () => { for (const statement of ddl) await pool.query(statement); };
  const snapshot = async () => (await pool.query(`SELECT events, verified_at, published_at, valid_until,
    credential_version, policy_version FROM calendar_publication_snapshot WHERE id = 1`)).rows[0];
  const resetRows = async () => {
    await pool.query('DELETE FROM calendar_publication_snapshot');
    await pool.query('DELETE FROM todoist_oauth_credentials');
  };
  const rejectsSql = async (text, values, code) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(client.query(text, values), error => error.code === code);
    } finally { await client.query('ROLLBACK'); client.release(); }
  };
  let httpAddress;
  const httpRead = async () => {
    const before = f.requests.length;
    const response = await fetch(`${httpAddress}/api/calendar`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    assert.equal(f.requests.length, before, 'Public reads must never call Todoist');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const serialized = JSON.stringify(body);
    for (const privateValue of ['PRIVATE-', 'synthetic-access', 'synthetic-refresh', 'encrypted_tokens',
      'credential_version', 'postgres:', 'SELECT ', 'UPDATE ', 'assignee_id', 'project_id']) assert(!serialized.includes(privateValue));
    return { status: response.status, cache: response.headers.get('cache-control'), body };
  };
  const freshPublication = async tasks => {
    f.advance(INTERVAL_MS);
    f.pages = () => ({ results: tasks, next_cursor: null });
    const result = await f.app.refresh();
    assert.equal(result.status, 'success');
    return result;
  };
  try {
    await run('exact isolated PostgreSQL 17.11 target and restricted role verified before DDL', async () => {
      assert.equal(identity.version_num, 170011);
      assert.equal(identity.database, config.database);
      assert.equal(identity.host, '127.0.0.1');
      assert.equal(identity.port, 55432);
      assert((await tables()).every(name => TABLES.includes(name)), 'No unrelated application tables permitted');
    });
    await run('only the two Calendar CREATE TABLE statements apply successfully', async () => {
      await applySchema();
      assert.deepEqual(await tables(), TABLES);
    });
    await run('runtime column types, nullability, primary keys, and CHECK constraints match', async () => {
      const expected = {
        calendar_publication_snapshot: ['id:int2:NO', 'events:jsonb:NO', 'verified_at:timestamptz:YES',
          'published_at:timestamptz:YES', 'valid_until:timestamptz:YES', 'credential_version:uuid:YES',
          'policy_version:text:YES', 'attempt_started_at:timestamptz:YES', 'attempt_credential_version:uuid:YES',
          'next_attempt_at:timestamptz:YES', 'refresh_status:text:NO', 'last_error_code:text:YES'],
        todoist_oauth_credentials: ['id:int2:NO', 'encrypted_tokens:text:YES', 'access_expires_at:timestamptz:YES',
          'scope:text:YES', 'configuration_id:text:YES', 'credential_version:uuid:YES', 'blocked:bool:NO',
          'refresh_in_progress:bool:NO', 'last_error_code:text:YES', 'oauth_state_hash:text:YES',
          'oauth_state_expires_at:timestamptz:YES', 'pending_authorization:text:YES', 'updated_at:timestamptz:NO']
      };
      for (const name of TABLES) {
        const columns = (await pool.query(`SELECT column_name, udt_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [name])).rows;
        assert.deepEqual(columns.map(c => `${c.column_name}:${c.udt_name}:${c.is_nullable}`), expected[name]);
        const constraints = (await pool.query(`SELECT contype, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint WHERE conrelid = $1::regclass`, [name])).rows;
        assert.equal(constraints.filter(c => c.contype === 'p' && c.definition === 'PRIMARY KEY (id)').length, 1);
        assert.equal(constraints.filter(c => c.contype === 'c').length, name === TABLES[0] ? 4 : 3);
        const indexes = (await pool.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', ['public', name])).rows;
        assert.equal(indexes.length, 1);
        assert(indexes[0].indexdef.includes('UNIQUE INDEX') && indexes[0].indexdef.includes('(id)'));
      }
    });
    await run('repeated schema application preserves table identity, defaults, and existing rows', async () => {
      await resetRows();
      await pool.query('INSERT INTO calendar_publication_snapshot (id) VALUES (1)');
      await pool.query('INSERT INTO todoist_oauth_credentials (id) VALUES (1)');
      const oids = async () => (await pool.query('SELECT $1::regclass::oid AS snapshot, $2::regclass::oid AS credentials', TABLES)).rows[0];
      const before = await oids();
      await applySchema();
      assert.deepEqual(await oids(), before);
      assert.deepEqual((await snapshot()).events, []);
      assert.equal((await pool.query('SELECT refresh_status FROM calendar_publication_snapshot')).rows[0].refresh_status, 'idle');
      const row = (await pool.query('SELECT blocked, refresh_in_progress, updated_at FROM todoist_oauth_credentials')).rows[0];
      assert.equal(row.blocked, false); assert.equal(row.refresh_in_progress, false);
      assert(row.updated_at instanceof Date && Number.isFinite(row.updated_at.getTime()));
    });
    await run('both singleton primary keys reject duplicate, non-singleton, and null IDs', async () => {
      for (const name of TABLES) {
        await rejectsSql(`INSERT INTO ${name} (id) VALUES ($1)`, [1], '23505');
        await rejectsSql(`INSERT INTO ${name} (id) VALUES ($1)`, [2], '23514');
        await rejectsSql(`INSERT INTO ${name} (id) VALUES ($1)`, [null], '23502');
      }
    });
    await run('JSONB, freshness, status, UUID, and timestamp invalid records are rejected', async () => {
      const cases = [
        ['events = $1::jsonb', '{}', '23514'], ['events = $1::jsonb', null, '23502'],
        ['events = $1::jsonb', '{invalid', '22P02'], ['refresh_status = $1', 'unknown', '23514'],
        ['refresh_status = $1', null, '23502'], ['credential_version = $1', 'invalid', '22P02'],
        ['verified_at = $1', 'not-a-timestamp', '22007'],
        ['valid_until = $1', new Date(BASE_NOW), '23514']
      ];
      for (const [assignment, value, code] of cases) await rejectsSql(`UPDATE calendar_publication_snapshot SET ${assignment} WHERE id = 1`, [value], code);
      await rejectsSql('UPDATE calendar_publication_snapshot SET verified_at = $1, valid_until = $1 WHERE id = 1', [new Date(BASE_NOW)], '23514');
      await rejectsSql('UPDATE calendar_publication_snapshot SET verified_at = $1, valid_until = $2 WHERE id = 1', [new Date(BASE_NOW), new Date(BASE_NOW - 1)], '23514');
    });
    await run('credential scope, state hash, and non-null flags enforce existing constraints', async () => {
      for (const [assignment, value, code] of [['scope = $1', 'data:read_write', '23514'],
        ['oauth_state_hash = $1', 'short', '23514'], ['blocked = $1', null, '23502'],
        ['refresh_in_progress = $1', null, '23502'], ['updated_at = $1', null, '23502']]) {
        await rejectsSql(`UPDATE todoist_oauth_credentials SET ${assignment} WHERE id = 1`, [value], code);
      }
    });
    await run('JSONB and zoned timestamps round-trip through PostgreSQL; explicit rollback restores defaults', async () => {
      const before = await snapshot(), client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE calendar_publication_snapshot SET events = $1::jsonb,
          verified_at = $2, valid_until = $3 WHERE id = 1`,
        [JSON.stringify([{ synthetic: true }]), '2026-10-01T08:00:00-04:00', '2026-10-01T08:05:00-04:00']);
        const row = (await client.query('SELECT events, verified_at, valid_until FROM calendar_publication_snapshot')).rows[0];
        assert.deepEqual(row.events, [{ synthetic: true }]);
        assert.equal(row.verified_at.toISOString(), '2026-10-01T12:00:00.000Z');
        assert.equal(row.valid_until.getTime() - row.verified_at.getTime(), INTERVAL_MS);
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.deepEqual(await snapshot(), before);
    });
    await run('synthetic OAuth ciphertext persists and decrypts through unchanged runtime', async () => {
      await resetRows();
      f = fixture(db);
      assert.equal(f.app.config.configured, true);
      const start = await f.app.auth.beginAuthorization();
      const url = new URL(start.authorization_url);
      assert.equal(url.searchParams.get('scope'), 'data:read');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const pending = (await pool.query('SELECT oauth_state_hash, pending_authorization FROM todoist_oauth_credentials')).rows[0];
      assert.equal(pending.oauth_state_hash.length, 64);
      assert(pending.pending_authorization && !pending.pending_authorization.includes('verifier'));
      await f.app.auth.completeAuthorization({ state: url.searchParams.get('state'), code: 'cal06b-synthetic-code' });
      const row = (await pool.query('SELECT * FROM todoist_oauth_credentials')).rows[0];
      assert(row.encrypted_tokens && !row.encrypted_tokens.includes('synthetic-access') && !row.encrypted_tokens.includes('synthetic-refresh'));
      assert.equal(row.scope, 'data:read'); assert.equal(row.blocked, false);
      assert.equal(row.oauth_state_hash, null); assert.equal(row.pending_authorization, null);
      const credential = await f.app.auth.getAccessToken();
      assert(credential.token.startsWith('cal06b-synthetic-access-'));
      assert.equal(credential.version, row.credential_version);
    });
    await run('isolated HTTP endpoint reports unavailable before any verified publication', async () => {
      const web = express(); web.get('/api/calendar', f.app.publicHandler);
      server = await new Promise((resolve, reject) => {
        const instance = web.listen(0, '127.0.0.1', () => resolve(instance)); instance.once('error', reject);
      });
      httpAddress = `http://127.0.0.1:${server.address().port}`;
      const result = await httpRead();
      assert.equal(result.status, 503); assert.equal(result.body.status, 'unavailable');
      assert.deepEqual(result.body.events, []); assert.equal(result.cache, 'no-store');
    });
    await run('initial approved publication commits exactly eight public event fields', async () => {
      const result = await f.app.refresh();
      assert.equal(result.status, 'success'); assert.equal(result.count, 1); assert.equal(result.delay, INTERVAL_MS);
      const row = await snapshot();
      assert.equal(row.events[0].event_id, 'cal06bA');
      assert.deepEqual(Object.keys(row.events[0]).sort(), [...EVENT_KEYS].sort());
      assert.equal(row.events[0].location, 'Synthetic Hall, Example City');
      assert.equal(row.events[0].description, 'Synthetic public description.');
      assert(!JSON.stringify(row.events).includes('PRIVATE-'));
      assert.equal(row.verified_at.getTime(), f.now()); assert.equal(row.published_at.getTime(), f.now());
      assert.equal(row.valid_until.getTime(), f.now() + INTERVAL_MS);
      assert.equal(row.policy_version, POLICY_VERSION);
      const operational = (await pool.query('SELECT next_attempt_at, refresh_status FROM calendar_publication_snapshot')).rows[0];
      assert.equal(operational.next_attempt_at.getTime(), f.now() + INTERVAL_MS);
      assert.equal(operational.refresh_status, 'idle');
      assert.deepEqual(state.transactions.slice(-2), ['BEGIN', 'COMMIT']);
    });
    await run('real HTTP ready response is snapshot-only, private-field-free, and cached for 30 seconds', async () => {
      const result = await httpRead();
      assert.equal(result.status, 200); assert.equal(result.body.status, 'ready');
      assert.equal(result.body.timezone, 'America/New_York');
      assert.deepEqual(result.body.events, (await snapshot()).events);
      assert.deepEqual(Object.keys(result.body.events[0]).sort(), [...EVENT_KEYS].sort());
      assert.equal(result.body.freshness.age_seconds, 0);
      assert.equal(result.cache, 'public, max-age=30, s-maxage=30, must-revalidate');
    });
    await run('multiple eligible events replace the old snapshot in chronological order', async () => {
      await freshPublication([task({ id: 'cal06bB', due: { date: '2026-11-15T01:00:00Z', is_recurring: false } }), task(),
        task({ id: 'cal06bExcluded', labels: [] })]);
      const row = await snapshot();
      assert.deepEqual(row.events.map(event => event.event_id), ['cal06bA', 'cal06bB']);
      assert.equal(row.events[0].all_day, true); assert.equal(row.events[0].date, '2026-11-14');
      assert.equal(row.events[1].date, '2026-11-14'); assert.equal(row.events[1].start_time, '20:00');
      for (const event of row.events) assert.deepEqual(Object.keys(event).sort(), [...EVENT_KEYS].sort());
    });
    await run('withdrawn approval removes previously published events on a valid replacement scan', async () => {
      await freshPublication([task({ labels: [] }), task({ id: 'cal06bB' })]);
      assert.deepEqual((await snapshot()).events.map(event => event.event_id), ['cal06bB']);
    });
    await run('identical repeated task IDs deduplicate without duplicate public events', async () => {
      await freshPublication([task(), task()]);
      assert.equal((await snapshot()).events.length, 1);
    });
    await run('valid empty scan publishes a fresh empty snapshot and HTTP 200 empty', async () => {
      await freshPublication([]);
      const row = await snapshot(); assert.deepEqual(row.events, []);
      assert.equal(row.verified_at.getTime(), f.now());
      const result = await httpRead();
      assert.equal(result.status, 200); assert.equal(result.body.status, 'empty');
      assert.deepEqual(result.body.events, []); assert(result.cache.startsWith('public, max-age=30'));
    });
    await run('cache lifetime is bounded by remaining freshness; expired publication is 503 stale', async () => {
      f.advance(INTERVAL_MS - 12000);
      let result = await httpRead();
      assert.equal(result.cache, 'public, max-age=12, s-maxage=12, must-revalidate');
      assert.equal(result.body.freshness.age_seconds, 288);
      f.advance(12000); result = await httpRead();
      assert.equal(result.status, 503); assert.equal(result.body.status, 'stale');
      assert.deepEqual(result.body.events, []); assert.equal(result.cache, 'no-store');
    });
    await run('incomplete paginated scan never publishes its first page or renews freshness', async () => {
      await freshPublication([task()]);
      const before = await snapshot(), transactionCount = state.transactions.length;
      f.advance(INTERVAL_MS);
      f.pages = url => url.searchParams.has('cursor') ? Response.json({ private: 'PRIVATE-UPSTREAM' }, { status: 500 }) :
        { results: [task({ id: 'cal06bPartial' })], next_cursor: 'synthetic-next' };
      const result = await f.app.refresh();
      assert.equal(result.status, 'failed'); assert.equal(result.code, 'UPSTREAM');
      assert.deepEqual(await snapshot(), before);
      assert.equal(state.transactions.length, transactionCount);
      const read = await httpRead(); assert.equal(read.body.status, 'stale');
    });
    await run('conflicting duplicate IDs reject the entire scan and preserve the last publication', async () => {
      const before = await snapshot(); f.advance(INTERVAL_MS);
      f.pages = () => ({ results: [task(), task({ content: 'Conflicting synthetic title' })], next_cursor: null });
      const result = await f.app.refresh();
      assert.equal(result.status, 'failed'); assert.equal(result.code, 'INCONSISTENT_SCAN');
      assert.deepEqual(await snapshot(), before);
    });
    await run('failure after real snapshot UPDATE rolls back all publication fields and freshness', async () => {
      const before = await snapshot(); f.advance(INTERVAL_MS);
      f.pages = () => ({ results: [task({ id: 'cal06bAbandoned' })], next_cursor: null });
      let updatedInsideTransaction = false;
      state.afterReplacement = async client => {
        assert.equal((await client.query('SELECT events FROM calendar_publication_snapshot')).rows[0].events[0].event_id, 'cal06bAbandoned');
        updatedInsideTransaction = true;
        throw Error('SYNTHETIC_FAILURE_BEFORE_COMMIT');
      };
      const result = await f.app.refresh();
      assert.equal(result.status, 'failed'); assert(updatedInsideTransaction);
      assert.deepEqual(state.transactions.slice(-2), ['BEGIN', 'ROLLBACK']);
      assert.deepEqual(await snapshot(), before);
    });
    await run('actual PostgreSQL constraint failure inside publication aborts and rolls back the transaction', async () => {
      const before = await snapshot(); f.advance(INTERVAL_MS); let rejectedByPostgres = false;
      state.afterReplacement = async client => {
        try { await client.query("UPDATE calendar_publication_snapshot SET events = '{}'::jsonb WHERE id = 1"); }
        catch (error) { rejectedByPostgres = error.code === '23514'; throw error; }
      };
      const result = await f.app.refresh();
      assert.equal(result.status, 'failed'); assert(rejectedByPostgres);
      assert.deepEqual(state.transactions.slice(-2), ['BEGIN', 'ROLLBACK']);
      assert.deepEqual(await snapshot(), before);
    });
    await run('successful publication recovers after rollback; public reads see only committed data', async () => {
      const before = await snapshot(); let observedUncommitted = false;
      state.afterReplacement = async client => {
        assert.equal((await client.query('SELECT events FROM calendar_publication_snapshot')).rows[0].events[0].event_id, 'cal06bRecovered');
        assert.deepEqual(await snapshot(), before);
        const read = await httpRead();
        assert.equal(read.body.status, 'stale'); assert.deepEqual(read.body.events, []);
        assert.equal(read.body.freshness.verified_at, before.verified_at.toISOString());
        observedUncommitted = true;
      };
      await freshPublication([task({ id: 'cal06bRecovered' })]);
      assert(observedUncommitted);
      const result = await httpRead();
      assert.equal(result.body.status, 'ready'); assert.equal(result.body.events[0].event_id, 'cal06bRecovered');
      assert.equal(result.body.freshness.verified_at, new Date(f.now()).toISOString());
      assert.deepEqual(state.transactions.slice(-2), ['BEGIN', 'COMMIT']);
    });
    await run('explicit rollback of a fresh publication leaves HTTP ready and its timestamp unchanged', async () => {
      const before = await snapshot(), client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE calendar_publication_snapshot SET events = '[]'::jsonb WHERE id = 1");
        const result = await httpRead();
        assert.equal(result.body.status, 'ready'); assert.deepEqual(result.body.events, before.events);
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.deepEqual(await snapshot(), before);
    });
    await run('public boundary withholds corrupted stored events without exposing private fields', async () => {
      const before = await snapshot();
      try {
        await pool.query('UPDATE calendar_publication_snapshot SET events = $1::jsonb WHERE id = 1',
          [JSON.stringify([{ ...before.events[0], private_task_field: 'PRIVATE-FIELD' }])]);
        const result = await httpRead();
        assert.equal(result.status, 503); assert.equal(result.body.status, 'unavailable');
        assert.deepEqual(result.body.events, []); assert.equal(result.cache, 'no-store');
      } finally {
        await pool.query('UPDATE calendar_publication_snapshot SET events = $1::jsonb WHERE id = 1', [JSON.stringify(before.events)]);
      }
      assert.deepEqual(await snapshot(), before);
    });
    await run('only Calendar tables exist; completed tests leave no checked-out clients or sensitive logs', async () => {
      assert.deepEqual(await tables(), TABLES);
      assert.equal(pool.waitingCount, 0); assert.equal(pool.totalCount, pool.idleCount);
      const logs = JSON.stringify(f.logs);
      for (const value of ['PRIVATE-', 'synthetic-access', 'synthetic-refresh', 'SELECT ', 'postgres:']) assert(!logs.includes(value));
      await f.app.stop();
      await resetRows(); // Retain schema but leave no test ciphertext/publication for CAL-06C.
      for (const name of TABLES) assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${name}`)).rows[0].count, 0);
    });
    await run('actual closed PostgreSQL pool produces safe HTTP 503 unavailable with no-store', async () => {
      await pool.end(); poolEnded = true;
      const result = await httpRead();
      assert.equal(result.status, 503); assert.equal(result.body.status, 'unavailable');
      assert.deepEqual(result.body.events, []); assert.equal(result.cache, 'no-store');
    });
    console.log(JSON.stringify({ passed, failed: 0, postgres: identity.version,
      database: identity.database, realPostgres: true, todoist: 'synthetic responses only',
      publicApi: 'isolated loopback HTTP harness', retained: 'two empty Calendar tables',
      concurrencyAndPoolExhaustion: 'not tested; reserved for CAL-06C' }));
  } finally {
    state.afterReplacement = null;
    if (f) await f.app.stop();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (!poolEnded) await pool.end();
  }
}

module.exports = { fixture, task };
if (require.main === module) main().catch(() => {
  console.error('CAL06B_STOPPED: inspect the named check; no production fallback is permitted.');
  process.exitCode = 1;
});
