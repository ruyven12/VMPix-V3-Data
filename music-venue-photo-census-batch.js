'use strict';

const crypto = require('node:crypto');
const { DEFINITION, buildPlan, project } = require('./music-venue-photo-census');
const PREFIX = 'venue_photo_census_batch:';
const GATE = [1447907401, 1128615507];
const fail = (code, status = 503) => Object.assign(new Error(code), { code, status });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeVenueId = value => (typeof value === 'string' || Number.isSafeInteger(value) && value >= 0) &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(value)) ? String(value) : null;
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19) ?
  new Date(value).toISOString() : null;
const latestDate = values => values.filter(Boolean).sort().at(-1) || null;
const REASONS = new Set(['ambiguous_venue_identity', 'invalid_venue_identity', 'prior_operation_requires_reconciliation',
  'verified_within_freshness_window', 'not_requested', 'venue_not_found', 'operation_interrupted', 'batch_stopped',
  'show_missing_stable_venue_id', 'show_missing_verified_set_mappings', 'unverified_album_mapping',
  'album_path_collision', 'lineup_album_unresolved', 'album_without_verified_mapping', 'album_shared_outside_venue',
  'album_scan_limit_reached', 'scan_deadline_reached', 'provider_album_attribution_mismatch', 'pagination_unverifiable',
  'album_changed_during_scan', 'image_page_missing', 'pagination_incomplete', 'missing_stable_image_identity',
  'repeated_image_across_album_pages', 'unknown_media_type', 'unexpected_next_page', 'next_page_missing',
  'page_scan_limit_reached', 'provider_request_failed', 'venue_relationships_changed_during_scan',
  'batch_cancelled', 'batch_deadline_reached', 'cancelled', 'provider_authorization_failed', 'provider_limited',
  'persistence_requires_reconciliation', 'unavailable_reason']);
const safeReasons = values => Array.isArray(values) ? [...new Set(values.map(value =>
  REASONS.has(value) ? value : 'unavailable_reason'))] : [];
const operationKey = id => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw fail('invalid_operation_id', 400);
  return PREFIX + id;
};
const abortError = () => fail('cancelled');
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); };
  const timer = setTimeout(done, Math.max(0, ms));
  signal?.addEventListener('abort', abort, { once: true });
});

function normalizeBatchOptions(input = {}) {
  const integer = (name, fallback, min, max) => {
    const raw = input[name] ?? fallback;
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)
      throw fail('invalid_' + name, 400);
    return Number(raw);
  };
  const boolean = name => {
    if (input[name] == null) return false;
    if (typeof input[name] !== 'boolean') throw fail('invalid_' + name, 400);
    return input[name];
  };
  const mode = input.mode ?? 'dry-run';
  if (!['dry-run', 'execute'].includes(mode)) throw fail('invalid_mode', 400);
  const confirm = boolean('confirm'), forceRefresh = boolean('forceRefresh');
  const operationId = input.operationId ?? null;
  if (operationId != null) operationKey(operationId);
  if (mode === 'execute' && (!confirm || !operationId)) throw fail('execution_confirmation_required', 400);
  const values = input.venueIds ?? [];
  if (!Array.isArray(values) || values.length > 100 || values.some(id =>
    typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) throw fail('invalid_venueIds', 400);
  return { mode, confirm, operationId, limit: integer('limit', 5, 1, 10),
    budgetSeconds: integer('budgetSeconds', 120, 10, 300), maxAgeHours: integer('maxAgeHours', 24, 1, 8760),
    venueIds: [...new Set(values)].sort(), forceRefresh };
}

function requestFingerprint(options) {
  const { mode, confirm, operationId, ...parameters } = options;
  return digest(parameters);
}

