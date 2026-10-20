'use strict';

// Isolated structural/contract tests. No server startup, environment reads or database connections.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildExactDuplicatesResponse: build, DEFINITIONS, SCHEMA_QUERY, QUERIES, QUERY_TIMEOUT_MS, safeCount } = require('../exact-duplicates');
const allSpecs = Object.values(DEFINITIONS).flat();
const blank = value => value == null || /^[\t\n\v\f\r ]*$/.test(String(value));
const postgresLeft = value => value == null ? null : Array.from(String(value)).slice(0, 161).join('');

function record(spec, id, identifier, extra = {}) {
  const fields = Object.fromEntries(spec.fields.map(field => [field, field === 'id' ? String(id) : `${field} fixture`]));
  fields[spec.criterion] = identifier;
  return { ...fields, ...extra };
}

function fixtureRecords(duplicate = false) {
  return Object.fromEntries(allSpecs.map(spec => {
    const numeric = ['show_id', 'person_id'].includes(spec.criterion);
    const first = numeric ? '101' : `${spec.table}-first`, second = numeric ? '102' : `${spec.table}-second`;
    return [spec.table, [
      record(spec, 1, first, { [spec.name]: 'Shared public name' }),
      record(spec, 2, duplicate ? first : second, { [spec.name]: 'Shared public name' })
    ]];
  }));
}

