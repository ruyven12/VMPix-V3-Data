'use strict';

const { SCHEMA_QUERY } = require('./exact-duplicates');
const QUERY_TIMEOUT_MS = 2000;
const SCAN_LIMIT = 2000;
const GROUP_LIMIT = 10;
const ARRAY_LIMIT = 5;
const BUCKET_LIMIT = 20;
const ROW_KEY_LIMIT = 16;
const PAIR_ATTEMPT_LIMIT = 5000;
const VALUE_LIMIT = 160;
const RAW_BYTE_LIMIT = 256;
const MATCHING_KEYS = Object.freeze(['canonicalId', 'name', 'aliases', 'contexts', 'category', 'location', 'city', 'state', 'country', 'showDate', 'venueId', 'promotion']);
const DEFINITIONS = Object.freeze({
  music: Object.freeze([
    { collection: 'bands', table: 'music_bands', criterion: 'band_id', name: 'band', rule: 'bands_name_location', fields: ['id', 'band_id', 'band', 'location', 'state', 'country', 'region', 'status'] },
    { collection: 'shows', table: 'music_shows', criterion: 'show_id', name: 'name', rule: 'shows_name_date_venue', fields: ['id', 'show_id', 'name', 'show_date', 'venue_id', 'venue', 'city', 'state'] },
    { collection: 'people', table: 'music_people', criterion: 'person_id', name: 'name', rule: 'people_name_category_context', aliases: 'json', contexts: 'json', contextField: 'bands', fields: ['id', 'person_id', 'name', 'category', 'aliases', 'bands'] },
    { collection: 'venues', table: 'music_venues', criterion: 'venue_key', name: 'venue', rule: 'venues_name_location', fields: ['id', 'venue_key', 'venue', 'city', 'state', 'country', 'latitude', 'longitude'] }
  ]),
  wrestling: Object.freeze([
    { collection: 'shows', table: 'wrestling_shows', criterion: 'show_key', name: 'show_name', rule: 'shows_name_date_venue', promotion: true, fields: ['id', 'show_key', 'show_name', 'show_date', 'promotion', 'venue_id', 'venue', 'city'] },
    { collection: 'people', table: 'wrestling_people', criterion: 'slug', name: 'name', rule: 'people_name_category_context', aliases: 'text', contexts: 'text', contextField: 'teams', fields: ['id', 'slug', 'name', 'category', 'aliases', 'teams'] },
    { collection: 'venues', table: 'wrestling_venues', criterion: 'venue_id', name: 'venue_name', rule: 'venues_name_location', fields: ['id', 'venue_id', 'venue_name', 'city', 'state', 'country', 'latitude', 'longitude'] }
  ])
});

function arrayCount(field, kind) {
  if (kind === 'json') return `CASE WHEN ${field} IS NULL THEN 0 WHEN jsonb_typeof(${field}) = 'array' THEN jsonb_array_length(${field}) ELSE NULL END`;
  return `CASE WHEN ${field} IS NULL THEN 0 WHEN coalesce(array_ndims(${field}), 1) = 1 THEN cardinality(${field}) ELSE NULL END`;
}
function arraySlots(field, kind, objectField) {
  return `ARRAY[${Array.from({ length: ARRAY_LIMIT }, (_, index) => {
    if (kind === 'text') return `left(${field}[coalesce(array_lower(${field}, 1), 1) + ${index}], 161)`;
    const item = `${field}->${index}`, value = objectField ? `${item}->>'${objectField}'` : `${field}->>${index}`;
    const type = objectField ? `jsonb_typeof(${item}) = 'object' AND jsonb_typeof(${item}->'${objectField}') = 'string'` : `jsonb_typeof(${item}) = 'string'`;
    return `CASE WHEN ${type} THEN left(${value}, 161) ELSE NULL END`;
  }).join(', ')}]::text[]`;
}
function collectionQuery(spec) {
  const scalarFields = spec.fields.filter(field => !['aliases', spec.contextField].includes(field));
  const columns = ['id::text AS row_id', ...scalarFields.map(field => `left(${field}::text, 161) AS field_${field}`)];
  if (spec.aliases) columns.push(`${arrayCount('aliases', spec.aliases)} AS alias_count`, 'aliases IS NULL AS aliases_null', `${arraySlots('aliases', spec.aliases)} AS alias_slots`,
    `${arrayCount(spec.contextField, spec.contexts)} AS context_count`, `${spec.contextField} IS NULL AS contexts_null`, `${arraySlots(spec.contextField, spec.contexts, spec.contexts === 'json' ? 'band' : null)} AS context_slots`);
  return `SELECT ${columns.join(',\n  ')}\nFROM public.${spec.table}\nORDER BY id ASC LIMIT 2001`;
}
const QUERIES = Object.freeze(Object.fromEntries(Object.values(DEFINITIONS).flat().map(spec => [spec.table, collectionQuery(spec)])));

