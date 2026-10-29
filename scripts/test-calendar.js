'use strict';

// Synthetic fixtures only. Never import server.js: its startup applies migrations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { mock } = require('node:test');
const { createCalendar, normalizeTask, normalizeTasks, localInstant, publicDescription } = require('../todoist-calendar');
const { PROJECT_ID, readConfig, requestJson, withDbLock } = require('../todoist-auth');

const BASE_NOW = Date.parse('2026-10-01T12:00:00Z');
const ENV = { TODOIST_CALENDAR_ENABLED: '1', TODOIST_CALENDAR_PUBLIC_ENABLED: 'true',
  DATABASE_URL: 'postgres://fixture.invalid/not-connected',
  TODOIST_CLIENT_ID: 'synthetic-client', TODOIST_CLIENT_SECRET: 'synthetic-client-secret',
  TODOIST_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
  TODOIST_REDIRECT_URI: 'https://fixture.invalid/api/calendar/oauth/callback', NODE_ENV: 'production' };
const task = (overrides = {}) => ({ id: 'taskA', project_id: PROJECT_ID, content: 'Synthetic Concert',
  checked: false, is_deleted: false, parent_id: null, labels: ['public-confirmed'],
  due: { date: '2026-11-14', timezone: null, is_recurring: false },
  description: 'Location: Test Hall — Example City, NY\nPrivate: DO-NOT-PUBLISH\nPublic: Doors open before the performance.',
  assignee_id: 'PRIVATE-ASSIGNEE', comments: ['PRIVATE-COMMENT'], ...overrides });

class MockDb {
  constructor() { this.snapshot = null; this.credential = null; this.locks = new Map(); this.calls = []; this.fail = null; }
  async connect() {
    if (this.connectFailure) throw Error('PRIVATE DATABASE FAILURE');
    const client = new EventEmitter();
    client.query = args => this.execute(args, client);
    client.release = destroy => { if (destroy) for (const [key, owner] of this.locks) if (owner === client) this.locks.delete(key); };
    return client;
  }
  async query(args) { return this.execute(args); }
  async execute(args, client) {
    const sql = (typeof args === 'string' ? args : args.text).replace(/\s+/g, ' ').trim();
    const p = args.values || [];
    this.calls.push({ sql, p });
    if (this.fail?.(sql, p)) throw Error('PRIVATE DATABASE FAILURE WITH SECRET');
    const rows = value => ({ rows: value });
    if (sql.startsWith('SELECT pg_try_advisory_lock')) {
      if (this.locks.has(p[1])) return rows([{ locked: false }]);
      this.locks.set(p[1], client); return rows([{ locked: true }]);
    }
    if (sql.startsWith('SELECT pg_advisory_unlock')) { this.locks.delete(p[1]); return rows([{}]); }
    if (sql === 'BEGIN') { client.before = structuredClone(this.snapshot); return rows([]); }
    if (sql === 'COMMIT') { client.before = null; return rows([]); }
    if (sql === 'ROLLBACK') { this.snapshot = client.before; client.before = null; return rows([]); }
    if (sql.startsWith('SELECT * FROM todoist_oauth_credentials')) return rows(this.credential ? [structuredClone(this.credential)] : []);
    if (sql.startsWith('INSERT INTO todoist_oauth_credentials')) {
      this.credential ||= { id: 1, encrypted_tokens: null, blocked: false, refresh_in_progress: false, credential_version: null };
      Object.assign(this.credential, { oauth_state_hash: p[0], oauth_state_expires_at: p[1], pending_authorization: p[2] }); return rows([]);
    }
    if (sql.startsWith('UPDATE todoist_oauth_credentials SET oauth_state_hash')) {
      Object.assign(this.credential, { oauth_state_hash: null, oauth_state_expires_at: null, pending_authorization: null }); return rows([]);
    }
    if (sql.startsWith('UPDATE todoist_oauth_credentials SET encrypted_tokens')) {
      Object.assign(this.credential, { encrypted_tokens: p[0], access_expires_at: p[1], scope: 'data:read',
        configuration_id: p[2], credential_version: p[3], blocked: false, refresh_in_progress: false, last_error_code: null }); return rows([]);
    }
    if (sql.startsWith('UPDATE todoist_oauth_credentials SET blocked')) {
      Object.assign(this.credential, { blocked: true, last_error_code: p[0], refresh_in_progress: false }); return rows([]);
    }
    if (sql.startsWith('UPDATE todoist_oauth_credentials SET refresh_in_progress')) {
      this.credential.refresh_in_progress = sql.includes('TRUE'); return rows([]);
    }
    if (sql.startsWith('INSERT INTO calendar_publication_snapshot')) {
      this.snapshot ||= { id: 1, events: [], verified_at: null, published_at: null, next_attempt_at: null,
        attempt_credential_version: null, credential_version: null, refresh_status: 'idle' }; return rows([]);
    }
    if (sql.startsWith('SELECT s.*, c.credential_version')) {
      if (!this.snapshot) return rows([]);
      return rows([{ ...structuredClone(this.snapshot), current_credential_version: this.credential?.credential_version || null,
        credentials_ready: !!this.credential?.encrypted_tokens && !this.credential.blocked && this.credential.configuration_id === p[0] }]);
    }
    if (sql.startsWith('UPDATE calendar_publication_snapshot SET refresh_status')) {
      Object.assign(this.snapshot, { refresh_status: 'running', attempt_started_at: p[0], attempt_credential_version: p[1], next_attempt_at: p[2] }); return rows([]);
    }
    if (sql.startsWith('SELECT credential_version FROM todoist_oauth_credentials')) {
      return rows(this.credential?.credential_version === p[0] && this.credential.configuration_id === p[1] &&
        !this.credential.blocked ? [{ credential_version: p[0] }] : []);
    }
    if (sql.startsWith('UPDATE calendar_publication_snapshot SET events')) {
      Object.assign(this.snapshot, { events: JSON.parse(p[0]), verified_at: p[1], published_at: p[2], valid_until: p[3],
        credential_version: p[4], policy_version: p[5], last_error_code: null, refresh_status: 'idle', next_attempt_at: p[6], attempt_credential_version: p[4] }); return rows([]);
    }
    if (sql.startsWith('UPDATE calendar_publication_snapshot SET last_error_code')) {
      Object.assign(this.snapshot, { last_error_code: p[0], refresh_status: p[1], next_attempt_at: p[2] }); return rows([]);
    }
    throw Error(`Unhandled mock query: ${sql}`);
  }
}

function fixture({ db = new MockDb(), env = ENV } = {}) {
  let now = BASE_NOW, tokenSequence = 0;
  const calls = [], logs = [], timers = new Map();
  const f = { db, calls, logs, timers, pages: () => ({ results: [task()], next_cursor: null }),
    now: () => now, advance: ms => { now += ms; }, setNow: value => { now = Date.parse(value); } };
  f.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/oauth/access_token')) {
      tokenSequence++;
      if (f.tokenResponse) return f.tokenResponse(url, options);
      return Response.json({ access_token: `synthetic-access-${tokenSequence}`, refresh_token: `synthetic-refresh-${tokenSequence}`,
        token_type: 'Bearer', scope: 'data:read', expires_in: 3600 });
    }
    const response = await f.pages(new URL(url), options);
    return response instanceof Response ? response : Response.json(response);
  };
  f.app = createCalendar({ db, env, fetchImpl: f.fetch, clock: f.now, logger: { info: (...args) => logs.push(args) },
    setTimer: (fn, delay) => { const key = { unref() {} }; timers.set(key, { fn, delay }); return key; }, clearTimer: key => timers.delete(key) });
  f.authorize = async () => {
    const start = await f.app.auth.beginAuthorization();
    const url = new URL(start.authorization_url);
    assert.equal(url.searchParams.get('scope'), 'data:read');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    await f.app.auth.completeAuthorization({ state: url.searchParams.get('state'), code: 'synthetic-code' });
    return url;
  };
  return f;
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const taskCalls = f => f.calls.filter(call => new URL(call.url).pathname === '/api/v1/tasks');

