"use strict";

const { createHash, randomBytes, randomUUID } = require("node:crypto");

const POLICY_LIMITS = Object.freeze({
  defaultAbsoluteLifetimeMs: 8 * 60 * 60 * 1000,
  defaultIdleTimeoutMs: 30 * 60 * 1000,
  maxAbsoluteLifetimeMs: 24 * 60 * 60 * 1000,
  maxIdleTimeoutMs: 60 * 60 * 1000,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const INVALID_SESSION = Object.freeze({ ok: false, error: "invalid_session" });
const DATABASE_ERROR = Object.freeze({ ok: false, error: "database_error" });
const INTERNAL_ERROR = Object.freeze({ ok: false, error: "internal_error" });

const CREATE_SQL = `
WITH issued AS (SELECT clock_timestamp() AS issued_at)
INSERT INTO admin_sessions (session_id, token_digest, created_at, expires_at, last_activity_at)
SELECT $1::uuid, $2::bytea, issued_at,
       issued_at + ($3::bigint * INTERVAL '1 millisecond'), issued_at
FROM issued
RETURNING session_id, created_at, expires_at, last_activity_at`;

// Lock before sampling the clock so a blocked request cannot revive an expired session.
// FOR UPDATE and the volatile clock CTE retain this dependency within one atomic statement.
const VALIDATE_SQL = `
WITH locked AS (
  SELECT session_id, created_at, expires_at, last_activity_at, revoked_at
  FROM admin_sessions
  WHERE token_digest = $1::bytea
  FOR UPDATE
), checked AS (
  SELECT locked.*, clock_timestamp() AS checked_at FROM locked
)
UPDATE admin_sessions AS session
SET last_activity_at = checked.checked_at
FROM checked
WHERE session.session_id = checked.session_id
  AND checked.revoked_at IS NULL
  AND checked.expires_at > checked.checked_at
  AND checked.created_at <= checked.checked_at
  AND checked.created_at > checked.checked_at - ($2::bigint * INTERVAL '1 millisecond')
  AND checked.last_activity_at <= checked.checked_at
  AND checked.last_activity_at > checked.checked_at - ($3::bigint * INTERVAL '1 millisecond')
RETURNING session.session_id, session.expires_at`;

const REVOKE_SQL = `
UPDATE admin_sessions
SET revoked_at = COALESCE(revoked_at, GREATEST(created_at, clock_timestamp()))
WHERE session_id = $1::uuid
RETURNING session_id, created_at, revoked_at`;

function isSessionId(value) {
  return typeof value === "string" && value.length === 36 && UUID_PATTERN.test(value);
}

function timestamp(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

function singleRow(result) {
  if (!result || !Array.isArray(result.rows) || !Number.isInteger(result.rowCount) ||
      result.rowCount < 0 || result.rowCount > 1 || result.rowCount !== result.rows.length) {
    throw new Error("Invalid session database result.");
  }
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (!row || typeof row !== "object" || !isSessionId(row.session_id)) {
    throw new Error("Invalid session database result.");
  }
  return row;
}

function createV3AdminSessionManager(options = {}) {
  let query;
  let policy;
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error();
    const { db, absoluteLifetimeMs = POLICY_LIMITS.defaultAbsoluteLifetimeMs,
      idleTimeoutMs = POLICY_LIMITS.defaultIdleTimeoutMs } = options;
    if (!db || typeof db.query !== "function" ||
        !Number.isSafeInteger(absoluteLifetimeMs) || absoluteLifetimeMs <= 0 ||
        absoluteLifetimeMs > POLICY_LIMITS.maxAbsoluteLifetimeMs ||
        !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 ||
        idleTimeoutMs > POLICY_LIMITS.maxIdleTimeoutMs || idleTimeoutMs > absoluteLifetimeMs) {
      throw new Error();
    }
    query = db.query.bind(db);
    policy = Object.freeze({ absoluteLifetimeMs, idleTimeoutMs });
  } catch {
    throw new TypeError("Invalid V3 Admin session configuration.");
  }

  async function createSession() {
    let entropy;
    let sessionId;
    let token;
    let digest;
    try {
      sessionId = randomUUID();
      entropy = randomBytes(32);
      if (!isSessionId(sessionId) || !Buffer.isBuffer(entropy) || entropy.length !== 32) return INTERNAL_ERROR;
      token = entropy.toString("hex");
      digest = createHash("sha256").update(token, "utf8").digest();
      if (!Buffer.isBuffer(digest) || digest.length !== 32) return INTERNAL_ERROR;
    } catch {
      return INTERNAL_ERROR;
    } finally {
      if (Buffer.isBuffer(entropy)) entropy.fill(0);
    }

    try {
      const row = singleRow(await query(CREATE_SQL, [sessionId, digest, policy.absoluteLifetimeMs]));
      if (!row || row.session_id !== sessionId) return DATABASE_ERROR;
      const createdAt = timestamp(row.created_at);
      const expiresAt = timestamp(row.expires_at);
      const lastActivityAt = timestamp(row.last_activity_at);
      if (createdAt === null || expiresAt === null || lastActivityAt !== createdAt ||
          expiresAt - createdAt !== policy.absoluteLifetimeMs) return DATABASE_ERROR;
      // Raw token is returned only here, to a trusted future authentication caller.
      return Object.freeze({ ok: true, token, sessionId,
        createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() });
    } catch {
      return DATABASE_ERROR;
    }
  }

  async function validateSession(token) {
    if (typeof token !== "string" || token.length !== 64 || !TOKEN_PATTERN.test(token)) return INVALID_SESSION;
    let digest;
    try {
      digest = createHash("sha256").update(token, "utf8").digest();
      if (!Buffer.isBuffer(digest) || digest.length !== 32) return INTERNAL_ERROR;
    } catch {
      return INTERNAL_ERROR;
    }
    try {
      const row = singleRow(await query(VALIDATE_SQL, [digest, policy.absoluteLifetimeMs, policy.idleTimeoutMs]));
      if (!row) return INVALID_SESSION;
      const expiresAt = timestamp(row.expires_at);
      if (expiresAt === null) return DATABASE_ERROR;
      return Object.freeze({ ok: true, sessionId: row.session_id, expiresAt: new Date(expiresAt).toISOString() });
    } catch {
      return DATABASE_ERROR;
    }
  }

  async function revokeSession(sessionId) {
    if (!isSessionId(sessionId)) return INVALID_SESSION;
    try {
      const row = singleRow(await query(REVOKE_SQL, [sessionId]));
      if (!row) return INVALID_SESSION;
      const createdAt = timestamp(row.created_at);
      const revokedAt = timestamp(row.revoked_at);
      if (row.session_id !== sessionId || createdAt === null || revokedAt === null || revokedAt < createdAt) {
        return DATABASE_ERROR;
      }
      return Object.freeze({ ok: true, sessionId });
    } catch {
      return DATABASE_ERROR;
    }
  }

  return Object.freeze({ policy, createSession, validateSession, revokeSession });
}

module.exports = { createV3AdminSessionManager };