function count(value) {
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function normalize(value) { return value.trim().replace(/\s+/g, ' ').toLowerCase(); }
function boundedText(value) {
  return typeof value === 'string' && value.length <= VALUE_LIMIT && Buffer.byteLength(value, 'utf8') <= RAW_BYTE_LIMIT && Buffer.byteLength(JSON.stringify(value), 'utf8') <= VALUE_LIMIT;
}
function proofText(value) { return boundedText(value) && normalize(value) !== '' && boundedText(normalize(value)); }
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function clip(value) {
  if (value === null) return { value: null, truncated: false };
  if (typeof value !== 'string') throw new Error('Invalid public field');
  let clean = '', bytes = 2;
  for (const character of value) {
    const extra = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (clean.length + character.length > VALUE_LIMIT || bytes + extra > VALUE_LIMIT) break;
    clean += character; bytes += extra;
  }
  return { value: clean, truncated: clean !== value };
}
function sourceArrays(row, spec) {
  if (!spec.aliases) return { aliases: [], contexts: [] };
  const aliasCount = count(row.alias_count), contextCount = count(row.context_count);
  if (aliasCount === null || contextCount === null || aliasCount > ARRAY_LIMIT || contextCount > ARRAY_LIMIT ||
      !Array.isArray(row.alias_slots) || !Array.isArray(row.context_slots) || row.alias_slots.length !== ARRAY_LIMIT || row.context_slots.length !== ARRAY_LIMIT ||
      typeof row.aliases_null !== 'boolean' || typeof row.contexts_null !== 'boolean' || row.aliases_null && aliasCount !== 0 || row.contexts_null && contextCount !== 0 ||
      row.alias_slots.slice(aliasCount).some(value => value !== null) || row.context_slots.slice(contextCount).some(value => value !== null)) return null;
  const aliases = row.alias_slots.slice(0, aliasCount), contexts = row.context_slots.slice(0, contextCount);
  return aliases.every(proofText) && contexts.every(proofText) ? { aliases, contexts } : null;
}
function prepareRow(row, spec) {
  if (!row || typeof row !== 'object' || !proofText(row.row_id) || row.field_id !== row.row_id) return null;
  const arrays = sourceArrays(row, spec); if (!arrays) return null;
  const rawFields = {};
  for (const field of spec.fields) {
    if (field === 'aliases') rawFields[field] = row.aliases_null ? null : JSON.stringify(arrays.aliases);
    else if (field === spec.contextField) rawFields[field] = row.contexts_null ? null : JSON.stringify(arrays.contexts);
    else {
      const value = row[`field_${field}`];
      if (value !== null && typeof value !== 'string') return null;
      rawFields[field] = value;
    }
  }
  const matchingData = Object.fromEntries(MATCHING_KEYS.map(key => [key, ['aliases', 'contexts'].includes(key) ? [] : null]));
  Object.assign(matchingData, { canonicalId: rawFields[spec.criterion], name: rawFields[spec.name], ...arrays });
  if (!proofText(matchingData.canonicalId) || !proofText(matchingData.name)) return null;
  const required = [];
  if (spec.rule === 'bands_name_location') required.push('location', 'state', 'country');
  if (spec.rule === 'venues_name_location') required.push('city', 'state', 'country');
  if (spec.rule === 'shows_name_date_venue') {
    matchingData.showDate = rawFields.show_date; matchingData.venueId = rawFields.venue_id;
    if (!validDate(matchingData.showDate) || !proofText(matchingData.venueId)) return null;
    if (spec.promotion) required.push('promotion');
  }
  if (spec.rule === 'people_name_category_context') {
    required.push('category');
    if (!arrays.contexts.length) return null;
  }
  for (const key of required) {
    matchingData[key] = rawFields[key];
    if (!proofText(matchingData[key])) return null;
  }
  const name = normalize(matchingData.name), keys = [];
  if (spec.rule === 'bands_name_location') keys.push([name, ...['location', 'state', 'country'].map(key => normalize(matchingData[key]))]);
  if (spec.rule === 'venues_name_location') keys.push([name, ...['city', 'state', 'country'].map(key => normalize(matchingData[key]))]);
  if (spec.rule === 'shows_name_date_venue') keys.push([name, matchingData.showDate, matchingData.venueId, spec.promotion ? normalize(matchingData.promotion) : null]);
  if (spec.rule === 'people_name_category_context') {
    const names = [...new Set([name, ...arrays.aliases.map(normalize)])], contexts = [...new Set(arrays.contexts.map(normalize))];
    for (const token of names) for (const context of contexts) keys.push([token, normalize(matchingData.category), context]);
  }
  if (keys.length > ROW_KEY_LIMIT) return null;
  return { id: row.row_id, name: matchingData.name, rawFields, matchingData, keys: keys.map(key => JSON.stringify(key)) };
}
function intersection(a, b) { const right = new Set(b); return [...new Set(a)].filter(value => right.has(value)).sort(); }
function evidenceFor(a, b, spec) {
  if (a.canonicalId === b.canonicalId) return null;
  const primary = normalize(a.name), samePrimary = primary === normalize(b.name);
  const sharedName = samePrimary ? primary : intersection([primary, ...a.aliases.map(normalize)], [normalize(b.name), ...b.aliases.map(normalize)])[0];
  if (!sharedName || !samePrimary && spec.rule !== 'people_name_category_context') return null;
  const evidence = [{ field: 'name', kind: samePrimary ? 'Normalized name' : 'Alias overlap', value: sharedName }];
  let fields = [];
  if (spec.rule === 'bands_name_location') fields = ['location', 'state', 'country'];
  if (spec.rule === 'venues_name_location') fields = ['city', 'state', 'country'];
  if (spec.rule === 'shows_name_date_venue') {
    if (a.showDate !== b.showDate || a.venueId !== b.venueId) return null;
    evidence.push({ field: 'showDate', kind: 'Exact equality', value: a.showDate }, { field: 'venueId', kind: 'Exact equality', value: a.venueId });
    if (spec.promotion) fields = ['promotion'];
  }
  if (spec.rule === 'people_name_category_context') {
    const category = normalize(a.category); if (category !== normalize(b.category)) return null;
    const context = intersection(a.contexts.map(normalize), b.contexts.map(normalize))[0];
    if (!context) return null;
    // Contexts are reported affiliation names, not inferred stable band/team identifiers.
    evidence.push({ field: 'category', kind: 'Normalized equality', value: category }, { field: 'context', kind: 'Normalized equality', value: context });
  }
  for (const field of fields) {
    const value = normalize(a[field]); if (value !== normalize(b[field])) return null;
    evidence.push({ field, kind: 'Normalized equality', value });
  }
  return evidence;
}
function publicRecord(row, spec) {
  const fields = {}, truncatedFields = [];
  for (const field of spec.fields) {
    const clean = clip(row.rawFields[field]); fields[field] = clean.value;
    if (clean.truncated) truncatedFields.push(field);
  }
  return { id: row.id, name: row.name, fields, truncatedFields, matchingData: row.matchingData };
}
function candidateGroup(pair, spec) {
  const records = pair.rows.map(row => publicRecord(row, spec));
  const comparison = spec.fields.map(field => ({ field, status: records.some(record => record.fields[field] === null || record.truncatedFields.includes(field)) ? 'Unknown' : records[0].fields[field] === records[1].fields[field] ? 'Matching' : 'Different' }));
  return { classification: 'Possible Match', evidence: pair.evidence, records, comparison };
}
function matchRows(rows, spec, remaining) {
  const bounded = rows.slice(0, SCAN_LIMIT), idCounts = new Map();
  for (const row of bounded) if (row && typeof row.row_id === 'string') idCounts.set(row.row_id, (idCounts.get(row.row_id) || 0) + 1);
  const eligible = bounded.map(row => row && idCounts.get(row.row_id) === 1 ? prepareRow(row, spec) : null).filter(Boolean);
  const buckets = new Map();
  for (const row of eligible) for (const key of row.keys) {
    if (!buckets.has(key)) buckets.set(key, { count: 0, rows: [] });
    const bucket = buckets.get(key); bucket.count++;
    if (bucket.rows.length < BUCKET_LIMIT) bucket.rows.push(row);
  }
  let attempts = 0, bucketLimited = false, pairLimited = false;
  const pairs = new Map();
  outer: for (const [, bucket] of [...buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (bucket.count > BUCKET_LIMIT) { bucketLimited = true; continue; }
    for (let left = 0; left < bucket.rows.length; left++) for (let right = left + 1; right < bucket.rows.length; right++) {
      if (attempts >= PAIR_ATTEMPT_LIMIT) { pairLimited = true; break outer; }
      attempts++;
      const pair = [bucket.rows[left], bucket.rows[right]].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const key = JSON.stringify(pair.map(row => row.id)); if (pairs.has(key)) continue;
      const evidence = evidenceFor(pair[0].matchingData, pair[1].matchingData, spec);
      if (evidence) pairs.set(key, { rows: pair, evidence });
    }
  }
  const unassessedRows = rows.length - eligible.length;
  const complete = rows.length <= SCAN_LIMIT && unassessedRows === 0 && !bucketLimited && !pairLimited;
  const reasons = [];
  if (rows.length > SCAN_LIMIT) reasons.push('The ordered probe exceeded 2,000 rows.');
  if (unassessedRows) reasons.push(`${unassessedRows} source rows were unassessed because corroboration was unavailable or outside supported bounds; optional fields are not missing-data errors.`);
  if (bucketLimited) reasons.push('A matching bucket exceeded 20 records and was not enumerated.');
  if (pairLimited) reasons.push('The 5,000 pair-attempt budget was reached.');
  if (complete) reasons.push('The complete bounded source satisfied the conservative rule; this is not a full identity or similarity audit.');
  return {
    state: pairs.size > 0 ? 'Warning' : complete ? 'Healthy' : 'Unavailable', count: complete ? pairs.size : null, sampleCount: pairs.size,
    scannedRows: rows.length, eligibleRows: eligible.length, unassessedRows,
    coverage: { complete, limit: SCAN_LIMIT, reason: reasons.join(' ') },
    groups: [...pairs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, remaining).map(([, pair]) => candidateGroup(pair, spec))
  };
}
function checkBase(spec, reason, state = 'Unavailable') {
  return {
    collection: spec.collection, rule: spec.rule,
    meaning: 'Possible review candidates require distinct raw canonical IDs, normalized name or verified alias overlap and the stated corroborating metadata. Names alone are insufficient. No candidate is a confirmed duplicate; shared band/team text is reported affiliation, not identity proof.',
    state, count: null, sampleCount: 0, scannedRows: null, eligibleRows: null, unassessedRows: null,
    coverage: { complete: false, limit: SCAN_LIMIT, reason }, groups: []
  };
}
async function buildPossibleDuplicatesResponse({ db, archive, now = () => performance.now(), date = () => new Date() } = {}) {
  const specs = DEFINITIONS[archive]; if (!Array.isArray(specs)) throw new Error('Unsupported archive');
  const started = now();
  const result = {
    ok: true, route: `/api/admin/diagnostics/${archive}/possible-duplicates`, source: 'postgres', archive, mode: 'manual', generatedAt: date().toISOString(),
    database: { connected: false }, state: 'Unavailable', checks: [],
    coverage: archive === 'wrestling' ? { embeddedMatches: { state: 'Unavailable', reason: 'Embedded matches have no verified stable identity and are excluded. Names, repeated appearances, URLs and array positions cannot establish duplicate matches.' } } : {},
    timings: { schemaMs: null, totalMs: null, collections: Object.fromEntries(specs.map(spec => [spec.collection, null])), matchingMs: Object.fromEntries(specs.map(spec => [spec.collection, null])) }, warnings: []
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
    if (!response || !Array.isArray(response.rows)) throw new Error('Invalid schema response');
    schema = response.rows; result.database.connected = true;
  } catch (_) {
    result.ok = false; result.warnings.push('PostgreSQL metadata could not be verified. No matching scan was run.');
    result.checks = specs.map(spec => checkBase(spec, 'Database connectivity could not be verified.'));
  }
  let remaining = GROUP_LIMIT;
  if (schema) for (const spec of specs) {
    const columns = schema.filter(row => row.table_name === spec.table);
    if (!spec.fields.every(field => columns.some(row => row.column_name === field)) || !columns.some(row => row.column_name === 'id' && row.id_index_usable === true)) {
      result.checks.push(checkBase(spec, 'Required public columns or a usable nonnullable single-column unique btree id index are unavailable. No collection probe was run.')); continue;
    }
    try {
      const response = await query(QUERIES[spec.table], [], spec.collection);
      if (!response || !Array.isArray(response.rows) || response.rows.length > SCAN_LIMIT + 1) throw new Error('Invalid bounded response');
      const begin = now(), matched = matchRows(response.rows, spec, remaining);
      result.timings.matchingMs[spec.collection] = Math.max(0, Math.round((now() - begin) * 100) / 100);
      result.checks.push({ ...checkBase(spec, ''), ...matched }); remaining -= matched.groups.length;
    } catch (_) {
      result.checks.push(checkBase(spec, 'The bounded possible-match check failed or timed out. No candidate total has been assumed.', 'Error'));
      result.warnings.push(`${spec.collection}: possible matching is unavailable.`);
    }
  }
  result.state = ['Error', 'Warning', 'Unavailable'].find(state => result.checks.some(check => check.state === state)) || 'Healthy';
  result.timings.totalMs = Math.max(0, Math.round((now() - started) * 100) / 100);
  return result;
}

module.exports = { buildPossibleDuplicatesResponse, DEFINITIONS, QUERIES, SCHEMA_QUERY, MATCHING_KEYS, QUERY_TIMEOUT_MS, SCAN_LIMIT, GROUP_LIMIT, ARRAY_LIMIT, BUCKET_LIMIT, ROW_KEY_LIMIT, PAIR_ATTEMPT_LIMIT, normalize, validDate };
