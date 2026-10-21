'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const reporting = require('../import-reporting');

function schemaRows(options = {}) {
  return reporting.COLUMNS.filter(name => !(options.missing || []).includes(name)).map(column_name => ({
    column_name, data_type: ['meta', 'warnings', 'errors'].includes(column_name) ? 'jsonb' : 'text',
    latest_index_usable: options.index !== false
  }));
}
function makeRow(section, category, overrides = {}) {
  return {
    id: 1, section, category, source: `${section}-${category}`, source_identifier: 'Archive source', import_type: 'manual',
    status: 'success', started_at: '2026-10-21T12:00:00.000Z', finished_at: '2026-10-21T12:00:02.000Z',
    duration_ms: 2000, rows_fetched: 3, rows_imported: 3, rows_inserted: 1, rows_updated: 2,
    rows_skipped: 0, total_rows_after_import: 3, error_message: null,
    warnings: [], errors: [], warnings_count: 0, errors_count: 0,
    meta: { rowsRead: 3, upserted: 3, rowsInserted: 1, rowsUpdated: 2, skipped: 0 },
    created_at: '2026-10-21T12:00:00.000Z', ...overrides
  };
}
function createMockPool(rows = [], options = {}) {
  const calls = [];
  return {
    calls,
    async query(config) {
      calls.push(config);
      const text = typeof config === 'string' ? config : config.text;
      if (options.fail && options.fail(text)) throw new Error('private backend error must not be exposed');
      if (text === reporting.SCHEMA_QUERY) return { rows: options.absent ? [] : schemaRows(options) };
      if (/^SELECT 1\s*$/.test(text)) return { rows: [{ value: 1 }] };
      if (/information_schema\.tables/.test(text)) return { rows: (config.values[0] || []).map(table_name => ({ table_name })) };
      if (/count\(\*\)::text AS total/.test(text)) return { rows: [{ total: String(rows.length) }] };
      if (/count\(\*\)::text AS count/.test(text)) return { rows: [{ count: '0' }] };
      if (/CROSS JOIN LATERAL/.test(text)) {
        const filter = config.values.find(Array.isArray);
        const pairs = new Set();
        for (let i = 0; i + 1 < config.values.length; i += 2) {
          if (typeof config.values[i] === 'string' && typeof config.values[i + 1] === 'string') pairs.add(`${config.values[i]}.${config.values[i + 1]}`);
        }
        return { rows: rows.filter(row => pairs.has(`${row.section}.${row.category}`) && (!filter || filter.includes(row.status))) };
      }
      return { rows };
    }
  };
}
function assertReadOnly(calls) {
  for (const config of calls) {
    assert.equal(config.query_timeout, reporting.QUERY_TIMEOUT_MS);
    assert.match(config.text, /^\s*SELECT\b/i);
    assert.doesNotMatch(config.text, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO)\b/i);
    const placeholders = [...config.text.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.equal(placeholders.length ? Math.max(...placeholders) : 0, config.values.length, 'SQL placeholder/value arity');
  }
}
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('latest archives use exactly metadata plus one fixed bounded SELECT', async () => {
  for (const section of ['music', 'wrestling', '']) {
    const rows = reporting.DATASETS.filter(parts => !section || parts[0] === section).map(([archive, category], i) => makeRow(archive, category, { id: i + 1 }));
    const pool = createMockPool(rows);
    const report = await reporting.buildLatestImportReportingResponse(pool, section);
    assert.equal(report.availability, 'Available'); assert.equal(report.items.length, rows.length);
    assert.equal(pool.calls.length, 2); assertReadOnly(pool.calls);
    assert.match(pool.calls[1].text, /ORDER BY history\.started_at DESC LIMIT 1/);
    assert.doesNotMatch(pool.calls[1].text, /count\(\*\)|DISTINCT ON|OFFSET|history\.id DESC/);
    assert.equal(report.limits.maxItems, rows.length);
  }
});
test('missing history remains unavailable, never a zero-valued successful import', async () => {
  const report = await reporting.buildLatestImportReportingResponse(createMockPool(), 'music');
  assert.equal(report.availability, 'Unavailable'); assert.deepEqual(report.items, []);
  assert(report.coverage.datasets.every(item => item.state === 'Unavailable'));
});
test('missing table and core column do not trigger data reads or maintenance', async () => {
  for (const options of [{ absent: true }, { missing: ['started_at'] }]) {
    const pool = createMockPool([], options); const report = await reporting.buildLatestImportReportingResponse(pool, 'music');
    assert.equal(report.coverage.schemaAvailable, false); assert.equal(report.availability, 'Unavailable');
    assert.equal(pool.calls.length, 1); assertReadOnly(pool.calls);
  }
});
test('missing lookup index fails closed without scanning history', async () => {
  const pool = createMockPool([], { index: false }); const report = await reporting.buildLatestImportReportingResponse(pool, 'wrestling');
  assert.equal(report.availability, 'Unavailable'); assert.equal(pool.calls.length, 1);
  assert.match(report.warnings[0], /index/); assertReadOnly(pool.calls);
});
test('optional absent fields use NULL and mark partial coverage', async () => {
  const pool = createMockPool([makeRow('music', 'bands', { rows_updated: null })], { missing: ['rows_updated', 'warnings'] });
  const report = await reporting.buildLatestImportReportingResponse(pool, 'music');
  assert.equal(report.availability, 'Partial'); assert.equal(report.items[0].rows_updated, null);
  assert.match(pool.calls[1].text, /NULL AS rows_updated/); assert.match(pool.calls[1].text, /NULL::jsonb AS warnings/);
});
test('genuine positive and provenance-supported zero counts remain available', () => {
  const item = reporting.projectImportHistoryItem(makeRow('music', 'bands'));
  assert.equal(item.rows_imported, 3); assert.equal(item.metric_provenance.rows_imported, 'stored_positive');
  assert.equal(item.rows_skipped, 0); assert.equal(item.metric_provenance.rows_skipped, 'explicit_zero');
  const empty = reporting.projectImportHistoryItem(makeRow('music', 'bands', { total_rows_after_import: 0 }));
  assert.equal(empty.total_rows_after_import, 0); assert.equal(empty.metric_provenance.total_rows_after_import, 'stored_explicit');
});
test('legacy/default zeros without original explicit metadata remain unknown', () => {
  const item = reporting.projectImportHistoryItem(makeRow('music', 'bands', { rows_fetched: 0, rows_imported: 0, rows_inserted: 0, rows_updated: 0, rows_skipped: 0, meta: {} }));
  for (const field of ['rows_fetched', 'rows_imported', 'rows_inserted', 'rows_updated', 'rows_skipped']) {
    assert.equal(item[field], null); assert.equal(item.metric_provenance[field], 'unavailable');
  }
});
test('running imports never publish initialized processing counts', () => {
  const item = reporting.projectImportHistoryItem(makeRow('music', 'bands', { status: 'running', finished_at: null }));
  assert.equal(item.rows_imported, null); assert.equal(item.rows_skipped, null); assert.equal(item.total_rows_after_import, null);
  assert.equal(item.finished_at, '');
});
test('conflicting original-result metadata cannot prove a stored count', () => {
  const item = reporting.projectImportHistoryItem(makeRow('music', 'bands', { rows_imported: 3, meta: { upserted: 2 } }));
  assert.equal(item.rows_imported, null); assert.equal(item.metric_provenance.rows_imported, 'conflict');
});
test('NULL, empty, whitespace, negative, fractional and unsafe counts remain unknown', () => {
  for (const value of [null, undefined, '', ' ', -1, '-1', 1.5, '1.5', '9007199254740992', {}, []]) {
    assert.equal(reporting.projectImportHistoryItem(makeRow('music', 'bands', { rows_imported: value, meta: {} })).rows_imported, null);
  }
  assert.equal(reporting.safeCount('0'), 0); assert.equal(reporting.safeCount(0), 0);
});
test('failed-record and processed counts are never invented from messages', () => {
  const item = reporting.projectImportHistoryItem(makeRow('music', 'bands', { status: 'failed', errors: ['One request failed'], errors_count: 1 }));
  assert.equal(item.rows_failed, null); assert(!Object.hasOwn(item, 'records_processed')); assert.equal(item.errors_count, 1);
});
test('warnings/errors retain actual message counts and bounded previews', () => {
  const warnings = Array.from({ length: 20 }, (_, i) => `Warning ${i}`);
  const item = reporting.projectImportHistoryItem(makeRow('music', 'bands', { warnings, warnings_count: 20 }));
  assert.equal(item.warnings.length, 10); assert.equal(item.warnings_count, 20); assert.equal(item.details_limited, true);
});
test('credential-bearing messages and arbitrary metadata are not exposed', () => {
  const item = reporting.projectImportHistoryItem(makeRow('music', 'bands', {
    warnings: ['Authorization: Bearer sample-secret', 'API key sample-secret', 'See https://example.test/path?token=sample-secret', 'admin_token=sample-secret', 'ADMIN_TOKEN sample-secret', 'Credential sample-secret'], warnings_count: 6,
    meta: { arbitraryPrivateField: 'sample-secret', rowsRead: 3 }
  }));
  const json = JSON.stringify(item); assert(!json.includes('sample-secret')); assert.deepEqual(item.meta, {});
  assert(item.warnings.some(value => value.includes('redacted')));
});
test('text output is bounded by encoded JSON bytes and cannot create HTML', () => {
  for (const text of ['x'.repeat(10000), '😀'.repeat(1000), '\n'.repeat(1000), '<script>alert(1)</script>']) {
    const output = reporting.safeText(text); assert(Buffer.byteLength(JSON.stringify(output)) <= reporting.TEXT_LIMIT);
    assert.equal(typeof output, 'string');
  }
});
test('database errors are explicit and generic without secret details', async () => {
  const report = await reporting.buildLatestImportReportingResponse(createMockPool([], { fail: () => true }), 'music');
  assert.equal(report.ok, false); assert.equal(report.availability, 'Unavailable');
  assert(!JSON.stringify(report).includes('private backend'));
});
test('invalid section never executes a query', async () => {
  const pool = createMockPool(); const report = await reporting.buildLatestImportReportingResponse(pool, 'music;DROP TABLE');
  assert.equal(report.error, 'INVALID_SECTION'); assert.equal(pool.calls.length, 0);
});
test('SQL projection reads only allowlisted numeric provenance, never raw metadata', () => {
  const sql = reporting.getImportReportingSelect({ columns: new Set(reporting.COLUMNS), types: new Map([['meta', 'jsonb'], ['warnings', 'jsonb'], ['errors', 'jsonb']]) });
  assert(sql.includes("->>'rowsRead'")); assert(!/\bmeta\s*,/.test(sql)); assert(sql.includes('jsonb_strip_nulls'));
  assert(!sql.includes('jsonb_array_elements')); assert(sql.includes('left(warnings::jsonb->>9, 321)'));
});
test('lookup index guard requires three actual btree key attributes, never INCLUDE columns', () => {
  assert(reporting.SCHEMA_QUERY.includes('indnkeyatts >= 3'));
  assert(!reporting.SCHEMA_QUERY.includes('indnatts >= 3'));
});

