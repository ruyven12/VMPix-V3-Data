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
const ENV = Object.freeze({ CONTACT_ENABLED: '1', CONTACT_FORMSPREE_PROXY_APPROVED: '1', CONTACT_ALLOWED_ORIGINS: ORIGIN,
  CONTACT_FORMSPREE_FORM_ID: 'testabcd',
  CONTACT_IDEMPOTENCY_SECRET: Buffer.alloc(32, 41).toString('base64') });
const SUCCESS = Object.freeze({ next: 'https://formspree.io/thanks', ok: true });
const FIELDS = Object.freeze({ name: 'Synthetic Visitor', email: 'visitor@example.com', subject: 'Synthetic subject',
  message: 'PRIVATE-SYNTHETIC-MESSAGE', turnstileToken: 'synthetic-challenge' });
const keyAt = (time = TIME) => `${time}.${crypto.randomUUID()}`;
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  let clock = options.bootTime ?? TIME - 120000;
  const calls = [];
  const mockFetch = async (url, init) => {
    const call = { url, ...init, payload: JSON.parse(init.body) };
    calls.push(call);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(url, 'https://formspree.io/f/testabcd');
    if (options.provider) return options.provider(call, calls, clock);
    return jsonResponse(200, SUCCESS);
  };
  const app = express();
  app.use('/api/contact', createContactRouter({ env: { ...ENV, ...options.env }, fetchImpl: mockFetch,
    now: () => clock, limits: { peerAttempts: 1000, globalAttempts: 2000, ...options.limits } }));
  // Confirm Contact never falls through to the existing permissive public middleware.
  app.use((_req, res) => res.set('Access-Control-Allow-Origin', '*').status(418).json({ legacy: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  clock = TIME;
  const port = server.address().port;
  function request({ body = { ...FIELDS, turnstileToken: `synthetic-${crypto.randomUUID()}` }, headers = {}, method = 'POST', route = '/api/contact', raw, partial = false } = {}) {
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
  assert.doesNotMatch(moduleSource, /console\.|require\(['"](?:\.\/db|pg|fs|node:fs)|siteverify|TURNSTILE_SECRET_KEY/);
});

for (const [label, env] of Object.entries({ disabled: { CONTACT_ENABLED: '0' }, missingFlag: { CONTACT_ENABLED: undefined },
  truthyFlag: { CONTACT_ENABLED: 'true' }, proxyNotApproved: { CONTACT_FORMSPREE_PROXY_APPROVED: '0' },
  proxyApprovalMissing: { CONTACT_FORMSPREE_PROXY_APPROVED: undefined }, unstableSecret: { CONTACT_IDEMPOTENCY_SECRET: 'short' },
  missingForm: { CONTACT_FORMSPREE_FORM_ID: '' }, fullEndpoint: { CONTACT_FORMSPREE_FORM_ID: 'https://evil.example/form' },
  pathInjection: { CONTACT_FORMSPREE_FORM_ID: 'testabcd/../../api' }, queryInjection: { CONTACT_FORMSPREE_FORM_ID: 'testabcd?to=evil' },
  fragment: { CONTACT_FORMSPREE_FORM_ID: 'testabcd#evil' }, encodedPath: { CONTACT_FORMSPREE_FORM_ID: 'test%2fabcd' },
  headerInjection: { CONTACT_FORMSPREE_FORM_ID: 'testabcd\r\nX-Test:value' }, whitespace: { CONTACT_FORMSPREE_FORM_ID: ' testabcd' } })) {
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
  for (const body of [[], null, {}, { ...FIELDS, to: 'attacker@example.com' }, { ...FIELDS, html: '<script>x</script>' },
    { ...FIELDS, endpoint: 'https://evil.example' }, { ...FIELDS, _cc: 'other@example.com' },
    { ...FIELDS, 'cf-turnstile-response': 'do-not-forward' }, { ...FIELDS, 'g-recaptcha-response': 'do-not-forward' }]) {
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

test('one standard Formspree POST forwards unverified token and text fields without a backend Turnstile secret', async t => {
  const f = await fixture(t, { env: { TURNSTILE_SECRET_KEY: undefined } });
  const r = await f.request({ body: { ...FIELDS, name: '  Zoë Visitor  ', message: '  <b>Text only</b>\r\nNext\tline  ' },
    headers: { Referer: 'https://evil.example/private', 'X-Forwarded-For': '1.2.3.4', Authorization: 'Bearer do-not-forward' } });
  assert.equal(r.status, 202); assert.equal(r.body.delivery, 'accepted'); assert.match(r.body.message, /not yet confirmed/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(f.calls[0].payload, { name: 'Zoë Visitor', email: FIELDS.email,
    subject: `[V3 Contact] ${FIELDS.subject}`, message: '<b>Text only</b>\nNext\tline',
    'cf-turnstile-response': FIELDS.turnstileToken });
  assert.deepEqual(f.calls[0].headers, { 'Content-Type': 'application/json', Accept: 'application/json' });
  for (const value of [...Object.values(ENV), ...Object.values(FIELDS), SUCCESS.next]) assert.ok(!r.text.includes(value));
});

test('exact maximum name/subject/message limits and valid long email are accepted without clipping', async t => {
  const f = await fixture(t);
  const email = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(61);
  assert.equal(email.length, 254);
  const r = await f.request({ body: { ...FIELDS, name: 'n'.repeat(100), email, subject: 's'.repeat(150), message: '😀'.repeat(2500) } });
  assert.equal(r.status, 202); assert.ok(f.calls[0].payload.message.endsWith('😀'.repeat(2500)));
});

for (const [label, token] of Object.entries({ missing: undefined, empty: '', null: null, object: {}, array: [],
  number: 7, tooLong: 'a'.repeat(2049), space: 'a b', newline: 'a\nb', nonASCII: 'é', control: 'a\u007fb' })) {
  test(`missing/malformed CAPTCHA (${label}) is rejected before Formspree`, async t => {
    const f = await fixture(t);
    const r = await f.request({ body: { ...FIELDS, turnstileToken: token } });
    assert.equal(r.status, 400); assert.equal(r.body.delivery, 'not_attempted');
    assert.equal(r.body.retryable, false); assert.equal(f.calls.length, 0);
  });
}

test('opaque token is forwarded unchanged up to the structural limit; legacy secret is ignored', async t => {
  const f = await fixture(t, { env: { TURNSTILE_SECRET_KEY: 'legacy-private-value-do-not-use' } });
  const token = 'a'.repeat(2048);
  assert.equal((await f.request({ body: { ...FIELDS, turnstileToken: token } })).status, 202);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload['cf-turnstile-response'], token);
  assert.ok(!JSON.stringify(f.calls).includes('legacy-private-value-do-not-use'));
});

// Synthetic rejection shapes exercise the adapter; they do not assert a live
// Formspree CAPTCHA error code or prove the production form is configured correctly.
for (const status of [400, 422, 403]) {
  test(`native CAPTCHA rejection (${status}) stays private and cannot trigger replay`, async t => {
    const f = await fixture(t, { provider: async call => jsonResponse(status, { errors: [
      { field: 'cf-turnstile-response', message: `PRIVATE CAPTCHA ${call.payload['cf-turnstile-response']}` }
    ] }) });
    const headers = { 'Idempotency-Key': keyAt() };
    const r = await f.request({ body: FIELDS, headers });
    assert.equal(r.status, status === 403 ? 502 : 422);
    assert.equal(r.body.delivery, 'rejected'); assert.equal(r.body.retryable, false);
    assert.ok(!r.text.includes(FIELDS.turnstileToken)); assert.ok(!r.text.includes('PRIVATE'));
    const retry = await f.request({ body: { ...FIELDS, turnstileToken: 'fresh-token' }, headers });
    assert.deepEqual(retry.body, r.body); assert.equal(f.calls.length, 1);
  });
}

for (const status of [400, 401, 403, 404, 405, 422, 429, 408, 409, 500, 503]) {
  test(`Formspree ${status} is distinguished and never automatically replayed`, async t => {
    const f = await fixture(t, { provider: async () =>
      jsonResponse(status, { errors: [{ message: FIELDS.message, field: 'email', code: 'PRIVATE-PROVIDER-CODE' }] }) });
    const headers = { 'Idempotency-Key': keyAt() };
    const r = await f.request({ headers });
    const expected = [400, 422].includes(status) ? [422, 'provider_validation_failed', 'rejected'] :
      status === 429 ? [429, 'provider_rate_limited', 'rejected'] :
      [401, 403, 404, 405].includes(status) ? [502, 'delivery_unavailable', 'rejected'] : [503, 'delivery_uncertain', 'unknown'];
    assert.deepEqual([r.status, r.body.code, r.body.delivery], expected);
    assert.equal(r.body.retryable, false); assert.ok(!r.text.includes(FIELDS.message));
    assert.ok(!r.text.includes('PRIVATE-PROVIDER-CODE'));
    f.advance(61000); assert.deepEqual((await f.request({ headers })).body, r.body); assert.equal(f.calls.length, 1);
  });
}

for (const [label, response] of Object.entries({ timeout: () => new Promise(() => {}),
  network: () => { throw new Error('private network data'); }, malformed: () => new Response('invalid json'),
  missingNext: () => jsonResponse(200, { ok: true }), falseSuccess: () => jsonResponse(200, { next: '/thanks', ok: false }),
  errorsWithNext: () => jsonResponse(200, { next: '/thanks', errors: [{ message: 'PRIVATE' }] }),
  paymentAction: () => jsonResponse(200, { next: '/thanks', stripe: {}, resubmitKey: 'PRIVATE' }),
  oversized: () => new Response('x'.repeat(LIMITS.responseBytes + 1)),
  redirect: () => { throw new Error('redirect rejected'); },
  slowBody: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) })) {
  test(`Formspree ${label} is uncertain, bounded and never replayed`, async t => {
    const f = await fixture(t, { limits: { sendMs: 35 }, provider: async () => response() });
    const headers = { 'Idempotency-Key': keyAt() }; const start = Date.now(); const r = await f.request({ headers });
    assert.equal(r.status, 503); assert.equal(r.body.code, 'delivery_uncertain'); assert.equal(r.body.delivery, 'unknown');
    assert.equal(r.body.retryable, false); assert.equal(r.headers['retry-after'], undefined);
    assert.ok(Date.now() - start < 1500); assert.equal(f.calls[0].signal.aborted, ['timeout', 'oversized', 'slowBody'].includes(label));
    f.advance(11000); assert.deepEqual((await f.request({ headers })).body, r.body); assert.equal(f.calls.length, 1);
  });
}

test('official next-only success is accepted without following or exposing provider URLs', async t => {
  const f = await fixture(t, { provider: async () =>
    jsonResponse(200, { next: 'https://private.example/receipt?secret=PRIVATE' }) });
  const r = await f.request(); assert.equal(r.status, 202); assert.ok(!r.text.includes('private.example')); assert.equal(f.calls.length, 1);
});

test('identical accepted retry is cached; changed message conflicts without another provider call', async t => {
  const f = await fixture(t); const key = keyAt(); const headers = { 'Idempotency-Key': key };
  assert.equal((await f.request({ headers })).status, 202);
  assert.equal((await f.request({ headers })).status, 202); assert.equal(f.calls.length, 1);
  const r = await f.request({ headers, body: { ...FIELDS, message: 'changed' } });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'idempotency_conflict'); assert.equal(f.calls.length, 1);
});

test('uncertain native CAPTCHA submission is never replayed with a fresh token', async t => {
  const f = await fixture(t, { limits: { sendMs: 35 }, provider: async () => new Promise(() => {}) });
  const headers = { 'Idempotency-Key': keyAt() };
  const first = await f.request({ headers, body: FIELDS });
  assert.equal(first.body.code, 'delivery_uncertain');
  f.advance(11000);
  assert.deepEqual((await f.request({ headers, body: FIELDS })).body, first.body);
  assert.deepEqual((await f.request({ headers, body: { ...FIELDS, turnstileToken: 'fresh-token' } })).body, first.body);
  const changedKey = await f.request({ body: FIELDS });
  assert.equal(changedKey.body.code, 'challenge_already_submitted');
  assert.equal(changedKey.body.retryable, false); assert.equal(changedKey.body.delivery, 'unknown');
  assert.equal(f.calls.length, 1);
});

test('forwarded challenge cannot be reused with a different key', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ body: FIELDS })).status, 202);
  const r = await f.request({ body: FIELDS });
  assert.equal(r.body.code, 'challenge_already_submitted'); assert.equal(r.body.retryable, false);
  assert.equal(r.body.delivery, 'unknown'); assert.equal(f.calls.length, 1);
});

