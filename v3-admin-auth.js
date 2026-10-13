"use strict";

const express = require("express");
const { verifyV3AdminPassword } = require("./v3-admin-password");
const { createV3AdminSessionManager } = require("./v3-admin-session");

const COOKIE_NAME = "__Host-v3_admin_session";
const COOKIE_OPTIONS = Object.freeze({ path: "/", secure: true, httpOnly: true, sameSite: "strict" });
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_PEERS = 1024;
const DEFAULT_LIMITER = { peers: new Map(), global: { startedAt: null, attempts: 0 } };
let activePasswordVerifications = 0;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^scrypt\$v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

function isToken(value) { return typeof value === "string" && value.length === 64 && TOKEN_PATTERN.test(value); }
function isSessionId(value) { return typeof value === "string" && value.length === 36 && UUID_PATTERN.test(value); }
function timestamp(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date.getTime() : null;
}
function connected(req, res) {
  return !req.aborted && !(req.destroyed && !req.complete) && !req.socket?.destroyed &&
    !res.destroyed && !res.writableEnded;
}
function respond(req, res, status, error) {
  if (!connected(req, res) || res.headersSent) return;
  return res.status(status).json({ ok: false, authenticated: false, error });
}
function readToken(req) {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  if (typeof header !== "string" || header.length > 4096) return null;
  let token = null;
  let seen = false;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    const name = (separator < 0 ? part : part.slice(0, separator)).trim();
    if (name !== COOKIE_NAME) continue;
    if (seen || separator < 0) return null;
    seen = true;
    token = part.slice(separator + 1);
    if (!isToken(token)) return null;
  }
  return token;
}
function validPasswordBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, "password") || typeof body.password !== "string" ||
      body.password.length === 0 || body.password.length > 1024) return false;
  const bytes = Buffer.from(body.password, "utf8");
  try { return bytes.length <= 1024 && bytes.toString("utf8") === body.password; }
  finally { bytes.fill(0); }
}