// A session advisory mutex outlives import lease expiry. Every census writer uses
// the retained client, so losing that session cannot silently borrow a new writer.
async function withMusicVenueCensusGate(db, callback, { signal, timeoutMs = 10000 } = {}) {
  if (signal?.aborted) throw abortError();
  let late = false, timer, client;
  const pending = Promise.resolve().then(() => db.connect());
  pending.then(value => { if (late) value.release(true); }, () => {});
  try {
    client = await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => { late = true; reject(fail('census_connection_timeout')); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
  const controller = new AbortController();
  let lost = false, locked = false, destroy = false, result, error;
  const onError = () => { lost = true; destroy = true; controller.abort(); };
  const onAbort = () => controller.abort();
  client.on?.('error', onError);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const query = (text, values) => {
    if (lost) return Promise.reject(fail('census_connection_lost'));
    return client.query({ text, values, query_timeout: timeoutMs }).catch(error => { onError(); throw error; });
  };
  const ownedDb = { query, isHealthy: () => !lost, connect: async () => ({ query, release() {} }) };
  try {
    const gate = await query('SELECT pg_try_advisory_lock($1, $2) AS acquired', GATE);
    if (gate.rows[0]?.acquired !== true) throw fail('census_operation_active', 409);
    locked = true;
    if (controller.signal.aborted) throw abortError();
    result = await callback(ownedDb, controller.signal);
  } catch (caught) { error = caught; }
  finally {
    if (locked && !lost) {
      try {
        const unlocked = await query('SELECT pg_advisory_unlock($1, $2) AS released', GATE);
        if (unlocked.rows[0]?.released !== true) throw Error();
      } catch { destroy = true; error = fail('census_gate_release_failed'); }
    }
    signal?.removeEventListener('abort', onAbort);
    client.removeListener?.('error', onError);
    client.release(destroy || lost);
  }
  if (error) throw error;
  return result;
}

// Abort and drain every owned provider promise before giving up the advisory gate.
// This also covers the scanner's deadline race: its original fetch must settle.
function createCensusRequestScope({ fetchJson, signal, deadline, now = Date.now }) {
  let closed = false;
  const pending = new Set(), controllers = new Set();
  const abort = () => { for (const controller of controllers) controller.abort(); };
  signal?.addEventListener('abort', abort);
  const track = work => {
    let promise;
    promise = Promise.resolve().then(work).finally(() => pending.delete(promise));
    pending.add(promise); return promise;
  };
  const scopedFetch = (endpoint, options = {}) => track(async () => {
    if (closed || signal?.aborted || now() >= deadline) throw abortError();
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    controllers.add(controller);
    options.signal?.addEventListener('abort', abortRequest, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(abortRequest, Math.min(15000, Math.max(1, deadline - now())));
    try { return await fetchJson(endpoint, { ...options, signal: controller.signal }); }
    finally {
      clearTimeout(timer); controllers.delete(controller);
      options.signal?.removeEventListener('abort', abortRequest);
    }
  });
  return { fetchJson: scopedFetch, track, get closed() { return closed; },
    async close() {
      closed = true; abort();
      await Promise.allSettled([...pending]);
      signal?.removeEventListener('abort', abort);
    } };
}

async function assertMusicVenueCensusReconciled(db, venueId) {
  const id = safeVenueId(venueId);
  if (!id) throw fail('invalid_venue_identity', 409);
  const rows = (await db.query("SELECT data FROM stats_snapshots WHERE section = 'music' AND category = 'venues' AND snapshot_key LIKE 'venue_photo_census_batch:%'")).rows;
  if (rows.some(row => ['running', 'uncertain'].includes(row.data?.status) && row.data?.inflight?.venue_id === id))
    throw fail('prior_operation_requires_reconciliation', 409);
}

async function readTransaction(db, read) {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return await read(client);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

const SHOWS_SQL = 'SELECT show_id, name, date, venue_id, venue, album_id, gallery_id, bands, smug_albums FROM music_shows ORDER BY show_id';
async function loadSource(client) {
  const venues = (await client.query('SELECT venue_id, venue_key, venue FROM music_venues ORDER BY venue_key, venue_id')).rows;
  const shows = (await client.query(SHOWS_SQL)).rows;
  const snapshots = (await client.query("SELECT snapshot_key, data, meta, generated_at FROM stats_snapshots WHERE section = 'music' AND category = 'venues' AND (snapshot_key LIKE 'venue_photos:%' OR snapshot_key LIKE 'venue_photo_census_batch:%')")).rows;
  return { venues, shows, snapshots };
}

function classify(source, options, dateFolder, now) {
  const groups = new Map(), conflicts = new Set(), invalid = [];
  for (const venue of source.venues) {
    const canonical = safeVenueId(venue.venue_key || venue.venue_id);
    if (!canonical) {
      invalid.push({ public: { venue_id: null, category: 'unavailable',
        reasons: ['invalid_venue_identity'], linkedShows: 0, albums: 0, selected: false, providerAsOf: null } });
      continue;
    }
    const id = canonical.toLowerCase();
    if (groups.has(id) && digest(groups.get(id)) !== digest(venue)) conflicts.add(id);
    else if (!groups.has(id)) groups.set(id, venue);
  }
  const unresolved = new Set(source.snapshots.filter(row => row.snapshot_key.startsWith(PREFIX) &&
    row.data?.inflight && ['running', 'uncertain'].includes(row.data.status))
    .map(row => row.data.inflight.venue_id));
  const counts = new Map();
  for (const venue of groups.values()) for (const alias of new Set([venue.venue_key, venue.venue_id]
    .filter(v => v != null && String(v).trim()).map(v => String(v).trim().toLowerCase()))) {
    counts.set(alias, (counts.get(alias) || 0) + 1);
  }
  const seen = new Set(), records = [...invalid];
  for (const venue of groups.values()) {
    const id = String(venue.venue_key || venue.venue_id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const collision = conflicts.has(id.toLowerCase()) || [venue.venue_key, venue.venue_id].filter(v => v != null)
      .some(v => (counts.get(String(v).trim().toLowerCase()) || 0) > 1);
    const plan = buildPlan(venue, source.shows, dateFolder);
    const rows = source.snapshots.filter(row => row.snapshot_key.startsWith('venue_photos:' + encodeURIComponent(id) + ':'));
    const current = project(plan, rows);
    const age = now - Date.parse(current.verifiedAt);
    const fresh = current.complete && age >= 0 && age < options.maxAgeHours * 3600000;
    const reasons = collision ? ['ambiguous_venue_identity'] : [...new Set(plan.issues.map(issue => issue.reason))];
    if (unresolved.has(id)) reasons.push('prior_operation_requires_reconciliation');
    let category = reasons.length ? 'unavailable' : fresh && !options.forceRefresh ? 'skipped' : 'eligible';
    if (category === 'skipped') reasons.push('verified_within_freshness_window');
    const requested = !options.venueIds.length || options.venueIds.includes(id);
    if (!requested && category === 'eligible') { category = 'skipped'; reasons.push('not_requested'); }
    records.push({ venue, plan, public: { venue_id: id, category, reasons, linkedShows: plan.linked_show_count,
      albums: plan.albums.length, lastVerifiedAt: safeDate(current.lastVerifiedAt), verifiedAt: safeDate(current.verifiedAt),
      providerAsOf: safeDate(current.verifiedAt), freshnessDue: !fresh, selected: false } });
  }
  const selected = records.filter(row => row.public.category === 'eligible').slice(0, options.limit);
  selected.forEach(row => { row.public.selected = true; });
  const missing = options.venueIds.filter(id => !seen.has(id));
  for (const id of missing) records.push({ public: { venue_id: id, category: 'unavailable',
    reasons: ['venue_not_found'], linkedShows: 0, albums: 0, selected: false, providerAsOf: null } });
  return { records, selected, discovered: groups.size, sourceRows: source.venues.length,
    duplicateVenueRows: source.venues.length - groups.size - invalid.length };
}

function createMusicVenuePhotoCensusBatch({ db, createService, dateFolder, fetchJson,
  acquireImportLock, releaseImportLock, owner, now = Date.now, sleep = delay }) {
  const getJournal = async (client, id) => (await client.query(
    "SELECT data FROM stats_snapshots WHERE section = 'music' AND category = 'venues' AND snapshot_key = $1",
    [operationKey(id)])).rows[0]?.data || null;
  const saveJournal = async (client, job) => {
    await client.query("INSERT INTO stats_snapshots (section, category, snapshot_key, data, generated_at, meta) VALUES ('music', 'venues', $1, $2::jsonb, $3, $4::jsonb) ON CONFLICT (section, category, snapshot_key) DO UPDATE SET data = EXCLUDED.data, generated_at = EXCLUDED.generated_at, meta = EXCLUDED.meta",
      [operationKey(job.operationId), JSON.stringify(job), new Date(now()).toISOString(),
        JSON.stringify({ operation: 'venue_photo_census_batch', operationId: job.operationId })]);
  };
  const journalActivity = async (client, id) => {
    const job = await getJournal(client, id);
    let active = false;
    if (job?.status === 'running') {
      try {
        active = (await client.query("SELECT id FROM import_locks WHERE section = 'music' AND category = 'shows' AND status = 'running' AND expires_at > NOW() AND meta->>'operationId' = $1 LIMIT 1", [id])).rows.length > 0;
      } catch { active = null; }
    }
    return { job, active };
  };
  const displayJournal = (job, active = false) => {
    const validStatus = ['running', 'uncertain', 'interrupted', 'completed', 'stopped'].includes(job.status) ? job.status : 'unavailable';
    const interrupted = validStatus === 'running' && active === false;
    const results = (Array.isArray(job.results) ? job.results : []).map(row => {
      const id = safeVenueId(row?.venue_id);
      const status = id && ['success', 'incomplete', 'failed', 'skipped', 'unavailable', 'not_processed'].includes(row?.status) ? row.status : 'unavailable';
      return { venue_id: id, status, total: status === 'success' ? safeCount(row.total) : null,
        verifiedAt: id ? safeDate(row?.verifiedAt) : null, lastVerifiedAt: id ? safeDate(row?.lastVerifiedAt) : null,
        providerAsOf: id ? safeDate(row?.providerAsOf) : null, freshnessDue: row?.freshnessDue === true,
        reasons: [...safeReasons(row?.reasons), ...(!id ? ['invalid_venue_identity'] : [])] };
    });
    const inflight = job.inflight ? { venue_id: safeVenueId(job.inflight.venue_id),
      beforeSnapshot: /^[a-f0-9]{64}$/.test(job.inflight.beforeSnapshot) ? job.inflight.beforeSnapshot : null,
      startedAt: safeDate(job.inflight.startedAt) } : null;
    const selected = (Array.isArray(job.selectedVenueIds) ? job.selectedVenueIds : []).map(safeVenueId).filter(Boolean).slice(0, 10);
    const known = new Set(results.map(row => row.venue_id));
    if (interrupted) for (const id of selected) if (!known.has(id) && id !== inflight?.venue_id)
      results.push({ venue_id: id, status: 'not_processed', total: null, reasons: ['operation_interrupted'] });
    let parameters = null;
    try {
      const options = normalizeBatchOptions(job.parameters || {});
      parameters = { limit: options.limit, budgetSeconds: options.budgetSeconds, maxAgeHours: options.maxAgeHours,
        venueIds: options.venueIds, forceRefresh: options.forceRefresh };
    } catch {}
    const raw = job.summary || {};
    return { ok: true, mode: 'execute', operationId: typeof job.operationId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(job.operationId) ? job.operationId : null,
      parameters, status: active === null && validStatus === 'running' ? 'activity_unverified' :
        interrupted ? (inflight ? 'uncertain' : 'interrupted') : validStatus,
      startedAt: safeDate(job.startedAt), finishedAt: safeDate(job.finishedAt), inflight,
      selectedVenueIds: selected, providerRequests: safeCount(job.providerRequests),
      stopReason: REASONS.has(job.stopReason) ? job.stopReason : job.stopReason == null ? null : 'unavailable_reason',
      summary: { discovered: safeCount(raw.discovered), sourceRows: safeCount(raw.sourceRows),
        duplicateVenueRows: safeCount(raw.duplicateVenueRows), selected: safeCount(raw.selected),
        eligible: safeCount(raw.eligible), skipped: safeCount(raw.skipped), unavailable: safeCount(raw.unavailable),
        freshnessDue: safeCount(raw.freshnessDue), successes: results.filter(row => row.status === 'success').length,
        incomplete: results.filter(row => row.status === 'incomplete').length,
        failed: results.filter(row => row.status === 'failed').length,
        notProcessed: results.filter(row => row.status === 'not_processed').length,
        lastCompletedVenue: [...results].reverse().find(row => ['success', 'incomplete'].includes(row.status))?.venue_id || null,
        lastCompletedAt: latestDate(results.filter(row => row.status === 'success').map(row => row.verifiedAt)) },
      freshnessPolicy: 'Verified provider as-of plus relationship fingerprint; due again after maxAgeHours.',
      results, requiresReconciliation: !!inflight && active !== true || validStatus === 'uncertain' || active === null, replayed: true };
  };
  async function preview(input = {}) {
    const options = normalizeBatchOptions({ ...input, mode: 'dry-run' });
    const source = await readTransaction(db, loadSource);
    const { records, selected, discovered, sourceRows, duplicateVenueRows } = classify(source, options, dateFolder, now());
    return { ok: true, mode: 'dry-run', readOnly: true, databaseMutated: false,
      asOf: new Date(now()).toISOString(), maxAgeHours: options.maxAgeHours,
      freshnessPolicy: 'Relationship fingerprint plus verified provider as-of age; unchanged relationships do not prove current provider contents.',
      totals: { discovered, sourceRows, duplicateVenueRows,
        lastCompletedAt: latestDate(records.map(row => row.public.lastVerifiedAt)), eligible: records.filter(r => r.public.category === 'eligible').length,
        skipped: records.filter(r => r.public.category === 'skipped').length,
        unavailable: records.filter(r => r.public.category === 'unavailable').length, selected: selected.length },
      venues: records.map(row => row.public) };
  }
  async function status(id) {
    const { job, active } = await readTransaction(db, client => journalActivity(client, id));
    if (!job) throw fail('batch_not_found', 404);
    return displayJournal(job, active);
  }
  async function execute(input, { signal } = {}) {
    const options = normalizeBatchOptions(input);
    if (options.mode !== 'execute') return preview(options);
    const fingerprint = requestFingerprint(options);
    const previous = await readTransaction(db, client => journalActivity(client, options.operationId));
    if (previous.job) {
      if (previous.job.requestFingerprint !== fingerprint) throw fail('operation_id_conflict', 409);
      return displayJournal(previous.job, previous.active);
    }
    const absoluteDeadline = now() + options.budgetSeconds * 1000;
    return withMusicVenueCensusGate(db, async (ownedDb, gateSignal) => {
      const prior = await journalActivity(ownedDb, options.operationId);
      if (prior.job) {
        if (prior.job.requestFingerprint !== fingerprint) throw fail('operation_id_conflict', 409);
        return displayJournal(prior.job, prior.active);
      }
      const source = await readTransaction(ownedDb, loadSource);
      const { records, selected, discovered, sourceRows, duplicateVenueRows } = classify(source, options, dateFolder, now());
      let lock, job, stopReason = null, uncertain = false, lastRequestAt = -Infinity;
      let providerRequests = 0, allowedAlbums = new Set(), requestScope;
      const check = () => {
        if (gateSignal.aborted) stopReason ||= 'cancelled';
        if (now() >= deadline) stopReason ||= 'batch_deadline_reached';
        if (stopReason) throw fail(stopReason);
      };
      let deadline = absoluteDeadline - 3000;
      const pacedFetch = async (endpoint, scope) => {
        check();
        const match = /^\/album\/([A-Za-z0-9]+)(?:\?_accept=application\/json|!images\?count=\d+&start=\d+&_accept=application\/json&_expand=Image)$/.exec(endpoint);
        if (!match || !allowedAlbums.has(match[1])) throw fail('provider_endpoint_rejected');
        for (let attempt = 0; attempt <= 2; attempt++) {
          check();
          await sleep(Math.max(0, 250 - (now() - lastRequestAt)), gateSignal);
          check();
          const controller = new AbortController(), abort = () => controller.abort();
          gateSignal.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(abort, Math.min(15000, Math.max(1, deadline - now())));
          try {
            lastRequestAt = now(); providerRequests++;
            const response = await scope.fetchJson(endpoint, { retries: 0, signal: controller.signal });
            check(); return response;
          } catch (error) {
            if (scope.closed) throw fail('provider_request_failed');
            const status = Number(error?.status);
            if ([401, 403].includes(status)) stopReason = 'provider_authorization_failed';
            else if (status === 429 && attempt === 2) stopReason = 'provider_limited';
            check();
            const retriable = !status || status === 429 || status >= 500 && status <= 599;
            if (!retriable || attempt === 2) throw fail('provider_request_failed');
            const retryAfter = error?.retryAfterMs;
            const pause = retryAfter == null ? 500 * (attempt + 1) : retryAfter;
            if (!Number.isFinite(pause) || pause < 0 || pause > 5000) {
              stopReason = 'provider_limited'; throw fail(stopReason);
            }
            await sleep(pause, gateSignal);
          } finally { clearTimeout(timer); gateSignal.removeEventListener('abort', abort); }
        }
      };
      try {
        check();
        const acquired = await acquireImportLock({ section: 'music', category: 'shows', owner,
          meta: { operation: 'venue_photo_census_batch', operationId: options.operationId } });
        if (!acquired?.acquired) throw fail('music_shows_locked', 409);
        if (acquired.bypassed || !acquired.lock?.id || !Number.isFinite(Date.parse(acquired.lock.expires_at)))
          throw fail('active_lock_required');
        lock = acquired.lock;
        deadline = Math.min(deadline, Date.parse(lock.expires_at) - 5000);
        check();
        job = { operationId: options.operationId, requestFingerprint: fingerprint,
          parameters: { limit: options.limit, budgetSeconds: options.budgetSeconds, maxAgeHours: options.maxAgeHours,
            venueIds: options.venueIds, forceRefresh: options.forceRefresh },
          selectedVenueIds: selected.map(row => row.plan.venue_id),
          summary: { discovered, sourceRows, duplicateVenueRows, selected: selected.length,
            eligible: records.filter(row => row.public.category === 'eligible').length,
            skipped: records.filter(row => row.public.category === 'skipped').length,
            unavailable: records.filter(row => row.public.category === 'unavailable').length,
            freshnessDue: records.filter(row => row.public.freshnessDue).length },
          freshnessPolicy: 'Verified provider as-of plus relationship fingerprint; due again after maxAgeHours.',
          status: 'running', startedAt: new Date(now()).toISOString(), finishedAt: null,
          inflight: null, providerRequests: 0, stopReason: null,
          results: records.filter(row => !row.public.selected).map(row => ({ venue_id: row.public.venue_id,
            status: row.public.category === 'eligible' ? 'not_processed' : row.public.category, reasons: row.public.reasons,
            lastVerifiedAt: row.public.lastVerifiedAt, providerAsOf: row.public.providerAsOf,
            freshnessDue: row.public.freshnessDue })) };
        await saveJournal(ownedDb, job);
        for (let index = 0; index < selected.length; index++) {
          const { venue, plan } = selected[index];
          try { check(); } catch { break; }
          allowedAlbums = new Set(plan.albums.map(album => album.album_id));
          const before = (await ownedDb.query("SELECT data, meta, generated_at FROM stats_snapshots WHERE section = 'music' AND category = 'venues' AND snapshot_key = $1",
            ['venue_photos:' + encodeURIComponent(plan.venue_id) + ':attempt'])).rows[0] || null;
          job.inflight = { venue_id: plan.venue_id, beforeSnapshot: digest(before), startedAt: new Date(now()).toISOString() };
          job.providerRequests = providerRequests;
          await saveJournal(ownedDb, job);
          requestScope = createCensusRequestScope({ fetchJson, signal: gateSignal,
            deadline: Math.min(deadline, now() + 90000), now });
          const scope = requestScope;
          const service = createService(ownedDb, endpoint => scope.track(() => pacedFetch(endpoint, scope)));
          try {
            const result = await service.refresh(venue, lock, { deadline, signal: gateSignal, batchOperationId: options.operationId,
              onPersist: async (client, value) => {
                const record = { venue_id: plan.venue_id, status: value.complete ? 'success' : 'incomplete',
                  total: value.complete ? value.total : null, verifiedAt: value.verifiedAt,
                  reasons: [...new Set(value.issues.map(issue => issue.reason))] };
                const next = { ...job, results: [...job.results, record], inflight: null, providerRequests };
                await saveJournal(client, next);
              } });
            job.results.push({ venue_id: plan.venue_id, status: result.complete ? 'success' : 'incomplete',
              total: result.complete ? result.total : null, verifiedAt: result.verifiedAt,
              reasons: [...new Set(result.issues.map(issue => issue.reason))] });
            job.inflight = null; job.providerRequests = providerRequests;
          } catch {
            // No retry after an uncertain write/COMMIT. A repeat operation only reads
            // the durable atomic checkpoint; a new explicitly approved action is needed.
            uncertain = true; stopReason ||= 'persistence_requires_reconciliation';
            break;
          } finally { await scope.close(); requestScope = null; }
          if (stopReason) break;
        }
        const done = new Set(job.results.map(row => row.venue_id));
        selected.filter(row => !done.has(row.plan.venue_id) && row.plan.venue_id !== job.inflight?.venue_id)
          .forEach(row => job.results.push({ venue_id: row.plan.venue_id, status: 'not_processed',
            reasons: [stopReason || 'batch_stopped'] }));
        job.providerRequests = providerRequests;
        if (uncertain) {
          const durable = await getJournal(ownedDb, options.operationId);
          if (durable) job = durable;
          uncertain = !durable || !!durable.inflight;
          job.status = uncertain ? 'uncertain' : 'interrupted'; job.stopReason = stopReason;
          // Leave the durable inflight checkpoint intact if persistence is ambiguous.
        } else {
          job.status = stopReason ? 'stopped' : 'completed'; job.stopReason = stopReason;
          job.finishedAt = new Date(now()).toISOString();
          await saveJournal(ownedDb, job);
        }
      } finally {
        if (requestScope) await requestScope.close();
        if (lock) {
          if (!ownedDb.isHealthy()) throw fail('census_connection_lost');
          const released = await releaseImportLock(lock.id, job?.status === 'completed' ? 'completed' : 'failed',
            { operation: 'venue_photo_census_batch', operationId: options.operationId });
          if (!released || String(released.id) !== String(lock.id) || released.status !== (job?.status === 'completed' ? 'completed' : 'failed'))
            throw fail('import_lock_release_failed');
        }
      }
      return { ...displayJournal(job), replayed: false,
        requiresReconciliation: uncertain || !!job.inflight };
    }, { signal });
  }
  return { preview, status, execute };
}

module.exports = { createCensusRequestScope, assertMusicVenueCensusReconciled, normalizeBatchOptions, planMusicVenueCensusBatch: classify, withMusicVenueCensusGate, createMusicVenuePhotoCensusBatch };
