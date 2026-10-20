'use strict';

// Mocked, isolated structural/contract checks. This never imports server.js, db.js or environment files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildWrestlingMissingDataResponse: build, QUERIES, QUERY_TIMEOUT_MS, REQUIRED_COLUMNS, TABLES, CHECKS, safeCount } = require('../wrestling-missing-data');

const schemaRows = Object.entries(REQUIRED_COLUMNS).flatMap(([entity, columns]) => columns.map((column_name) => ({ table_name: TABLES[entity], column_name })));
const blank = (value) => value == null || /^\s*$/.test(value);
const present = (value) => value != null;
const fixtures = {
  shows: [
    { id: 1, show_id: 101, show_key: 'public-key-101', show_name: 'Public show', date: 'Unparsed source date', show_date: null, promotion: 'Public promotion', matches: [{ notes: 'Segment without participants' }], venue_id: null, poster: null },
    { id: 2, show_id: null, show_key: '\t\n', show_name: ' ', date: null, promotion: '\n', matches: null },
    { id: 3, show_id: 103, show_key: 'public-key-103', show_name: 'Another show', date: '\t', promotion: 'Public promotion', matches: { segment: true } }
  ],
  people: [
    { id: 1, name: 'Public person', category: 'wrestler', slug: null, portrait_url: null, notes: null },
    { id: 2, name: '\n\t', category: ' ', slug: 'public-person-2' },
    { id: null, name: null, category: null }
  ],
  venues: [
    { id: 1, venue_id: 'public-venue-1', venue_name: 'Public venue', latitude: null, longitude: null, city: null },
    { id: 2, venue_id: null, venue_name: '\t', latitude: 0, longitude: null },
    { id: 3, venue_id: 'public-venue-3', venue_name: 'Another venue', latitude: null, longitude: 0 },
    { id: 4, venue_id: 'public-venue-4', venue_name: 'Coordinate venue', latitude: 0, longitude: 0 }
  ]
};
const predicates = {
  showsMissingIdentity: (row) => [row.show_id == null && 'show_id', blank(row.show_key) && 'show_key', blank(row.show_name) && 'show_name'].filter(Boolean),
  showsMissingDate: (row) => blank(row.date) ? ['date'] : [],
  showsMissingMetadata: (row) => blank(row.promotion) ? ['promotion'] : [],
  peopleMissingIdentity: (row) => [row.id == null && 'id', blank(row.name) && 'name'].filter(Boolean),
  peopleMissingClassification: (row) => blank(row.category) ? ['category'] : [],
  venuesMissingIdentity: (row) => [blank(row.venue_id) && 'venue_id', blank(row.venue_name) && 'venue_name'].filter(Boolean),
  venuesIncompleteCoordinates: (row) => present(row.latitude) !== present(row.longitude) ? [row.latitude == null ? 'latitude' : 'longitude'] : []
};

// This reference reducer creates PostgreSQL-shaped mock aggregate rows. Actual SQL execution is separate QA.
function aggregate(entity, records) {
  const result = { total_records: String(records.length) };
  for (const spec of CHECKS.filter((check) => check.entity === entity)) {
    const affected = records.filter((record) => predicates[spec.key](record).length);
    result[spec.column] = String(affected.length);
    result[`${spec.column}_examples`] = affected.slice(0, 10).map((record) => ({
      id: String(entity === 'shows' ? record.show_id ?? record.id ?? '' : entity === 'venues' ? record.venue_id ?? record.id ?? '' : record.id ?? ''),
      name: entity === 'shows' ? record.show_name : entity === 'people' ? record.name : record.venue_name,
      missingFields: predicates[spec.key](record)
    }));
  }
  if (entity === 'shows') {
    result.embedded_entries = String(records.reduce((sum, record) => sum + (Array.isArray(record.matches) ? record.matches.length : 0), 0));
    result.unsupported_rows = String(records.filter((record) => !Array.isArray(record.matches)).length);
  }
  return result;
}

