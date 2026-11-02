'use strict';

const express = require('express');
const crypto = require('node:crypto');

const APPROVED_ORIGINS = Object.freeze(['https://vmpix-v3.onrender.com']);
const FIELD_LIMITS = Object.freeze({ name: 100, email: 254, subject: 150, message: 5000 });
const LIMITS = Object.freeze({ bodyBytes: 48 * 1024, responseBytes: 16 * 1024,
  bodyMs: 5000, sendMs: 8000, requestMs: 18000,
  concurrent: 4, peerAttempts: 5, globalAttempts: 30, rateMs: 15 * 60 * 1000,
  peers: 1024, records: 1000, retryMs: 60 * 60 * 1000, futureMs: 60000 });
const KEY_PATTERN = /^(\d{13})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const SINGLE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MESSAGE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const FORMSPREE_BASE = 'https://formspree.io/f/';
const FORM_ID_PATTERN = /^[a-zA-Z0-9]{8,32}$/;

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value) &&
    !value.startsWith('.') && !value.includes('..') && !value.includes('.@') && value.split('@')[0].length <= 64;
}
function configured(env) {
  const origins = String(env.CONTACT_ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const allowed = origins.length > 0 && origins.every(s => APPROVED_ORIGINS.includes(s));
  const secret = env.CONTACT_IDEMPOTENCY_SECRET;
  const formId = env.CONTACT_FORMSPREE_FORM_ID;
  // Operator attestation: native Turnstile rejects invalid challenges, Formspree
  // domain restriction is off, recipient and single-process safeguards are approved.
  // This flag cannot inspect provider settings and is not provider authentication.
  const ready = env.CONTACT_ENABLED === '1' && env.CONTACT_FORMSPREE_PROXY_APPROVED === '1' && allowed &&
    typeof formId === 'string' && FORM_ID_PATTERN.test(formId) &&
    typeof secret === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(secret) &&
    Buffer.from(secret, 'base64').length === 32 && Buffer.from(secret, 'base64').toString('base64') === secret;
  return { origins: allowed ? new Set(origins) : new Set(), ready,
    endpoint: typeof formId === 'string' && FORM_ID_PATTERN.test(formId) ? `${FORMSPREE_BASE}${formId}` : null,
    secret };
}
function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 5 || !Object.keys(body).every(k => Object.hasOwn(FIELD_LIMITS, k) || k === 'turnstileToken')) return null;
  const fields = {};
  const invalid = [];
  for (const [name, max] of Object.entries(FIELD_LIMITS)) {
    const raw = body[name];
    if (typeof raw !== 'string' || raw.length > max || !raw.trim() ||
        (name === 'message' ? MESSAGE_CONTROL : SINGLE_CONTROL).test(raw) ||
        Buffer.from(raw, 'utf8').toString('utf8') !== raw) { invalid.push(name); continue; }
    fields[name] = raw.replace(/\r\n?/g, '\n').trim();
    if (name === 'email' && !validEmail(fields[name])) invalid.push(name);
  }
  const token = body.turnstileToken;
  if (typeof token !== 'string' || !token.length || token.length > 2048 || /[^\x21-\x7e]/.test(token)) invalid.push('turnstileToken');
  return { fields, invalid, token };
}
function failure(status, code, delivery = 'not_attempted', retryable = false, retryAfter = 0, fields) {
  return { status, retryAfter, body: { ok: false, code, delivery, retryable, ...(fields ? { fields } : {}) } };
}
function accepted() {
  return { status: 202, body: { ok: true, code: 'provider_accepted', delivery: 'accepted', retryable: false,
    message: 'Your submission was accepted by Formspree. Inbox delivery is not yet confirmed.' } };
}
function respond(req, res, result) {
  if (res.headersSent || res.destroyed || res.writableEnded || req.aborted) return;
  if (!req.complete) { res.set('Connection', 'close'); req.resume(); }
  if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
  res.status(result.status).json(result.body);
}
function fault(code) { return Object.assign(new Error(code), { code }); }

// Bound upload time and bytes before JSON parsing; compressed bodies are never inflated.
function readBody(req, signal, limits) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    const cleanup = () => {
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error);
      signal.removeEventListener('abort', abort);
    };
    const fail = code => { cleanup(); chunks = []; req.pause(); reject(fault(code)); };
    const error = () => fail('invalid_request');
    const abort = () => fail('request_timeout');
    const data = chunk => {
      size += chunk.length;
      if (size > limits.bodyBytes) return fail('payload_too_large');
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const raw = Buffer.concat(chunks);
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        resolve(JSON.parse(decoded));
      } catch { reject(fault('invalid_request')); }
      finally { chunks = []; }
    };
    const timer = setTimeout(() => fail('request_timeout'), limits.bodyMs);
    req.on('data', data); req.once('end', end); req.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// The deadline includes response-body reading. Never redirect private submission data.