// Activation requires same-origin HTTPS UI/API and separately approved TLS/proxy recognition.
// Forwarded-proto headers alone are deliberately not trusted; this module adds no credential CORS.
// limiterState is a trusted test dependency: { peers: Map, global: { startedAt: null, attempts: 0 } }.
function createV3AdminAuthRouter({ db, env = process.env, verifyPassword = verifyV3AdminPassword,
  sessions, now = Date.now, limiterState = DEFAULT_LIMITER } = {}) {
  const router = express.Router({ caseSensitive: true, strict: true });
  let enabled = false;
  let configuration = null;
  let manager = sessions || null;
  try {
    enabled = env.V3_ADMIN_AUTH_ENABLED === "true";
    if (enabled) {
      const hash = env.V3_ADMIN_PASSWORD_HASH;
      const origin = env.V3_ADMIN_AUTH_ORIGIN;
      const parsed = typeof origin === "string" ? new URL(origin) : null;
      if (typeof hash === "string" && hash.length === 107 && HASH_PATTERN.test(hash) && parsed &&
          parsed.protocol === "https:" && parsed.origin === origin && !parsed.username && !parsed.password &&
          typeof verifyPassword === "function" && typeof now === "function" &&
          limiterState?.peers instanceof Map && limiterState.global) {
        configuration = Object.freeze({ hash, origin });
      }
    }
  } catch { /* Missing/malformed configuration leaves the enabled routes unavailable. */ }

  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Authentication unavailable.");
    return value;
  };
  const getSessions = () => {
    if (!manager) manager = createV3AdminSessionManager({ db });
    if (typeof manager.createSession !== "function" || typeof manager.validateSession !== "function" ||
        typeof manager.revokeSession !== "function") throw new Error("Authentication unavailable.");
    return manager;
  };
  const clearCookie = (res) => res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const bestEffortRevoke = async (sessionId) => {
    if (!isSessionId(sessionId)) return;
    try { await getSessions().revokeSession(sessionId); } catch { /* Never expose database details. */ }
  };

  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
    if (!enabled) return respond(req, res, 404, "not_found");
    if (!configuration) return respond(req, res, 503, "authentication_unavailable");
    if (req.secure !== true || req.headers["x-v3-admin-request"] !== "1") {
      return respond(req, res, 403, "request_rejected");
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") return respond(req, res, 403, "request_rejected");
    const origin = req.headers.origin;
    if ((req.method === "POST" && origin !== configuration.origin) ||
        (origin !== undefined && origin !== configuration.origin)) return respond(req, res, 403, "request_rejected");
    const expected = { "/login": "POST", "/session": "GET", "/logout": "POST" }[req.path];
    if (!expected) return respond(req, res, 404, "not_found");
    if (req.method !== expected) {
      res.set("Allow", expected);
      return respond(req, res, 405, "method_not_allowed");
    }
    if (!connected(req, res)) return;
    next();
  });

  const limitLogin = (req, res, next) => {
    if (!req.is("application/json")) return respond(req, res, 400, "invalid_request");
    const at = clock();
    const peer = typeof req.socket?.remoteAddress === "string" && req.socket.remoteAddress.length <= 128
      ? req.socket.remoteAddress : "unknown";
    const state = limiterState;
    if (state.peers.size > MAX_PEERS || !Number.isSafeInteger(state.global.attempts) || state.global.attempts < 0 ||
        (state.global.startedAt !== null && !Number.isSafeInteger(state.global.startedAt))) {
      throw new Error("Authentication unavailable.");
    }
    for (const [key, entry] of state.peers) {
      if (at - entry.startedAt >= RATE_WINDOW_MS) state.peers.delete(key);
    }
    if (state.global.startedAt === null || at - state.global.startedAt >= RATE_WINDOW_MS) {
      state.global.startedAt = at;
      state.global.attempts = 0;
    }
    let entry = state.peers.get(peer);
    const limited = state.global.attempts >= 20 || (entry && entry.attempts >= 5) ||
      (!entry && state.peers.size >= MAX_PEERS);
    if (limited) {
      const start = entry?.attempts >= 5 ? entry.startedAt : state.global.startedAt;
      const retry = Math.max(1, Math.min(900, Math.ceil((RATE_WINDOW_MS - (at - start)) / 1000)));
      res.set("Retry-After", String(retry));
      return respond(req, res, 429, "try_later");
    }
    if (!entry) { entry = { startedAt: at, attempts: 0 }; state.peers.set(peer, entry); }
    entry.attempts += 1;
    state.global.attempts += 1;
    next();
  };

  const json = express.json({ limit: "4kb", strict: true, inflate: false, type: "application/json" });
  router.post("/login", limitLogin, json, asyncRoute(async (req, res) => {
    if (!validPasswordBody(req.body)) return respond(req, res, 400, "invalid_request");
    if (!connected(req, res)) return;
    if (activePasswordVerifications >= 1) {
      res.set("Retry-After", "1");
      return respond(req, res, 429, "try_later");
    }
    let lost = false;
    let createdId = null;
    let cookieSet = false;
    const disconnect = () => { lost = true; };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    activePasswordVerifications += 1;
    try {
      let accepted;
      try { accepted = await verifyPassword(req.body.password, configuration.hash); }
      finally { activePasswordVerifications -= 1; }
      if (lost || !connected(req, res)) return;
      if (accepted !== true) return respond(req, res, 401, "invalid_credentials");
      const sessionManager = getSessions();
      const created = await sessionManager.createSession();
      if (created?.ok === true && isSessionId(created.sessionId)) createdId = created.sessionId;
      if (lost || !connected(req, res)) { await bestEffortRevoke(createdId); return; }
      const createdAt = timestamp(created?.createdAt);
      const expiresAt = timestamp(created?.expiresAt);
      const configuredLifetime = sessionManager.policy?.absoluteLifetimeMs ?? SESSION_LIFETIME_MS;
      if (created?.ok !== true || !createdId || !isToken(created.token) || createdAt === null || expiresAt === null ||
          expiresAt <= createdAt || expiresAt - createdAt > SESSION_LIFETIME_MS ||
          !Number.isSafeInteger(configuredLifetime) || configuredLifetime <= 0) {
        await bestEffortRevoke(createdId);
        return respond(req, res, 503, "authentication_unavailable");
      }
      const lifetime = Math.min(expiresAt - clock(), configuredLifetime, SESSION_LIFETIME_MS);
      if (lifetime < 1000) {
        await bestEffortRevoke(createdId);
        return respond(req, res, 503, "authentication_unavailable");
      }
      // Fixed token alphabet/attributes prevent header injection; preserve the stored Expires deadline.
      // Express's maxAge cookie option otherwise overwrites an explicit Expires value.
      cookieSet = true;
      res.append("Set-Cookie", `${COOKIE_NAME}=${created.token}; Max-Age=${Math.floor(lifetime / 1000)}; Path=/; ` +
        `Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`);
      return res.status(200).json({ ok: true, authenticated: true });
    } catch {
      await bestEffortRevoke(createdId);
      if (cookieSet && !res.headersSent) res.removeHeader("Set-Cookie");
      return respond(req, res, 503, "authentication_unavailable");
    } finally {
      req.removeListener("aborted", disconnect);
      res.removeListener("close", disconnect);
    }
  }));

  router.get("/session", asyncRoute(async (req, res) => {
    const token = readToken(req);
    if (!token) { clearCookie(res); return respond(req, res, 401, "invalid_session"); }
    const result = await getSessions().validateSession(token);
    if (result?.ok === true && isSessionId(result.sessionId) && timestamp(result.expiresAt) !== null) {
      if (connected(req, res)) return res.status(200).json({ ok: true, authenticated: true });
      return;
    }
    if (result?.ok === false && result.error === "invalid_session") {
      clearCookie(res);
      return respond(req, res, 401, "invalid_session");
    }
    return respond(req, res, 503, "authentication_unavailable");
  }));

  router.post("/logout", asyncRoute(async (req, res) => {
    const token = readToken(req);
    try {
      if (!token) {
        clearCookie(res);
        return res.status(200).json({ ok: true, authenticated: false });
      }
      const result = await getSessions().validateSession(token);
      if (result?.ok === false && result.error === "invalid_session") {
        clearCookie(res);
        return res.status(200).json({ ok: true, authenticated: false });
      }
      if (result?.ok !== true || !isSessionId(result.sessionId) || timestamp(result.expiresAt) === null) {
        clearCookie(res);
        return respond(req, res, 503, "authentication_unavailable");
      }
      const revoked = await getSessions().revokeSession(result.sessionId);
      clearCookie(res);
      if (revoked?.ok !== true || revoked.sessionId !== result.sessionId) {
        return respond(req, res, 503, "authentication_unavailable");
      }
      if (connected(req, res)) return res.status(200).json({ ok: true, authenticated: false });
    } catch {
      if (!res.headersSent) clearCookie(res);
      return respond(req, res, 503, "authentication_unavailable");
    }
  }));

  router.use((_req, res) => res.status(404).json({ ok: false, authenticated: false, error: "not_found" }));
  router.use((error, req, res, _next) => {
    const status = error?.type === "entity.too.large" ? 413 :
      ["entity.parse.failed", "encoding.unsupported", "charset.unsupported", "request.size.invalid"].includes(error?.type) ? 400 : 503;
    return respond(req, res, status, status === 503 ? "authentication_unavailable" : "invalid_request");
  });
  return router;
}

module.exports = { createV3AdminAuthRouter };
