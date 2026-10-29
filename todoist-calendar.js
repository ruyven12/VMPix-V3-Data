'use strict';

const { PROJECT_ID, readConfig, createTodoistAuth, fault, safeCode, requestJson, withDbLock, query } = require('./todoist-auth');

const TIMEZONE = 'America/New_York';
const INTERVAL_MS = 300000;
const POLICY_VERSION = 'voodoo-gigs-public-confirmed-v1';
const TASKS_URL = 'https://api.todoist.com/api/v1/tasks';
const EVENT_KEYS = ['event_id', 'title', 'date', 'start_time', 'all_day', 'location', 'status', 'description'];
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function localParts(instant) {
  const p = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(item => [item.type, item.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, second: p.second };
}

function validDate(value) {
  const match = typeof value === 'string' && datePattern.exec(value);
  if (!match || Number(match[1]) < 1970) return false;
  const instant = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return instant.toISOString().slice(0, 10) === value;
}

// Derive New York offsets with Intl, rather than assuming a browser/server timezone.
// A floating clock time in a DST gap or fold has no unique instant and is withheld.
function localInstant(date, time, second = '00') {
  if (!validDate(date) || !timePattern.test(time) || !/^[0-5]\d$/.test(second)) return null;
  const wall = Date.parse(`${date}T${time}:${second}Z`);
  const candidates = new Set();
  for (const delta of [-129600000, 0, 129600000]) {
    const probe = wall + delta;
    const parts = localParts(probe);
    const offset = Date.parse(`${parts.date}T${parts.time}:${parts.second}Z`) - probe;
    const candidate = wall - offset;
    const check = localParts(candidate);
    if (check.date === date && check.time === time && check.second === second) candidates.add(candidate);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function dayEnd(date) {
  const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return localInstant(nextDate, '00:00');
}

function text(value, limit) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean && clean.length <= limit ? clean : null;
}

function schedule(due) {
  if (!due || due.is_recurring !== false || typeof due.date !== 'string') return null;
  if (validDate(due.date)) return { date: due.date, time: null, allDay: true, instant: localInstant(due.date, '00:00'), end: dayEnd(due.date) };
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::([0-5]\d)(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(due.date);
  if (!match || !validDate(match[1]) || !timePattern.test(match[2])) return null;
  let instant;
  if (match[4]) {
    instant = Date.parse(due.date);
    if (!Number.isFinite(instant)) return null;
  } else {
    if (due.timezone != null && due.timezone !== TIMEZONE) return null;
    instant = localInstant(match[1], match[2], match[3] || '00');
    if (instant === null) return null;
  }
  const parts = localParts(instant);
  return { date: parts.date, time: parts.time, allDay: false, instant, end: instant };
}

function publicDescription(value) {
  if (typeof value !== 'string' || value.length > 20000) return { location: null, description: null };
  const output = { location: null, description: null };
  const seen = new Set();
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*(Location|Public):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1] === 'Location' ? 'location' : 'description';
    // Ambiguous repeated fields are omitted, not concatenated with private text.
    output[key] = seen.has(key) ? null : text(match[2], key === 'location' ? 300 : 2000);
    seen.add(key);
  }
  return output;
}

function normalizeTask(task, now) {
  if (!task || typeof task !== 'object' || Array.isArray(task) || task.project_id !== PROJECT_ID ||
    typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(task.id) || task.id.startsWith('tmp-') ||
    task.checked !== false || task.is_completed === true || task.completed_at != null || task.is_deleted !== false || task.parent_id !== null ||
    !Array.isArray(task.labels) || task.labels.some(label => typeof label !== 'string') ||
    !task.labels.includes('public-confirmed') || task.labels.some(label => ['cancelled', 'draft', 'tentative'].includes(label.trim().toLowerCase()))) return null;
  const title = text(task.content, 500);
  const timing = schedule(task.due);
  if (!title || !timing || timing.end === null || timing.end <= now) return null;
  return { event: { event_id: task.id, title, date: timing.date, start_time: timing.time,
    all_day: timing.allDay, ...publicDescription(task.description), status: 'confirmed' }, timing };
}

function normalizeTasks(tasks, now) {
  return tasks.map(task => normalizeTask(task, now)).filter(Boolean).sort((a, b) =>
    a.event.date.localeCompare(b.event.date) || Number(b.event.all_day) - Number(a.event.all_day) ||
    a.timing.instant - b.timing.instant || a.event.event_id.localeCompare(b.event.event_id));
}

function taskSignature(task) {
  // Object/label ordering and unrelated private metadata must not create false conflicts.
  return JSON.stringify([task.project_id, task.content, task.checked, task.is_completed, task.completed_at,
    task.is_deleted, task.parent_id, Array.isArray(task.labels) ? [...task.labels].sort() : task.labels,
    task.due?.date, task.due?.timezone, task.due?.is_recurring, task.description]);
}

// A stored snapshot is still untrusted at the public boundary. Never spread records.
function publicRecords(records) {
  if (!Array.isArray(records) || records.length > 1000) throw fault('SNAPSHOT_INVALID');
  const ids = new Set();
  return records.map(record => {
    if (!record || typeof record !== 'object' || Object.keys(record).length !== EVENT_KEYS.length ||
      EVENT_KEYS.some(key => !Object.prototype.hasOwnProperty.call(record, key)) ||
      typeof record.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.event_id) ||
      record.event_id.startsWith('tmp-') || ids.has(record.event_id) || typeof record.title !== 'string' || text(record.title, 500) !== record.title ||
      !validDate(record.date) || typeof record.all_day !== 'boolean' || record.status !== 'confirmed' ||
      (record.all_day ? record.start_time !== null : typeof record.start_time !== 'string' || !timePattern.test(record.start_time)) ||
      (record.location !== null && text(record.location, 300) !== record.location) ||
      (record.description !== null && text(record.description, 2000) !== record.description)) throw fault('SNAPSHOT_INVALID');
    ids.add(record.event_id);
    return Object.fromEntries(EVENT_KEYS.map(key => [key, record[key]]));
  });
}

