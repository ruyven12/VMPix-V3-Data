'use strict';

const QUERY_TIMEOUT_MS = 2000;
const MESSAGE_LIMIT = 10;
const TEXT_LIMIT = 320;
const DATASETS = Object.freeze([
  ['music', 'bands'], ['music', 'shows'], ['music', 'people'], ['music', 'venues'],
  ['wrestling', 'shows'], ['wrestling', 'people'], ['wrestling', 'venues']
]);
const CORE_COLUMNS = Object.freeze(['id', 'section', 'category', 'status', 'started_at']);
const COLUMNS = Object.freeze([
  ...CORE_COLUMNS, 'source', 'source_identifier', 'import_type', 'finished_at', 'duration_ms',
  'rows_fetched', 'rows_imported', 'rows_inserted', 'rows_updated', 'rows_skipped',
  'total_rows_after_import', 'error_message', 'warnings', 'errors', 'meta', 'created_at'
]);
const SCHEMA_QUERY = `SELECT column_info.column_name, column_info.data_type,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace namespace
    JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
    JOIN pg_catalog.pg_index index_info ON index_info.indrelid = relation.oid
    JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_info.indexrelid
    JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam
    JOIN pg_catalog.pg_attribute section_column ON section_column.attrelid = relation.oid AND section_column.attname = 'section'
    JOIN pg_catalog.pg_attribute category_column ON category_column.attrelid = relation.oid AND category_column.attname = 'category'
    JOIN pg_catalog.pg_attribute started_column ON started_column.attrelid = relation.oid AND started_column.attname = 'started_at'
    WHERE namespace.nspname = 'public' AND relation.relname = 'import_history'
      AND index_info.indisvalid AND index_info.indisready AND index_info.indnkeyatts >= 3
      AND index_info.indpred IS NULL AND index_info.indexprs IS NULL AND access_method.amname = 'btree'
      AND index_info.indkey[0] = section_column.attnum AND index_info.indkey[1] = category_column.attnum
      AND index_info.indkey[2] = started_column.attnum
  ) AS latest_index_usable
FROM information_schema.columns column_info
WHERE column_info.table_schema = 'public' AND column_info.table_name = 'import_history'`;

async function query(db, text, values = []) {
  // pg's client wait limit is not a guarantee of server-side query cancellation.
  return db.query({ text, values, query_timeout: QUERY_TIMEOUT_MS });
}

async function readImportHistorySchema(db) {
  const result = await query(db, SCHEMA_QUERY);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const columns = new Set(rows.map(row => row.column_name).filter(name => COLUMNS.includes(name)));
  const types = new Map(rows.map(row => [row.column_name, row.data_type]));
  return {
    columns, types,
    available: CORE_COLUMNS.every(name => columns.has(name)),
    latestIndexUsable: rows.some(row => row.latest_index_usable === true),
    missing: COLUMNS.filter(name => !columns.has(name))
  };
}

function safeCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function safeTime(value) {
  if (value == null || value === '') return '';
  if (!(value instanceof Date) && typeof value !== 'string') return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function safeText(value) {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '[Unsupported detail]';
  let text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  // Import messages are untrusted. Do not expose configuration/credential-bearing lines.
  if (/(?:authorization|bearer\s|password|scrypt\$|api[\s_-]*key|token|secret|credential|oauth|cookie|private[\s_-]*key|database_url|postgres(?:ql)?:\/\/)/i.test(text)) return '[Sensitive detail redacted]';
  text = text.replace(/https?:\/\/[^\s<>]+/gi, '[URL omitted]');
  let low = 0;
  let high = Math.min(text.length, TEXT_LIMIT);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle)), 'utf8') <= TEXT_LIMIT) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function syncHealth(status) {
  const clean = String(status || '').trim().toLowerCase();
  if (clean === 'success') return 'healthy';
  if (clean === 'warning') return 'warning';
  if (clean === 'failed' || clean === 'error') return 'failed';
  return 'unknown';
}

