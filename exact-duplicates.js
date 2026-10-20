'use strict';

const QUERY_TIMEOUT_MS = 2000;
const SCAN_LIMIT = 10000;
const GROUP_LIMIT = 10;
const MEMBER_LIMIT = 2;
const VALUE_LIMIT = 160;
const IDENTIFIER_BYTE_LIMIT = 256;
const DEFINITIONS = Object.freeze({
  music: Object.freeze([
    { collection: 'bands', table: 'music_bands', criterion: 'band_id', name: 'band', fields: ['id', 'band_id', 'band', 'region', 'location', 'status'] },
    { collection: 'shows', table: 'music_shows', criterion: 'show_id', name: 'name', fields: ['id', 'show_id', 'name', 'date', 'venue_id', 'venue', 'city', 'state'] },
    { collection: 'people', table: 'music_people', criterion: 'person_id', name: 'name', fields: ['id', 'person_id', 'name', 'category'] },
    { collection: 'venues', table: 'music_venues', criterion: 'venue_key', name: 'venue', fields: ['id', 'venue_key', 'venue', 'city', 'state', 'country', 'latitude', 'longitude'] }
  ]),
  wrestling: Object.freeze([
    { collection: 'shows', table: 'wrestling_shows', criterion: 'show_key', name: 'show_name', fields: ['id', 'show_key', 'show_name', 'date', 'promotion', 'venue_id', 'venue'] },
    { collection: 'people', table: 'wrestling_people', criterion: 'slug', name: 'name', fields: ['id', 'slug', 'name', 'category'] },
    { collection: 'venues', table: 'wrestling_venues', criterion: 'venue_id', name: 'venue_name', fields: ['id', 'venue_id', 'venue_name', 'city', 'state', 'country', 'latitude', 'longitude'] }
  ])
});

// The ordering guard requires a valid, ready, nonpartial, expression-free unique btree
// index on the nonnullable id column before any bounded collection probe is allowed.
const SCHEMA_QUERY = `SELECT column_info.table_name, column_info.column_name,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace
    JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
    JOIN pg_catalog.pg_index index_info ON index_info.indrelid = relation.oid
    JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_info.indexrelid
    JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam
    WHERE namespace.nspname = 'public' AND relation.relname = column_info.table_name
      AND attribute.attname = 'id' AND attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attnotnull
      AND index_info.indisunique AND index_info.indisvalid AND index_info.indisready
      AND index_info.indnatts = 1 AND index_info.indkey[0] = attribute.attnum
      AND index_info.indpred IS NULL AND index_info.indexprs IS NULL AND access_method.amname = 'btree'
  ) AS id_index_usable
FROM information_schema.columns column_info
WHERE column_info.table_schema = 'public' AND column_info.table_name = ANY($1::text[])`;

function fixedCollectionQuery(spec) {
  // All interpolated SQL identifiers come exclusively from the static definitions above.
  const publicFields = spec.fields.map(field => `'${field}', left(member.${field}::text, 161)`).join(', ');
  return `WITH scanned AS (
  SELECT id AS row_id,
    (CASE WHEN ${spec.criterion} IS NULL THEN NULL
      WHEN octet_length(${spec.criterion}::text) > 256 THEN NULL
      WHEN ${spec.criterion}::text ~ '^[[:space:]]*$' THEN NULL
      ELSE ${spec.criterion}::text END) COLLATE "C" AS exact_key,
    coalesce(octet_length(${spec.criterion}::text) > 256, false) AS oversized_key
  FROM public.${spec.table}
  ORDER BY id ASC LIMIT 10001
), scan_stats AS (
  SELECT count(*)::text AS scanned_rows,
    count(*) FILTER (WHERE oversized_key)::text AS oversized_keys
  FROM scanned
), duplicate_groups AS (
  SELECT exact_key, count(*)::text AS record_count
  FROM scanned
  WHERE exact_key IS NOT NULL
    AND (SELECT scanned_rows::bigint FROM scan_stats) <= 10000
    AND (SELECT oversized_keys::bigint FROM scan_stats) = 0
  GROUP BY exact_key HAVING count(*) > 1
)
SELECT scan_stats.*,
  (SELECT count(*)::text FROM duplicate_groups) AS duplicate_count,
  (SELECT coalesce(sum(record_count::bigint), 0)::text FROM duplicate_groups) AS affected_rows,
  coalesce((SELECT jsonb_agg(group_item ORDER BY sort_key COLLATE "C") FROM (
    SELECT exact_key AS sort_key,
      jsonb_build_object('identifier', left(exact_key, 161), 'recordCount', record_count,
        'records', (SELECT jsonb_agg((
          SELECT jsonb_build_object('id', left(member.id::text, 161), 'name', left(member.${spec.name}::text, 161),
            'fields', jsonb_build_object(${publicFields}))
          FROM public.${spec.table} member WHERE member.id = bounded_members.row_id
        ) ORDER BY row_id) FROM (
          SELECT row_id FROM scanned records
          WHERE records.exact_key = duplicate_groups.exact_key
          ORDER BY row_id ASC LIMIT 2
        ) bounded_members)) AS group_item
    FROM duplicate_groups ORDER BY exact_key COLLATE "C" LIMIT $1
  ) bounded_groups), '[]'::jsonb) AS groups
FROM scan_stats`;
}

