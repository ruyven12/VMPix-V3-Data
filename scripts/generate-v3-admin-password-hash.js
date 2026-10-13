"use strict";

const { randomBytes, scrypt } = require("node:crypto");
const { promisify } = require("node:util");
const { Writable } = require("node:stream");
const readline = require("node:readline");
const { verifyV3AdminPassword } = require("../v3-admin-password.js");

const scryptAsync = promisify(scrypt);
const MAX_PASSWORD_BYTES = 1024;
const SCRYPT_OPTIONS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
const failure = () => new Error("Password provisioning failed.");

function confirmedPasswordBytes(password, confirmation) {
  if (typeof password !== "string" || !password.length || password.length > MAX_PASSWORD_BYTES ||
      typeof confirmation !== "string" || password !== confirmation) throw failure();
  const bytes = Buffer.from(password, "utf8");
  if (bytes.length > MAX_PASSWORD_BYTES || bytes.toString("utf8") !== password) {
    bytes.fill(0);
    throw failure();
  }
  return bytes;
}

async function generateV3AdminPasswordHash(password, confirmation) {
  let passwordBytes;
  let salt;
  let key;
  try {
    passwordBytes = confirmedPasswordBytes(password, confirmation);
    salt = randomBytes(16);
    if (!Buffer.isBuffer(salt) || salt.length !== 16) throw failure();
    key = await scryptAsync(passwordBytes, salt, 32, SCRYPT_OPTIONS);
    if (!Buffer.isBuffer(key) || key.length !== 32) throw failure();
    const encodedHash = `scrypt$v1$${salt.toString("hex")}$${key.toString("hex")}`;
    if (!(await verifyV3AdminPassword(password, encodedHash))) throw failure();
    return encodedHash;
  } catch {
    throw failure();
  } finally {
    // Best-effort cleanup; JavaScript strings cannot be wiped.
    for (const buffer of [passwordBytes, salt, key]) {
      if (Buffer.isBuffer(buffer)) buffer.fill(0);
    }
  }
}

async function runProvisioning({ input = process.stdin, output = process.stdout, error = process.stderr,
  args = process.argv.slice(2), signals = process, releaseInput = () => {} } = {}) {
  let rl;
  let muted;
  let rawBefore;
  let terminalStarted = false;
  let terminalRestored = false;
  let terminalRestoring = false;
  let inputCompleted = false;
  let cancelled = false;
  let stderrFailed = false;
  let receivedLines = 0;
  let pendingLine;
  const lines = [];
  const listeners = [];
  let resolveAbort;
  const aborted = new Promise((resolve) => { resolveAbort = resolve; });
  const listen = (emitter, event, handler) => {
    emitter.on(event, handler);
    listeners.push([emitter, event, handler]);
  };
  const restoreTerminal = () => {
    if (!terminalStarted || terminalRestored || terminalRestoring) return;
    terminalRestoring = true;
    try {
      rl?.close();
      // readline.close() disables raw mode; restore the original state afterwards.
      input.setRawMode(rawBefore);
      if (input.isRaw !== rawBefore) throw failure();
      input.pause();
      lines.length = 0;
      terminalRestored = true;
      // The direct CLI can cancel its native console read; imported callers retain ownership.
      releaseInput();
    } finally { terminalRestoring = false; }
  };
  const abort = () => {
    cancelled = true;
    pendingLine?.(null);
    pendingLine = null;
    resolveAbort(null);
    try { restoreTerminal(); } catch { /* Final failure remains generic. */ }
  };
  // Intentional input shutdown can produce native terminal read errors after confirmation.
  const abortInput = () => { if (!inputCompleted) abort(); };
  const write = (stream, text) => new Promise((resolve, reject) => {
    try { stream.write(text, (err) => err ? reject(failure()) : resolve()); }
    catch { reject(failure()); }
  });
  const readLine = () => {
    if (cancelled) return Promise.resolve(null);
    if (lines.length) return Promise.resolve(lines.shift());
    return new Promise((resolve) => { pendingLine = resolve; });
  };

  try {
    if (args.length || !input.isTTY || !output.isTTY || !error.isTTY ||
        typeof input.setRawMode !== "function" || typeof releaseInput !== "function") {
      throw failure();
    }
    rawBefore = input.isRaw === true;
    terminalStarted = true;
    muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    rl = readline.createInterface({ input, output: muted, terminal: true, historySize: 0, prompt: "", crlfDelay: Infinity });
    if (input.isRaw !== true) throw failure();
    listen(rl, "line", (line) => {
      if (cancelled || inputCompleted) return;
      // Stop the native read synchronously, before confirmation resumes in a microtask.
      receivedLines += 1;
      if (receivedLines === 2) {
        try { input.pause(); } catch { abort(); return; }
      }
      if (pendingLine) {
        const resolve = pendingLine;
        pendingLine = null;
        resolve(line);
      } else if (lines.length < 2) lines.push(line);
      else abort();
    });
    listen(rl, "error", abortInput);
    listen(rl, "SIGINT", abort);
    listen(rl, "close", abortInput);
    listen(input, "end", abortInput);
    listen(input, "error", abortInput);
    listen(output, "error", abort);
    listen(error, "error", () => { stderrFailed = true; abort(); });
    listen(muted, "error", abort);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) listen(signals, signal, abort);

    const collect = async () => {
      let password;
      let confirmation;
      try {
        await write(error, "Password (hidden): ");
        password = await readLine();
        if (cancelled || password === null) throw failure();
        await write(error, "\nConfirm password (hidden): ");
        confirmation = await readLine();
        if (cancelled || confirmation === null) throw failure();
        // Validate before ending input; core validation remains shared with direct callers.
        confirmedPasswordBytes(password, confirmation).fill(0);
        inputCompleted = true;
        restoreTerminal();
        await write(error, "\n");
        if (cancelled) throw failure();
        return await generateV3AdminPasswordHash(password, confirmation);
      } finally {
        password = undefined;
        confirmation = undefined;
      }
    };
    const encodedHash = await Promise.race([collect(), aborted]);
    if (cancelled || !encodedHash) throw failure();
    // Input is already restored; signal/output cancellation remains active through the write.
    restoreTerminal();
    await Promise.race([write(output, `V3_ADMIN_PASSWORD_HASH=${encodedHash}\n`), aborted]);
    if (cancelled) throw failure();
    return 0;
  } catch {
    const wasCancelled = cancelled;
    try { restoreTerminal(); } catch { /* Do not expose terminal/crypto errors. */ }
    // Cancellation must not wait on a diagnostic write blocked by an interrupted console read.
    if (!stderrFailed && !wasCancelled) {
      try { await write(error, "\nPassword provisioning failed or cancelled. Use an interactive terminal and matching valid input.\n"); }
      catch { /* A failed error stream must not expose internal error details. */ }
    }
    return 1;
  } finally {
    for (const [emitter, event, handler] of listeners) emitter.removeListener(event, handler);
    try { restoreTerminal(); } catch { /* Best-effort restoration on every exit. */ }
    muted?.destroy();
    lines.length = 0;
    pendingLine = null;
  }
}

module.exports = { generateV3AdminPasswordHash, runProvisioning };

if (require.main === module) {
  const finish = (code) => {
    // Standalone CLI only: runProvisioning has awaited writes and completed terminal cleanup.
    process.exit(code);
  };
  runProvisioning({ releaseInput: () => process.stdin.destroy() }).then(finish, () => finish(1));
}
