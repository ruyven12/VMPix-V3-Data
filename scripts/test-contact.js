'use strict';

// Synthetic fixtures and loopback HTTP only. Never import server.js/db.js or load .env.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createContactRouter, FIELD_LIMITS, LIMITS } = require('../contact');

const ORIGINAL_FETCH = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Unexpected live fetch is forbidden in Contact tests.'); };
after(() => { globalThis.fetch = ORIGINAL_FETCH; });
const ORIGIN = 'https://vmpix-v3.onrender.com';
const TIME = Date.parse('2026-10-30T12:00:00Z');
const ENV = Object.freeze({ CONTACT_ENABLED: '1', CONTACT_SENDER_VERIFIED: '1', CONTACT_ALLOWED_ORIGINS: ORIGIN,
  CONTACT_FROM_EMAIL: 'relay@sender.example', CONTACT_TO_EMAIL: 'inbox@recipient.example',
  RESEND_API_KEY: 'synthetic-resend-private-key', TURNSTILE_SECRET_KEY: 'synthetic-turnstile-private-key',
  CONTACT_IDEMPOTENCY_SECRET: Buffer.alloc(32, 41).toString('base64') });
const FIELDS = Object.freeze({ name: 'Synthetic Visitor', email: 'visitor@example.com', subject: 'Synthetic subject',
  message: 'PRIVATE-SYNTHETIC-MESSAGE', turnstileToken: 'synthetic-challenge' });
