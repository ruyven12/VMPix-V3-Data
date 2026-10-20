'use strict';

// Inert source-shaped fixtures only: this never loads server/db/environment or connects to PostgreSQL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildPossibleDuplicatesResponse: build, DEFINITIONS, QUERIES, SCHEMA_QUERY, MATCHING_KEYS, normalize, validDate } = require('../possible-duplicates');
const specs = Object.values(DEFINITIONS).flat();
const postgresLeft = value => value == null ? null : Array.from(String(value)).slice(0, 161).join('');
function record(spec, id, canonicalId, overrides = {}) {
  const numeric = ['show_id', 'person_id'].includes(spec.criterion);
  return {
    id: String(id), [spec.criterion]: canonicalId ?? (numeric ? String(100 + id) : `${spec.table}-${id}`), [spec.name]: `Public record ${id}`,
    location: 'Brunswick', city: 'Brunswick', state: 'Maine', country: 'United States', region: 'New England', status: 'Active',
    category: 'Performer', show_date: '2026-10-16', venue_id: spec.collection === 'shows' ? 'public-venue-id' : canonicalId ?? `${spec.table}-${id}`,
    venue: 'Public Venue', promotion: 'Public Promotion', latitude: '43.9', longitude: '-69.9',
    aliases: [], bands: [{ band: 'Public Band', instrument: 'Public instrument' }], teams: ['Public Team'], [spec.name]: `Public record ${id}`, ...overrides
  };
}
function fixtureRecords(candidates = false) {
  return Object.fromEntries(specs.map(spec => [spec.table, [record(spec, 1), record(spec, 2, undefined, candidates ? { [spec.name]: '  PUBLIC  RECORD 1 ' } : {})]]));
}
function projectRow(spec, source) {
  const row = { row_id: source.id == null ? null : String(source.id) };
  for (const field of spec.fields) if (!['aliases', spec.contextField].includes(field)) row[`field_${field}`] = postgresLeft(source[field]);
  if (spec.aliases) {
    for (const [prefix, field, kind] of [['alias', 'aliases', spec.aliases], ['context', spec.contextField, spec.contexts]]) {
      const value = source[field], values = Array.isArray(value) ? value : [];
      row[`${prefix}_count`] = value == null ? 0 : Array.isArray(value) ? value.length : null;
      row[prefix === 'alias' ? 'aliases_null' : 'contexts_null'] = value == null;
      row[`${prefix}_slots`] = Array.from({ length: 5 }, (_, index) => {
        let entry = values[index];
        if (prefix === 'context' && kind === 'json') entry = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.band : null;
        return typeof entry === 'string' ? postgresLeft(entry) : null;
      });
    }
  }
  return row;
}
function createMockDatabase({ records = fixtureRecords(), missing = [], noIndex = [], fail = [], override = {} } = {}) {
  const calls = [];
  return { calls, async query(config) {
    assert.equal(config.query_timeout, 2000);
    if (config.text === SCHEMA_QUERY) {
      calls.push('schema'); if (fail.includes('schema')) throw new Error('private database password');
      return { rows: specs.filter(spec => config.values[0].includes(spec.table)).flatMap(spec => spec.fields.filter(field => !missing.includes(`${spec.table}.${field}`)).map(column_name => ({ table_name: spec.table, column_name, id_index_usable: !noIndex.includes(spec.table) }))) };
    }
    const spec = specs.find(spec => QUERIES[spec.table] === config.text); assert.ok(spec);
    assert.deepEqual(config.values, []); calls.push(spec.table);
    if (fail.includes(spec.table)) throw new Error('private token/password_hash');
    return { rows: override[spec.table] || (records[spec.table] || []).slice(0, 2001).map(source => projectRow(spec, source)) };
  } };
}
const tests = [];
const test = (name, check) => tests.push({ name, check });
test('queries are fixed SELECTs with indexed ordering, row cap and five fixed array positions', () => {
  for (const spec of specs) {
    const sql = QUERIES[spec.table];
    assert.match(sql, /^SELECT /); assert.match(sql, /ORDER BY id ASC LIMIT 2001$/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|COPY|SET|CALL|UNNEST|JOIN|SIMILARITY|LEVENSHTEIN|jsonb_array_elements|jsonb_each|pg_sleep|set_config)\b/i);
    assert.doesNotMatch(sql, /raw_sheet|notes|portrait|password|authorization|token|url/i);
    assert.doesNotMatch(sql, /257/);
    assert.equal((sql.match(/FROM public\./g) || []).length, 1);
    if (spec.aliases === 'json') { assert.match(sql, /aliases->4/); assert.doesNotMatch(sql, /aliases->5|bands->5/); }
    if (spec.aliases === 'text') { assert.match(sql, /array_lower\(aliases, 1\)/); assert.match(sql, /\+ 4\]/); assert.doesNotMatch(sql, /\+ 5\]/); }
  }
  assert.match(SCHEMA_QUERY, /indisunique AND index_info.indisvalid AND index_info.indisready/);
});
test('all seven collections support fully assessed nonmatching and genuine possible fixtures', async () => {
  for (const archive of ['music', 'wrestling']) {
    const healthy = await build({ db: createMockDatabase(), archive });
    assert.equal(healthy.state, 'Healthy'); assert.ok(healthy.checks.every(check => check.count === 0 && check.sampleCount === 0 && check.eligibleRows === 2 && check.unassessedRows === 0));
    const result = await build({ db: createMockDatabase({ records: fixtureRecords(true) }), archive });
    assert.equal(result.state, 'Warning'); assert.equal(result.mode, 'manual');
    for (const check of result.checks) {
      assert.equal(check.count, 1); assert.equal(check.sampleCount, 1); assert.equal(check.groups.length, 1);
      const group = check.groups[0]; assert.equal(group.classification, 'Possible Match'); assert.equal(group.records.length, 2);
      assert.notEqual(group.records[0].matchingData.canonicalId, group.records[1].matchingData.canonicalId);
      assert.equal(group.evidence[0].kind, 'Normalized name'); assert.equal(group.comparison.find(item => item.field === 'id').status, 'Different');
      assert.deepEqual(Object.keys(group.records[0].matchingData), MATCHING_KEYS);
    }
  }
});
test('name-only, category-only and differing corroboration produce no unsupported match', async () => {
  const records = fixtureRecords(true);
  records.music_bands[1].location = 'Another city'; records.music_people[1].bands = [{ band: 'Another band' }]; records.music_venues[1].city = 'Another city';
  records.wrestling_people[1].teams = ['Another team']; records.wrestling_venues[1].country = 'Another country'; records.wrestling_shows[1].promotion = 'Another promotion';
  for (const archive of ['music', 'wrestling']) {
    const result = await build({ db: createMockDatabase({ records }), archive });
    for (const check of result.checks.filter(check => check.collection !== 'shows')) assert.equal(check.count, 0);
    if (archive === 'wrestling') assert.equal(result.checks[0].count, 0);
  }
});
test('same-named shows on different actual dates never become candidates; invalid dates are unassessed', async () => {
  const records = fixtureRecords(true); records.music_shows[1].show_date = '2026-10-17'; records.wrestling_shows[1].show_date = '2026-10-17';
  for (const archive of ['music', 'wrestling']) {
    let result = await build({ db: createMockDatabase({ records }), archive }); assert.equal(result.checks.find(check => check.collection === 'shows').count, 0);
    records[`${archive}_shows`][1].show_date = '2026-02-30';
    result = await build({ db: createMockDatabase({ records }), archive });
    const check = result.checks.find(check => check.collection === 'shows'); assert.equal(check.count, null); assert.equal(check.sampleCount, 0); assert.equal(check.unassessedRows, 1);
  }
  assert.equal(validDate('2024-02-29'), true); assert.equal(validDate('2025-02-29'), false); assert.equal(validDate('Oct 16, 2026'), false);
});
test('alias overlap requires category and shared reported band/team and produces defensible evidence', async () => {
  for (const archive of ['music', 'wrestling']) {
    const records = fixtureRecords(), people = records[`${archive}_people`];
    people[0].name = 'Alpha'; people[0].aliases = ['Beta']; people[1].name = 'Beta'; people[1].aliases = ['Alpha'];
    const result = await build({ db: createMockDatabase({ records }), archive }), check = result.checks.find(check => check.collection === 'people');
    assert.equal(check.count, 1); assert.deepEqual(check.groups[0].evidence.map(item => item.field), ['name', 'category', 'context']);
    assert.equal(check.groups[0].evidence[0].kind, 'Alias overlap');
    people[1].category = 'Different classification';
    const negative = await build({ db: createMockDatabase({ records }), archive }); assert.equal(negative.checks.find(check => check.collection === 'people').count, 0);
  }
});
test('pairs deduplicate across alias/context keys and three records produce three distinct pairs', async () => {
  const records = fixtureRecords(), spec = DEFINITIONS.music.find(spec => spec.collection === 'people');
  records[spec.table] = [1, 2, 3].map(id => record(spec, id, undefined, { name: 'Public person', aliases: ['Alternate One', 'Alternate Two'], bands: [{ band: 'Band One' }, { band: 'Band Two' }] }));
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' }), check = result.checks.find(check => check.collection === 'people');
  assert.equal(check.count, 3); assert.equal(check.groups.length, 3);
  assert.equal(new Set(check.groups.map(group => JSON.stringify(group.records.map(record => record.id).sort()))).size, 3);
});
test('same raw canonical IDs are excluded as exact-owned; ID case differences remain distinct', async () => {
  const records = fixtureRecords(true); records.music_bands[1].band_id = records.music_bands[0].band_id;
  let result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks[0].count, 0);
  records.music_bands[0].band_id = 'RAW-ID'; records.music_bands[1].band_id = 'raw-id';
  result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks[0].count, 1);
});
test('normalization preserves punctuation and diacritics; component boundaries cannot collide', async () => {
  assert.equal(normalize('  A  B  '), 'a b'); assert.notEqual(normalize('A.B'), normalize('AB')); assert.notEqual(normalize('Café'), normalize('Cafe'));
  const records = fixtureRecords(); Object.assign(records.music_bands[0], { band: 'A|B', location: 'C' }); Object.assign(records.music_bands[1], { band: 'A', location: 'B|C' });
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks[0].count, 0);
});
test('long shared prefixes in names, aliases and corroboration are unassessed instead of falsely matching', async () => {
  for (const field of ['band', 'location']) {
    const records = fixtureRecords(true); records.music_bands[0][field] = 'x'.repeat(180) + 'A'; records.music_bands[1][field] = 'x'.repeat(180) + 'B';
    const result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks[0].count, null); assert.equal(result.checks[0].sampleCount, 0); assert.equal(result.checks[0].unassessedRows, 2);
  }
  const records = fixtureRecords(true); records.music_people.forEach((row, index) => { row.aliases = ['x'.repeat(180) + index]; });
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' }); const check = result.checks.find(check => check.collection === 'people'); assert.equal(check.count, null); assert.equal(check.sampleCount, 0);
});
test('NULL optional aliases remain usable while missing optional corroboration is unassessed, not Missing Data', async () => {
  const records = fixtureRecords(true); records.music_people[0].aliases = null; records.wrestling_people[0].aliases = null;
  for (const archive of ['music', 'wrestling']) {
    const result = await build({ db: createMockDatabase({ records }), archive }), check = result.checks.find(check => check.collection === 'people'); assert.equal(check.count, 1); assert.equal(check.groups[0].records[0].fields.aliases, null);
  }
  records.music_bands[0].country = null;
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks[0].count, null); assert.match(result.checks[0].coverage.reason, /optional fields are not missing-data errors/);
});
test('malformed arrays, sixth entries and per-row key overflow yield partial counts and retain known candidates', async () => {
  const records = fixtureRecords(true), spec = DEFINITIONS.music.find(spec => spec.collection === 'people');
  records.music_people.push(record(spec, 3, undefined, { aliases: Array.from({ length: 6 }, (_, index) => `Alias ${index}`) }));
  let result = await build({ db: createMockDatabase({ records }), archive: 'music' }), check = result.checks.find(check => check.collection === 'people');
  assert.equal(check.count, null); assert.equal(check.sampleCount, 1); assert.equal(check.groups.length, 1); assert.equal(check.unassessedRows, 1);
  records.music_people[2].aliases = { unsupported: true };
  result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks.find(check => check.collection === 'people').count, null);
  records.music_people[2].aliases = Array.from({ length: 5 }, (_, index) => `Alias ${index}`); records.music_people[2].bands = ['One', 'Two', 'Three'].map(band => ({ band }));
  result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks.find(check => check.collection === 'people').unassessedRows, 1);
});
test('row, bucket and pair-attempt caps never produce a global healthy zero', async () => {
  const spec = DEFINITIONS.music[0], records = fixtureRecords(); records.music_bands = Array.from({ length: 2002 }, (_, index) => record(spec, index + 1));
  let result = await build({ db: createMockDatabase({ records }), archive: 'music' }), check = result.checks[0];
  assert.equal(check.scannedRows, 2001); assert.equal(check.eligibleRows, 2000); assert.equal(check.unassessedRows, 1); assert.equal(check.count, null); assert.equal(check.state, 'Unavailable');
  records.music_bands = Array.from({ length: 21 }, (_, index) => record(spec, index + 1, undefined, { band: 'One shared name' }));
  result = await build({ db: createMockDatabase({ records }), archive: 'music' }); check = result.checks[0]; assert.equal(check.count, null); assert.equal(check.sampleCount, 0); assert.equal(check.eligibleRows, 21); assert.match(check.coverage.reason, /exceeded 20/);
  records.music_bands = Array.from({ length: 27 }, (_, bucket) => Array.from({ length: 20 }, (_, member) => record(spec, bucket * 20 + member + 1, undefined, { band: `Bucket ${bucket}` }))).flat();
  result = await build({ db: createMockDatabase({ records }), archive: 'music' }); check = result.checks[0]; assert.equal(check.count, null); assert.equal(check.sampleCount, 5000); assert.equal(check.groups.length, 10); assert.match(check.coverage.reason, /5,000/);
});
test('archive-wide preview is ten pairs and empty tables can be a verified bounded zero', async () => {
  const records = fixtureRecords(true);
  for (const spec of DEFINITIONS.music) records[spec.table].push(record(spec, 3, undefined, { [spec.name]: records[spec.table][0][spec.name] }));
  let result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks.reduce((sum, check) => sum + check.groups.length, 0), 10); assert.equal(result.checks[3].groups.length, 1);
  for (const spec of specs) records[spec.table] = [];
  result = await build({ db: createMockDatabase({ records }), archive: 'wrestling' }); assert.equal(result.state, 'Healthy'); assert.ok(result.checks.every(check => check.count === 0 && check.eligibleRows === 0 && check.coverage.complete));
});
test('schema/index failures skip collection reads and query failures preserve other results', async () => {
  const db = createMockDatabase({ missing: ['music_bands.location'], noIndex: ['music_people'] });
  let result = await build({ db, archive: 'music' }); assert.deepEqual(db.calls, ['schema', 'music_shows', 'music_venues']);
  assert.equal(result.checks[0].count, null); assert.equal(result.checks[0].scannedRows, null); assert.equal(result.checks[0].sampleCount, 0); assert.equal(result.checks[1].count, 0);
  result = await build({ db: createMockDatabase({ fail: ['music_people'] }), archive: 'music' }); assert.equal(result.state, 'Error'); assert.equal(result.checks[2].count, null); assert.equal(result.checks[0].count, 0); assert.doesNotMatch(JSON.stringify(result), /private token|password_hash/);
  result = await build({ db: createMockDatabase({ fail: ['schema'] }), archive: 'music' }); assert.equal(result.database.connected, false); assert.equal(result.ok, false); assert.ok(result.checks.every(check => check.count === null));
});
test('malformed response rows and repeated source IDs do not become invented healthy results', async () => {
  const records = fixtureRecords(true), spec = DEFINITIONS.music[0]; records.music_bands[1].id = records.music_bands[0].id;
  let result = await build({ db: createMockDatabase({ records }), archive: 'music' }); assert.equal(result.checks[0].count, null); assert.equal(result.checks[0].eligibleRows, 0);
  result = await build({ db: createMockDatabase({ override: { music_bands: Array(2002).fill(projectRow(spec, record(spec, 1))) } }), archive: 'music' }); assert.equal(result.checks[0].state, 'Error');
});
test('public projection clips comparisons conservatively and excludes sensitive/raw data', async () => {
  const records = fixtureRecords(true); records.music_bands.forEach(row => { row.status = '\u0001'.repeat(161); row.password_hash = 'private-secret'; row.notes = 'private notes'; row.admin_token = 'private token'; });
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' }), group = result.checks[0].groups[0];
  assert.equal(group.comparison.find(item => item.field === 'status').status, 'Unknown'); assert.ok(group.records[0].truncatedFields.includes('status'));
  for (const record of group.records) for (const value of Object.values(record.fields)) if (value !== null) assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 160);
  assert.doesNotMatch(JSON.stringify(result), /password_hash|private-secret|private notes|admin_token/);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 96 * 1024);
});
test('matching evidence stays bounded, timing types are explicit and embedded matches remain unavailable', async () => {
  const result = await build({ db: createMockDatabase({ records: fixtureRecords(true) }), archive: 'wrestling' });
  for (const check of result.checks) for (const group of check.groups) for (const evidence of group.evidence) assert.ok(Buffer.byteLength(JSON.stringify(evidence.value), 'utf8') <= 160);
  assert.ok(Object.values(result.timings.collections).every(value => value >= 0)); assert.ok(Object.values(result.timings.matchingMs).every(value => value >= 0));
  assert.equal(result.coverage.embeddedMatches.state, 'Unavailable'); assert.ok(result.checks.every(check => check.collection !== 'matches'));
});
test('maximal escaped affiliation proofs and ten pair previews remain below response limits', async () => {
  const spec = DEFINITIONS.music.find(spec => spec.collection === 'people'), records = fixtureRecords();
  records.music_people = Array.from({ length: 20 }, (_, index) => record(spec, index + 1, undefined, {
    aliases: Array.from({ length: 5 }, (_, alias) => `Alias${alias}${'\u0001'.repeat(23)}`),
    bands: Array.from({ length: 2 }, (_, band) => ({ band: `Band${band}${'\u0001'.repeat(23)}` })), category: `Role${'\u0001'.repeat(23)}`
  }));
  const result = await build({ db: createMockDatabase({ records }), archive: 'music' });
  const check = result.checks.find(check => check.collection === 'people'); assert.equal(check.count, 190); assert.equal(check.groups.length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 96 * 1024);
  assert.equal(check.groups[0].comparison.find(field => field.field === 'aliases').status, 'Unknown');
});
test('fixed protected routes ignore caller archive parameters and use no-store/connectivity statuses without startup', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const archive of ['music', 'wrestling']) {
    const start = source.indexOf(`app.get('/api/admin/diagnostics/${archive}/possible-duplicates', `), end = source.indexOf('\napp.get(', start + 1);
    assert.ok(start > source.indexOf("app.use(['/api/admin', '/admin/import', '/admin/smug', '/api/wrestling/people/import'], requireAdminAccess)"));
    let handler, usedArchive; let connected = true;
    const context = { app: { get: (_, callback) => { handler = callback; } }, dbPool: {}, buildPossibleDuplicatesResponse: async options => { usedArchive = options.archive; return { database: { connected } }; } };
    vm.runInNewContext(source.slice(start, end), context);
    const response = { headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ query: { archive: 'forged', limit: '999999' } }, response); assert.equal(usedArchive, archive); assert.equal(response.code, 200); assert.equal(response.headers['Cache-Control'], 'no-store');
    connected = false; await handler({}, response); assert.equal(response.code, 503);
    context.buildPossibleDuplicatesResponse = async () => { throw new Error('private password'); }; await handler({}, response); assert.equal(response.code, 503); assert.doesNotMatch(JSON.stringify(response.body), /private password/);
  }
});
async function run() {
  for (const { name, check } of tests) { await check(); console.log(`PASS ${name}`); }
  console.log(`${tests.length} focused structural/mock checks passed. PostgreSQL execution, plans and actual database cost remain unverified.`);
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { createMockDatabase, fixtureRecords, record, projectRow };