function projectImportHistoryItem(row) {
  const messages = key => Array.isArray(row[key])
    ? row[key].filter(value => value != null).slice(0, MESSAGE_LIMIT).map(safeText) : [];
  const warnings = messages('warnings');
  const errors = messages('errors');
  const messageCount = key => Object.prototype.hasOwnProperty.call(row, `${key}_count`)
    ? safeCount(row[`${key}_count`]) : (Array.isArray(row[key]) ? row[key].length : null);
  const status = safeText(row.status) || '';
  const duration = safeCount(row.duration_ms);
  const warningCount = messageCount('warnings');
  const errorCount = messageCount('errors');
  const meta = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
  const metricSources = {
    rows_fetched: ['rowsFetched', 'rowsRead'], rows_imported: ['upserted', 'importedRows', 'rowsInserted', 'imported'],
    rows_inserted: ['rowsInserted'], rows_updated: ['rowsUpdated'], rows_skipped: ['skipped'], total_rows_after_import: []
  };
  const metrics = {};
  const provenance = {};
  for (const [field, keys] of Object.entries(metricSources)) {
    const stored = safeCount(row[field]);
    const evidenceKey = keys.find(key => Object.prototype.hasOwnProperty.call(meta, key));
    const evidence = evidenceKey ? safeCount(meta[evidenceKey]) : null;
    if (status.trim().toLowerCase() === 'running' || stored == null) {
      metrics[field] = null; provenance[field] = 'unavailable';
    } else if (evidenceKey && evidence !== stored) {
      metrics[field] = null; provenance[field] = 'conflict';
    } else if (stored > 0) {
      metrics[field] = stored; provenance[field] = 'stored_positive';
    } else if (field === 'total_rows_after_import' && safeTime(row.finished_at)) {
      metrics[field] = 0; provenance[field] = 'stored_explicit';
    } else if (evidenceKey && evidence === 0 && safeTime(row.finished_at)) {
      metrics[field] = 0; provenance[field] = 'explicit_zero';
    } else {
      metrics[field] = null; provenance[field] = 'unavailable';
    }
  }
  return {
    id: safeCount(row.id), dataset: `${safeText(row.section) || ''}.${safeText(row.category) || ''}`,
    section: safeText(row.section) || '', category: safeText(row.category) || '',
    source: safeText(row.source) || '', source_identifier: safeText(row.source_identifier) || '',
    import_type: safeText(row.import_type) || '', status, sync_health: syncHealth(status),
    started_at: safeTime(row.started_at), startedAt: safeTime(row.started_at),
    finished_at: safeTime(row.finished_at), finishedAt: safeTime(row.finished_at),
    duration_ms: duration, duration: duration == null ? null : `${duration}ms`,
    ...metrics, metric_provenance: provenance, rows_failed: null,
    refresh: !!(row.meta && (row.meta.refresh === true || row.meta.refresh === 'true')),
    error_message: safeText(row.error_message) || errors[0] || null,
    warnings, errors, warnings_count: warningCount, errors_count: errorCount,
    details_limited: warningCount > MESSAGE_LIMIT || errorCount > MESSAGE_LIMIT
      || ['warnings', 'errors'].some(key => Array.isArray(row[key]) && row[key].filter(value => value != null).slice(0, MESSAGE_LIMIT).some(value => typeof value !== 'string' || safeText(value) !== value)),
    // Only the explicit public fields above are reporting data; arbitrary import metadata is private.
    meta: {}, created_at: safeTime(row.created_at)
  };
}

function getImportReportingSelect(schema, alias = '') {
  const columns = schema ? schema.columns : new Set(COLUMNS);
  const prefix = alias ? `${alias}.` : '';
  const column = name => `${prefix}${name}`;
  const textFields = new Set(['section', 'category', 'status', 'source', 'source_identifier', 'import_type', 'error_message']);
  const parts = COLUMNS.filter(name => !['warnings', 'errors', 'meta'].includes(name)).map(name => {
    if (!columns.has(name)) return `NULL AS ${name}`;
    return textFields.has(name) ? `left(${column(name)}::text, 321) AS ${name}` : `${column(name)} AS ${name}`;
  });
  for (const name of ['warnings', 'errors']) {
    const jsonType = !schema || ['json', 'jsonb'].includes(schema.types.get(name));
    if (!columns.has(name) || !jsonType) {
      parts.push(`NULL::jsonb AS ${name}`, `NULL::integer AS ${name}_count`);
      continue;
    }
    const value = `${column(name)}::jsonb`;
    parts.push(`CASE WHEN jsonb_typeof(${value}) = 'array' THEN jsonb_build_array(${Array.from({ length: MESSAGE_LIMIT }, (_, i) => `left(${value}->>${i}, 321)`).join(', ')}) ELSE NULL END AS ${name}`);
    parts.push(`CASE WHEN jsonb_typeof(${value}) = 'array' THEN jsonb_array_length(${value}) ELSE NULL END AS ${name}_count`);
  }
  const metadataKeys = ['rowsRead', 'rowsFetched', 'upserted', 'importedRows', 'imported', 'rowsInserted', 'rowsUpdated', 'skipped', 'refresh'];
  const metadataType = !schema || ['json', 'jsonb'].includes(schema.types.get('meta'));
  parts.push(columns.has('meta') && metadataType
    ? `jsonb_strip_nulls(jsonb_build_object(${metadataKeys.map(key => `'${key}', CASE WHEN jsonb_typeof(${column('meta')}::jsonb->'${key}') IN ('number', 'string', 'boolean') THEN left(${column('meta')}::jsonb->>'${key}', 32) ELSE NULL END`).join(', ')})) AS meta`
    : `'{}'::jsonb AS meta`);
  return parts.join(',\n');
}