const keyAt = (time = TIME) => `${time}.${crypto.randomUUID()}`;
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const challenge = (changes = {}) => ({ success: true, challenge_ts: new Date(TIME).toISOString(),
  hostname: 'vmpix-v3.onrender.com', action: 'contact', ...changes });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  let clock = TIME;
  const calls = [];
  const mockFetch = async (url, init) => {
    const call = { url, ...init, payload: JSON.parse(init.body) };
    calls.push(call);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(['https://api.resend.com/emails', 'https://challenges.cloudflare.com/turnstile/v0/siteverify'].includes(url));
    if (options.provider) return options.provider(call, calls, clock);
    return url.includes('siteverify') ? jsonResponse(200, challenge({ challenge_ts: new Date(clock).toISOString() })) :
      jsonResponse(200, { id: 'synthetic-provider-id' });
  };
  const app = express();
  app.use('/api/contact', createContactRouter({ env: { ...ENV, ...options.env }, fetchImpl: mockFetch,
    now: () => clock, limits: { peerAttempts: 1000, globalAttempts: 2000, ...options.limits } }));
  // Confirm Contact never falls through to the existing permissive public middleware.
  app.use((_req, res) => res.set('Access-Control-Allow-Origin', '*').status(418).json({ legacy: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  function request({ body = FIELDS, headers = {}, method = 'POST', route = '/api/contact', raw, partial = false } = {}) {
    return new Promise((resolve, reject) => {
      const data = raw === undefined ? JSON.stringify(body) : raw;
      const defaults = { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': keyAt(clock) };
      const allHeaders = { ...defaults, ...headers };
      for (const name of Object.keys(allHeaders)) if (allHeaders[name] === undefined) delete allHeaders[name];
      const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: allHeaders, agent: false }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      if (partial) req.write(data); else req.end(data);
    });
  }
  return { request, calls, port, advance: ms => { clock += ms; }, get clock() { return clock; } };
}

test('route is mounted before shared CORS and startup is not imported by this test', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("const { createContactRouter } = require('./contact');"));
  assert.ok(source.indexOf("app.use('/api/contact', createContactRouter());") < source.indexOf('app.use(allowCors)'));
  assert.deepEqual(FIELD_LIMITS, { name: 100, email: 254, subject: 150, message: 5000 });
  const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'contact.js'), 'utf8');
  assert.doesNotMatch(moduleSource, /console\.|require\(['"](?:\.\/db|pg|fs|node:fs)/);
});

for (const [label, env] of Object.entries({ disabled: { CONTACT_ENABLED: '0' }, missingFlag: { CONTACT_ENABLED: undefined },
  truthyFlag: { CONTACT_ENABLED: 'true' }, senderUnverified: { CONTACT_SENDER_VERIFIED: '0' },
  keyMissing: { RESEND_API_KEY: '' }, challengeSecretMissing: { TURNSTILE_SECRET_KEY: '' },
  unstableSecret: { CONTACT_IDEMPOTENCY_SECRET: 'short' }, recipientMissing: { CONTACT_TO_EMAIL: '' },
  senderHeaderInjection: { CONTACT_FROM_EMAIL: 'sender@example.com\r\nBcc:attacker@example.com' },
  multipleRecipients: { CONTACT_TO_EMAIL: 'a@example.com,b@example.com' } })) {
  test(`configuration fails closed: ${label}`, async t => {
    const f = await fixture(t, { env });
    const r = await f.request();
    assert.equal(r.status, 503); assert.equal(r.body.code, 'contact_unavailable'); assert.equal(f.calls.length, 0);
    assert.equal(r.headers['cache-control'], 'no-store');
  });
}

test('all defaults off, even with native fetch available', async t => {
  const app = express(); app.use('/api/contact', createContactRouter({ env: {} }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await new Promise(resolve => http.get(`http://127.0.0.1:${server.address().port}/api/contact`, res => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  }));
  assert.equal(result, 403);
});

test('exact origin and narrow preflight; no wildcard/credentials and rejected requests cannot send', async t => {
  const f = await fixture(t);
  for (const origin of [undefined, 'null', 'https://evil.example', `${ORIGIN}.evil.example`, 'http://vmpix-v3.onrender.com', `${ORIGIN}/`]) {
    const r = await f.request({ headers: { Origin: origin } });
    assert.equal(r.status, 403); assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  const preflight = await f.request({ method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, idempotency-key' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(preflight.headers['access-control-allow-methods'], 'POST');
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.match(preflight.headers.vary, /Origin/);
  for (const headers of [{ 'Access-Control-Request-Method': 'DELETE' },
    { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' }]) {
    assert.equal((await f.request({ method: 'OPTIONS', headers })).status, 403);
  }
  for (const env of [{ CONTACT_ALLOWED_ORIGINS: '*' }, { CONTACT_ALLOWED_ORIGINS: `${ORIGIN},https://evil.example` }, { CONTACT_ALLOWED_ORIGINS: '' }]) {
    const bad = await fixture(t, { env }); assert.equal((await bad.request()).status, 403); assert.equal(bad.calls.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('unsupported methods, subpaths, query input and case variants cannot fall through', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await f.request({ method })).status, 405);
  for (const route of ['/api/contact/extra', '/api/contact?email=private', '/api/CONTACT']) assert.equal((await f.request({ route })).status, 404);
  assert.equal((await f.request({ route: '/api/music/unrelated' })).status, 418);
  assert.equal(f.calls.length, 0);
});

test('only bounded UTF-8 JSON bodies are accepted, including streamed limits and upload deadline', async t => {
  const f = await fixture(t, { limits: { bodyMs: 35 } });
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/x-www-form-urlencoded' },
    { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Encoding': 'gzip' }]) {
    assert.equal((await f.request({ headers })).status, 415);
  }
  for (const [label, request, status] of [
    ['malformed', { raw: '{broken' }, 400], ['UTF-8', { raw: Buffer.from([0xff]) }, 400],
    ['actual size', { raw: 'x'.repeat(LIMITS.bodyBytes + 1) }, 413],
    ['incomplete announced body', { headers: { 'Content-Length': LIMITS.bodyBytes + 1 } }, 408]
  ]) {
    try { assert.equal((await f.request(request)).status, status); }
    catch (error) { throw new Error(`Body check failed: ${label}: ${error.message}`, { cause: error }); }
  }
  const start = Date.now();
  assert.equal((await f.request({ raw: '{', partial: true })).status, 408);
  assert.ok(Date.now() - start < 1500); assert.equal(f.calls.length, 0);
});

for (const field of Object.keys(FIELD_LIMITS)) {
  test(`${field}: required, type, UTF-16 limit, control characters and malformed Unicode`, async t => {
    const f = await fixture(t);
    for (const value of ['', '   ', null, 17, {}, [], 'x'.repeat(FIELD_LIMITS[field] + 1), 'x\u0000y', '\ud800']) {
      const r = await f.request({ body: { ...FIELDS, [field]: value } });
      assert.equal(r.status, 400); assert.ok(r.body.fields.includes(field));
    }
    assert.equal(f.calls.length, 0);
  });
}

test('rejects unknown payload keys, header injection, malformed email and challenge token', async t => {
  const f = await fixture(t);
  for (const body of [[], null, {}, { ...FIELDS, to: 'attacker@example.com' }, { ...FIELDS, html: '<script>x</script>' }]) {
    assert.equal((await f.request({ body })).status, 400);
  }
  for (const field of ['name', 'email', 'subject']) {
    assert.equal((await f.request({ body: { ...FIELDS, [field]: `${FIELDS[field]}\r\nBcc:other@example.com` } })).status, 400);
  }
  for (const email of ['bad', 'a b@example.com', 'a@example..com', '.a@example.com', 'a.@example.com', 'a@-example.com', 'a'.repeat(65) + '@example.com']) {
    assert.equal((await f.request({ body: { ...FIELDS, email } })).status, 400);
  }
  for (const turnstileToken of ['', null, 'a'.repeat(2049), 'a b', 'a\nb']) {
    assert.equal((await f.request({ body: { ...FIELDS, turnstileToken } })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('valid fields use fixed sender/recipient, visitor Reply-To, deterministic plain text and private responses', async t => {
  const f = await fixture(t);
  const r = await f.request({ body: { ...FIELDS, name: '  Zoë Visitor  ', message: '  <b>Text only</b>\r\nNext\tline  ' } });
  assert.equal(r.status, 202); assert.equal(r.body.delivery, 'accepted'); assert.match(r.body.message, /not yet confirmed/);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].payload, { from: ENV.CONTACT_FROM_EMAIL, to: [ENV.CONTACT_TO_EMAIL], reply_to: FIELDS.email,
    subject: `[V3 Contact] ${FIELDS.subject}`, text: 'Name: Zoë Visitor\nEmail: visitor@example.com\nSubject: Synthetic subject\n\n<b>Text only</b>\nNext\tline' });
  assert.equal(f.calls[1].headers.Authorization, `Bearer ${ENV.RESEND_API_KEY}`);
  assert.equal(f.calls[0].payload.secret, ENV.TURNSTILE_SECRET_KEY);
  assert.equal(f.calls[0].payload.remoteip, undefined);
  assert.match(f.calls[0].payload.idempotency_key, /^[0-9a-f-]{36}$/);
  for (const value of [...Object.values(ENV), ...Object.values(FIELDS), 'synthetic-provider-id']) assert.ok(!r.text.includes(value));
});

test('exact maximum name/subject/message limits and valid long email are accepted without clipping', async t => {
  const f = await fixture(t);
  const email = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(61);
  assert.equal(email.length, 254);
  const r = await f.request({ body: { ...FIELDS, name: 'n'.repeat(100), email, subject: 's'.repeat(150), message: '😀'.repeat(2500) } });
  assert.equal(r.status, 202); assert.ok(f.calls[1].payload.text.endsWith('😀'.repeat(2500)));
});

for (const [label, changes] of Object.entries({ failure: { success: false, 'error-codes': ['timeout-or-duplicate'] },
  contradictorySuccess: { success: true, 'error-codes': ['invalid-input-response'] },
  otherHost: { hostname: 'evil.example' }, otherAction: { action: 'login' },
  missingTime: { challenge_ts: undefined }, expired: { challenge_ts: new Date(TIME - 300001).toISOString() },
  future: { challenge_ts: new Date(TIME + 60001).toISOString() } })) {
  test(`Turnstile rejects ${label} before any email call`, async t => {
    const f = await fixture(t, { provider: async () => jsonResponse(200, challenge(changes)) });
    const r = await f.request(); assert.equal(r.status, 400); assert.equal(r.body.code, 'challenge_invalid');
    assert.equal(r.body.delivery, 'not_attempted'); assert.equal(f.calls.length, 1);
  });
}

for (const [label, provider] of Object.entries({ unavailable: async () => jsonResponse(503, { private: ENV.TURNSTILE_SECRET_KEY }),
  malformedErrors: async () => jsonResponse(200, challenge({ 'error-codes': 'invalid-input-response' })),
  malformed: async () => new Response('not JSON'), internal: async () => jsonResponse(200, { success: false, 'error-codes': ['internal-error'] }),
  badSecret: async () => jsonResponse(200, { success: false, 'error-codes': ['invalid-input-secret'] }),
  throw: async () => { throw new Error(ENV.TURNSTILE_SECRET_KEY); },
  timeout: async () => new Promise(() => {}), oversized: async () => new Response('x'.repeat(LIMITS.responseBytes + 1)) })) {
  test(`Turnstile ${label} fails closed with safe unavailable response`, async t => {
    const f = await fixture(t, { provider, limits: { challengeMs: 35 } });
    const r = await f.request(); assert.equal(r.status, 503); assert.equal(r.body.code, 'verification_unavailable');
    assert.equal(f.calls.length, 1); assert.ok(!r.text.includes(ENV.TURNSTILE_SECRET_KEY));
  });
}

for (const status of [400, 401, 403, 404, 405, 422, 429, 409, 500, 503]) {
  test(`Resend ${status} is safely distinguished from provider acceptance`, async t => {
    const f = await fixture(t, { provider: async call => call.url.includes('siteverify') ? jsonResponse(200, challenge()) :
      jsonResponse(status, { name: status === 409 ? 'concurrent_idempotent_requests' : 'provider_error', message: FIELDS.message }) });
    const r = await f.request(); assert.equal(r.status, 503); assert.equal(r.body.ok, false);
    assert.equal(r.body.delivery, [409, 500, 503].includes(status) ? 'unknown' : 'rejected');
    assert.ok(Number(r.headers['retry-after']) >= 10); assert.ok(!r.text.includes(FIELDS.message));
  });
}

for (const [label, emailResponse] of Object.entries({ timeout: () => new Promise(() => {}),
  network: () => { throw new Error('private network data'); }, malformed: () => new Response('invalid json'),
  missingId: () => jsonResponse(200, {}), oversized: () => new Response('x'.repeat(LIMITS.responseBytes + 1)),
  redirect: () => { throw new Error('redirect rejected'); },
  slowBody: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) })) {
  test(`Resend ${label} is uncertain, bounded and never false success`, async t => {
    const f = await fixture(t, { limits: { sendMs: 35 }, provider: async call => call.url.includes('siteverify') ? jsonResponse(200, challenge()) : emailResponse() });
    const start = Date.now(); const r = await f.request();
    assert.equal(r.status, 503); assert.equal(r.body.code, 'delivery_uncertain'); assert.equal(r.body.delivery, 'unknown');
    assert.ok(Date.now() - start < 1500); assert.equal(f.calls[1].signal.aborted, ['timeout', 'oversized', 'slowBody'].includes(label));
  });
}

test('identical accepted retry is cached; changed message conflicts without another provider call', async t => {
  const f = await fixture(t); const key = keyAt(); const headers = { 'Idempotency-Key': key };
  assert.equal((await f.request({ headers })).status, 202);
  assert.equal((await f.request({ headers })).status, 202); assert.equal(f.calls.length, 2);
  const r = await f.request({ headers, body: { ...FIELDS, message: 'changed' } });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'idempotency_conflict'); assert.equal(f.calls.length, 2);
});

test('uncertain retry respects cooldown, uses same provider key/body and Siteverify retry UUID', async t => {
  let sends = 0;
  const f = await fixture(t, { provider: async (call, _calls, at) => {
    if (call.url.includes('siteverify')) return jsonResponse(200, challenge({ challenge_ts: new Date(at).toISOString() }));
    if (++sends === 1) throw new Error('connection lost after acceptance');
    return jsonResponse(200, { id: 'same-delivery' });
  } });
  const headers = { 'Idempotency-Key': keyAt() };
  assert.equal((await f.request({ headers })).body.delivery, 'unknown');
  assert.equal((await f.request({ headers })).body.delivery, 'unknown'); assert.equal(f.calls.length, 2);
  f.advance(11000);
  assert.equal((await f.request({ headers })).status, 202);
  assert.equal(f.calls[1].headers['Idempotency-Key'], f.calls[3].headers['Idempotency-Key']);
  assert.equal(f.calls[1].body, f.calls[3].body);
  assert.equal(f.calls[0].payload.idempotency_key, f.calls[2].payload.idempotency_key);
});

test('new challenge token changes only Siteverify retry UUID, never email identity', async t => {
  const f = await fixture(t, { provider: async (call, _calls, at) => call.url.includes('siteverify') ?
    jsonResponse(200, challenge({ challenge_ts: new Date(at).toISOString() })) : jsonResponse(429, {}) });
  const headers = { 'Idempotency-Key': keyAt() };
  await f.request({ headers }); f.advance(61000);
  await f.request({ headers, body: { ...FIELDS, turnstileToken: 'new-challenge' } });
  assert.notEqual(f.calls[0].payload.idempotency_key, f.calls[2].payload.idempotency_key);
  assert.equal(f.calls[1].headers['Idempotency-Key'], f.calls[3].headers['Idempotency-Key']);
});

test('uncertainty remains truthful if a later retry is rejected by verification or provider', async t => {
  let phase = 0;
  const f = await fixture(t, { provider: async call => {
    if (call.url.includes('siteverify')) return jsonResponse(200, phase === 1 ? challenge({ success: false }) : challenge());
    return jsonResponse(phase === 0 ? 500 : 403, {});
  } });
  const headers = { 'Idempotency-Key': keyAt() };
  assert.equal((await f.request({ headers })).body.delivery, 'unknown');
  f.advance(11000); phase = 1; assert.equal((await f.request({ headers })).body.delivery, 'unknown');
  phase = 2; assert.equal((await f.request({ headers })).body.delivery, 'unknown');
});

test('same key across process recreation keeps provider identity and payload; changed config conflicts safely', async t => {
  const known = new Map();
  const provider = async call => {
    if (call.url.includes('siteverify')) return jsonResponse(200, challenge());
    const key = call.headers['Idempotency-Key'];
    if (known.has(key) && known.get(key) !== call.body) return jsonResponse(409, { name: 'invalid_idempotent_request' });
    known.set(key, call.body); return jsonResponse(200, { id: 'stable-id' });
  };
  const first = await fixture(t, { provider }); const second = await fixture(t, { provider });
  const changed = await fixture(t, { provider, env: { CONTACT_FROM_EMAIL: 'new@sender.example' } });
  const headers = { 'Idempotency-Key': keyAt() };
  assert.equal((await first.request({ headers })).status, 202);
  assert.equal((await second.request({ headers })).status, 202); assert.equal(known.size, 1);
  const r = await changed.request({ headers }); assert.equal(r.status, 409); assert.equal(r.body.delivery, 'unknown');
  assert.equal(r.body.retryable, false); assert.equal((await changed.request({ headers })).status, 409);
  assert.equal(changed.calls.length, 2);
});

test('invalid/future/expired keys never send, including after cache loss beyond provider retention', async t => {
  const f = await fixture(t);
  for (const key of [undefined, 'a', crypto.randomUUID(), `${TIME}.not-a-uuid`]) {
    assert.equal((await f.request({ headers: { 'Idempotency-Key': key } })).status, 400);
  }
  for (const key of [keyAt(TIME - LIMITS.retryMs - 1), keyAt(TIME + 60001), keyAt(TIME - 48 * 3600000)]) {
    const r = await f.request({ headers: { 'Idempotency-Key': key } }); assert.equal(r.status, 409); assert.equal(r.body.delivery, 'unknown');
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request({ headers: { 'Idempotency-Key': keyAt(TIME + 60000) } })).status, 202);
});

test('rate limits use socket peer, ignore spoofed forwarded IPs and reset at window boundary', async t => {
  const f = await fixture(t, { limits: { peerAttempts: 2 } });
  const body = { ...FIELDS, email: '' };
  assert.equal((await f.request({ body })).status, 400);
  assert.equal((await f.request({ body, headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 400);
  const r = await f.request({ body, headers: { 'X-Forwarded-For': '5.6.7.8', 'CF-Connecting-IP': '5.6.7.8' } });
  assert.equal(r.status, 429); assert.equal(r.headers['retry-after'], '900');
  f.advance(LIMITS.rateMs); assert.equal((await f.request({ body })).status, 400); assert.equal(f.calls.length, 0);
});

test('global request cap and bounded record capacity fail closed without evicting retry protection', async t => {
  const limited = await fixture(t, { limits: { globalAttempts: 1 } });
  await limited.request({ body: {} }); assert.equal((await limited.request()).status, 429);
  const f = await fixture(t, { limits: { records: 1 } }); const headers = { 'Idempotency-Key': keyAt() };
  assert.equal((await f.request({ headers })).status, 202);
  assert.equal((await f.request()).body.code, 'contact_busy');
  assert.equal((await f.request({ headers })).status, 202); assert.equal(f.calls.length, 2);
  f.advance(LIMITS.retryMs + 1); assert.equal((await f.request()).status, 202);
  assert.equal((await f.request({ headers })).body.code, 'retry_window_closed');
});

test('in-flight duplicate and bounded concurrency reject excess work and recover after completion', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { limits: { concurrent: 2 }, provider: async call => {
    if (call.url.includes('siteverify')) { await waiting; return jsonResponse(200, challenge()); }
    return jsonResponse(200, { id: 'one-email' });
  } });
  const headers = { 'Idempotency-Key': keyAt() }; const first = f.request({ headers });
  while (f.calls.length < 1) await sleep(5);
  assert.equal((await f.request({ headers })).body.code, 'request_in_progress');
  const second = f.request(); while (f.calls.length < 2) await sleep(5);
  assert.equal((await f.request()).body.code, 'contact_busy');
  release(); assert.equal((await first).status, 202); assert.equal((await second).status, 202);
  assert.equal((await f.request()).status, 202);
});

test('total deadline bounds work and releases request capacity', async t => {
  const f = await fixture(t, { limits: { requestMs: 35, challengeMs: 1000, concurrent: 1 }, provider: async () => new Promise(() => {}) });
  const r = await f.request(); assert.equal(r.body.code, 'verification_unavailable'); assert.ok(f.calls[0].signal.aborted);
  assert.equal((await f.request()).body.code, 'verification_unavailable'); assert.equal(f.calls.length, 2);
});

test('client disconnect during verification aborts work before sending and frees capacity', async t => {
  const f = await fixture(t, { limits: { concurrent: 1, challengeMs: 200 }, provider: async () => new Promise(() => {}) });
  const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/api/contact',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': keyAt() } });
  req.on('error', () => {}); req.end(JSON.stringify(FIELDS));
  while (!f.calls.length) await sleep(5);
  req.destroy(); await sleep(25); assert.equal(f.calls[0].signal.aborted, true);
  const r = await f.request(); assert.equal(r.body.code, 'verification_unavailable'); assert.equal(f.calls.length, 2);
});

test('disconnect after send starts keeps uncertainty and reuses the provider key on retry', async t => {
  let sends = 0;
  const f = await fixture(t, { provider: async (call, _calls, at) => {
    if (call.url.includes('siteverify')) return jsonResponse(200, challenge({ challenge_ts: new Date(at).toISOString() }));
    if (++sends === 1) return new Promise(() => {});
    return jsonResponse(200, { id: 'replayed-acceptance' });
  } });
  const key = keyAt();
  const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/api/contact',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': key } });
  req.on('error', () => {}); req.end(JSON.stringify(FIELDS));
  while (f.calls.length < 2) await sleep(5);
  req.destroy(); await sleep(25);
  assert.ok(f.calls[1].signal.aborted);
  const headers = { 'Idempotency-Key': key };
  assert.equal((await f.request({ headers })).body.delivery, 'unknown');
  f.advance(11000); assert.equal((await f.request({ headers })).status, 202);
  assert.equal(f.calls[1].headers['Idempotency-Key'], f.calls[3].headers['Idempotency-Key']);
});

test('streamed oversized upload stops before parsing or sending and next request still works', async t => {
  const f = await fixture(t, { limits: { bodyBytes: 500 } });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/api/contact',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': keyAt() } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.write('x'.repeat(250)); req.end('x'.repeat(251));
  });
  assert.equal(result.status, 413); assert.equal(f.calls.length, 0);
  assert.equal((await f.request()).status, 202);
});

test('sensitive upstream errors and content are neither logged nor returned', async t => {
  const logs = []; const originals = {};
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    originals[method] = console[method]; console[method] = (...args) => logs.push(args);
  }
  try {
    const f = await fixture(t, { provider: async call => {
      if (call.url.includes('siteverify')) return jsonResponse(200, challenge());
      throw new Error(`${FIELDS.message} ${ENV.RESEND_API_KEY} ${ENV.CONTACT_TO_EMAIL}`);
    } });
    const r = await f.request(); assert.equal(r.body.delivery, 'unknown');
    assert.equal(logs.length, 0); assert.ok(!r.text.includes(FIELDS.message)); assert.ok(!r.text.includes(ENV.RESEND_API_KEY));
  } finally { for (const method of Object.keys(originals)) console[method] = originals[method]; }
});
