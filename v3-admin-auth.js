"use strict";

const express = require("express");
const net = require("node:net");
const { verifyV3AdminPassword } = require("./v3-admin-password");
const { createV3AdminSessionManager } = require("./v3-admin-session");

const FRONTEND_ORIGIN = "https://vmpix-v3.onrender.com";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_PEERS = 1024;
const DEFAULT_LIMITER = { peers: new Map(), global: { startedAt: null, attempts: 0 } };
let activePasswordVerifications = 0;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^scrypt\$v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/;
const AUTH_METHODS = Object.freeze({ "/login": "POST", "/session": "GET", "/logout": "POST" });
const CORS_HEADERS = new Set(["authorization", "content-type", "x-v3-admin-request"]);

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
function readBearer(req) {
  const value = req.headers.authorization;
  if (typeof value !== "string" || value.length !== 71 || !value.startsWith("Bearer ")) return null;
  const token = value.slice(7);
  return isToken(token) ? token : null;
}
function sessionAttempt(req) {
  return req.headers.authorization !== undefined || req.headers["x-v3-admin-request"] !== undefined ||
    isToken(req.headers["x-admin-token"]) || isToken(req.query?.token) || isToken(req.query?.admin_token) ||
    typeof req.headers.cookie === "string" && req.headers.cookie.includes("__Host-v3_admin_session=");
}
function uniqueHeaders(req) {
  const names = new Set(["origin", "authorization", "x-v3-admin-request",
    "access-control-request-method", "access-control-request-headers"]);
  const seen = new Set();
  const raw = req.rawHeaders || [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = String(raw[index]).toLowerCase();
    if (names.has(name) && seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}
function validPasswordBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, "password") || typeof body.password !== "string" ||
      body.password.length === 0 || body.password.length > 1024) return false;
  const bytes = Buffer.from(body.password, "utf8");
  try { return bytes.length <= 1024 && bytes.toString("utf8") === body.password; }
  finally { bytes.fill(0); }
}

// Exact immediate-peer addresses only; never infer a trusted proxy from platform/Host/Origin headers.
// Operators must verify ingress ownership and header rewriting before configuring this optional set.
function trustedProxyAddresses(value) {
  const list = new net.BlockList();
  if (value === undefined || value === "") return list;
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid proxy configuration.");
  const addresses = value.split(",").map((address) => address.trim());
  if (!addresses.length || addresses.length > 32 || addresses.some((address) => address.includes("%") || !net.isIP(address))) {
    throw new Error("Invalid proxy configuration.");
  }
  const unspecified = new net.BlockList();
  unspecified.addAddress("0.0.0.0", "ipv4");
  unspecified.addAddress("::", "ipv6");
  for (const address of addresses) {
    const kind = net.isIP(address) === 4 ? "ipv4" : "ipv6";
    if (unspecified.check(address, kind)) throw new Error("Invalid proxy configuration.");
    list.addAddress(address, kind);
  }
  return list;
}
function verifiedHttps(req, trustedPeers) {
  if (req.socket?.encrypted === true) return true;
  const peer = req.socket?.remoteAddress;
  if (typeof peer !== "string" || peer.includes("%")) return false;
  const kind = typeof peer === "string" ? net.isIP(peer) : 0;
  if (!kind || !trustedPeers.check(peer, kind === 4 ? "ipv4" : "ipv6") ||
      req.headers["x-forwarded-proto"] !== "https") return false;
  const raw = req.rawHeaders || [];
  let count = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (String(raw[index]).toLowerCase() === "x-forwarded-proto") {
      if (raw[index + 1] !== "https") return false;
      count += 1;
    }
  }
  return count === 1;
}