test('concurrent keys cannot dispatch the same challenge twice', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { provider: async () => {
    await waiting;
    return jsonResponse(200, SUCCESS);
  } });
  const first = f.request({ body: FIELDS });
  while (!f.calls.length) await sleep(5);
  try {
    assert.equal((await f.request({ body: FIELDS })).body.code, 'challenge_already_submitted');
    assert.equal(f.calls.length, 1);
  } finally { release(); }
  assert.equal((await first).status, 202); assert.equal(f.calls.length, 1);
});

test('uncertainty survives elapsed time and refreshed challenge without another dispatch', async t => {
  const f = await fixture(t, { provider: async () => jsonResponse(500, {}) });
  const headers = { 'Idempotency-Key': keyAt() };
  assert.equal((await f.request({ headers })).body.delivery, 'unknown');
  f.advance(61000);
  const r = await f.request({ headers, body: { ...FIELDS, turnstileToken: 'fresh-token' } });
  assert.equal(r.body.delivery, 'unknown'); assert.equal(r.body.retryable, false); assert.equal(f.calls.length, 1);
});

test('restart refuses pre-start keys, including future-skew keys, after receipt memory is lost', async t => {
  const first = await fixture(t);
  const keys = [keyAt(), keyAt(TIME + LIMITS.futureMs)];
  for (const key of keys) assert.equal((await first.request({ headers: { 'Idempotency-Key': key } })).status, 202);
  const restarted = await fixture(t, { bootTime: TIME + 1 }); restarted.advance(120000);
  for (const key of keys) {
    const r = await restarted.request({ headers: { 'Idempotency-Key': key } });
    assert.equal(r.body.code, 'submission_history_unavailable'); assert.equal(r.body.retryable, false);
  }
  assert.equal(restarted.calls.length, 0); assert.equal((await restarted.request()).status, 202);
});

