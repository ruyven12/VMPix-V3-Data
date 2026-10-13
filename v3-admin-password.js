"use strict";

const { scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const scryptAsync = promisify(scrypt);
const MAX_PASSWORD_BYTES = 1024;
const KEY_BYTES = 32;
const SCRYPT_OPTIONS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });

// Provisioning format: scrypt$v1$<16-byte lowercase hex salt>$<32-byte lowercase hex key>.
// v1 fixes the parameters above; encoded hashes cannot select their own KDF cost.
const HASH_PATTERN = /^scrypt\$v1\$([0-9a-f]{32})\$([0-9a-f]{64})$/;

async function verifyV3AdminPassword(password, encodedHash = process.env.V3_ADMIN_PASSWORD_HASH) {
  let passwordBytes;
  let salt;
  let expectedKey;
  let derivedKey;

  try {
    if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_BYTES) {
      return false;
    }
    if (typeof encodedHash !== "string" || encodedHash.length !== 107) {
      return false;
    }
    const match = HASH_PATTERN.exec(encodedHash);
    if (!match) return false;

    passwordBytes = Buffer.from(password, "utf8");
    if (passwordBytes.length > MAX_PASSWORD_BYTES || passwordBytes.toString("utf8") !== password) {
      return false;
    }

    salt = Buffer.from(match[1], "hex");
    expectedKey = Buffer.from(match[2], "hex");
    derivedKey = await scryptAsync(passwordBytes, salt, KEY_BYTES, SCRYPT_OPTIONS);
    if (!Buffer.isBuffer(derivedKey) || derivedKey.length !== KEY_BYTES) return false;
    return timingSafeEqual(derivedKey, expectedKey);
  } catch {
    return false;
  } finally {
    // Best-effort cleanup of owned buffers; JavaScript strings cannot be wiped.
    for (const buffer of [passwordBytes, salt, expectedKey, derivedKey]) {
      if (Buffer.isBuffer(buffer)) buffer.fill(0);
    }
  }
}

module.exports = { verifyV3AdminPassword };