test('exact project + explicit approval; every exclusion fails closed', () => {
  assert(normalizeTask(task(), BASE_NOW));
  for (const change of [{ project_id: 'other-project' }, { labels: [] }, { labels: ['PUBLIC-CONFIRMED'] },
    ...['draft', 'tentative', 'cancelled', 'Cancelled'].map(label => ({ labels: ['public-confirmed', label] })),
    { checked: true }, { checked: undefined }, { completed_at: '2026-09-01T00:00:00Z' }, { is_completed: true },
    { is_deleted: true }, { is_deleted: undefined }, { parent_id: 'parent' }, { parent_id: undefined },
    { content: '' }, { id: 'tmp-placeholder' }, { labels: [42, 'public-confirmed'] }, { due: null },
    { due: { date: '2026-11-14', is_recurring: true } }, { due: { date: '2026-11-14' } }]) {
    assert.equal(normalizeTask(task(change), BASE_NOW), null, JSON.stringify(change));
  }
  assert.equal(normalizeTask(null, BASE_NOW), null);
});

test('public fields only, bounded single-line descriptions and missing values', () => {
  const result = normalizeTask(task(), BASE_NOW).event;
  assert.deepEqual(Object.keys(result).sort(), ['event_id', 'title', 'date', 'start_time', 'all_day', 'location', 'status', 'description'].sort());
  assert.equal(result.location, 'Test Hall — Example City, NY');
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert(!JSON.stringify(result).includes('DO-NOT-PUBLISH'));
  assert.deepEqual(publicDescription('Location: one\nLocation: two\nPublic: visible\nnot public'), { location: null, description: 'visible' });
  assert.deepEqual(publicDescription(null), { location: null, description: null });
  assert.equal(normalizeTask(task({ description: 'private notes only' }), BASE_NOW).event.description, null);
});

test('NY all-day boundaries, past events, malformed dates and floating times', () => {
  const t = task({ due: { date: '2026-10-01', is_recurring: false } });
  assert(normalizeTask(t, Date.parse('2026-10-02T03:59:59Z')));
  assert.equal(normalizeTask(t, Date.parse('2026-10-02T04:00:00Z')), null);
  for (const date of ['2026-02-30', '2026-13-01', '2026-11-01T25:00', 'yesterday', '2026-00-00', '2026-10-01T10:60'])
    assert.equal(normalizeTask(task({ due: { date, is_recurring: false } }), BASE_NOW), null);
  const timed = normalizeTask(task({ due: { date: '2026-10-01T18:30:00', timezone: null, is_recurring: false } }), BASE_NOW);
  assert.equal(timed.timing.instant, Date.parse('2026-10-01T22:30:00Z'));
  assert.equal(timed.event.start_time, '18:30');
  assert.equal(normalizeTask(task({ due: { date: '2026-10-01T08:00:00', is_recurring: false } }), BASE_NOW), null);
});

test('DST gap/fold withheld; fixed instants convert without shifting all-day dates', () => {
  assert.equal(localInstant('2026-03-08', '02:30'), null);
  assert.equal(localInstant('2026-11-01', '01:30'), null);
  assert.equal(localInstant('2026-03-08', '03:30'), Date.parse('2026-03-08T07:30:00Z'));
  const fixed = normalizeTask(task({ due: { date: '2026-11-01T06:30:00Z', timezone: 'America/New_York', is_recurring: false } }), BASE_NOW);
  assert.equal(fixed.event.date, '2026-11-01'); assert.equal(fixed.event.start_time, '01:30');
  const midnight = normalizeTask(task({ due: { date: '2026-10-02T02:30:00Z', is_recurring: false } }), BASE_NOW);
  assert.equal(midnight.event.date, '2026-10-01'); assert.equal(midnight.event.start_time, '22:30');
});

test('chronological order with all-day first and stable ID tie-break', () => {
  const dates = [['later', '2026-12-01'], ['timedB', '2026-11-14T20:00:00'], ['day', '2026-11-14'], ['timedA', '2026-11-14T20:00:00']];
  assert.deepEqual(normalizeTasks(dates.map(([id, date]) => task({ id, due: { date, is_recurring: false } })), BASE_NOW)
    .map(item => item.event.event_id), ['day', 'timedA', 'timedB', 'later']);
});

test('disabled/missing configuration is unavailable without database or network work', async () => {
  for (const env of [{}, { ...ENV, TODOIST_CALENDAR_ENABLED: '0' }, { ...ENV, TODOIST_TOKEN_ENCRYPTION_KEY: 'bad' },
    { ...ENV, TODOIST_REDIRECT_URI: 'http://example.com/api/calendar/oauth/callback' },
    { ...ENV, TODOIST_REDIRECT_URI: ENV.TODOIST_REDIRECT_URI + '?redirect=evil' }]) {
    const f = fixture({ env });
    assert.equal((await f.app.readPublic()).httpStatus, 503);
    assert.equal((await f.app.refresh()).status, 'disabled'); f.app.start();
    assert.equal(f.calls.length, 0); assert.equal(f.db.calls.length, 0); assert.equal(f.timers.size, 0);
  }
  assert(readConfig(ENV).configured);
});