function extractFunction(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |\\nconst [A-Z_]+ =)`));
  if (!match) throw new Error(`Missing ${name}`); return match[0];
}
function handlerContext(pool) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const names = ['buildImportHistoryApiItem', 'buildImportHistoryQueryOptions', 'handleImportHistoryRequest', 'handleLatestImportHistoryRequest',
    'getImportHistoryStatusSelect', 'buildImportStatusHistoryWhere', 'getDistinctImportHistoryItems', 'getRecentImportHistoryItems', 'getImportStatusFromLatest', 'getImportSyncStatus',
    'getImportItemTimeMs', 'getLatestImportFailureReason', 'getImportDatasetKey', 'getImportStaleWarningHours', 'buildImportStatusReport', 'handleAdminImportStatusRequest'];
  const context = vm.createContext({ importReporting: reporting, dbPool: pool, Date, Map, Set, Number, String, Object, Array,
    process: { env: { DATABASE_URL: 'inert-fixture-only' } }, formatEasternGeneratedTime: () => 'Fixture time',
    toIntegerCount: value => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0,
    getClampedLimit: value => Math.max(1, Math.min(100, Number(value) || 10)), getPageNumber: value => Math.max(1, Number(value) || 1),
    buildPaginationMeta: (page, limit, total, count) => ({ page, limit, total, count, totalPages: Math.ceil(total / limit), hasNextPage: page * limit < total, hasPrevPage: page > 1 }),
    buildListMeta: value => value, console: { warn() {} } });
  const datasetConst = source.match(/const IMPORT_STATUS_DATASETS = Object\.freeze\(\[[^]*?\]\);/)[0];
  vm.runInContext(`${datasetConst}\n${names.map(name => extractFunction(source, name)).join('\n')}`, context);
  return { context, source };
}
function response() { return { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } }; }
test('all five reporting GET paths and shared status builder have read-only transitive execution', async () => {
  for (const [name, fixed] of [['handleImportHistoryRequest', undefined], ['handleImportHistoryRequest', 'music'], ['handleImportHistoryRequest', 'wrestling'], ['handleLatestImportHistoryRequest'], ['handleAdminImportStatusRequest']]) {
    const pool = createMockPool([makeRow('music', 'bands')]); const { context } = handlerContext(pool); const res = response();
    await context[name]({ query: { limit: '10' } }, res, fixed);
    assert.equal(res.statusCode, 200, name); assert.equal(res.body.ok, true, name); assert(pool.calls.length > 0, name);
    assertReadOnly(pool.calls); assert(!JSON.stringify(res.body).includes('inert-fixture-only'));
  }
});
test('missing schema returns unavailable through all five handlers without data access', async () => {
  for (const [name, fixed] of [['handleImportHistoryRequest'], ['handleImportHistoryRequest', 'music'], ['handleImportHistoryRequest', 'wrestling'], ['handleLatestImportHistoryRequest'], ['handleAdminImportStatusRequest']]) {
    const pool = createMockPool([], { absent: true }); const { context } = handlerContext(pool); const res = response();
    await context[name]({ query: {} }, res, fixed); assert.equal(res.body.availability, 'Unavailable');
    assertReadOnly(pool.calls); assert(pool.calls.length <= 2);
  }
});
test('existing Admin session and legacy guards still cover every reporting path', () => {
  const { source } = handlerContext(createMockPool());
  const guard = source.indexOf("app.use(['/api/admin', '/admin/import', '/admin/smug', '/api/wrestling/people/import'], requireAdminAccess)");
  assert(guard > -1);
  for (const route of ['/api/admin/status/imports', '/api/admin/import-history', '/api/admin/import-history/music', '/api/admin/import-history/wrestling', '/api/admin/import-history/latest']) {
    assert(source.indexOf(`app.get('${route}'`) > guard);
  }
  assert(source.includes('v3AdminAuthRouter.authorizeSession')); assert(source.includes('ADMIN_TOKEN'));
});
test('health readiness marker is additive, public and requires no database query', () => {
  const { source } = handlerContext(createMockPool());
  const health = source.slice(source.indexOf("app.get('/health',"), source.indexOf("app.get('/health/db',"));
  assert(health.includes('importReportingReadOnly: 1')); assert(!health.includes('.query(')); assert(!health.includes('ensure'));
});

async function main() {
  let passed = 0;
  for (const [name, fn] of tests) { await fn(); passed++; console.log(`PASS ${name}`); }
  console.log(JSON.stringify({ passed, failed: 0, database: 'mocked only; no PostgreSQL runtime or query timing verified' }));
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { schemaRows, makeRow, createMockPool, handlerContext, response, assertReadOnly };