const QUERIES = Object.freeze(Object.fromEntries(Object.values(DEFINITIONS).flat().map(spec => [spec.table, fixedCollectionQuery(spec)])));

function safeCount(value) {
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function clip(value) {
  if (value === null) return { value: null, truncated: false };
  if (typeof value !== 'string') throw new Error('Invalid public field');
  let clean = '', encodedBytes = 2;
  for (const character of value) {
    const bytes = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (clean.length + character.length > VALUE_LIMIT || encodedBytes + bytes > VALUE_LIMIT) break;
    clean += character; encodedBytes += bytes;
  }
  return { value: clean, truncated: clean !== value };
}

function projectRecord(record, spec) {
  if (!record || typeof record !== 'object' || !record.fields || typeof record.fields !== 'object') throw new Error('Invalid public record');
  const fields = {}, truncatedFields = [];
  for (const field of spec.fields) {
    const clean = clip(record.fields[field]);
    fields[field] = clean.value;
    if (clean.truncated) truncatedFields.push(field);
  }
  const id = clip(record.id), name = clip(record.name);
  if (id.truncated || id.value === null || id.value !== fields.id || name.value !== fields[spec.name]) throw new Error('Invalid record identity');
  return { id: id.value, name: name.value, fields, truncatedFields };
}

function projectGroups(value, spec, available, count, affectedRows) {
  if (!Array.isArray(value) || value.length > available || value.length > count) throw new Error('Invalid group preview');
  const seenRecordIds = new Set();
  const groups = value.map(group => {
    const identifier = clip(group.identifier), recordCount = safeCount(group.recordCount);
    if (identifier.value === null || !identifier.truncated && !identifier.value.trim() || recordCount === null || recordCount < 2 || recordCount > affectedRows || !Array.isArray(group.records) || group.records.length !== MEMBER_LIMIT) throw new Error('Invalid group');
    const records = group.records.map(record => projectRecord(record, spec));
    if (records[0].id === records[1].id) throw new Error('Repeated record in preview');
    for (const record of records) {
      if (seenRecordIds.has(record.id)) throw new Error('Record repeated across exact groups');
      seenRecordIds.add(record.id);
    }
    if (records.some(record => record.fields[spec.criterion] !== identifier.value || record.truncatedFields.includes(spec.criterion) !== identifier.truncated)) throw new Error('Mismatched exact criterion');
    const comparison = spec.fields.map(field => {
      const unknown = records.some(record => record.fields[field] === null || record.truncatedFields.includes(field));
      return { field, status: unknown ? 'Unknown' : records[0].fields[field] === records[1].fields[field] ? 'Matching' : 'Different' };
    });
    return { identifier: identifier.value, identifierTruncated: identifier.truncated, recordCount, records, comparison, previewComplete: recordCount === MEMBER_LIMIT };
  });
  if (groups.reduce((total, group) => total + group.recordCount, 0) > affectedRows) throw new Error('Invalid member totals');
  return groups;
}

function emptyCheck(spec, state, reason, scannedRows = null) {
  return {
    collection: spec.collection, criterion: spec.criterion, matchingFields: [spec.criterion],
    meaning: `Exact stored ${spec.criterion} equality only. NULL and whitespace-only values are excluded; case and whitespace are not normalized. Distinct identifiers, alternate IDs and shared names do not establish a match. Findings are review candidates, not proof of duplicate people or events.`,
    state, count: null, affectedRows: null, scannedRows,
    coverage: { complete: false, limit: SCAN_LIMIT, reason }, groups: []
  };
}

function overallState(checks) {
  return ['Error', 'Warning', 'Unavailable'].find(state => checks.some(check => check.state === state)) || 'Healthy';
}

async function buildExactDuplicatesResponse({ db, archive, now = () => performance.now(), date = () => new Date() } = {}) {
  const specs = DEFINITIONS[archive];
  if (!specs) throw new Error('Unsupported archive');
  const started = now();
  const result = {
    ok: true, route: `/api/admin/diagnostics/${archive}/exact-duplicates`, source: 'postgres', archive,
    generatedAt: date().toISOString(), database: { connected: false }, state: 'Unavailable', checks: [],
    coverage: archive === 'wrestling' ? { embeddedMatches: { state: 'Unavailable', reason: 'Embedded matches and entries have no verified stable match identifier. Repeated appearances, names, URLs and array positions cannot establish exact duplicates.' } } : {},
    timings: { schemaMs: null, totalMs: null, collections: Object.fromEntries(specs.map(spec => [spec.collection, null])) }, warnings: []
  };
  async function query(text, values, collection) {
    const begin = now();
    try { return await db.query({ text, values, query_timeout: QUERY_TIMEOUT_MS }); }
    finally {
      const elapsed = Math.max(0, Math.round((now() - begin) * 100) / 100);
      if (collection) result.timings.collections[collection] = elapsed; else result.timings.schemaMs = elapsed;
    }
  }
  let schema;
  try {
    if (!db || typeof db.query !== 'function') throw new Error('Database unavailable');
    const response = await query(SCHEMA_QUERY, [specs.map(spec => spec.table)]);
    if (!response || !Array.isArray(response.rows)) throw new Error('Invalid schema');
    schema = response.rows;
    result.database.connected = true;
  } catch (_) {
    result.ok = false;
    result.warnings.push('PostgreSQL metadata could not be verified. No collection was scanned.');
    result.checks = specs.map(spec => emptyCheck(spec, 'Unavailable', 'Database connectivity could not be verified.'));
  }

  let remaining = GROUP_LIMIT;
  if (schema) for (const spec of specs) {
    const columns = schema.filter(row => row.table_name === spec.table);
    if (!spec.fields.every(field => columns.some(row => row.column_name === field))) {
      result.checks.push(emptyCheck(spec, 'Unavailable', 'Required table or public projection columns are unavailable; no collection scan was attempted.'));
      continue;
    }
    if (!columns.some(row => row.column_name === 'id' && row.id_index_usable === true)) {
      result.checks.push(emptyCheck(spec, 'Unavailable', 'A usable nonnullable, single-column unique btree id index could not be verified; no unindexed scan was attempted.'));
      continue;
    }
    try {
      const response = await query(QUERIES[spec.table], [remaining], spec.collection);
      if (!response || !Array.isArray(response.rows) || response.rows.length !== 1) throw new Error('Invalid aggregate');
      const row = response.rows[0], scannedRows = safeCount(row.scanned_rows), oversizedKeys = safeCount(row.oversized_keys);
      if (scannedRows === null || scannedRows > SCAN_LIMIT + 1 || oversizedKeys === null || oversizedKeys > scannedRows) throw new Error('Invalid coverage');
      if (scannedRows > SCAN_LIMIT || oversizedKeys > 0) {
        result.checks.push(emptyCheck(spec, 'Unavailable', scannedRows > SCAN_LIMIT
          ? 'The ordered probe exceeded 10,000 records. Global duplicate counts are unavailable; a larger scan was not run.'
          : 'An identifier exceeds the 256-byte safety limit. Global duplicate counts are unavailable; oversized identifiers were not silently discarded.', scannedRows));
        continue;
      }
      const count = safeCount(row.duplicate_count), affectedRows = safeCount(row.affected_rows);
      if (count === null || affectedRows === null || affectedRows > scannedRows || count > Math.floor(affectedRows / 2) || (count === 0) !== (affectedRows === 0)) throw new Error('Invalid exact counts');
      const groups = projectGroups(row.groups, spec, remaining, count, affectedRows);
      if (groups.length !== Math.min(remaining, count)) throw new Error('Missing bounded preview');
      const check = emptyCheck(spec, count > 0 ? 'Warning' : 'Healthy', 'Counts cover the complete bounded collection. At most 10 groups are previewed per archive, with two records per group; further preview pagination is not available.', scannedRows);
      Object.assign(check, { count, affectedRows, groups });
      check.coverage.complete = true;
      result.checks.push(check);
      remaining -= groups.length;
    } catch (_) {
      result.checks.push(emptyCheck(spec, 'Error', 'The bounded exact-identifier check failed or timed out. No count has been assumed.'));
      result.warnings.push(`${spec.collection}: the exact-identifier check is unavailable.`);
    }
  }
  result.state = overallState(result.checks);
  result.timings.totalMs = Math.max(0, Math.round((now() - started) * 100) / 100);
  return result;
}

module.exports = { buildExactDuplicatesResponse, DEFINITIONS, SCHEMA_QUERY, QUERIES, QUERY_TIMEOUT_MS, SCAN_LIMIT, GROUP_LIMIT, MEMBER_LIMIT, VALUE_LIMIT, IDENTIFIER_BYTE_LIMIT, safeCount };