test('fresh process rejects keys within startup uncertainty and recovers for newly created keys', async t => {
  const f = await fixture(t, { bootTime: TIME });
  assert.equal((await f.request()).body.code, 'submission_history_unavailable');
  f.advance(LIMITS.futureMs + 1); assert.equal((await f.request()).status, 202);
});

test('invalid/future/expired keys never send, including after cache expiry', async t => {
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
  assert.equal((await f.request({ headers })).status, 202); assert.equal(f.calls.length, 1);
  f.advance(LIMITS.retryMs + LIMITS.futureMs + 1); assert.equal((await f.request()).status, 202);
  assert.equal((await f.request({ headers })).body.code, 'retry_window_closed');
});

test('in-flight duplicate and bounded concurrency reject excess work and recover after completion', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { limits: { concurrent: 2 }, provider: async () => {
    await waiting;
    return jsonResponse(200, SUCCESS);
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
  const f = await fixture(t, { limits: { requestMs: 35, sendMs: 1000, concurrent: 1 }, provider: async () => new Promise(() => {}) });
  const r = await f.request(); assert.equal(r.body.code, 'delivery_uncertain'); assert.ok(f.calls[0].signal.aborted);
  assert.equal((await f.request()).body.code, 'delivery_uncertain'); assert.equal(f.calls.length, 2);
});

test('client disconnect during upload makes no provider call and frees capacity', async t => {
  const f = await fixture(t, { limits: { concurrent: 1, bodyMs: 200 } });
  const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/api/contact',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': keyAt() } });
  req.on('error', () => {}); req.write('{');
  await sleep(25); req.destroy(); await sleep(25); assert.equal(f.calls.length, 0);
  const r = await f.request(); assert.equal(r.status, 202); assert.equal(f.calls.length, 1);
});

