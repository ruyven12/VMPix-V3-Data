'use strict';

// CAL-06A: explicit disposable local database only. Never import db.js/server.js,
// load .env, or fall back to DATABASE_URL. This module performs no migrations.
const { Pool } = require('pg');

function testConfig(env = process.env, max = 4) {
  try {
    if (env.CALENDAR_TEST_MODE !== 'local-cal06a' || env.NODE_ENV === 'production' ||
        typeof env.TEST_DATABASE_URL !== 'string' || !env.TEST_DATABASE_URL ||
        !Number.isInteger(max) || max < 1 || max > 8) throw Error();
    const url = new URL(env.TEST_DATABASE_URL);
    const match = /^\/vmpix_calendar_test_([a-f0-9]{8})$/.exec(url.pathname);
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '55432' ||
        url.search || url.hash || !match || user !== `cal06a_owner_${match[1]}` || password.length < 20) throw Error();
    return { host: '127.0.0.1', port: 55432, database: url.pathname.slice(1), user, password,
      ssl: false, max, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
      query_timeout: 3000, application_name: 'vmpix-calendar-isolated-test', options: '-c timezone=UTC -c search_path=public' };
  } catch { throw Error('CALENDAR_TEST_CONFIGURATION_REJECTED'); }
}

function validateIdentity(row, config) {
  if (!row || row.database !== config.database || row.username !== config.user ||
      row.host !== config.host || row.port !== config.port || row.instance !== config.database ||
      row.listen_addresses !== '127.0.0.1' || row.version_num < 170000 || row.version_num >= 180000 ||
      !Number.isInteger(row.version_num) || row.is_owner !== true || row.can_login !== true ||
      ['superuser', 'create_database', 'create_role', 'replication', 'bypass_rls'].some(key => row[key] !== false)) {
    throw Error('CALENDAR_TEST_IDENTITY_REJECTED');
  }
}

async function openTestDatabase({ env = process.env, max = 4 } = {}) {
  const config = testConfig(env, max); // Reject non-test targets before constructing a pool.
  const pool = new Pool(config);
  pool.on('error', () => { console.error('CALENDAR_TEST_IDLE_CONNECTION_ERROR'); });
  try {
    const client = await pool.connect();
    let identity;
    try {
      identity = (await client.query(`SELECT current_database() AS database, current_user AS username,
        host(inet_server_addr()) AS host, inet_server_port() AS port,
        current_setting('vmpix.calendar_test_instance', true) AS instance,
        current_setting('listen_addresses') AS listen_addresses,
        current_setting('server_version_num')::integer AS version_num,
        current_setting('server_version') AS version,
        d.datdba = r.oid AS is_owner, r.rolcanlogin AS can_login, r.rolsuper AS superuser,
        r.rolcreatedb AS create_database, r.rolcreaterole AS create_role,
        r.rolreplication AS replication, r.rolbypassrls AS bypass_rls
        FROM pg_roles r JOIN pg_database d ON d.datname = current_database() WHERE r.rolname = current_user`)).rows[0];
      validateIdentity(identity, config);
    } finally { client.release(); }
    return { pool, identity };
  } catch {
    await pool.end();
    throw Error('CALENDAR_TEST_CONNECTION_OR_IDENTITY_FAILED');
  }
}

async function checkConnectivity() {
  const { pool, identity } = await openTestDatabase();
  try {
    const first = await pool.connect();
    let firstPid;
    try {
      const result = (await first.query('SELECT $1::integer + $2::integer AS value, pg_backend_pid() AS pid', [17, 25])).rows[0];
      if (result.value !== 42) throw Error('CALENDAR_TEST_PARAMETER_CHECK_FAILED');
      firstPid = result.pid;
    } finally { first.release(); }
    const second = await pool.connect();
    let reused;
    try { reused = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid === firstPid; }
    finally { second.release(); }
    const tables = (await pool.query("SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'")).rows[0].count;
    console.log(JSON.stringify({ status: 'ISOLATED_POSTGRES_READY', ...identity, parameterizedRead: true,
      connectionReused: reused, applicationTableCount: tables, idleClients: pool.idleCount, waitingClients: pool.waitingCount }));
  } finally { await pool.end(); }
}

module.exports = { testConfig, validateIdentity, openTestDatabase };
if (require.main === module) checkConnectivity().catch(() => {
  console.error('CALENDAR_TEST_CHECK_FAILED: explicit isolated test configuration and a running local instance are required.');
  process.exitCode = 1;
});