// Configuration is read only at factory creation. Missing/malformed configuration fails closed.
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
      if (typeof hash === "string" && hash.length === 107 && HASH_PATTERN.test(hash) &&
          origin === FRONTEND_ORIGIN && typeof verifyPassword === "function" && typeof now === "function" &&
          limiterState?.peers instanceof Map && limiterState.global) {
        configuration = Object.freeze({ hash, origin,
          trustedPeers: trustedProxyAddresses(env.V3_ADMIN_AUTH_TRUSTED_PROXY_IPS) });
      }
    }
  } catch { /* Enabled requests remain unavailable; no supplied value is logged. */ }
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
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const bestEffortRevoke = async (sessionId) => {
    if (!isSessionId(sessionId)) return;
    try { await getSessions().revokeSession(sessionId); } catch { /* Never expose database details. */ }
  };
  const securityHeaders = (res) => res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const cors = (req, res) => {
    res.set("Access-Control-Allow-Origin", configuration.origin);
    res.vary("Origin");
    res.removeHeader("Access-Control-Allow-Credentials");
  };
  const requestAllowed = (req, res, preflight = false) => {
    securityHeaders(res);
    if (!enabled) { respond(req, res, 404, "not_found"); return false; }
    if (!configuration) { respond(req, res, 503, "authentication_unavailable"); return false; }
    if (!verifiedHttps(req, configuration.trustedPeers) || !uniqueHeaders(req) ||
        req.headers.origin !== configuration.origin ||
        !preflight && req.headers["x-v3-admin-request"] !== "1") {
      res.removeHeader("Access-Control-Allow-Origin");
      respond(req, res, 403, "request_rejected"); return false;
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && !["same-origin", "same-site", "cross-site"].includes(site)) {
      respond(req, res, 403, "request_rejected"); return false;
    }
    cors(req, res);
    return connected(req, res);
  };
  const preflight = (req, res, methods) => {
    if (!requestAllowed(req, res, true)) return;
    const method = req.headers["access-control-request-method"];
    const requested = req.headers["access-control-request-headers"];
    if (typeof requested !== "string" || requested.length > 256 || !methods.includes(method)) {
      return respond(req, res, 403, "request_rejected");
    }
    const names = requested.split(",").map((name) => name.trim().toLowerCase());
    if (!names.length || !names.includes("x-v3-admin-request") || names.some((name) => !CORS_HEADERS.has(name))) {
      return respond(req, res, 403, "request_rejected");
    }
    res.set("Access-Control-Allow-Methods", method);
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-V3-Admin-Request");
    res.vary("Access-Control-Request-Method");
    res.vary("Access-Control-Request-Headers");
    return res.status(204).end();
  };
  const validatedSession = async (req) => {
    const token = readBearer(req);
    if (!token) return { ok: false, error: "invalid_session" };
    const result = await getSessions().validateSession(token);
    if (result?.ok === true && isSessionId(result.sessionId) && timestamp(result.expiresAt) !== null) return result;
    return result?.ok === false && result.error === "invalid_session" ? result : { ok: false, error: "database_error" };
  };

  // Called only for existing protected routes, after legitimate legacy credentials have matched.
  Object.defineProperty(router, "authorizeSession", { value: async (req, res) => {
    if (!sessionAttempt(req) && !enabled) return null;
    if (!requestAllowed(req, res)) return false;
    try {
      const result = await validatedSession(req);
      if (result.ok === true && connected(req, res)) return true;
      respond(req, res, result.error === "invalid_session" ? 401 : 503,
        result.error === "invalid_session" ? "invalid_session" : "authentication_unavailable");
    } catch { respond(req, res, 503, "authentication_unavailable"); }
    return false;
  } });
  Object.defineProperty(router, "controlPlaneCors", { value: (req, res, next) => {
    const requested = req.headers["access-control-request-headers"];
    if (req.method === "OPTIONS") {
      const names = typeof requested === "string" ? requested.split(",").map((name) => name.trim().toLowerCase()) : [];
      if (!names.includes("x-v3-admin-request")) return next();
      return preflight(req, res, ["GET", "POST", "PUT", "PATCH", "DELETE"]);
    }
    const selected = enabled || sessionAttempt(req);
    if (!selected) return next();
    if (!requestAllowed(req, res)) return;
    res.locals.v3AdminCors = true;
    return next();
  } });

  router.use((req, res, next) => {
    const expected = AUTH_METHODS[req.path];
    securityHeaders(res);
    if (!expected || req.url !== req.path) return respond(req, res, 404, "not_found");
    if (req.method === "OPTIONS") return preflight(req, res, [expected]);
    if (!requestAllowed(req, res)) return;
    if (req.method !== expected) {
      res.set("Allow", expected);
      return respond(req, res, 405, "method_not_allowed");
    }
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
    for (const [key, entry] of state.peers) if (at - entry.startedAt >= RATE_WINDOW_MS) state.peers.delete(key);
    if (state.global.startedAt === null || at - state.global.startedAt >= RATE_WINDOW_MS) {
      state.global.startedAt = at; state.global.attempts = 0;
    }
    let entry = state.peers.get(peer);
    if (state.global.attempts >= 20 || entry && entry.attempts >= 5 || !entry && state.peers.size >= MAX_PEERS) {
      const start = entry?.attempts >= 5 ? entry.startedAt : state.global.startedAt;
      res.set("Retry-After", String(Math.max(1, Math.min(900, Math.ceil((RATE_WINDOW_MS - (at - start)) / 1000)))));
      return respond(req, res, 429, "try_later");
    }
    if (!entry) { entry = { startedAt: at, attempts: 0 }; state.peers.set(peer, entry); }
    entry.attempts += 1; state.global.attempts += 1;
    next();
  };
  const json = express.json({ limit: "4kb", strict: true, inflate: false, type: "application/json" });
  router.post("/login", limitLogin, json, asyncRoute(async (req, res) => {
    if (!validPasswordBody(req.body)) return respond(req, res, 400, "invalid_request");
    if (!connected(req, res)) return;
    if (activePasswordVerifications >= 1) {
      res.set("Retry-After", "1"); return respond(req, res, 429, "try_later");
    }
    let lost = false;
    let createdId = null;
    const disconnect = () => { lost = true; };
    req.once("aborted", disconnect); res.once("close", disconnect);
    activePasswordVerifications += 1;
    try {
      let accepted;
      try { accepted = await verifyPassword(req.body.password, configuration.hash); }
      finally { activePasswordVerifications -= 1; req.body.password = ""; }
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
          !Number.isSafeInteger(configuredLifetime) || configuredLifetime <= 0 ||
          Math.min(expiresAt - clock(), configuredLifetime, SESSION_LIFETIME_MS) < 1000) {
        await bestEffortRevoke(createdId); return respond(req, res, 503, "authentication_unavailable");
      }
      return res.status(200).json({ ok: true, authenticated: true, token: created.token, expiresAt: created.expiresAt });
    } catch {
      await bestEffortRevoke(createdId);
      return respond(req, res, 503, "authentication_unavailable");
    } finally {
      req.removeListener("aborted", disconnect); res.removeListener("close", disconnect);
    }
  }));
  router.get("/session", asyncRoute(async (req, res) => {
    const result = await validatedSession(req);
    if (result.ok === true) {
      if (connected(req, res)) return res.status(200).json({ ok: true, authenticated: true, expiresAt: result.expiresAt });
      return;
    }
    return respond(req, res, result.error === "invalid_session" ? 401 : 503,
      result.error === "invalid_session" ? "invalid_session" : "authentication_unavailable");
  }));
  router.post("/logout", asyncRoute(async (req, res) => {
    if (req.headers.authorization === undefined) return res.status(200).json({ ok: true, authenticated: false });
    const result = await validatedSession(req);
    if (result.ok === false && result.error === "invalid_session") {
      return res.status(200).json({ ok: true, authenticated: false });
    }
    if (result.ok !== true) return respond(req, res, 503, "authentication_unavailable");
    const revoked = await getSessions().revokeSession(result.sessionId);
    if (revoked?.ok !== true || revoked.sessionId !== result.sessionId) return respond(req, res, 503, "authentication_unavailable");
    if (connected(req, res)) return res.status(200).json({ ok: true, authenticated: false });
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