function aggregate(spec, input, groupLimit) {
  const records = input.slice(0, 10001);
  const oversized = records.filter(row => row[spec.criterion] != null && Buffer.byteLength(String(row[spec.criterion]), 'utf8') > 256).length;
  const grouped = new Map();
  if (records.length <= 10000 && oversized === 0) for (const row of records) {
    if (blank(row[spec.criterion])) continue;
    const key = String(row[spec.criterion]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const groups = [...grouped].filter(([, members]) => members.length > 1).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return {
    scanned_rows: String(records.length), oversized_keys: String(oversized),
    duplicate_count: String(groups.length), affected_rows: String(groups.reduce((sum, [, members]) => sum + members.length, 0)),
    groups: groups.slice(0, groupLimit).map(([identifier, members]) => ({
      identifier: postgresLeft(identifier), recordCount: String(members.length),
      records: members.slice(0, 2).map(row => ({
        id: postgresLeft(row.id), name: postgresLeft(row[spec.name]),
        fields: Object.fromEntries(spec.fields.map(field => [field, postgresLeft(row[field])]))
      }))
    }))
  };
}

function createMockDatabase({ records = fixtureRecords(), missingColumns = [], unusableIndexes = [], fail = [], overrides = {} } = {}) {
  const calls = [];
  return { calls, async query(config) {
    assert.equal(config.query_timeout, 2000);
    if (config.text === SCHEMA_QUERY) {
      calls.push({ table: 'schema', values: config.values });
      if (fail.includes('schema')) throw new Error('private credentials must not be returned');
      return { rows: allSpecs.filter(spec => config.values[0].includes(spec.table)).flatMap(spec => spec.fields
        .filter(field => !missingColumns.includes(`${spec.table}.${field}`))
        .map(column_name => ({ table_name: spec.table, column_name, id_index_usable: !unusableIndexes.includes(spec.table) }))) };
    }
    const spec = allSpecs.find(item => QUERIES[item.table] === config.text);
    assert.ok(spec, 'Only fixed SELECTs are allowed');
    assert.equal(config.values.length, 1);
    assert.ok(Number.isInteger(config.values[0]) && config.values[0] >= 0 && config.values[0] <= 10);
    calls.push({ table: spec.table, values: config.values });
    if (fail.includes(spec.table)) throw new Error('private password_hash/database-token must not be returned');
    return { rows: [{ ...aggregate(spec, records[spec.table] || [], config.values[0]), ...(overrides[spec.table] || {}) }] };
  } };
}

const tests = [];
const test = (name, check) => tests.push({ name, check });
test('fixed read-only SQL guards valid indexes and bounds probes before grouping', () => {
  assert.equal(QUERY_TIMEOUT_MS, 2000);
  assert.match(SCHEMA_QUERY, /index_info\.indisunique AND index_info\.indisvalid AND index_info\.indisready/);
  assert.match(SCHEMA_QUERY, /index_info\.indnatts = 1 AND index_info\.indkey\[0\] = attribute\.attnum/);
  assert.match(SCHEMA_QUERY, /attribute\.attnotnull/);
  assert.match(SCHEMA_QUERY, /index_info\.indpred IS NULL AND index_info\.indexprs IS NULL AND access_method\.amname = 'btree'/);
  for (const sql of [SCHEMA_QUERY, ...Object.values(QUERIES)]) {
    assert.match(sql, /^(SELECT|WITH)\b/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|CALL|COPY|DO|SET|BEGIN|COMMIT|UNNEST|jsonb_array_elements|pg_sleep|set_config)\b/i);
  }
  for (const spec of allSpecs) {
    const sql = QUERIES[spec.table];
    assert.match(sql, /ORDER BY id ASC LIMIT 10001/);
    assert.match(sql, /scanned_rows::bigint FROM scan_stats\) <= 10000/);
    assert.match(sql, /oversized_keys::bigint FROM scan_stats\) = 0/);
    assert.match(sql, /COLLATE "C"/);
    assert.ok(sql.includes(`WHEN octet_length(${spec.criterion}::text) > 256 THEN NULL`));
    assert.ok(sql.includes(`WHEN ${spec.criterion}::text ~ '^[[:space:]]*$' THEN NULL`));
    assert.doesNotMatch(sql, /lower\(|trim\(|notes|raw_sheet|portrait|password|token|album|match_url/i);
    assert.equal((sql.match(/FROM public\./g) || []).length, 2);
    assert.doesNotMatch(sql.slice(sql.indexOf('WITH scanned AS'), sql.indexOf('), scan_stats AS')), /jsonb_build_object|left\(/);
    assert.match(sql, /member\.id = bounded_members\.row_id/);
    assert.match(sql, /ORDER BY row_id ASC LIMIT 2/);
    assert.match(sql, /ORDER BY exact_key COLLATE "C" LIMIT \$1/);
  }
});
test('all seven verified nonduplicate collections return exact zero without shared-name false positives', async () => {
  for (const archive of ['music', 'wrestling']) {
    const db = createMockDatabase(), result = await build({ db, archive });
    assert.equal(result.database.connected, true); assert.equal(result.state, 'Healthy'); assert.deepEqual(result.warnings, []);
    assert.equal(result.checks.length, DEFINITIONS[archive].length);
    assert.ok(result.checks.every(check => check.count === 0 && check.affectedRows === 0 && check.scannedRows === 2 && check.coverage.complete && !check.groups.length));
    assert.equal(db.calls.length, DEFINITIONS[archive].length + 1);
    assert.ok(Object.values(result.timings.collections).every(value => value >= 0));
  }
});
test('real duplicate-shaped aggregate fixtures project two actual IDs and conservative field comparisons', async () => {
  for (const archive of ['music', 'wrestling']) {
    const result = await build({ db: createMockDatabase({ records: fixtureRecords(true) }), archive });
    assert.equal(result.state, 'Warning');
    for (const check of result.checks) {
      assert.equal(check.count, 1); assert.equal(check.affectedRows, 2);
      const group = check.groups[0]; assert.equal(group.recordCount, 2); assert.equal(group.previewComplete, true);
      assert.deepEqual(group.records.map(item => item.id), ['1', '2']);
      assert.equal(group.comparison.find(item => item.field === check.criterion).status, 'Matching');
      assert.equal(group.comparison.find(item => item.field === 'id').status, 'Different');
    }
  }
});
test('case differences, edge whitespace, NULL and blank IDs are not normalized into exact matches', async () => {
  const spec = DEFINITIONS.music[0], records = fixtureRecords();
  records[spec.table] = ['Case-ID', 'case-id', ' Case-ID', 'Case-ID ', '', '\t\n', null].map((key, index) => record(spec, index + 1, key));
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' });
  assert.equal(result.checks[0].count, 0); assert.equal(result.checks[0].scannedRows, 7);
});
test('archive-wide preview caps at ten groups and each group previews two of its actual members', async () => {
  const records = fixtureRecords(true), spec = DEFINITIONS.music[0];
  records[spec.table] = Array.from({ length: 12 }, (_, group) => Array.from({ length: 3 }, (_, member) => record(spec, group * 3 + member + 1, `key-${String(group).padStart(2, '0')}`))).flat();
  const db = createMockDatabase({ records }), result = await build({ db, archive: 'music' });
  assert.equal(result.checks[0].count, 12); assert.equal(result.checks[0].affectedRows, 36); assert.equal(result.checks[0].groups.length, 10);
  assert.ok(result.checks[0].groups.every(group => group.records.length === 2 && !group.previewComplete && group.recordCount === 3));
  assert.equal(result.checks.reduce((sum, check) => sum + check.groups.length, 0), 10);
  assert.ok(db.calls.slice(2).every(call => call.values[0] === 0));
});
test('ten-thousand-row coverage boundary is exact and the extra probe row makes global counts unavailable', async () => {
  const records = fixtureRecords(), spec = DEFINITIONS.wrestling[0];
  records[spec.table] = Array.from({ length: 10000 }, (_, index) => record(spec, index + 1, `key-${index}`));
  const complete = await build({ db: createMockDatabase({ records }), archive: 'wrestling' });
  assert.equal(complete.checks[0].count, 0); assert.equal(complete.checks[0].coverage.complete, true);
  records[spec.table].push(record(spec, 10001, 'key-extra'), record(spec, 10002, 'key-0'));
  const limited = await build({ db: createMockDatabase({ records }), archive: 'wrestling' });
  assert.equal(limited.checks[0].count, null); assert.equal(limited.checks[0].affectedRows, null);
  assert.equal(limited.checks[0].scannedRows, 10001); assert.equal(limited.checks[0].coverage.complete, false);
  assert.equal(limited.checks[0].state, 'Unavailable'); assert.equal(limited.checks[1].count, 0);
});
test('oversized identifiers make the entire criterion unavailable instead of silently producing zero', async () => {
  const records = fixtureRecords(), spec = DEFINITIONS.music[0]; records[spec.table][0][spec.criterion] = '😀'.repeat(65);
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' });
  assert.equal(result.checks[0].state, 'Unavailable'); assert.equal(result.checks[0].count, null); assert.equal(result.checks[0].affectedRows, null);
  assert.match(result.checks[0].coverage.reason, /256-byte/); assert.equal(result.checks[0].scannedRows, 2);
});
test('missing schema or usable id index prevents the collection probe and preserves other results', async () => {
  const db = createMockDatabase({ missingColumns: ['music_bands.band_id'], unusableIndexes: ['music_people'] });
  const result = await build({ db, archive: 'music' });
  assert.deepEqual(db.calls.map(call => call.table), ['schema', 'music_shows', 'music_venues']);
  assert.equal(result.checks[0].count, null); assert.equal(result.checks[2].count, null);
  assert.equal(result.checks[1].state, 'Healthy'); assert.equal(result.state, 'Unavailable');
});
test('database and collection failures have generic safe errors and truthful null counts', async () => {
  const unavailable = await build({ db: createMockDatabase({ fail: ['schema'] }), archive: 'wrestling' });
  assert.equal(unavailable.ok, false); assert.equal(unavailable.database.connected, false);
  assert.ok(unavailable.checks.every(check => check.count === null));
  const partial = await build({ db: createMockDatabase({ fail: ['music_people'] }), archive: 'music' });
  assert.equal(partial.ok, true); assert.equal(partial.database.connected, true); assert.equal(partial.state, 'Error');
  assert.equal(partial.checks[2].count, null); assert.equal(partial.checks[0].count, 0);
  assert.doesNotMatch(JSON.stringify([unavailable, partial]), /private credentials|password_hash|database-token/);
});
test('unsafe count precision and impossible count/member combinations are rejected', async () => {
  for (const input of [null, undefined, '', ' ', '01', '-1', '1.2', '9007199254740992', [], {}, Infinity, NaN]) assert.equal(safeCount(input), null);
  assert.equal(safeCount('9007199254740991'), Number.MAX_SAFE_INTEGER); assert.equal(safeCount('0'), 0);
  for (const invalid of [{ scanned_rows: '10002' }, { duplicate_count: '2', affected_rows: '2' }, { affected_rows: '9007199254740992' }, { oversized_keys: '3' }]) {
    const result = await build({ db: createMockDatabase({ overrides: { music_bands: invalid } }), archive: 'music' });
    assert.equal(result.checks[0].state, 'Error'); assert.equal(result.checks[0].count, null);
  }
});
test('display values are JSON-byte bounded, clipped comparisons unknown and private fields omitted', async () => {
  const spec = DEFINITIONS.music[0], records = fixtureRecords(true);
  records[spec.table].forEach(row => { row.band = '\u0001'.repeat(161); row.status = null; row.region = '😀'.repeat(161); row.password_hash = 'private-value'; row.notes = 'private notes'; });
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' }), group = result.checks[0].groups[0];
  assert.equal(group.comparison.find(item => item.field === 'band').status, 'Unknown');
  assert.equal(group.comparison.find(item => item.field === 'region').status, 'Unknown');
  assert.equal(group.comparison.find(item => item.field === 'status').status, 'Unknown');
  for (const member of group.records) for (const value of Object.values(member.fields)) if (value !== null) {
    assert.ok(value.length <= 160); assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 160);
  }
  assert.ok(group.records[0].truncatedFields.includes('band')); assert.ok(group.records[0].truncatedFields.includes('region'));
  assert.doesNotMatch(JSON.stringify(group), /password_hash|private-value|private notes/);
});
test('clipped long identifier previews do not imply the clipped fields match and remain bounded', async () => {
  const spec = DEFINITIONS.music[0], records = fixtureRecords(true), identifier = ' '.repeat(200) + 'A';
  records[spec.table].forEach(row => { row[spec.criterion] = identifier; });
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' }), group = result.checks[0].groups[0];
  assert.equal(result.checks[0].count, 1); assert.equal(group.identifierTruncated, true);
  assert.equal(group.comparison.find(item => item.field === spec.criterion).status, 'Unknown');
});
test('maximum public preview stays below the frontend response cap even for escaped values', async () => {
  const spec = DEFINITIONS.music[1], records = fixtureRecords();
  records[spec.table] = Array.from({ length: 10 }, (_, group) => [1, 2].map((member) => record(spec, group * 2 + member, String(group + 1), Object.fromEntries(spec.fields.filter(field => !['id', spec.criterion].includes(field)).map(field => [field, '\u0001'.repeat(161)]))))).flat();
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' });
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 96 * 1024);
});
test('a source record cannot appear in two exact groups for one canonical criterion', async () => {
  const spec = DEFINITIONS.music[0], records = fixtureRecords();
  records[spec.table] = [record(spec, 1, 'first'), record(spec, 2, 'first'), record(spec, 1, 'second'), record(spec, 4, 'second')];
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' });
  assert.equal(result.checks[0].state, 'Error'); assert.equal(result.checks[0].count, null);
});
test('embedded-match exact detection remains explicitly unavailable with no entry scans', async () => {
  const result = await build({ db: createMockDatabase(), archive: 'wrestling' });
  assert.equal(result.coverage.embeddedMatches.state, 'Unavailable');
  assert.match(result.coverage.embeddedMatches.reason, /no verified stable match identifier/);
  assert.ok(result.checks.every(check => check.collection !== 'matches'));
});
test('both fixed routes inherit existing authorization, set no-store and map connectivity without startup', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const archive of ['music', 'wrestling']) {
    const begin = source.indexOf(`app.get('/api/admin/diagnostics/${archive}/exact-duplicates', `);
    const end = source.indexOf('\napp.get(', begin + 1);
    assert.ok(begin > source.indexOf("app.use(['/api/admin', '/admin/import', '/admin/smug', '/api/wrestling/people/import'], requireAdminAccess)"));
    let handler, calledArchive; let connected = true;
    const context = { app: { get: (_, callback) => { handler = callback; } }, dbPool: {}, buildExactDuplicatesResponse: async args => { calledArchive = args.archive; return { database: { connected } }; } };
    vm.runInNewContext(source.slice(begin, end), context);
    const res = { headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ query: { archive: 'forged', limit: '999999' } }, res);
    assert.equal(calledArchive, archive); assert.equal(res.code, 200); assert.equal(res.headers['Cache-Control'], 'no-store');
    connected = false; await handler({}, res); assert.equal(res.code, 503);
    context.buildExactDuplicatesResponse = async () => { throw new Error('private-value'); };
    await handler({}, res); assert.equal(res.code, 503); assert.doesNotMatch(JSON.stringify(res.body), /private-value/);
  }
});

async function run() {
  for (const { name, check } of tests) { await check(); console.log(`PASS ${name}`); }
  console.log(`${tests.length} focused structural/mock checks passed. Actual PostgreSQL execution remains separate verification.`);
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { createMockDatabase, fixtureRecords, record, aggregate };