test('CAL-08: both flags default off; public exposure requires an explicit value and the master', async () => {
  const defaults = fixture({ env: {} });
  assert.equal(defaults.app.config.enabled, false); assert.equal(defaults.app.config.publicEnabled, false);
  for (const value of [undefined, '', 'false', '0', 'yes', 'TRUE', ' true ', true, 1]) {
    const f = fixture({ env: { ...ENV, TODOIST_CALENDAR_PUBLIC_ENABLED: value } });
    assert.equal(f.app.config.configured, true); assert.equal(f.app.config.publicEnabled, false);
    let acquisitions = 0;
    f.db.connect = () => { acquisitions++; throw Error('Public-disabled reads must never acquire a connection'); };
    const result = await f.app.readPublic();
    assert.equal(result.httpStatus, 503); assert.equal(result.cache, 'no-store');
    assert.equal(result.body.status, 'unavailable'); assert.deepEqual(result.body.events, []);
    assert.equal(result.body.freshness, null); assert.equal(f.calls.length, 0); assert.equal(f.db.calls.length, 0);
    assert.equal(acquisitions, 0);
  }
  for (const master of [undefined, '0', '1']) for (const publicFlag of ['false', 'true', '1']) {
    const f = fixture({ env: { ...ENV, TODOIST_CALENDAR_ENABLED: master, TODOIST_CALENDAR_PUBLIC_ENABLED: publicFlag } });
    assert.equal(f.app.config.enabled, master === '1');
    assert.equal(f.app.config.publicEnabled, publicFlag !== 'false');
    if (master !== '1') {
      assert.equal((await f.app.refresh()).status, 'disabled');
      await rejected(f.app.auth.beginAuthorization(), 'CONFIGURATION');
      assert.equal((await f.app.readPublic()).body.status, 'unavailable'); f.app.start();
      assert.equal(f.db.calls.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
    } else {
      await f.authorize(); assert.equal((await f.app.refresh()).status, 'success');
      assert.equal((await f.app.readPublic()).body.status, publicFlag === 'false' ? 'unavailable' : 'ready');
    }
  }
});

test('CAL-08: private OAuth, publication and diagnostics remain available without public payloads', async () => {
  const f = fixture({ env: { ...ENV, TODOIST_CALENDAR_PUBLIC_ENABLED: 'false' } });
  await f.authorize(); assert.equal((await f.app.refresh()).count, 1);
  const saved = structuredClone({ snapshot: f.db.snapshot, credential: f.db.credential });
  const requests = f.calls.length, queries = f.db.calls.length;
  assert.equal((await f.app.readPublic()).httpStatus, 503); assert.equal(f.db.calls.length, queries);
  let body, status = 200; const headers = {};
  const res = { set: (k, v) => { headers[k] = v; }, status: value => { status = value; return res; }, json: value => { body = value; return res; } };
  await f.app.diagnosticsHandler({}, res);
  assert.equal(body.integration_enabled, true); assert.equal(body.public_enabled, false);
  assert.equal(body.configured, true); assert.equal(body.authorized, true); assert.equal(body.published_event_count, 1);
  assert.equal(status, 200); assert.equal(headers['Cache-Control'], 'no-store');
  assert(!JSON.stringify(body).match(/synthetic|PRIVATE|token|configuration_id|Synthetic Concert/));
  f.db.fail = () => true; await f.app.diagnosticsHandler({}, res);
  assert.deepEqual(body, { integration_enabled: true, public_enabled: false, configured: true,
    refresh_status: 'unavailable', last_error_code: 'DATABASE' }); assert.equal(status, 503);
  assert.equal(f.calls.length, requests); assert.deepEqual({ snapshot: f.db.snapshot, credential: f.db.credential }, saved);
});

test('CAL-08: visibility-only restarts preserve authorization, snapshots and persisted scheduling', async () => {
  const f = fixture({ env: { ...ENV, TODOIST_CALENDAR_PUBLIC_ENABLED: 'false' } });
  await f.authorize(); await f.app.refresh();
  const saved = structuredClone({ snapshot: f.db.snapshot, credential: f.db.credential });
  for (const publicFlag of ['true', 'false', '1', undefined]) {
    const restarted = fixture({ db: f.db, env: { ...ENV, TODOIST_CALENDAR_PUBLIC_ENABLED: publicFlag } });
    assert.equal(restarted.app.config.configurationId, f.app.config.configurationId);
    assert.equal((await restarted.app.auth.getAccessToken()).token, 'synthetic-access-1');
    assert.equal(restarted.calls.length, 0);
    const result = await restarted.app.readPublic();
    assert.equal(result.body.status, ['true', '1'].includes(publicFlag) ? 'ready' : 'unavailable');
    assert.equal((await restarted.app.refresh()).status, 'waiting'); assert.equal(restarted.calls.length, 0);
    restarted.app.start(); restarted.app.start(); assert.equal(restarted.timers.size, 1);
    const [timer, scheduled] = [...restarted.timers][0]; restarted.timers.delete(timer); await scheduled.fn();
    assert.equal(restarted.timers.size, 1); assert.equal([...restarted.timers.values()][0].delay, 300000);
    await restarted.app.stop(); assert.equal(restarted.timers.size, 0); assert.equal(restarted.calls.length, 0);
    assert.deepEqual({ snapshot: f.db.snapshot, credential: f.db.credential }, saved);
  }
});

test('CAL-08: public flag changes cannot bypass persisted 900-second provider backoff', async () => {
  const f = fixture(); await f.authorize(); await f.app.refresh(); f.advance(300000);
  f.pages = () => Response.json({ error_extra: { retry_after: 900 } }, { status: 429 });
  assert.equal((await f.app.refresh()).delay, 900000);
  const saved = structuredClone({ snapshot: f.db.snapshot, credential: f.db.credential });
  const workers = ['false', 'true'].map(publicFlag => fixture({ db: f.db,
    env: { ...ENV, TODOIST_CALENDAR_PUBLIC_ENABLED: publicFlag } }));
  for (const worker of workers) worker.advance(300000);
  const results = await Promise.all(workers.map(worker => worker.app.refresh()));
  assert(results.every(result => ['waiting', 'busy'].includes(result.status)));
  for (const worker of workers) {
    worker.advance(899999); assert.equal((await worker.app.refresh()).status, 'waiting');
    assert.equal(worker.calls.length, 0); await worker.app.readPublic();
  }
  assert.deepEqual({ snapshot: f.db.snapshot, credential: f.db.credential }, saved); assert.equal(f.db.locks.size, 0);
});

test('OAuth state/PKCE/redirect, one-use callback and authenticated encryption', async () => {
  const f = fixture(); const url = await f.authorize();
  const tokenCall = f.calls[0];
  assert.equal(tokenCall.options.body.get('redirect_uri'), ENV.TODOIST_REDIRECT_URI);
  assert(tokenCall.options.body.get('code_verifier').length >= 43);
  assert(!f.db.credential.encrypted_tokens.includes('synthetic-access'));
  assert(!f.db.credential.encrypted_tokens.includes('synthetic-refresh'));
  assert.equal(f.db.credential.pending_authorization, null);
  await rejected(f.app.auth.completeAuthorization({ state: url.searchParams.get('state'), code: 'synthetic-code' }), 'AUTH_STATE');
  await rejected(f.app.auth.completeAuthorization({ state: ['malformed'], code: 'x' }), 'AUTH_STATE');
  const start = await f.app.auth.beginAuthorization(); f.advance(600001);
  await rejected(f.app.auth.completeAuthorization({ state: new URL(start.authorization_url).searchParams.get('state'), code: 'x' }), 'AUTH_STATE');
});

test('OAuth write scope is rejected and no tokens saved', async () => {
  const f = fixture();
  f.tokenResponse = () => Response.json({ access_token: 'private', refresh_token: 'private', token_type: 'Bearer', scope: 'data:read_write', expires_in: 3600 });
  await rejected(f.authorize(), 'AUTH_SCOPE'); assert.equal(f.db.credential.encrypted_tokens, null);
});

test('token reuse, expiration, rotation and serialization', async () => {
  const f = fixture(); await f.authorize();
  assert.equal((await f.app.auth.getAccessToken()).token, 'synthetic-access-1'); assert.equal(f.calls.length, 1);
  f.advance(3600000);
  const results = await Promise.allSettled([f.app.auth.getAccessToken(), f.app.auth.getAccessToken()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'AUTH_BUSY');
  assert.equal(f.calls.length, 2); assert.equal((await f.app.auth.getAccessToken()).token, 'synthetic-access-2');
  assert.equal(f.db.credential.refresh_in_progress, false);
});

test('token rate limit preserves the unconsumed token; 401 recovers exactly once', async () => {
  const f = fixture(); await f.authorize(); f.advance(3600000);
  f.tokenResponse = () => new Response('PRIVATE', { status: 429, headers: { 'Retry-After': '600' } });
  await rejected(f.app.auth.getAccessToken(), 'RATE_LIMIT');
  assert.equal(f.db.credential.blocked, false); assert.equal(f.db.credential.refresh_in_progress, false);
  f.tokenResponse = null;
  let first = true;
  f.pages = () => { if (first) { first = false; return new Response('PRIVATE', { status: 401 }); }
    return { results: [task()], next_cursor: null }; };
  assert.equal((await f.app.refresh()).status, 'success'); assert.equal(taskCalls(f).length, 2);
  assert.equal(f.db.credential.blocked, false);
});

test('interrupted rotation and corrupt ciphertext require reauthorization, not replay', async () => {
  for (const kind of ['pending', 'corrupt', 'network']) {
    const f = fixture(); await f.authorize(); f.advance(3600000);
    if (kind === 'pending') f.db.credential.refresh_in_progress = true;
    if (kind === 'corrupt') f.db.credential.encrypted_tokens += 'tamper';
    if (kind === 'network') f.tokenResponse = () => { throw Error('PRIVATE network body'); };
    await rejected(f.app.auth.getAccessToken(), 'AUTH_REAUTHORIZE');
    const calls = f.calls.length;
    await rejected(f.app.auth.getAccessToken(), 'AUTH_REAUTHORIZE');
    assert.equal(f.calls.length, calls); assert(f.db.credential.blocked);
  }
});

test('project-filtered pagination, deduplication and atomic public snapshot', async () => {
  const f = fixture(); await f.authorize();
  f.pages = url => url.searchParams.has('cursor') ? { results: [Object.fromEntries(Object.entries(task()).reverse()), task({ id: 'taskB' })], next_cursor: null }
    : { results: [task()], next_cursor: 'opaque-cursor' };
  assert.equal((await f.app.refresh()).count, 2);
  for (const call of taskCalls(f)) {
    const url = new URL(call.url); assert.equal(url.searchParams.get('project_id'), PROJECT_ID);
    assert.equal(url.searchParams.get('limit'), '50'); assert(!url.search.includes('token'));
    assert.match(call.options.headers.Authorization, /^Bearer synthetic-access-/); assert.equal(call.options.redirect, 'error');
  }
  assert.equal(taskCalls(f).length, 2);
  assert(f.db.calls.some(call => call.sql === 'BEGIN')); assert(f.db.calls.some(call => call.sql === 'COMMIT'));
  const before = f.db.calls.length, requests = f.calls.length;
  const response = await f.app.readPublic();
  assert.equal(response.httpStatus, 200); assert.equal(response.body.status, 'ready');
  assert.match(response.cache, /max-age=30/); assert(!response.cache.includes('stale-while-revalidate'));
  assert(f.db.calls.slice(before).every(call => call.sql.startsWith('SELECT')));
  assert.equal(f.calls.length, requests);
  assert(!JSON.stringify(response).match(/synthetic-access|DO-NOT-PUBLISH|PRIVATE|project_id|assignee/));
});

test('approval withdrawal and complete successful empty scans replace old events', async () => {
  const f = fixture(); await f.authorize(); await f.app.refresh(); f.advance(300000);
  f.pages = () => ({ results: [task({ labels: [] })], next_cursor: null });
  assert.equal((await f.app.refresh()).count, 0); assert.equal((await f.app.readPublic()).body.status, 'empty');
  f.advance(300000); f.pages = () => ({ results: [], next_cursor: null });
  assert.equal((await f.app.refresh()).count, 0); assert.equal((await f.app.readPublic()).httpStatus, 200);
});

test('partial pages, loops, conflicts, foreign projects and malformed results retain snapshot freshness', async () => {
  for (const kind of ['partial', 'loop', 'limit', 'conflict', 'foreign', 'malformed']) {
    const f = fixture(); await f.authorize(); await f.app.refresh(); const saved = structuredClone(f.db.snapshot); f.advance(300000);
    let count = 0;
    f.pages = url => {
      count++;
      if (kind === 'partial' && url.searchParams.has('cursor')) return new Response('PRIVATE ERROR', { status: 500 });
      if (kind === 'foreign') return { results: [task({ project_id: 'personal-project' })], next_cursor: null };
      if (kind === 'malformed') return { items: [task()] };
      return { results: [task({ content: kind === 'conflict' && count > 1 ? 'changed' : 'Synthetic Concert' })],
        next_cursor: kind === 'limit' ? `cursor-${count}` : 'repeating' };
    };
    assert.notEqual((await f.app.refresh()).status, 'success', kind);
    assert.deepEqual(f.db.snapshot.events, saved.events); assert.deepEqual(f.db.snapshot.verified_at, saved.verified_at);
    assert.equal((await f.app.readPublic()).body.status, 'stale'); assert(count <= 20);
  }
});

test('database lock and publication failures fail closed; concurrent instances do not rescan', async () => {
  const f = fixture(); await f.authorize();
  f.db.locks.set(1, 'other-instance'); assert.equal((await f.app.refresh()).status, 'busy'); assert.equal(taskCalls(f).length, 0);
  f.db.locks.delete(1); f.db.connectFailure = true;
  assert.equal((await f.app.refresh()).code, 'DATABASE'); assert.equal(taskCalls(f).length, 0);
  f.db.connectFailure = false; await f.app.refresh(); const saved = structuredClone(f.db.snapshot); f.advance(300000);
  f.db.fail = sql => sql === 'COMMIT';
  assert.equal((await f.app.refresh()).code, 'DATABASE'); assert.deepEqual(f.db.snapshot.events, saved.events);
  assert.deepEqual(f.db.snapshot.verified_at, saved.verified_at); assert.equal(f.db.locks.size, 0);
  f.db.fail = null; f.db.snapshot.next_attempt_at = null;
  const second = fixture({ db: f.db }); second.setNow(new Date(f.now()).toISOString());
  const results = await Promise.all([f.app.refresh(), second.app.refresh()]);
  assert.equal(results.filter(r => r.status === 'success').length, 1);
  const count = f.calls.length + second.calls.length;
  await second.app.refresh(); assert.equal(f.calls.length + second.calls.length, count);
});

test('rate limits persist retry delay; persistent authentication failures halt external requests', async () => {
  const f = fixture(); await f.authorize();
  f.pages = () => new Response('private rate-limit message', { status: 429, headers: { 'Retry-After': '900' } });
  const result = await f.app.refresh(); assert.equal(result.code, 'RATE_LIMIT'); assert.equal(result.delay, 900000);
  const count = f.calls.length; f.advance(300000); assert.equal((await f.app.refresh()).status, 'waiting'); assert.equal(f.calls.length, count);
  f.advance(600000); f.pages = () => new Response('private auth error', { status: 401 });
  assert.equal((await f.app.refresh()).code, 'AUTH_REAUTHORIZE'); assert(f.db.credential.blocked);
  const blockedCount = f.calls.length; f.advance(300000); await f.app.refresh(); assert.equal(f.calls.length, blockedCount);
  assert(!JSON.stringify(f.logs).match(/private|synthetic-access|synthetic-refresh|secret/i));
});

test('fresh/empty/stale/unavailable, cache expiry, tampered snapshots and configuration changes', async () => {
  const f = fixture(); assert.equal((await f.app.readPublic()).body.status, 'unavailable'); await f.authorize(); await f.app.refresh();
  f.advance(299001); assert.match((await f.app.readPublic()).cache, /max-age=0/);
  f.advance(999); let response = await f.app.readPublic(); assert.equal(response.body.status, 'stale'); assert.deepEqual(response.body.events, []); assert.equal(response.cache, 'no-store');
  f.advance(1); await f.app.refresh(); f.db.snapshot.events[0].raw_task = 'PRIVATE';
  response = await f.app.readPublic(); assert.equal(response.httpStatus, 503); assert(!JSON.stringify(response).includes('PRIVATE'));
  delete f.db.snapshot.events[0].raw_task;
  Object.assign(f.db.snapshot.events[0], { all_day: false, start_time: ['12:00'] });
  assert.equal((await f.app.readPublic()).httpStatus, 503);
  f.db.fail = () => true; assert.equal((await f.app.readPublic()).body.status, 'unavailable'); f.db.fail = null;
  const different = fixture({ db: f.db, env: { ...ENV, TODOIST_CLIENT_SECRET: 'changed-synthetic-secret' } });
  assert.equal((await different.app.readPublic()).httpStatus, 503);
});

test('snapshot expiry prevents overdue publication, including fixed DST-fold instants', async () => {
  const f = fixture(); await f.authorize(); f.setNow('2026-11-01T05:29:00Z');
  f.pages = () => ({ results: [task({ due: { date: '2026-11-01T05:30:00Z', is_recurring: false } }),
    task({ id: 'second-fold', due: { date: '2026-11-01T06:30:00Z', is_recurring: false } })], next_cursor: null });
  assert.equal((await f.app.refresh()).count, 2); assert.equal(Date.parse(f.db.snapshot.valid_until), Date.parse('2026-11-01T05:30:00Z'));
  f.advance(60000); assert.equal((await f.app.readPublic()).body.status, 'stale');
  assert.equal((await f.app.refresh()).count, 1); assert.equal((await f.app.readPublic()).body.events[0].event_id, 'second-fold');
});

test('bounded timeout/response size and abort cleanup', async () => {
  await rejected(requestJson((url, options) => new Promise((resolve, reject) =>
    options.signal.addEventListener('abort', () => reject(Error('private failure')), { once: true })), 'https://fixture.invalid', { timeoutMs: 5 }), 'TIMEOUT');
  await rejected(requestJson(async () => new Response('x'.repeat(100)), 'https://fixture.invalid', { maxBytes: 8 }), 'RESPONSE_LIMIT');
  const f = fixture(); await f.authorize();
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.pages = (url, options) => new Promise((resolve, reject) => { entered(); options.signal.addEventListener('abort', () => reject(Error('private')), { once: true }); });
  const work = f.app.refresh(); await waiting; assert.equal((await f.app.refresh()).status, 'busy'); await f.app.stop(); await work;
  assert.equal(f.db.locks.size, 0); assert.equal(f.db.snapshot.verified_at, null);
});

test('one scheduler, stop/restart and protected diagnostics do not leak or ingest', async () => {
  const f = fixture(); await f.authorize(); f.app.start(); f.app.start(); assert.equal(f.timers.size, 1);
  await f.app.stop(); assert.equal(f.timers.size, 0); f.app.start(); assert.equal(f.timers.size, 1); await f.app.stop();
  await f.app.refresh(); let body, code, headers = {};
  const res = { set: (k, v) => { headers[k] = v; }, status: n => { code = n; return res; }, json: value => { body = value; return res; } };
  const requests = f.calls.length; await f.app.publicHandler({}, res);
  assert.equal(code, 200); assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  await f.app.diagnosticsHandler({}, res); assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(body.published_event_count, 1); assert.equal(f.calls.length, requests);
  assert(!JSON.stringify(body).match(/synthetic|PRIVATE|token|project_id/));
});

test('integration wiring stays outside legacy Sheets and preserves Admin middleware', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(source, /app\.get\('\/api\/calendar', calendar\.publicHandler\)/);
  assert.match(source, /app\.get\('\/api\/admin\/calendar\/status', requireCalendarAdminCredential, calendar\.diagnosticsHandler\)/);
  assert.match(source, /app\.post\('\/api\/admin\/calendar\/oauth\/start', requireCalendarAdminCredential, calendar\.oauthStartHandler\)/);
  assert(!source.slice(source.indexOf('const ROUTES ='), source.indexOf('const ADMIN_ROUTE_INVENTORY')).includes("'/api/calendar'"));
  assert.match(source, /app\.use\(\['\/api\/admin', '\/admin\/import', '\/admin\/smug', '\/api\/wrestling\/people\/import'\], requireAdminAccess\)/);
  for (const name of ['todoist-calendar.js', 'todoist-auth.js']) {
    const module = fs.readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(module, /CREATE TABLE|ALTER TABLE|loadLocalEnv\(|require\(['"]\.\/server/);
  }
});

test('actual Express handlers: CAL-08 visibility gate, conditional requests and Admin protection (isolated HTTP)', async () => {
  const express = require('express');
  const source = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  const extract = name => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}', start);
    return source.slice(start, end + 2);
  };
  const context = vm.createContext({ crypto, Buffer, getConfiguredAdminSecrets: () => ['synthetic-admin-header'] });
  vm.runInContext(extract('adminTokenMatches') + '\n' + extract('requireCalendarAdminCredential'), context);
  const f = fixture(); await f.authorize(); await f.app.refresh();
  const privateApp = fixture({ db: f.db, env: { ...ENV, TODOIST_CALENDAR_PUBLIC_ENABLED: 'false' } });
  let active = f.app;
  const app = express();
  app.get('/api/calendar', (req, res) => active.publicHandler(req, res));
  app.get('/api/admin/calendar/status', context.requireCalendarAdminCredential, (req, res) => active.diagnosticsHandler(req, res));
  app.post('/api/admin/calendar/oauth/start', context.requireCalendarAdminCredential, (req, res) => active.oauthStartHandler(req, res));
  app.get('/api/calendar/oauth/callback', f.app.oauthCallbackHandler);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const requests = f.calls.length;
    let response = await fetch(base + '/api/calendar?refresh=1');
    assert.equal(response.status, 200); assert.equal((await response.json()).status, 'ready');
    assert.equal(f.calls.length, requests); assert.match(response.headers.get('cache-control'), /max-age=30/);
    const readyTag = response.headers.get('etag'); assert(readyTag);
    // Simulate a visibility-only configuration restart, sharing the same persisted state.
    active = privateApp.app;
    const queries = f.db.calls.length;
    for (const headers of [{}, { 'If-None-Match': readyTag }, { 'If-None-Match': '*' },
      { 'If-Modified-Since': 'Thu, 01 Oct 2026 12:00:00 GMT' },
      { 'If-None-Match': readyTag, 'Cache-Control': 'max-age=3600', Authorization: 'Bearer synthetic-admin-header' }]) {
      response = await fetch(base + '/api/calendar?refresh=1&public_enabled=true', { headers });
      assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
      const hidden = await response.json();
      assert.equal(hidden.status, 'unavailable'); assert.deepEqual(hidden.events, []); assert.equal(hidden.freshness, null);
      assert(!JSON.stringify(hidden).match(/Synthetic Concert|synthetic|PRIVATE|configured|public_enabled/));
    }
    assert.equal(f.db.calls.length, queries); assert.equal(privateApp.calls.length, 0);
    for (const query of ['', '?admin_token=synthetic-admin-header']) {
      response = await fetch(base + '/api/admin/calendar/status' + query);
      assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    response = await fetch(base + '/api/admin/calendar/status', { headers: { Authorization: 'Bearer synthetic-admin-header' } });
    assert.equal(response.status, 200); const diagnostics = await response.json();
    assert.equal(diagnostics.published_event_count, 1); assert.equal(diagnostics.public_enabled, false);
    assert.equal(diagnostics.integration_enabled, true); assert.equal(diagnostics.authorized, true);
    response = await fetch(base + '/api/admin/calendar/oauth/start', { method: 'POST' }); assert.equal(response.status, 401);
    response = await fetch(base + '/api/admin/calendar/oauth/start', {
      method: 'POST', headers: { Authorization: 'Bearer synthetic-admin-header' } });
    assert.equal(response.status, 200); assert.match((await response.json()).authorization_url, /^https:\/\/app\.todoist\.com\/oauth\/authorize\?/);
    assert.equal(privateApp.calls.length, 0);
    response = await fetch(base + '/api/calendar/oauth/callback?state=bad&code=private');
    assert.equal(response.status, 400); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert(!(await response.text()).includes('private')); assert.equal(f.calls.length, requests);
    const res = { locals: { v3AdminSessionAuthorized: true } };
    let passed = false; context.requireCalendarAdminCredential({}, res, () => { passed = true; }); assert(passed);
    active = f.app;
    response = await fetch(base + '/api/calendar'); assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ready');
    f.advance(300000); f.pages = () => ({ results: [], next_cursor: null }); await f.app.refresh();
    response = await fetch(base + '/api/calendar');
    assert.equal(response.status, 200); assert.equal((await response.json()).status, 'empty');
    const etag = response.headers.get('etag');
    f.advance(300000);
    response = await fetch(base + '/api/calendar', { headers: { 'If-None-Match': etag } });
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    let body = await response.json(); assert.equal(body.status, 'stale'); assert.deepEqual(body.events, []);
    f.db.fail = () => true;
    response = await fetch(base + '/api/calendar'); body = await response.json();
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.status, 'unavailable'); assert.deepEqual(body.events, []);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

// CAL-04: production-readiness checks. Failures are release blockers, not skipped checks.
test('PKCE digest matches the verifier; mismatched/denied callbacks cannot exchange tokens', async () => {
  const f = fixture(); const start = await f.app.auth.beginAuthorization();
  const url = new URL(start.authorization_url), state = url.searchParams.get('state');
  await rejected(f.app.auth.completeAuthorization({ state: 'X'.repeat(43), code: 'synthetic-code' }), 'AUTH_STATE');
  assert.equal(f.calls.length, 0);
  await f.app.auth.completeAuthorization({ state, code: 'synthetic-code' });
  assert.equal(crypto.createHash('sha256').update(f.calls[0].options.body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  const denied = new URL((await f.app.auth.beginAuthorization()).authorization_url).searchParams.get('state');
  const count = f.calls.length;
  await rejected(f.app.auth.completeAuthorization({ state: denied, error: 'access_denied' }), 'AUTH_DENIED');
  await rejected(f.app.auth.completeAuthorization({ state: denied, code: 'synthetic-code' }), 'AUTH_STATE');
  assert.equal(f.calls.length, count);
});

test('legacy OAuth and lost rotated refresh-token responses fail closed', async () => {
  const f = fixture();
  f.tokenResponse = () => Response.json({ access_token: 'synthetic-legacy', token_type: 'Bearer', expires_in: 315360000 });
  await rejected(f.authorize(), 'AUTH_SCOPE'); assert.equal(f.db.credential.encrypted_tokens, null);
  f.tokenResponse = null; await f.authorize(); const ciphertext = f.db.credential.encrypted_tokens;
  f.advance(3600000);
  f.tokenResponse = () => Response.json({ access_token: 'synthetic-grace-retry', token_type: 'Bearer', expires_in: 3600, scope: 'data:read' });
  await rejected(f.app.auth.getAccessToken(), 'AUTH_REAUTHORIZE');
  assert.equal(f.db.credential.encrypted_tokens, ciphertext); assert.equal(f.db.credential.blocked, true);
});

test('process restart retains the snapshot, tokens and persisted refresh/backoff schedule', async () => {
  const first = fixture(); await first.authorize(); await first.app.refresh(); await first.app.stop();
  const saved = structuredClone(first.db.snapshot), restarted = fixture({ db: first.db });
  assert.equal((await restarted.app.readPublic()).body.status, 'ready');
  assert.equal((await restarted.app.refresh()).status, 'waiting'); assert.equal(restarted.calls.length, 0);
  assert.deepEqual(first.db.snapshot.events, saved.events);
  restarted.advance(300000);
  restarted.pages = () => new Response('synthetic rate limit', { status: 429, headers: { 'Retry-After': '900' } });
  assert.equal((await restarted.app.refresh()).delay, 900000);
  const afterBackoffRestart = fixture({ db: first.db });
  afterBackoffRestart.setNow(new Date(restarted.now() + 300000).toISOString());
  assert.equal((await afterBackoffRestart.app.refresh()).status, 'waiting'); assert.equal(afterBackoffRestart.calls.length, 0);
  assert.equal((await afterBackoffRestart.app.readPublic()).body.status, 'stale');
  afterBackoffRestart.advance(600000); afterBackoffRestart.pages = () => ({ results: [], next_cursor: null });
  assert.equal((await afterBackoffRestart.app.refresh()).count, 0);
  assert.equal((await afterBackoffRestart.app.readPublic()).body.status, 'empty');
});

test('credential replacement during a scan prevents publication under an old authorization', async () => {
  const f = fixture(); await f.authorize(); await f.app.refresh(); const saved = structuredClone(f.db.snapshot);
  f.advance(300000);
  f.pages = () => { f.db.credential.credential_version = crypto.randomUUID(); return { results: [task({ content: 'Changed event' })], next_cursor: null }; };
  assert.equal((await f.app.refresh()).code, 'AUTH_REAUTHORIZE');
  assert.deepEqual(f.db.snapshot.events, saved.events); assert.deepEqual(f.db.snapshot.verified_at, saved.verified_at);
  assert.equal((await f.app.readPublic()).body.status, 'unavailable'); assert.equal(f.db.locks.size, 0);
});

test('failed token persistence blocks reuse without replacing the previous publication', async () => {
  const f = fixture(); await f.authorize(); await f.app.refresh(); const saved = structuredClone(f.db.snapshot);
  f.advance(3600000); f.db.fail = sql => sql.startsWith('UPDATE todoist_oauth_credentials SET encrypted_tokens');
  assert.equal((await f.app.refresh()).code, 'AUTH_REAUTHORIZE');
  assert.deepEqual(f.db.snapshot.events, saved.events); assert.deepEqual(f.db.snapshot.verified_at, saved.verified_at);
  assert(f.db.credential.blocked); const requests = f.calls.length;
  f.advance(300000); await f.app.refresh(); assert.equal(f.calls.length, requests); assert.equal(f.db.locks.size, 0);
});

test('CAL-05A: body-only 900-second backoff persists from the error without renewing publication', async () => {
  const f = fixture(); await f.authorize(); await f.app.refresh();
  const saved = structuredClone(f.db.snapshot);
  f.advance(300000);
  f.pages = () => {
    f.advance(2000); // Count the delay from the response, not the start of the scan.
    return Response.json({ error_tag: 'RATE_LIMIT_EXCEEDED', http_code: 429,
      error_extra: { retry_after: 900 }, private_detail: 'PRIVATE-RATE-LIMIT-CANARY' }, { status: 429 });
  };
  const result = await f.app.refresh();
  assert.equal(result.code, 'RATE_LIMIT');
  assert.equal(result.delay, 900000, 'Nested Todoist backoff must not be shortened to the five-minute default');
  assert.equal(Date.parse(f.db.snapshot.next_attempt_at), f.now() + 900000);
  for (const key of ['events', 'verified_at', 'published_at', 'valid_until']) assert.deepEqual(f.db.snapshot[key], saved[key]);
  const publicResult = await f.app.readPublic();
  assert.equal(publicResult.body.status, 'stale'); assert.deepEqual(publicResult.body.events, []);
  assert(!JSON.stringify([publicResult, f.logs]).match(/PRIVATE|synthetic-access|synthetic-refresh|error_extra/));
  assert.equal(f.db.locks.size, 0);
});

test('CAL-05A: retry hints use seconds, preserve HTTP dates and choose the longest usable delay', async () => {
  const cases = [
    ['900', {}, 900000],
    [null, { error_extra: { retry_after: 900 } }, 900000],
    ['300', { error_extra: { retry_after: 900 } }, 900000],
    ['1200', { error_extra: { retry_after: 900 } }, 1200000],
    ['Thu, 01 Oct 2026 12:20:00 GMT', { error_extra: { retry_after: 900 } }, 1200000],
    ['Thursday, 01-Oct-26 12:20:00 GMT', {}, 1200000],
    ['Thu Oct  1 12:20:00 2026', {}, 1200000],
    ['Thu, 01 Oct 2026 11:00:00 GMT', { error_extra: { retry_after: 900 } }, 900000],
    ['broken', { error_extra: { retry_after: '900.0001' } }, 900001],
    ['900.0001', { error_extra: { retry_after: 'invalid' } }, 900001],
    [null, { retry_after: 1200, error_extra: { retry_after: 900 } }, 1200000],
    [null, { error_extra: { retry_after: 315360000 } }, 315360000000], // No arbitrary short cap.
    [null, {}, 300000],
    ['-1', { error_extra: { retry_after: -1 } }, 300000],
    ['1e309', { error_extra: { retry_after: 'Infinity' } }, 300000],
    ['8640000000000', { error_extra: { retry_after: 8640000000000 } }, 300000], // Deadline exceeds Date range.
    [null, { error_extra: { retry_after: 0 } }, 0],
    ...[null, true, false, '', ' ', 'NaN', 'Infinity', '1e309', [], [900], {}, -0.0001, -900, 1e308]
      .map(value => [null, { error_extra: { retry_after: value } }, 300000]),
  ];
  for (const [header, body, expected] of cases) {
    const response = await requestJson(async (url, options) => {
      assert.equal('clock' in options, false);
      return Response.json(body, { status: 429, headers: header === null ? {} : { 'Retry-After': header } });
    }, 'https://fixture.invalid', { clock: () => BASE_NOW });
    assert.equal(response.retryAfterMs, expected, JSON.stringify({ header, body }));
  }
  for (const invalid of ['NaN', 'Infinity', '-Infinity', '1e309']) {
    const response = await requestJson(async () => new Response(`{"error_extra":{"retry_after":${invalid}}}`, { status: 429 }),
      'https://fixture.invalid', { clock: () => BASE_NOW });
    assert.equal(response.retryAfterMs, 300000);
  }
});

test('CAL-05A: refresh persists header/body precedence and preserves fallback and successful cadence', async () => {
  for (const [header, body, delay] of [
    ['1200', { error_extra: { retry_after: 900 } }, 1200000],
    ['Thu, 01 Oct 2026 12:20:00 GMT', { error_extra: { retry_after: 900 } }, 1200000],
    ['300', { error_extra: { retry_after: 900 } }, 900000],
    [null, { error_extra: { retry_after: 900.0001 } }, 900001],
    [null, { error_extra: { retry_after: 'bad' } }, 300000],
    [null, {}, 300000],
    [null, { error_extra: { retry_after: 0 } }, 300000],
  ]) {
    const f = fixture(); await f.authorize();
    f.pages = () => Response.json(body, { status: 429, headers: header === null ? {} : { 'Retry-After': header } });
    assert.equal((await f.app.refresh()).delay, delay);
    assert.equal(new Date(f.db.snapshot.next_attempt_at).getTime(), f.now() + delay);
    const requests = f.calls.length;
    f.advance(delay - 1); assert.equal((await f.app.refresh()).status, 'waiting'); assert.equal(f.calls.length, requests);
    f.advance(1); f.pages = () => ({ results: [task()], next_cursor: null });
    const success = await f.app.refresh(); assert.equal(success.status, 'success'); assert.equal(success.delay, 300000);
    assert.equal(new Date(f.db.snapshot.next_attempt_at).getTime(), f.now() + 300000);
  }
});

test('CAL-05A: restart, concurrent workers and credential replacement cannot bypass pending backoff', async () => {
  const first = fixture(); await first.authorize();
  first.pages = () => Response.json({ error_extra: { retry_after: 900 } }, { status: 429 });
  assert.equal((await first.app.refresh()).delay, 900000); await first.app.stop();
  const second = fixture({ db: first.db }), third = fixture({ db: first.db });
  second.advance(300000); third.advance(300000);
  const before = await Promise.all([second.app.refresh(), third.app.refresh()]);
  assert(before.every(result => ['waiting', 'busy'].includes(result.status)));
  assert.equal(second.calls.length + third.calls.length, 0);
  const oldVersion = first.db.credential.credential_version;
  await second.authorize(); assert.notEqual(first.db.credential.credential_version, oldVersion);
  const requests = second.calls.length;
  assert.equal((await second.app.refresh()).status, 'waiting');
  assert.equal((await third.app.refresh()).status, 'waiting');
  assert.equal(second.calls.length + third.calls.length, requests);
  assert.equal(Date.parse(first.db.snapshot.next_attempt_at), BASE_NOW + 900000);
  second.advance(599999); third.advance(599999);
  assert.equal((await third.app.refresh()).delay, 1); assert.equal(third.calls.length, 0);
  second.advance(1); third.advance(1);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  second.pages = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const winner = second.app.refresh(); await started;
  assert.equal((await third.app.refresh()).status, 'busy'); assert.equal(third.calls.length, 0);
  release({ results: [task()], next_cursor: null }); assert.equal((await winner).status, 'success');
  assert.equal((await third.app.refresh()).status, 'waiting');
  assert.equal(taskCalls(second).length, 1); assert.equal(first.db.locks.size, 0);
});

test('CAL-05A: token-refresh rate limits share the persisted delay without changing authorization recovery', async () => {
  const f = fixture(); await f.authorize(); await f.app.refresh();
  const saved = structuredClone(f.db.snapshot);
  f.advance(3600000);
  f.tokenResponse = () => Response.json({ error_extra: { retry_after: 900 } }, { status: 429 });
  const result = await f.app.refresh(); assert.equal(result.code, 'RATE_LIMIT'); assert.equal(result.delay, 900000);
  assert.equal(f.db.credential.blocked, false); assert.equal(f.db.credential.refresh_in_progress, false);
  assert.equal(Date.parse(f.db.snapshot.next_attempt_at), f.now() + 900000);
  const requests = f.calls.length;
  f.advance(300000); assert.equal((await f.app.refresh()).status, 'waiting'); assert.equal(f.calls.length, requests);
  assert.deepEqual(f.db.snapshot.events, saved.events); assert.deepEqual(f.db.snapshot.verified_at, saved.verified_at);
  f.advance(600000); f.tokenResponse = () => new Response('', { status: 400 });
  assert.equal((await f.app.refresh()).code, 'AUTH_REAUTHORIZE'); assert(f.db.credential.blocked);
  const blocked = f.calls.length; f.advance(300000); await f.app.refresh(); assert.equal(f.calls.length, blocked);
  // An explicit reauthorization still clears an authentication stop immediately.
  f.tokenResponse = null; await f.authorize(); assert.equal((await f.app.refresh()).status, 'success');
});

test('CAL-05A: platform timer limit cannot shorten a persisted 30-day provider delay', async () => {
  const f = fixture(); await f.authorize();
  f.pages = () => Response.json({ error_extra: { retry_after: 2592000 } }, { status: 429 });
  const tick = async () => {
    assert.equal(f.timers.size, 1);
    const [key, timer] = [...f.timers][0]; f.timers.delete(key); await timer.fn();
  };
  f.app.start();
  try {
    await tick(); assert.equal(Date.parse(f.db.snapshot.next_attempt_at), BASE_NOW + 2592000000);
    assert.equal([...f.timers.values()][0].delay, 2147483647);
    const requests = f.calls.length;
    f.advance(2147483647); await tick(); assert.equal(f.calls.length, requests);
    const remaining = 2592000000 - 2147483647;
    assert.equal([...f.timers.values()][0].delay, remaining);
    f.advance(remaining); f.pages = () => ({ results: [], next_cursor: null }); await tick();
    assert.equal(taskCalls(f).length, 2); assert.equal([...f.timers.values()][0].delay, 300000);
    assert.equal((await f.app.readPublic()).body.status, 'empty');
  } finally { await f.app.stop(); }
  assert.equal(f.timers.size, 0);
});

test('CAL-05B: original exhausted-pool regression returns within the acquisition deadline and recovers', async () => {
  // Real installed pg Pool, synthetic transport; no PostgreSQL or network connection.
  const { Pool } = require('pg');
  const seed = fixture(); await seed.authorize(); await seed.app.refresh();
  const row = { ...seed.db.snapshot, current_credential_version: seed.db.credential.credential_version, credentials_ready: true };
  let queries = 0, ended = 0;
  class FakeClient extends EventEmitter {
    constructor() { super(); this._queryable = true; this._ending = false; }
    connect(callback) { process.nextTick(() => callback(null)); }
    query(config, values, callback) {
      queries++; assert.equal(config.query_timeout, 3000);
      const done = typeof values === 'function' ? values : callback;
      if (done) process.nextTick(() => done(null, { rows: [row] }));
      else return Promise.resolve({ rows: [row] });
    }
    end(callback) { ended++; this.emit('end'); if (callback) process.nextTick(callback); }
  }
  const pool = new Pool({ max: 1, Client: FakeClient });
  let held = await pool.connect();
  const f = fixture({ db: pool });
  let deadline;
  const started = performance.now();
  const request = f.app.readPublic();
  try {
    const result = await Promise.race([request, new Promise(resolve => { deadline = setTimeout(() => resolve(null), 3300); })]);
    assert(result, 'Calendar SELECT remains queued beyond its 3000ms query timeout when the pool is exhausted');
    assert.equal(result.httpStatus, 503); assert.equal(result.body.status, 'unavailable');
    assert.deepEqual(result.body.events, []); assert.equal(result.cache, 'no-store');
    const elapsed = performance.now() - started;
    assert(elapsed >= 2900 && elapsed < 3300, `Acquisition took ${elapsed}ms`);
    console.log(`INFO exhausted-pool acquisition returned after ${Math.round(elapsed)}ms (synthetic transport)`);
    assert.equal(queries, 0); assert.equal(ended, 0); assert.equal(pool.totalCount, 1);
    held.release(); held = null;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pool.waitingCount, 0); assert.equal(pool.idleCount, 1); assert.equal(queries, 0);
    assert.equal(ended, 0, 'Late healthy checkout must not be destroyed');
    assert.equal((await f.app.readPublic()).body.status, 'ready');
    assert.equal(queries, 1); assert.equal(pool.idleCount, 1); assert.equal(pool.totalCount, 1);
  } finally {
    clearTimeout(deadline); held?.release(); await request; await pool.end();
  }
});

const settleAcquisition = () => new Promise(resolve => setImmediate(resolve));

function acquisitionFixture() {
  const pending = [];
  const db = { connect: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    query: () => assert.fail('Public Calendar must not use unbounded pool.query') };
  const f = fixture({ db });
  return Object.assign(f, { pending, tick: async ms => { f.advance(ms); mock.timers.tick(ms); await settleAcquisition(); } });
}

function acquisitionClient(queryImpl = async () => ({ rows: [] })) {
  const client = new EventEmitter();
  client.queries = []; client.releases = [];
  client.query = args => { client.queries.push(args); return queryImpl(args); };
  client.release = destroy => client.releases.push(destroy);
  return client;
}

test('CAL-05B: never-resolving acquisition returns 503 at 3000ms; late client runs no SQL or second response', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = acquisitionFixture(), client = acquisitionClient();
    let sends = 0, status, body;
    const headers = {};
    const res = { set: (key, value) => { headers[key] = value; }, status: value => { status = value; return res; },
      json: value => { sends++; body = value; return res; } };
    const request = f.app.publicHandler({}, res); await settleAcquisition(); assert.equal(f.pending.length, 1);
    await f.tick(2999); assert.equal(sends, 0);
    await f.tick(1); assert.equal(sends, 1); await request;
    assert.equal(status, 503); assert.equal(body.status, 'unavailable'); assert.deepEqual(body.events, []);
    assert.equal(headers['Cache-Control'], 'no-store'); assert.equal(f.calls.length, 0);
    f.pending[0].resolve(client); await settleAcquisition();
    assert.deepEqual(client.releases, [undefined]); assert.equal(client.queries.length, 0); assert.equal(client.listenerCount('error'), 0);
    await f.tick(6000); assert.equal(sends, 1); assert.equal(client.releases.length, 1);
    assert(!JSON.stringify([body, headers, f.logs]).match(/PRIVATE|postgres:|synthetic|DATABASE|SQL/));
  } finally { mock.timers.reset(); }
});

test('CAL-05B: late rejection and immediate acquisition failures stay handled and private', async () => {
  const unhandled = [], onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = acquisitionFixture(); let response;
    f.app.readPublic().then(value => { response = value; }); await settleAcquisition();
    await f.tick(3000); assert.equal(response?.httpStatus, 503);
    f.pending[0].reject(Error('PRIVATE postgres://secret connection failure')); await settleAcquisition();
    for (const connect of [() => { throw Error('PRIVATE SQL credential'); }, () => Promise.reject(Error('PRIVATE SQL credential'))]) {
      f.db.connect = connect;
      const result = await f.app.readPublic(); assert.equal(result.body.status, 'unavailable'); assert.equal(result.cache, 'no-store');
      assert(!JSON.stringify(result).match(/PRIVATE|SQL|credential/));
    }
    await f.tick(6000); assert.equal(f.pending.length, 1); assert.deepEqual(unhandled, []); assert.deepEqual(f.logs, []);
  } finally { mock.timers.reset(); process.removeListener('unhandledRejection', onUnhandled); }
});

test('CAL-05B: concurrent timeouts release each late checkout once and preserve recovery', async () => {
  const seed = fixture(); await seed.authorize(); await seed.app.refresh();
  const saved = structuredClone(seed.db.snapshot);
  const row = { ...saved, current_credential_version: seed.db.credential.credential_version, credentials_ready: true };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = acquisitionFixture(), responses = [];
    for (let i = 0; i < 12; i++) f.app.readPublic().then(value => responses.push(value));
    await settleAcquisition(); assert.equal(f.pending.length, 12);
    await f.tick(3000); assert.equal(responses.length, 12);
    assert(responses.every(result => result.httpStatus === 503 && result.cache === 'no-store' && result.body.status === 'unavailable'));
    const clients = f.pending.map(() => acquisitionClient());
    for (let i = 11; i >= 0; i--) f.pending[i].resolve(clients[i]);
    await settleAcquisition();
    for (const client of clients) { assert.deepEqual(client.releases, [undefined]); assert.equal(client.queries.length, 0); }
    const recovered = acquisitionClient(async () => ({ rows: [row] }));
    f.db.connect = async () => recovered;
    const result = await f.app.readPublic(); assert.equal(result.body.status, 'ready');
    assert.deepEqual(recovered.releases, [false]); assert.equal(recovered.listenerCount('error'), 0);
    assert.equal(recovered.queries[0].query_timeout, 3000); assert.match(recovered.queries[0].text, /^SELECT /);
    assert.deepEqual(seed.db.snapshot, saved); assert.equal(f.calls.length, 0);
  } finally { mock.timers.reset(); }
});

test('CAL-05B: acquisition and query deadlines are independent; connection errors clean up once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = acquisitionFixture(); let complete, result;
    const client = acquisitionClient(() => new Promise(resolve => { complete = resolve; }));
    f.app.readPublic().then(value => { result = value; }); await settleAcquisition();
    await f.tick(2999); f.pending[0].resolve(client); await settleAcquisition();
    assert.equal(client.queries[0].query_timeout, 3000);
    await f.tick(1); assert.equal(result, undefined); assert.deepEqual(client.releases, []);
    complete({ rows: [] }); await settleAcquisition();
    assert.equal(result.body.status, 'unavailable'); assert.deepEqual(client.releases, [false]);
    assert.equal(client.listenerCount('error'), 0);
    await f.tick(6000); assert.deepEqual(client.releases, [false]);

    let rejectQuery;
    const broken = acquisitionClient(() => new Promise((_, reject) => { rejectQuery = reject; }));
    f.db.connect = async () => broken;
    const failed = f.app.readPublic(); await settleAcquisition();
    broken.emit('error', Error('PRIVATE connection failure'));
    assert.equal((await failed).body.status, 'unavailable'); assert.deepEqual(broken.releases, [true]);
    rejectQuery(Error('PRIVATE late query rejection')); await settleAcquisition();
    assert.deepEqual(broken.releases, [true]); assert.equal(broken.listenerCount('error'), 0);

    // Guard even when a delayed event loop delivers the connection before its timer callback.
    const late = acquisitionClient(); f.db.connect = () => { f.advance(3000); return Promise.resolve(late); };
    assert.equal((await f.app.readPublic()).body.status, 'unavailable');
    assert.deepEqual(late.releases, [undefined]); assert.equal(late.queries.length, 0);
  } finally { mock.timers.reset(); }
});