async function providerJson(fetchImpl, url, options, parentSignal, timeoutMs, maxBytes) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener('abort', abort, { once: true });
  if (parentSignal.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(fault('provider_unavailable')); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  if (controller.signal.aborted) rejectAbort();
  try {
    return await Promise.race([aborted, (async () => {
      if (controller.signal.aborted) throw fault('provider_unavailable');
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.body) throw fault('provider_unavailable');
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) { controller.abort(); throw fault('provider_unavailable'); }
          chunks.push(Buffer.from(value));
        }
      } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      return { status: response.status, body };
    })()]);
  } finally {
    clearTimeout(timer); parentSignal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

// No database, environment-file loading, persistent drafts or logging. Injected dependencies
// are for isolated tests; normal startup uses native fetch and the fixed provider URLs above.
function createContactRouter({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, limits = {} } = {}) {
  const policy = Object.freeze({ ...LIMITS, ...limits });
  const config = configured(env);
  const router = express.Router({ caseSensitive: true, strict: true });
  const peers = new Map();
  const records = new Map();
  const challenges = new Map();
  const startedAt = now();
  const peerSalt = crypto.randomBytes(32);
  let globalWindow = { at: 0, count: 0 };
  let active = 0;
  const digest = value => crypto.createHmac('sha256', config.secret).update(value).digest('hex');
  const rateLimit = (req, at) => {
    for (const [key, entry] of peers) if (at - entry.at >= policy.rateMs) peers.delete(key);
    if (at - globalWindow.at >= policy.rateMs) globalWindow = { at, count: 0 };
    // Forwarded/CF headers are deliberately not trusted. Behind Render, this may conservatively
    // group visitors by proxy peer. Do not enable broad Express trust proxy to change that.
    const peer = crypto.createHmac('sha256', peerSalt).update(req.socket.remoteAddress || 'unknown').digest('hex');
    let entry = peers.get(peer);
    if (globalWindow.count >= policy.globalAttempts || entry?.count >= policy.peerAttempts || !entry && peers.size >= policy.peers) {
      const started = entry?.count >= policy.peerAttempts ? entry.at : globalWindow.at;
      return Math.max(1, Math.ceil((policy.rateMs - (at - started)) / 1000));
    }
    if (!entry) { entry = { at, count: 0 }; peers.set(peer, entry); }
    entry.count++; globalWindow.count++;
    return 0;
  };
  async function processMessage(req, signal, at) {
    const body = await readBody(req, signal, policy);
    const validation = validateBody(body);
    if (!validation) return failure(400, 'invalid_request');
    if (validation.invalid.length) return failure(400, 'invalid_fields', 'not_attempted', false, 0, validation.invalid);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return failure(400, 'invalid_idempotency_key');
    const keyTime = Number(key.slice(0, 13));
    // Formspree has no assumed provider-side deduplication. Old keys never start
    // another send after cache expiry; pre-restart keys fail closed below.
    if (at - keyTime > policy.retryMs || keyTime - at > policy.futureMs) return failure(409, 'retry_window_closed', 'unknown');
    const { fields, token } = validation;
    const payload = { name: fields.name, email: fields.email,
      subject: `[V3 Contact] ${fields.subject}`, message: fields.message };
    const serialized = JSON.stringify(payload);
    const recordKey = digest(`key:${key}`);
    const fingerprint = digest(`payload:${serialized}`);
    for (const [id, entry] of records) if (!entry.busy && entry.expires <= at) records.delete(id);
    let record = records.get(recordKey);
    if (record && record.fingerprint !== fingerprint) return failure(409, 'idempotency_conflict', 'unknown');
    if (record?.accepted) return accepted();
    if (record?.busy) return failure(409, 'request_in_progress', 'unknown');
    if (record?.attempted) return record.result;
    if (!record) {
      // Without durable receipts, refuse a missing key that could predate startup,
      // including the full allowed future-clock skew. Fresh clients need ~60s
      // after startup; overlapping processes still require separate coordination.
      if (!Number.isSafeInteger(startedAt) || keyTime - policy.futureMs <= startedAt) {
        return failure(409, 'submission_history_unavailable', 'unknown');
      }
      if (records.size >= policy.records) return failure(503, 'contact_busy', 'not_attempted', true, 60);
      record = { fingerprint, expires: keyTime + policy.retryMs + 1, busy: false, attempted: false };
      records.set(recordKey, record);
    }
    if (signal.aborted) throw fault('request_timeout');
    // Duplicate guard only: retain a keyed digest, never verify/consume the token here.
    // Formspree is the sole Turnstile verifier. Refuse repeat dispatch under another
    // key even if the original outcome is unknown; do not suggest an automatic retry.
    for (const [id, expires] of challenges) if (expires <= at) challenges.delete(id);
    const challengeKey = digest(`challenge:${token}`);
    if (challenges.has(challengeKey)) return failure(409, 'challenge_already_submitted', 'unknown');
    if (challenges.size >= policy.records) return failure(503, 'contact_busy', 'not_attempted', true, 60);
    challenges.set(challengeKey, at + policy.retryMs + policy.futureMs);
    record.busy = true;
    try {
      // Mark the attempt BEFORE dispatch. No repeat POST is safe after this point.
      record.attempted = true;
      record.result = failure(503, 'delivery_uncertain', 'unknown');
      const sent = await providerJson(fetchImpl, config.endpoint, { method: 'POST',
        // Forward the unverified token once. No secret, idempotency header, client
        // headers or fabricated Origin/Referer are forwarded to Formspree.
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...payload, 'cf-turnstile-response': token })
      }, signal, policy.sendMs, policy.responseBytes);
      const result = sent.body;
      // The official Formspree client identifies success by a string `next`.
      // Require a successful HTTP status too; never follow or expose `next`.
      const hasError = result && (Object.hasOwn(result, 'error') || Object.hasOwn(result, 'errors') ||
        Object.hasOwn(result, 'stripe') || Object.hasOwn(result, 'resubmitKey') || result.ok === false);
      if (sent.status >= 200 && sent.status < 300 && result && !hasError &&
          typeof result.next === 'string' && result.next.length > 0 && result.next.length <= 2048) {
        record.accepted = true;
        return accepted();
      }
      if ([400, 422].includes(sent.status)) record.result = failure(422, 'provider_validation_failed', 'rejected');
      else if (sent.status === 429) record.result = failure(429, 'provider_rate_limited', 'rejected', false, 60);
      else if ([401, 403, 404, 405].includes(sent.status)) record.result = failure(502, 'delivery_unavailable', 'rejected');
      // 5xx, network errors, redirects and unexpected 2xx bodies stay uncertain.
      return record.result;
    } catch {
      record.result = failure(503, 'delivery_uncertain', 'unknown');
      return record.result;
    } finally { record.busy = false; }
  }
  router.use((req, res) => {
    void (async () => {
      res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.vary('Origin');
      if (req.baseUrl !== '/api/contact' || req.path !== '/' || req.url !== '/') return respond(req, res, failure(404, 'not_found'));
      const origin = req.headers.origin;
      if (!config.origins.has(origin)) return respond(req, res, failure(403, 'origin_not_allowed'));
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After' });
      if (req.method === 'OPTIONS') {
        res.vary('Access-Control-Request-Method'); res.vary('Access-Control-Request-Headers');
        const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        if (req.headers['access-control-request-method'] !== 'POST' || headers.some(s => !['content-type', 'idempotency-key'].includes(s))) {
          return respond(req, res, failure(403, 'preflight_not_allowed'));
        }
        res.set({ 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key' });
        return res.status(204).end();
      }
      if (req.method !== 'POST') { res.set('Allow', 'POST, OPTIONS'); return respond(req, res, failure(405, 'method_not_allowed')); }
      if (!config.ready || typeof fetchImpl !== 'function') return respond(req, res, failure(503, 'contact_unavailable'));
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) return respond(req, res, failure(503, 'contact_unavailable'));
      const retryAfter = rateLimit(req, at);
      if (retryAfter) return respond(req, res, failure(429, 'rate_limited', 'not_attempted', true, retryAfter));
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') ||
          req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
        return respond(req, res, failure(415, 'unsupported_content_type'));
      }
      if (active >= policy.concurrent) return respond(req, res, failure(503, 'contact_busy', 'not_attempted', true, 10));
      active++;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, policy.requestMs);
      req.once('aborted', abort); res.once('close', abort);
      try { respond(req, res, await processMessage(req, controller.signal, at)); }
      catch (error) {
        const status = error.code === 'payload_too_large' ? 413 : error.code === 'request_timeout' ? 408 : 400;
        respond(req, res, failure(status, status === 400 ? 'invalid_request' : error.code));
      } finally {
        clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); active--;
      }
    })().catch(() => respond(req, res, failure(503, 'contact_unavailable')));
  });
  return router;
}

module.exports = { createContactRouter, FIELD_LIMITS, LIMITS };