async function readLatestImportItems(db, schema, section, statuses) {
  if (!schema.available || !schema.latestIndexUsable) return [];
  const datasets = DATASETS.filter(([archive]) => !section || archive === section);
  const values = [];
  const datasetSql = datasets.map(([archive, category]) => {
    values.push(archive, category);
    return `($${values.length - 1}::text, $${values.length}::text)`;
  }).join(', ');
  let statusSql = '';
  if (Array.isArray(statuses) && statuses.length) {
    values.push(statuses.filter(value => ['success', 'warning', 'failed', 'error'].includes(value)));
    statusSql = ` AND lower(trim(history.status)) = ANY($${values.length}::text[])`;
  }
  const result = await query(db, `SELECT latest.* FROM (VALUES ${datasetSql}) AS dataset(section, category)
CROSS JOIN LATERAL (
  SELECT ${getImportReportingSelect(schema, 'history')}
  FROM public.import_history history
  WHERE history.section = dataset.section AND history.category = dataset.category${statusSql}
  ORDER BY history.started_at DESC LIMIT 1
) latest`, values);
  const allowed = new Set(datasets.map(parts => parts.join('.')));
  const seen = new Set();
  return (Array.isArray(result.rows) ? result.rows : []).slice(0, DATASETS.length).map(projectImportHistoryItem).filter(item => {
    if (!allowed.has(item.dataset) || seen.has(item.dataset)) return false;
    seen.add(item.dataset); return true;
  });
}

async function buildLatestImportReportingResponse(db, section = '') {
  const started = performance.now();
  const cleanSection = typeof section === 'string' ? section.trim().toLowerCase() : '';
  if (cleanSection && !['music', 'wrestling'].includes(cleanSection)) {
    return { ok: false, route: '/api/admin/import-history/latest', error: 'INVALID_SECTION', availability: 'Unavailable', items: [] };
  }
  const datasets = DATASETS.filter(([archive]) => !cleanSection || archive === cleanSection);
  const report = {
    ok: true, route: '/api/admin/import-history/latest', source: 'postgres', section: cleanSection || 'admin',
    generatedAt: new Date().toISOString(), database: { connected: false }, availability: 'Unavailable',
    items: [], warnings: [], coverage: { schemaAvailable: false, datasets: datasets.map(([archive, category]) => ({
      section: archive, category, state: 'Unavailable', reason: 'Import history has not been verified.'
    })) }, timings: { schemaMs: null, queryMs: null, totalMs: null },
    limits: { maxItems: datasets.length, maxMessages: MESSAGE_LIMIT, queryTimeoutMs: QUERY_TIMEOUT_MS }
  };
  try {
    let before = performance.now();
    const schema = await readImportHistorySchema(db);
    report.timings.schemaMs = Math.round((performance.now() - before) * 100) / 100;
    report.database.connected = true;
    report.coverage.schemaAvailable = schema.available;
    if (!schema.available) report.warnings.push('Import history table or required reporting columns are unavailable.');
    else if (!schema.latestIndexUsable) report.warnings.push('The required import-history lookup index is unavailable; reporting was not scanned.');
    else {
      if (schema.missing.length) report.warnings.push(`Some stored reporting fields are unavailable: ${schema.missing.join(', ')}.`);
      before = performance.now();
      report.items = await readLatestImportItems(db, schema, cleanSection);
      report.timings.queryMs = Math.round((performance.now() - before) * 100) / 100;
      const found = new Set(report.items.map(item => item.dataset));
      report.coverage.datasets.forEach(item => {
        item.state = found.has(`${item.section}.${item.category}`) ? 'Available' : 'Unavailable';
        item.reason = item.state === 'Available' ? null : 'No stored import history is available for this collection.';
      });
      report.availability = report.items.length === datasets.length && !schema.missing.length ? 'Available' : (report.items.length ? 'Partial' : 'Unavailable');
    }
  } catch (_) {
    report.ok = false;
    report.warnings.push('Import reporting could not be completed. Stored results are unavailable.');
  }
  report.timings.totalMs = Math.round((performance.now() - started) * 100) / 100;
  return report;
}

module.exports = {
  QUERY_TIMEOUT_MS, MESSAGE_LIMIT, TEXT_LIMIT, DATASETS, CORE_COLUMNS, COLUMNS, SCHEMA_QUERY,
  query, readImportHistorySchema, safeCount, safeText, projectImportHistoryItem,
  getImportReportingSelect, readLatestImportItems, buildLatestImportReportingResponse
};