test('CAL-05B: actual pg Client still enforces the separate 3000ms query timeout', async () => {
  // Exercise installed driver timeout code without ever connecting a socket.
  const { Client } = require('pg');
  const client = new Client(), releases = [];
  client.release = destroy => releases.push(destroy);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const f = acquisitionFixture(); let result;
    f.app.readPublic().then(value => { result = value; }); await settleAcquisition();
    await f.tick(2000); f.pending[0].resolve(client); await settleAcquisition();
    await f.tick(2999); assert.equal(result, undefined); assert.deepEqual(releases, []);
    await f.tick(1); assert.equal(result?.body.status, 'unavailable'); assert.equal(result.httpStatus, 503);
    assert.deepEqual(releases, [true]); assert.equal(client.listenerCount('error'), 0);
    await f.tick(6000); assert.deepEqual(releases, [true]);
  } finally { mock.timers.reset(); await client.end(); }
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.run(); console.log(`PASS ${item.name}`); }
    catch (error) { failed++; console.error(`FAIL ${item.name}: ${error.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} CAL-03/CAL-04/CAL-05A/CAL-05B/CAL-08 checks passed (mocked services; isolated HTTP/pg-driver checks; no live Todoist or PostgreSQL).`);
  process.exitCode = failed ? 1 : 0;
})();
