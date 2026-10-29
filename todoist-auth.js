'use strict';

const crypto = require('node:crypto');

const PROJECT_ID = '6gRQ3CfW6Ww7V2fF';
const CALLBACK_PATH = '/api/calendar/oauth/callback';
const LOCK_NAMESPACE = 1447904076;
const TOKEN_URL = 'https://api.todoist.com/oauth/access_token';
const AUTH_URL = 'https://app.todoist.com/oauth/authorize';
const AUTH_CODES = new Set(['AUTH_REQUIRED', 'AUTH_REAUTHORIZE', 'AUTH_SCOPE', 'AUTH_STATE', 'AUTH_DENIED', 'AUTH_BUSY']);

function fault(code, retryAfterMs = 0) {
  const error = new Error(code);
  error.code = code;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function safeCode(error) {
  const codes = ['CONFIGURATION', 'DATABASE', 'BUSY', 'CANCELLED', 'TIMEOUT', 'NETWORK', 'RATE_LIMIT',
    'UPSTREAM', 'RESPONSE_LIMIT', 'RESPONSE_INVALID', 'SCAN_LIMIT', 'CURSOR_LOOP', 'SCOPE_MISMATCH',
    'INCONSISTENT_SCAN', 'SNAPSHOT_INVALID', ...AUTH_CODES];
  return codes.includes(error?.code) ? error.code : 'DATABASE';
}

function readConfig(env = process.env) {
  const enabled = env.TODOIST_CALENDAR_ENABLED === '1';
  const clientId = String(env.TODOIST_CLIENT_ID || '').trim();
  const clientSecret = String(env.TODOIST_CLIENT_SECRET || '').trim();
  const rawKey = String(env.TODOIST_TOKEN_ENCRYPTION_KEY || '').trim();
  const redirectUri = String(env.TODOIST_REDIRECT_URI || '').trim();
  let key = null, validRedirect = false;
  try {
    const parsed = new URL(redirectUri);
    const local = !env.RENDER && env.NODE_ENV !== 'production' && parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    validRedirect = (parsed.protocol === 'https:' || local) && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash && parsed.pathname === CALLBACK_PATH && parsed.href === redirectUri;
    const decoded = Buffer.from(rawKey, 'base64');
    if (decoded.length === 32 && decoded.toString('base64') === rawKey) key = decoded;
  } catch { /* Disabled until exact configuration is supplied. */ }
  const configured = enabled && !!env.DATABASE_URL && !!clientId && !!clientSecret && !!key && validRedirect;
  const configurationId = configured ? crypto.createHash('sha256')
    .update(JSON.stringify([PROJECT_ID, clientId, clientSecret, rawKey, redirectUri])).digest('hex') : '';
  return { enabled, configured, clientId, clientSecret, key, redirectUri, configurationId };
}

function seal(value, config, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(Buffer.from(`calendar-v1:${config.configurationId}:${purpose}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

function unseal(value, config, purpose) {
  try {
    const [version, iv, tag, ciphertext, extra] = String(value).split('.');
    if (version !== 'v1' || extra || !ciphertext) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', config.key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(`calendar-v1:${config.configurationId}:${purpose}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw fault('AUTH_REAUTHORIZE'); }
}

// All remote requests stay on fixed Todoist URLs; never follow credential-bearing redirects.
async function requestJson(fetchImpl, url, { signal, timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, ...options } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) { controller.abort(); throw fault('RESPONSE_LIMIT'); }
      chunks.push(Buffer.from(chunk));
    }
    let data = null;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { if (response.ok) throw fault('RESPONSE_INVALID'); }
    const retry = response.headers.get('retry-after');
    const seconds = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry)
      : retry ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000) : Number(data?.retry_after);
    const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 300000;
    return { status: response.status, ok: response.ok, data, retryAfterMs };
  } catch (error) {
    if (signal?.aborted) throw fault('CANCELLED');
    if (controller.signal.aborted && error.code !== 'RESPONSE_LIMIT') throw fault('TIMEOUT');
    if (error.code) throw fault(safeCode(error), error.retryAfterMs);
    throw fault('NETWORK');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function query(client, text, values = []) {
  return client.query({ text, values, query_timeout: 3000 });
}

// Session advisory locks use a dedicated connection. Destroy a suspect connection so a
// timed-out unlock cannot return a still-locked session to the shared pool.
async function withDbLock(db, key, operation) {
  let timer, expired = false, client, acquired = false, destroy = false;
  const onError = () => { destroy = true; };
  const connection = Promise.resolve().then(() => db.connect()).then(value => {
    if (expired) { value.release(true); throw fault('DATABASE'); }
    return value;
  });
  try {
    client = await Promise.race([connection, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(fault('DATABASE')); }, 3000);
    })]);
    clearTimeout(timer);
    client.on?.('error', onError);
    const result = await query(client, 'SELECT pg_try_advisory_lock($1, $2) AS locked', [LOCK_NAMESPACE, key]);
    acquired = result.rows?.[0]?.locked === true;
    if (!acquired) return null;
    return await operation(client);
  } catch (error) {
    destroy = true;
    throw error.code && safeCode(error) !== 'DATABASE' ? error : fault('DATABASE');
  } finally {
    clearTimeout(timer);
    if (client) {
      if (acquired) {
        try { await query(client, 'SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, key]); }
        catch { destroy = true; }
      }
      client.removeListener?.('error', onError);
      client.release(destroy);
    }
  }
}

function createTodoistAuth({ db, config, fetchImpl = global.fetch, clock = Date.now }) {
  const requireConfig = () => { if (!config.configured) throw fault('CONFIGURATION'); };
  const readRow = async client => (await query(client, 'SELECT * FROM todoist_oauth_credentials WHERE id = 1')).rows?.[0];
  const blockOnClient = (client, code) => query(client,
    'UPDATE todoist_oauth_credentials SET blocked = TRUE, last_error_code = $1, refresh_in_progress = FALSE, updated_at = NOW() WHERE id = 1', [code]);
  const tokenFields = (data, previousRefresh) => {
    const scopes = typeof data?.scope === 'string' ? data.scope.trim().split(/[\s,]+/) : [];
    if (scopes.length !== 1 || scopes[0] !== 'data:read') throw fault('AUTH_SCOPE');
    if (data.token_type?.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' ||
      !data.access_token || data.access_token.length > 8192 || typeof data.refresh_token !== 'string' ||
      !data.refresh_token || data.refresh_token.length > 8192 || data.refresh_token === previousRefresh ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 60 || data.expires_in > 86400) throw fault('AUTH_REAUTHORIZE');
    return { access_token: data.access_token, refresh_token: data.refresh_token };
  };
  const save = async (client, data, version, previousRefresh) => {
    const tokens = tokenFields(data, previousRefresh);
    await query(client, `UPDATE todoist_oauth_credentials SET encrypted_tokens = $1, access_expires_at = $2,
      scope = 'data:read', configuration_id = $3, credential_version = $4, blocked = FALSE,
      refresh_in_progress = FALSE, last_error_code = NULL, updated_at = NOW() WHERE id = 1`,
    [seal(tokens, config, 'tokens'), new Date(clock() + data.expires_in * 1000), config.configurationId, version]);
    return { token: tokens.access_token, version };
  };

  async function beginAuthorization() {
    requireConfig();
    const result = await withDbLock(db, 2, async client => {
      const state = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(48).toString('base64url');
      const expires = new Date(clock() + 600000);
      const digest = crypto.createHash('sha256').update(state).digest('hex');
      await query(client, `INSERT INTO todoist_oauth_credentials (id, oauth_state_hash, oauth_state_expires_at, pending_authorization)
        VALUES (1, $1, $2, $3) ON CONFLICT (id) DO UPDATE SET oauth_state_hash = EXCLUDED.oauth_state_hash,
        oauth_state_expires_at = EXCLUDED.oauth_state_expires_at, pending_authorization = EXCLUDED.pending_authorization`,
      [digest, expires, seal({ verifier, redirectUri: config.redirectUri }, config, 'state')]);
      const url = new URL(AUTH_URL);
      Object.entries({ client_id: config.clientId, scope: 'data:read', state, response_type: 'code',
        redirect_uri: config.redirectUri, code_challenge_method: 'S256',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') })
        .forEach(([key, value]) => url.searchParams.set(key, value));
      return { authorization_url: url.href, expires_at: expires.toISOString() };
    });
    if (!result) throw fault('AUTH_BUSY');
    return result;
  }

  async function completeAuthorization({ state, code, error }) {
    requireConfig();
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw fault('AUTH_STATE');
    const result = await withDbLock(db, 2, async client => {
      const row = await readRow(client);
      const digest = crypto.createHash('sha256').update(state).digest('hex');
      if (!row?.oauth_state_hash || row.oauth_state_hash.length !== digest.length ||
        !crypto.timingSafeEqual(Buffer.from(row.oauth_state_hash), Buffer.from(digest)) ||
        !(Date.parse(row.oauth_state_expires_at) > clock())) throw fault('AUTH_STATE');
      const pending = unseal(row.pending_authorization, config, 'state');
      if (pending.redirectUri !== config.redirectUri) throw fault('AUTH_STATE');
      // Consume before exchanging. Neither callback replay nor an ambiguous exchange is retried.
      await query(client, 'UPDATE todoist_oauth_credentials SET oauth_state_hash = NULL, oauth_state_expires_at = NULL, pending_authorization = NULL WHERE id = 1');
      if (error) throw fault('AUTH_DENIED');
      if (typeof code !== 'string' || !code || code.length > 2048) throw fault('AUTH_STATE');
      const response = await requestJson(fetchImpl, TOKEN_URL, { method: 'POST', maxBytes: 65536,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
          code, redirect_uri: config.redirectUri, code_verifier: pending.verifier }) });
      if (!response.ok) throw fault(response.status === 429 ? 'RATE_LIMIT' : 'AUTH_REAUTHORIZE', response.retryAfterMs);
      await save(client, response.data, crypto.randomUUID());
      return { authorized: true };
    });
    if (!result) throw fault('AUTH_BUSY');
    return result;
  }

  async function getAccessToken({ rejectedToken, signal } = {}) {
    requireConfig();
    const result = await withDbLock(db, 2, async client => {
      const row = await readRow(client);
      if (!row?.encrypted_tokens || row.configuration_id !== config.configurationId) throw fault('AUTH_REQUIRED');
      if (row.blocked || row.refresh_in_progress) {
        if (row.refresh_in_progress) await blockOnClient(client, 'AUTH_REAUTHORIZE');
        throw fault('AUTH_REAUTHORIZE');
      }
      let tokens;
      try { tokens = unseal(row.encrypted_tokens, config, 'tokens'); }
      catch { await blockOnClient(client, 'AUTH_REAUTHORIZE'); throw fault('AUTH_REAUTHORIZE'); }
      if (row.scope !== 'data:read') { await blockOnClient(client, 'AUTH_SCOPE'); throw fault('AUTH_SCOPE'); }
      if (Date.parse(row.access_expires_at) > clock() + 60000 && tokens.access_token !== rejectedToken) {
        return { token: tokens.access_token, version: row.credential_version };
      }
      // If the process dies after Todoist rotates the token, require reauthorization;
      // do not replay a possibly consumed refresh token after restart.
      await query(client, 'UPDATE todoist_oauth_credentials SET refresh_in_progress = TRUE WHERE id = 1');
      try {
        const response = await requestJson(fetchImpl, TOKEN_URL, { signal, method: 'POST', maxBytes: 65536,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId,
            client_secret: config.clientSecret, refresh_token: tokens.refresh_token }) });
        if (response.status === 429) {
          await query(client, 'UPDATE todoist_oauth_credentials SET refresh_in_progress = FALSE WHERE id = 1');
          throw fault('RATE_LIMIT', response.retryAfterMs);
        }
        if (!response.ok) throw fault('AUTH_REAUTHORIZE');
        return await save(client, response.data, row.credential_version, tokens.refresh_token);
      } catch (error) {
        if (error.code === 'RATE_LIMIT') throw error;
        await blockOnClient(client, error.code === 'AUTH_SCOPE' ? 'AUTH_SCOPE' : 'AUTH_REAUTHORIZE');
        throw fault('AUTH_REAUTHORIZE');
      }
    });
    if (!result) throw fault('AUTH_BUSY');
    return result;
  }

  async function block(code = 'AUTH_REAUTHORIZE') {
    const result = await withDbLock(db, 2, async client => {
      await blockOnClient(client, AUTH_CODES.has(code) ? code : 'AUTH_REAUTHORIZE');
      return true;
    });
    if (!result) throw fault('AUTH_BUSY');
  }
  return { beginAuthorization, completeAuthorization, getAccessToken, block };
}

module.exports = { PROJECT_ID, CALLBACK_PATH, readConfig, createTodoistAuth, fault, safeCode,
  requestJson, withDbLock, query };