test('disconnect after send starts keeps uncertainty and blocks replay', async t => {
  let sends = 0;
  const f = await fixture(t, { provider: async () => {
    if (++sends === 1) return new Promise(() => {});
    return jsonResponse(200, SUCCESS);
  } });
  const key = keyAt();
  const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: '/api/contact',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': key } });
  req.on('error', () => {}); req.end(JSON.stringify(FIELDS));
  while (f.calls.length < 1) await sleep(5);
  req.destroy(); await sleep(25);
  assert.ok(f.calls[0].signal.aborted);
  const headers = { 'Idempotency-Key': key };
  assert.equal((await f.request({ headers })).body.delivery, 'unknown');
  f.advance(11000); const result = await f.request({ headers });
  assert.equal(result.body.delivery, 'unknown'); assert.equal(result.body.retryable, false); assert.equal(f.calls.length, 1);
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
    const f = await fixture(t, { provider: async () => {
      throw new Error(`${FIELDS.message} ${FIELDS.turnstileToken} inbox@private.example`);
    } });
    const r = await f.request({ body: FIELDS }); assert.equal(r.body.delivery, 'unknown');
    assert.equal(logs.length, 0); assert.ok(!r.text.includes(FIELDS.message)); assert.ok(!r.text.includes(FIELDS.turnstileToken));
    assert.ok(!r.text.includes('inbox@private.example'));
  } finally { for (const method of Object.keys(originals)) console[method] = originals[method]; }
});
