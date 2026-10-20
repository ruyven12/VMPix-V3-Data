'use strict';

const ROUTE = '/api/admin/diagnostics/wrestling/missing-data';
const QUERY_TIMEOUT_MS = 2500;
const EXAMPLE_LIMIT = 10;
const REQUIRED_COLUMNS = Object.freeze({
  shows: Object.freeze(['id', 'show_id', 'show_key', 'show_name', 'date', 'promotion', 'matches']),
  people: Object.freeze(['id', 'name', 'category']),
  venues: Object.freeze(['id', 'venue_id', 'venue_name', 'latitude', 'longitude'])
});
const TABLES = Object.freeze({ shows: 'wrestling_shows', people: 'wrestling_people', venues: 'wrestling_venues' });

// Fixed SELECTs only: one metadata query, then one aggregate/bounded-sample query per collection.
// No embedded-entry expansion or relationship audit is needed for these completeness checks.
const QUERIES = Object.freeze({
  schema: `SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
  shows: `WITH inspected AS (
  SELECT id AS sort_id,
    left(coalesce(show_id::text, id::text), 100) AS public_id,
    left(show_name, 160) AS public_name,
    show_id IS NULL AS missing_show_id,
    coalesce(show_key, '') ~ '^[[:space:]]*$' AS missing_show_key,
    coalesce(show_name, '') ~ '^[[:space:]]*$' AS missing_show_name,
    coalesce(date, '') ~ '^[[:space:]]*$' AS missing_date,
    coalesce(promotion, '') ~ '^[[:space:]]*$' AS missing_promotion,
    CASE WHEN jsonb_typeof(matches) = 'array' THEN jsonb_array_length(matches) ELSE NULL END AS entry_count
  FROM public.wrestling_shows
), summary AS (
  SELECT count(*)::text AS total_records,
    count(*) FILTER (WHERE missing_show_id OR missing_show_key OR missing_show_name)::text AS shows_missing_identity,
    count(*) FILTER (WHERE missing_date)::text AS shows_missing_date,
    count(*) FILTER (WHERE missing_promotion)::text AS shows_missing_metadata,
    coalesce(sum(entry_count), 0)::text AS embedded_entries,
    count(*) FILTER (WHERE entry_count IS NULL)::text AS unsupported_rows
  FROM inspected
)
SELECT summary.*,
  coalesce((SELECT jsonb_agg(sample) FROM (
    SELECT jsonb_build_object('id', public_id, 'name', public_name, 'missingFields', array_remove(ARRAY[
      CASE WHEN missing_show_id THEN 'show_id' END,
      CASE WHEN missing_show_key THEN 'show_key' END,
      CASE WHEN missing_show_name THEN 'show_name' END], NULL)) AS sample
    FROM inspected WHERE missing_show_id OR missing_show_key OR missing_show_name ORDER BY sort_id ASC NULLS LAST LIMIT 10
  ) bounded), '[]'::jsonb) AS shows_missing_identity_examples,
  coalesce((SELECT jsonb_agg(sample) FROM (
    SELECT jsonb_build_object('id', public_id, 'name', public_name, 'missingFields', ARRAY['date']) AS sample
    FROM inspected WHERE missing_date ORDER BY sort_id ASC NULLS LAST LIMIT 10
  ) bounded), '[]'::jsonb) AS shows_missing_date_examples,
  coalesce((SELECT jsonb_agg(sample) FROM (
    SELECT jsonb_build_object('id', public_id, 'name', public_name, 'missingFields', ARRAY['promotion']) AS sample
    FROM inspected WHERE missing_promotion ORDER BY sort_id ASC NULLS LAST LIMIT 10
  ) bounded), '[]'::jsonb) AS shows_missing_metadata_examples
FROM summary`,
  people: `WITH inspected AS (
  SELECT id AS sort_id, left(id::text, 100) AS public_id, left(name, 160) AS public_name,
    id IS NULL AS missing_id,
    coalesce(name, '') ~ '^[[:space:]]*$' AS missing_name,
    coalesce(category, '') ~ '^[[:space:]]*$' AS missing_category
  FROM public.wrestling_people
), summary AS (
  SELECT count(*)::text AS total_records,
    count(*) FILTER (WHERE missing_id OR missing_name)::text AS people_missing_identity,
    count(*) FILTER (WHERE missing_category)::text AS people_missing_classification
  FROM inspected
)
SELECT summary.*,
  coalesce((SELECT jsonb_agg(sample) FROM (
    SELECT jsonb_build_object('id', public_id, 'name', public_name, 'missingFields', array_remove(ARRAY[
      CASE WHEN missing_id THEN 'id' END, CASE WHEN missing_name THEN 'name' END], NULL)) AS sample
    FROM inspected WHERE missing_id OR missing_name ORDER BY sort_id ASC NULLS LAST LIMIT 10
  ) bounded), '[]'::jsonb) AS people_missing_identity_examples,
  coalesce((SELECT jsonb_agg(sample) FROM (
    SELECT jsonb_build_object('id', public_id, 'name', public_name, 'missingFields', ARRAY['category']) AS sample
    FROM inspected WHERE missing_category ORDER BY sort_id ASC NULLS LAST LIMIT 10
  ) bounded), '[]'::jsonb) AS people_missing_classification_examples
FROM summary`,
  venues: `WITH inspected AS (
  SELECT id AS sort_id, left(coalesce(venue_id, id::text), 100) AS public_id,
    left(venue_name, 160) AS public_name,
    coalesce(venue_id, '') ~ '^[[:space:]]*$' AS missing_venue_id,
    coalesce(venue_name, '') ~ '^[[:space:]]*$' AS missing_venue_name,
    latitude IS NULL AS missing_latitude, longitude IS NULL AS missing_longitude
  FROM public.wrestling_venues
), summary AS (
  SELECT count(*)::text AS total_records,
    count(*) FILTER (WHERE missing_venue_id OR missing_venue_name)::text AS venues_missing_identity,
    count(*) FILTER (WHERE missing_latitude <> missing_longitude)::text AS venues_incomplete_coordinates
  FROM inspected
)
SELECT summary.*,
  coalesce((SELECT jsonb_agg(sample) FROM (
    SELECT jsonb_build_object('id', public_id, 'name', public_name, 'missingFields', array_remove(ARRAY[
      CASE WHEN missing_venue_id THEN 'venue_id' END, CASE WHEN missing_venue_name THEN 'venue_name' END], NULL)) AS sample
    FROM inspected WHERE missing_venue_id OR missing_venue_name ORDER BY sort_id ASC NULLS LAST LIMIT 10
  ) bounded), '[]'::jsonb) AS venues_missing_identity_examples,
  coalesce((SELECT jsonb_agg(sample) FROM (
    SELECT jsonb_build_object('id', public_id, 'name', public_name, 'missingFields', array_remove(ARRAY[
      CASE WHEN missing_latitude THEN 'latitude' END, CASE WHEN missing_longitude THEN 'longitude' END], NULL)) AS sample
    FROM inspected WHERE missing_latitude <> missing_longitude ORDER BY sort_id ASC NULLS LAST LIMIT 10
  ) bounded), '[]'::jsonb) AS venues_incomplete_coordinates_examples
FROM summary`
});

const CHECKS = Object.freeze([
  { key: 'showsMissingIdentity', entity: 'shows', label: 'Show identity', column: 'shows_missing_identity', fields: ['show_id', 'show_key', 'show_name'], meaning: 'Shows missing their public show ID, archive key or show name.' },
  { key: 'showsMissingDate', entity: 'shows', label: 'Show dates', column: 'shows_missing_date', fields: ['date'], meaning: 'Shows missing the source date required by the existing import. The optional derived show_date is not checked.' },
  { key: 'showsMissingMetadata', entity: 'shows', label: 'Show event metadata', column: 'shows_missing_metadata', fields: ['promotion'], meaning: 'Shows missing the promotion required by the existing import. Optional venue, image and camera fields are excluded.' },
  { key: 'peopleMissingIdentity', entity: 'people', label: 'People identity', column: 'people_missing_identity', fields: ['id', 'name'], meaning: 'People missing their database ID or name. Optional slugs, portraits and notes are excluded.' },
  { key: 'peopleMissingClassification', entity: 'people', label: 'People classification', column: 'people_missing_classification', fields: ['category'], meaning: 'People without the classification expected by existing diagnostics. Category is nullable in PostgreSQL; this is a review warning, not a database constraint failure.' },
  { key: 'venuesMissingIdentity', entity: 'venues', label: 'Venue identity', column: 'venues_missing_identity', fields: ['venue_id', 'venue_name'], meaning: 'Venues missing their public venue ID or name. Optional location descriptions and notes are excluded.' },
  { key: 'venuesIncompleteCoordinates', entity: 'venues', label: 'Venue coordinate pairs', column: 'venues_incomplete_coordinates', fields: ['latitude', 'longitude'], meaning: 'Venues with exactly one coordinate missing. Both coordinates absent is allowed; range and formatting validation are outside this check.' }
]);

function safeCount(value) {
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function cleanExamples(value, spec, count) {
  if (!Array.isArray(value)) throw new Error('Invalid bounded examples');
  return value.slice(0, Math.min(EXAMPLE_LIMIT, count)).map((sample) => {
    if (!sample || typeof sample !== 'object' || !Array.isArray(sample.missingFields)) throw new Error('Invalid example');
    const id = typeof sample.id === 'string' ? sample.id.slice(0, 100) : null;
    const name = typeof sample.name === 'string' ? sample.name.slice(0, 160) : null;
    const missingFields = [...new Set(sample.missingFields.filter((field) => spec.fields.includes(field)))];
    if (!missingFields.length) throw new Error('Invalid example fields');
    return { id, name, missingFields };
  });
}

function unavailableChecks(entity, state, reason) {
  return CHECKS.filter((check) => check.entity === entity).map(({ key, label, meaning }) => ({
    key, entity, label, meaning, count: null, totalRecords: null, state, examples: [], reason
  }));
}

function collectionChecks(entity, row) {
  const totalRecords = safeCount(row.total_records);
  if (totalRecords === null) throw new Error('Invalid total');
  return CHECKS.filter((check) => check.entity === entity).map((spec) => {
    const count = safeCount(row[spec.column]);
    if (count === null || count > totalRecords) throw new Error('Invalid count');
    return {
      key: spec.key, entity, label: spec.label, meaning: spec.meaning,
      count, totalRecords, state: count > 0 ? 'Warning' : 'Healthy',
      examples: cleanExamples(row[`${spec.column}_examples`], spec, count)
    };
  });
}

function combineState(checks) {
  for (const state of ['Error', 'Warning', 'Unavailable']) {
    if (checks.some((check) => check.state === state)) return state;
  }
  return 'Healthy';
}

// Dependency injection keeps this diagnostic independent of startup migrations and environment loading.
async function buildWrestlingMissingDataResponse({ db, now = () => performance.now(), date = () => new Date() } = {}) {
  const started = now();
  const result = {
    ok: true, route: ROUTE, source: 'postgres', generatedAt: date().toISOString(),
    database: { connected: false }, state: 'Unavailable',
    counts: { shows: null, people: null, venues: null, embeddedEntries: null }, checks: [],
    coverage: { embeddedEntries: { state: 'Unavailable', count: null, complete: false, unsupportedRows: null,
      reason: 'Embedded entry counts are unavailable. Participant requirements are not defined for every entry type; participant validation is unsupported.' } },
    timings: { schemaMs: null, showsMs: null, peopleMs: null, venuesMs: null, totalMs: null },
    warnings: []
  };
  const timedQuery = async (key, values = []) => {
    const begin = now();
    try {
      return await db.query({ text: QUERIES[key], values, query_timeout: QUERY_TIMEOUT_MS });
    } finally {
      result.timings[`${key}Ms`] = Math.max(0, Math.round((now() - begin) * 100) / 100);
    }
  };

  let schemaRows;
  try {
    if (!db || typeof db.query !== 'function') throw new Error('Unavailable database');
    const schema = await timedQuery('schema', [Object.values(TABLES)]);
    if (!schema || !Array.isArray(schema.rows)) throw new Error('Invalid schema response');
    schemaRows = schema.rows;
    result.database.connected = true;
  } catch (_) {
    result.ok = false;
    result.warnings.push('PostgreSQL schema inspection is unavailable. No collection result has been assumed.');
    for (const entity of Object.keys(TABLES)) result.checks.push(...unavailableChecks(entity, 'Unavailable', 'Database connectivity could not be verified.'));
  }

  if (schemaRows) {
    // Sequential collection queries bound backend work; the frontend may run Music alongside this request.
    for (const entity of Object.keys(TABLES)) {
      const columns = new Set(schemaRows.filter((row) => row.table_name === TABLES[entity]).map((row) => row.column_name));
      const missing = REQUIRED_COLUMNS[entity].filter((column) => !columns.has(column));
      if (missing.length) {
        const reason = `Required ${entity} schema is unavailable: ${missing.join(', ')}.`;
        result.checks.push(...unavailableChecks(entity, 'Unavailable', reason));
        result.warnings.push(reason);
        continue;
      }
      try {
        const response = await timedQuery(entity);
        if (!response || !Array.isArray(response.rows) || response.rows.length !== 1) throw new Error('Invalid aggregate response');
        const row = response.rows[0];
        const checks = collectionChecks(entity, row);
        let embedded;
        if (entity === 'shows') {
          const count = safeCount(row.embedded_entries);
          const unsupportedRows = safeCount(row.unsupported_rows);
          if (count === null || unsupportedRows === null || unsupportedRows > checks[0].totalRecords) throw new Error('Invalid embedded count');
          const complete = unsupportedRows === 0;
          embedded = { state: 'Unavailable', count, complete, unsupportedRows,
            reason: complete
              ? 'Stored JSON-array entries counted only. Participant requirements are not defined for every entry type; participant validation is unsupported.'
              : 'Only entries in valid JSON arrays are counted; NULL or non-array show rows make this a partial subtotal. Participant validation is unsupported.' };
        }
        result.checks.push(...checks);
        result.counts[entity] = checks[0].totalRecords;
        if (embedded) {
          result.coverage.embeddedEntries = embedded;
          result.counts.embeddedEntries = embedded.complete ? embedded.count : null;
        }
      } catch (_) {
        const reason = `${entity[0].toUpperCase() + entity.slice(1)} missing-data check failed or timed out. Previous values have not been reported as current.`;
        result.checks.push(...unavailableChecks(entity, 'Error', reason));
        result.warnings.push(reason);
      }
    }
  }
  result.state = combineState(result.checks);
  result.timings.totalMs = Math.max(0, Math.round((now() - started) * 100) / 100);
  return result;
}

module.exports = { buildWrestlingMissingDataResponse, ROUTE, QUERY_TIMEOUT_MS, EXAMPLE_LIMIT, QUERIES, REQUIRED_COLUMNS, TABLES, CHECKS, safeCount };