const READ_SNAPSHOT = `SELECT s.*, c.credential_version AS current_credential_version,
  (c.encrypted_tokens IS NOT NULL AND c.blocked = FALSE AND c.configuration_id = $1) AS credentials_ready
  FROM calendar_publication_snapshot s LEFT JOIN todoist_oauth_credentials c ON c.id = 1 WHERE s.id = 1`;

function createCalendar({ db, env = process.env, fetchImpl = global.fetch, clock = Date.now,
  logger = console, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  // Public exposure is independent of OAuth configuration and the refresh worker.
  // Deliberately excluded from readConfig's credential fingerprint.
  const config = { ...readConfig(env),
    publicEnabled: env.TODOIST_CALENDAR_PUBLIC_ENABLED === 'true' || env.TODOIST_CALENDAR_PUBLIC_ENABLED === '1' };
  const auth = createTodoistAuth({ db, config, fetchImpl, clock });
  let timer = null, running = null, controller = null, stopped = true;
  const note = (status, code) => logger.info?.('Calendar refresh', { status, code });

  async function fetchTasks(signal) {
    let credential = await auth.getAccessToken({ signal });
    let cursor = null, refreshedAfter401 = false;
    const cursors = new Set(), tasks = new Map();
    for (let page = 0; page < 20; page += 1) {
      if (signal?.aborted) throw fault('CANCELLED');
      const url = new URL(TASKS_URL);
      url.searchParams.set('project_id', PROJECT_ID);
      url.searchParams.set('limit', '50');
      if (cursor) url.searchParams.set('cursor', cursor);
      let response = await requestJson(fetchImpl, url.href, { signal, clock,
        headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json' } });
      if (response.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        credential = await auth.getAccessToken({ rejectedToken: credential.token, signal });
        response = await requestJson(fetchImpl, url.href, { signal, clock,
          headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json' } });
      }
      if ([401, 403].includes(response.status)) { await auth.block(); throw fault('AUTH_REAUTHORIZE'); }
      if (response.status === 429) throw fault('RATE_LIMIT', response.retryAfterMs);
      if (!response.ok) throw fault('UPSTREAM');
      const body = response.data;
      if (!body || !Array.isArray(body.results) || body.results.length > 50 ||
        !(body.next_cursor === null || typeof body.next_cursor === 'string' && body.next_cursor.length > 0 && body.next_cursor.length <= 2048)) throw fault('RESPONSE_INVALID');
      for (const task of body.results) {
        if (task?.project_id != null && task.project_id !== PROJECT_ID) throw fault('SCOPE_MISMATCH');
        if (!task || typeof task.id !== 'string') continue;
        if (tasks.has(task.id) && taskSignature(tasks.get(task.id)) !== taskSignature(task)) throw fault('INCONSISTENT_SCAN');
        tasks.set(task.id, task);
      }
      cursor = body.next_cursor;
      if (cursor === null) return { tasks: [...tasks.values()], credentialVersion: credential.version };
      if (cursors.has(cursor)) throw fault('CURSOR_LOOP');
      cursors.add(cursor);
    }
    throw fault('SCAN_LIMIT');
  }

  async function refresh() {
    if (!config.configured) return { status: 'disabled', delay: INTERVAL_MS };
    if (running) return { status: 'busy', delay: INTERVAL_MS };
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), 60000);
    running = (async () => {
      try {
        const result = await withDbLock(db, 1, async client => {
          await query(client, 'INSERT INTO calendar_publication_snapshot (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
          const existing = (await query(client, READ_SNAPSHOT, [config.configurationId])).rows?.[0];
          const now = clock();
          // pg returns a Date; Date.parse(Date) would discard its milliseconds.
          const nextAttempt = new Date(existing?.next_attempt_at).getTime();
          // All processes consult the same persisted schedule; one winner per interval.
          // Reauthorization may clear an authentication failure, but must not
          // bypass a provider rate-limit deadline shared by every worker.
          if (nextAttempt > now && (existing?.last_error_code === 'RATE_LIMIT' ||
            existing?.current_credential_version === existing?.attempt_credential_version)) {
            return { status: 'waiting', delay: nextAttempt - now };
          }
          await query(client, `UPDATE calendar_publication_snapshot SET refresh_status = 'running',
            attempt_started_at = $1, attempt_credential_version = $2, next_attempt_at = $3 WHERE id = 1`,
          [new Date(now), existing?.current_credential_version || null, new Date(now + INTERVAL_MS)]);
          try {
            const scan = await fetchTasks(controller.signal);
            if (controller.signal.aborted) throw fault('CANCELLED');
            const normalized = normalizeTasks(scan.tasks, clock());
            const events = normalized.map(item => item.event);
            // Contract has no UTC instant. Tighten freshness at the first event boundary
            // so a cached snapshot can never claim a started event is still upcoming,
            // including the repeated New York hour during the autumn DST change.
            const validUntil = Math.min(now + INTERVAL_MS, ...normalized.map(item => item.timing.end));
            if (validUntil <= clock()) throw fault('TIMEOUT');
            await query(client, 'BEGIN');
            try {
              // Reauthorization may occur during the scan. Do not publish for the old credential.
              const lease = await query(client, `SELECT credential_version FROM todoist_oauth_credentials
                WHERE id = 1 AND credential_version = $1 AND configuration_id = $2 AND blocked = FALSE FOR SHARE`,
              [scan.credentialVersion, config.configurationId]);
              if (!lease.rows?.length) throw fault('AUTH_REAUTHORIZE');
              await query(client, `UPDATE calendar_publication_snapshot SET events = $1::jsonb, verified_at = $2,
                published_at = $3, valid_until = $4, credential_version = $5, policy_version = $6,
                last_error_code = NULL, refresh_status = 'idle', next_attempt_at = $7,
                attempt_credential_version = $5 WHERE id = 1`,
              [JSON.stringify(events), new Date(now), new Date(clock()), new Date(validUntil), scan.credentialVersion,
                POLICY_VERSION, new Date(Math.max(now + 10000, validUntil))]);
              await query(client, 'COMMIT');
            } catch (error) { await query(client, 'ROLLBACK'); throw error; }
            note('success', null);
            return { status: 'success', count: events.length, delay: Math.max(10000, validUntil - clock()) };
          } catch (error) {
            const code = safeCode(error);
            const delay = Math.max(INTERVAL_MS, Number(error.retryAfterMs) || 0);
            const status = code.startsWith('AUTH_') && code !== 'AUTH_BUSY' ? 'auth_required' : 'failed';
            await query(client, `UPDATE calendar_publication_snapshot SET last_error_code = $1,
              refresh_status = $2, next_attempt_at = $3 WHERE id = 1`, [code, status, new Date(clock() + delay)]);
            note(status, code);
            return { status, code, delay };
          }
        });
        return result || { status: 'busy', delay: INTERVAL_MS };
      } catch (error) {
        note('failed', safeCode(error));
        return { status: 'failed', code: safeCode(error), delay: INTERVAL_MS };
      }
    })();
    try { return await running; }
    finally { clearTimeout(deadline); running = null; controller = null; }
  }

  function scheduleNext(delay) {
    if (stopped) return;
    timer = setTimer(async () => {
      timer = null;
      const result = await refresh();
      // Long Retry-After values are persisted; never overflow the platform timer.
      scheduleNext(Math.min(2147483647, Math.max(10000, result.delay)));
    }, delay);
    timer?.unref?.();
  }
  function start() {
    if (!stopped || !config.configured) return;
    stopped = false;
    scheduleNext(0);
  }
  async function stop() {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    await running;
  }

  function unavailable(status = 'unavailable', freshness = null) {
    return { httpStatus: 503, cache: 'no-store', body: { status, timezone: TIMEZONE, events: [], freshness,
      message: 'Upcoming events are temporarily unavailable.' } };
  }

  async function readPublicSnapshot() {
    // pg's connectionTimeoutMillis is pool-wide. Bound only this Calendar read,
    // leaving the shared pool and the existing 3000ms query timeout unchanged.
    let acquisitionTimer, expired = false, client;
    const deadline = clock() + 3000;
    const connection = Promise.resolve().then(() => db.connect()).then(value => {
      if (expired || clock() >= deadline) {
        value.release(); // Healthy late checkout: return it without executing SQL.
        throw fault('DATABASE');
      }
      return value;
    });
    try {
      client = await Promise.race([connection, new Promise((_, reject) => {
        acquisitionTimer = setTimeout(() => { expired = true; reject(fault('DATABASE')); }, 3000);
      })]);
    } finally { clearTimeout(acquisitionTimer); }

    let failed = false, onError;
    try {
      // Retain pool.query's checked-out-client error handling. Both promise
      // branches remain observed even if acquisition or the client fails first.
      return await new Promise((resolve, reject) => {
        onError = () => { failed = true; reject(fault('DATABASE')); };
        client.once?.('error', onError);
        query(client, READ_SNAPSHOT, [config.configurationId]).then(resolve, reject);
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      client.removeListener?.('error', onError);
      client.release(failed);
    }
  }

  async function readPublic() {
    // Gate before database access, including requests carrying cached validators.
    if (!config.configured || !config.publicEnabled) return unavailable();
    try {
      const row = (await readPublicSnapshot()).rows?.[0];
      if (!row?.credentials_ready || !row.verified_at || row.policy_version !== POLICY_VERSION ||
        row.credential_version !== row.current_credential_version) return unavailable();
      const verified = Date.parse(row.verified_at), until = Date.parse(row.valid_until), now = clock();
      if (!Number.isFinite(verified) || !Number.isFinite(until) || verified > now || until > verified + INTERVAL_MS || until <= verified) return unavailable();
      const freshness = { verified_at: new Date(verified).toISOString(), expires_at: new Date(until).toISOString(),
        age_seconds: Math.floor((now - verified) / 1000) };
      if (now >= until) return unavailable('stale', freshness);
      const events = publicRecords(row.events);
      const seconds = Math.min(30, Math.floor((until - now) / 1000));
      return { httpStatus: 200, cache: `public, max-age=${seconds}, s-maxage=${seconds}, must-revalidate`,
        body: { status: events.length ? 'ready' : 'empty', timezone: TIMEZONE, events, freshness } };
    } catch { return unavailable(); }
  }

  async function publicHandler(req, res) {
    const result = await readPublic();
    res.set('Cache-Control', result.cache);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.status(result.httpStatus).json(result.body);
  }

  async function diagnosticsHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    const configuration = { integration_enabled: config.enabled, public_enabled: config.publicEnabled,
      configured: config.configured };
    let row;
    try { if (config.configured) row = (await query(db, READ_SNAPSHOT, [config.configurationId])).rows?.[0]; }
    catch { return res.status(503).json({ ...configuration, refresh_status: 'unavailable', last_error_code: 'DATABASE' }); }
    const verified = Date.parse(row?.verified_at);
    return res.json({ ...configuration, authorized: !!row?.credentials_ready,
      last_successful_refresh: row?.published_at || null,
      snapshot_age_seconds: Number.isFinite(verified) ? Math.max(0, Math.floor((clock() - verified) / 1000)) : null,
      published_event_count: Array.isArray(row?.events) ? row.events.length : 0,
      last_error_code: row?.last_error_code ? safeCode({ code: row.last_error_code }) : null,
      refresh_status: !config.configured ? 'disabled' : row?.refresh_status || 'unavailable' });
  }

  async function oauthStartHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await auth.beginAuthorization()); }
    catch (error) { return res.status(error.code === 'AUTH_BUSY' ? 409 : 503).json({ error: safeCode(error) }); }
  }

  async function oauthCallbackHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    try {
      await auth.completeAuthorization(req.query || {});
      return res.type('text/plain').send('Calendar authorization saved. You may close this window. Publication will be checked by the backend refresh.');
    } catch (error) {
      return res.status(error.code === 'AUTH_BUSY' ? 409 : 400).type('text/plain')
        .send('Calendar authorization was not completed. Start a new authorization from the protected setup endpoint.');
    }
  }

  return { start, stop, refresh, readPublic, publicHandler, diagnosticsHandler, oauthStartHandler,
    oauthCallbackHandler, config, auth };
}

module.exports = { createCalendar, normalizeTask, normalizeTasks, publicDescription, publicRecords,
  schedule, localInstant, localParts, TIMEZONE, INTERVAL_MS, POLICY_VERSION, EVENT_KEYS };
