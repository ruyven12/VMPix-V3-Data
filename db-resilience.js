'use strict';

const clients = new WeakMap();
const pools = new WeakSet();
const connectionError = error => Object.assign(new Error('Database connection unavailable'), {
  code: 'DATABASE_CONNECTION_LOST',
  databaseCode: /^(?:[0-9A-Z]{5}|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)$/.test(error?.code || '') ? error.code : null
});
function isConnectionError(error) {
  return /^(08[A-Z0-9]{3}|57P0[123]|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|DATABASE_CONNECTION_LOST)$/.test(error?.code || '')
    || /^(Connection terminated|Client has encountered a connection error|Client was closed)/i.test(error?.message || '');
}

// One listener per physical client survives checkout/release and late socket events.
// Never release from this listener: the transaction owner (or pg's pool.query)
// must unwind first. Pending queries reject even if a disconnect arrives between
// protocol completion and the promise/callback reaching its owner.
function guardClient(client, report = () => {}) {
  if (clients.has(client) || typeof client.on !== 'function') return client;
  const state = { error: null, pending: new Set() };
  clients.set(client, state);
  const fail = error => {
    if (!state.error) state.error = connectionError(error);
    for (const finish of [...state.pending]) finish(state.error);
  };
  client.on('error', error => { const first = !state.error; fail(error); if (first) report('client_disconnect'); });
  client.on('end', fail);
  const query = client.query.bind(client);
  client.query = (...args) => {
    // Leave pg's advanced Submittable/stream return contract to the driver.
    if (typeof args[0]?.submit === 'function') return query(...args);
    const last = args.length - 1;
    const callback = typeof args[last] === 'function' ? args.pop()
      : typeof args[0]?.callback === 'function' ? args[0].callback : null;
    // pg normalizes query config in place; do not leave our completion callback
    // on a caller-owned config that may be reused for a later query.
    if (args[0] && typeof args[0] === 'object') args[0] = { ...args[0] };
    // All application queries use the documented promise or callback interface.
    const run = done => {
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true; state.pending.delete(finish);
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (isConnectionError(error) || error && /^\s*ROLLBACK\s*;?\s*$/i.test(sql || '')) fail(error);
        done(state.error || error, result);
      };
      if (state.error) { queueMicrotask(() => finish(state.error)); return; }
      state.pending.add(finish);
      try { query(...args, finish); } catch (error) { finish(error); }
    };
    if (callback) { run(callback); return; }
    return new Promise((resolve, reject) => run((error, result) => error ? reject(error) : resolve(result)));
  };
  return client;
}

function clientFailure(client) { return clients.get(client)?.error || null; }

function installPoolSafety(pool, report = event => console.warn(`[database] ${event}`)) {
  if (pools.has(pool)) return pool;
  pools.add(pool);
  // pg already removes a failed idle client before emitting this pool event.
  pool.on('error', () => report('idle_disconnect'));
  pool.on('connect', client => guardClient(client, report));
  const connect = pool.connect.bind(pool);
  pool.connect = callback => {
    const acquire = done => connect((error, client) => {
      if (error) { done(error); return; }
      guardClient(client, report);
      const release = client.release.bind(client);
      client.release = error => release(error || clientFailure(client));
      const failed = clientFailure(client);
      if (failed) { client.release(failed); done(failed); return; }
      done(null, client, client.release);
    });
    if (typeof callback === 'function') return acquire(callback);
    return new Promise((resolve, reject) => acquire((error, client) => error ? reject(error) : resolve(client)));
  };
  return pool;
}

// Only callers that own a read-only operation opt in. Never replay a write or
// individual transaction statement, especially a COMMIT with an unknown outcome.
async function retryDatabaseRead(read) {
  try { return await read(); }
  catch (error) {
    if (!isConnectionError(error)) throw error;
    return read();
  }
}

module.exports = { installPoolSafety, guardClient, clientFailure, isConnectionError, retryDatabaseRead };