function database({ schema = schemaRows, records = fixtures, overrides = {}, fail = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(config) {
      const key = Object.keys(QUERIES).find((entry) => QUERIES[entry] === config.text);
      assert.ok(key, 'Only fixed allowlisted SELECTs are dispatched');
      assert.equal(config.query_timeout, 2500);
      assert.deepEqual(config.values, key === 'schema' ? [Object.values(TABLES)] : []);
      calls.push(key);
      if (fail.includes(key)) throw new Error('Do not leak password=private-test-value or database connection details');
      return key === 'schema' ? { rows: schema } : { rows: [{ ...aggregate(key, records[key]), ...(overrides[key] || {}) }] };
    }
  };
}

const tests = [];
const test = (name, check) => tests.push({ name, check });
test('all diagnostic queries are bounded SELECTs without writes or entry/relationship expansion', () => {
  assert.equal(QUERY_TIMEOUT_MS, 2500);
  for (const [name, sql] of Object.entries(QUERIES)) {
    assert.match(sql, /^(SELECT|WITH)\b/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|CALL|COPY|DO|GRANT|REVOKE|SET|BEGIN|COMMIT|JOIN|UNNEST|jsonb_array_elements)\b/i);
    assert.doesNotMatch(sql, /\b(pg_sleep|set_config|ensure\w*|repair\w*)\s*\(/i);
    if (name !== 'schema') {
      assert.equal((sql.match(/FROM public\.wrestling_\w+/g) || []).length, 1);
      assert.equal((sql.match(/LIMIT 10/g) || []).length, CHECKS.filter((spec) => spec.entity === name).length);
      assert.doesNotMatch(sql, /row_to_json|to_jsonb\s*\(|raw_sheet|portrait_url|notes|authorization|password|token/i);
    }
  }
  assert.match(QUERIES.shows, /CASE WHEN jsonb_typeof\(matches\) = 'array' THEN jsonb_array_length\(matches\) ELSE NULL END/);
  assert.doesNotMatch(QUERIES.shows, /show_date|participants|winner|match_type/);
  assert.doesNotMatch(QUERIES.people, /slug|portrait/);
  assert.match(QUERIES.venues, /missing_latitude <> missing_longitude/g);
  for (const field of ['show_key', 'show_name', 'date', 'promotion']) assert.ok(QUERIES.shows.includes(`coalesce(${field}, '') ~ '^[[:space:]]*$'`));
});
test('NULL, empty and whitespace fields produce exact per-check counts; optional fields stay excluded', async () => {
  const db = database();
  const result = await build({ db });
  assert.deepEqual(db.calls, ['schema', 'shows', 'people', 'venues']);
  assert.equal(result.database.connected, true);
  assert.equal(result.state, 'Warning');
  assert.deepEqual(result.counts, { shows: 3, people: 3, venues: 4, embeddedEntries: null });
  assert.deepEqual(result.checks.map((check) => check.count), [1, 2, 1, 2, 2, 1, 2]);
  assert.deepEqual(result.checks.find((check) => check.key === 'venuesIncompleteCoordinates').examples.map((sample) => sample.missingFields), [['longitude'], ['latitude']]);
  assert.equal(result.coverage.embeddedEntries.count, 1);
  assert.equal(result.coverage.embeddedEntries.unsupportedRows, 2); // show rows may exceed counted entries
  assert.equal(result.coverage.embeddedEntries.complete, false);
  assert.equal(result.coverage.embeddedEntries.state, 'Unavailable');
  assert.match(result.coverage.embeddedEntries.reason, /partial subtotal.*unsupported/);
  assert.ok(Object.values(result.timings).every((value) => typeof value === 'number' && value >= 0));
});
test('healthy empty tables are verified zero; valid embedded segments have no assumed participant requirement', async () => {
  const empty = await build({ db: database({ records: { shows: [], people: [], venues: [] } }) });
  assert.equal(empty.state, 'Healthy');
  assert.ok(empty.checks.every((check) => check.count === 0 && check.totalRecords === 0 && check.state === 'Healthy'));
  const valid = await build({ db: database({ records: { shows: [fixtures.shows[0]], people: [fixtures.people[0]], venues: [fixtures.venues[0], fixtures.venues[3]] } }) });
  assert.equal(valid.state, 'Healthy');
  assert.deepEqual(valid.warnings, []);
  assert.equal(valid.checks.length, 7);
  assert.equal(valid.counts.embeddedEntries, 1);
  assert.equal(valid.coverage.embeddedEntries.complete, true);
  assert.equal(valid.coverage.embeddedEntries.state, 'Unavailable');
});
test('missing required schema marks affected collection unavailable without inventing zero', async () => {
  const db = database({ schema: schemaRows.filter((row) => row.table_name !== 'wrestling_people') });
  const result = await build({ db });
  assert.deepEqual(db.calls, ['schema', 'shows', 'venues']);
  assert.equal(result.counts.people, null);
  assert.ok(result.checks.filter((check) => check.entity === 'people').every((check) => check.state === 'Unavailable' && check.count === null && check.totalRecords === null && check.examples.length === 0));
  assert.equal(result.counts.shows, 3);
  const missingDate = await build({ db: database({ schema: schemaRows.filter((row) => !(row.table_name === 'wrestling_shows' && row.column_name === 'date')) }) });
  assert.equal(missingDate.counts.shows, null);
  assert.equal(missingDate.counts.embeddedEntries, null);
});
test('individual collection errors preserve other current results and never expose error details', async () => {
  const result = await build({ db: database({ fail: ['people'] }) });
  assert.equal(result.database.connected, true);
  assert.equal(result.counts.people, null);
  assert.equal(result.counts.venues, 4);
  assert.equal(result.state, 'Error');
  assert.doesNotMatch(JSON.stringify(result), /private-test-value|password=/);
});
test('unverified database connectivity fails closed without executing collection queries', async () => {
  const db = database({ fail: ['schema'] });
  const result = await build({ db });
  assert.deepEqual(db.calls, ['schema']);
  assert.equal(result.ok, false);
  assert.equal(result.database.connected, false);
  assert.equal(result.state, 'Unavailable');
  assert.ok(result.checks.every((check) => check.count === null));
  assert.doesNotMatch(JSON.stringify(result), /private-test-value/);
});
test('count parsing rejects unsafe, missing, negative, noninteger and malformed data', async () => {
  for (const input of [null, undefined, '', ' ', '-1', '1.2', '01', 'Infinity', '9007199254740992', NaN, Infinity, -1, 1.1, {}, []]) assert.equal(safeCount(input), null);
  assert.equal(safeCount('0'), 0);
  assert.equal(safeCount('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.equal(safeCount(3), 3);
  const result = await build({ db: database({ overrides: { people: { total_records: '9007199254740992' } } }) });
  assert.equal(result.counts.people, null);
  assert.equal(result.state, 'Error');
  const excess = await build({ db: database({ overrides: { people: { people_missing_identity: '4' } } }) });
  assert.equal(excess.counts.people, null);
});
test('example output is limited, field allowlisted, and excludes raw nested/private fields', async () => {
  const samples = Array.from({ length: 20 }, (_, id) => ({ id: 'i'.repeat(250), name: 'n'.repeat(300), missingFields: ['name', 'password_hash', 'name'], password_hash: 'private-test-value', nested: { secret: true } }));
  const result = await build({ db: database({ overrides: { people: { total_records: '20', people_missing_identity: '20', people_missing_identity_examples: samples } } }) });
  const examples = result.checks.find((check) => check.key === 'peopleMissingIdentity').examples;
  assert.equal(examples.length, 10);
  assert.deepEqual(Object.keys(examples[0]), ['id', 'name', 'missingFields']);
  assert.equal(examples[0].id.length, 100);
  assert.equal(examples[0].name.length, 160);
  assert.deepEqual(examples[0].missingFields, ['name']);
  assert.doesNotMatch(JSON.stringify(examples), /password_hash|private-test-value|nested|secret/);
});
test('malformed examples and impossible embedded storage counts do not become healthy results', async () => {
  const malformed = await build({ db: database({ overrides: { shows: { shows_missing_identity_examples: {} } } }) });
  assert.equal(malformed.counts.shows, null);
  assert.equal(malformed.state, 'Error');
  const impossible = await build({ db: database({ overrides: { shows: { unsupported_rows: '4' } } }) });
  assert.equal(impossible.counts.shows, null);
  assert.equal(impossible.coverage.embeddedEntries.count, null);
});
test('route uses existing Admin middleware, no-store and connectivity-based HTTP status without server startup', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const prefix = "app.get('/api/admin/diagnostics/wrestling/missing-data', ";
  const begin = source.indexOf(prefix);
  const end = source.indexOf("app.get('/api/admin/diagnostics/wrestling',", begin);
  assert.ok(begin > 0 && end > begin);
  assert.ok(source.indexOf("app.use(['/api/admin', '/admin/import', '/admin/smug', '/api/wrestling/people/import'], requireAdminAccess)") < begin);
  const routeSource = source.slice(begin, end);
  assert.doesNotMatch(routeSource, /ensure\w+|apply\w+|ADMIN_TOKEN|authorizeSession|loadLocalEnv/);
  let handler;
  let outcome = { database: { connected: true }, state: 'Warning' };
  const context = { app: { get: (route, callback) => { assert.equal(route, '/api/admin/diagnostics/wrestling/missing-data'); handler = callback; } }, dbPool: {}, buildWrestlingMissingDataResponse: async () => outcome };
  vm.runInNewContext(routeSource, context);
  const res = { locals: {}, headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  outcome = { database: { connected: false }, state: 'Unavailable' };
  await handler({}, res);
  assert.equal(res.code, 503);
  context.buildWrestlingMissingDataResponse = async () => { throw new Error('private-test-value'); };
  await handler({}, res);
  assert.equal(res.code, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /private-test-value/);
});
test('existing shared authorization rejects missing/forged credentials and accepts V3 or legitimate legacy access (isolated mocks)', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const begin = source.indexOf('async function requireAdminAccess(');
  const end = source.indexOf('function requireRefreshAdminAccess(', begin);
  const context = {
    getConfiguredAdminSecrets: () => ['fixture-legacy-secret'], getAdminProtectionStatus: () => ({ required: true }),
    getRequestAdminTokens: (req) => req.tokens || [], adminTokenMatches: (token, secrets) => secrets.includes(token),
    v3AdminAuthRouter: { authorizeSession: async () => undefined }, buildAdminAccessError: (_, code) => ({ code }),
    adminProtectionWarningLogged: false, console: { warn() {} }
  };
  vm.runInNewContext(source.slice(begin, end), context);
  const guard = context.requireAdminAccess;
  const response = () => ({ locals: {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  let next = 0;
  for (const request of [{}, { tokens: ['forged'] }]) {
    const res = response(); await guard(request, res, () => next++); assert.equal(res.code, 401);
  }
  assert.equal(next, 0);
  await guard({ tokens: ['fixture-legacy-secret'] }, response(), () => next++);
  assert.equal(next, 1);
  context.v3AdminAuthRouter.authorizeSession = async () => true;
  const valid = response(); await guard({}, valid, () => next++);
  assert.equal(next, 2); assert.equal(valid.locals.v3AdminSessionAuthorized, true);
  context.v3AdminAuthRouter.authorizeSession = async (_, res) => { res.status(401).json({ code: 'SESSION_EXPIRED' }); return false; };
  const expired = response(); await guard({}, expired, () => next++);
  assert.equal(expired.code, 401); assert.equal(next, 2);
});

(async () => {
  let passed = 0;
  for (const { name, check } of tests) {
    await check();
    passed++;
    console.log(`PASS ${name}`);
  }
  console.log(`${passed} focused checks passed. PostgreSQL execution and browser layout are separate verification.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
