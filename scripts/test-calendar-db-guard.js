'use strict';

// Configuration/identity guard tests only. No connections or credentials are read.
const assert = require('node:assert/strict');
const { testConfig, validateIdentity } = require('./calendar-test-db');
const url = 'postgresql://cal06a_owner_a1b2c3d4:synthetic-test-password-only@127.0.0.1:55432/vmpix_calendar_test_a1b2c3d4';
const env = { CALENDAR_TEST_MODE: 'local-cal06a', NODE_ENV: 'test', TEST_DATABASE_URL: url,
  DATABASE_URL: 'postgresql://private:private@production.invalid/production', PGHOST: 'production.invalid', PGOPTIONS: '-c search_path=private' };
const config = testConfig(env);
assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 55432); assert.equal(config.max, 4);
assert.equal(config.options, '-c timezone=UTC -c search_path=public'); assert.equal(config.ssl, false);
const rejected = [
  {}, { DATABASE_URL: url }, { ...env, TEST_DATABASE_URL: undefined }, { ...env, CALENDAR_TEST_MODE: undefined },
  { ...env, NODE_ENV: 'production' }, ...[
    url.replace('127.0.0.1', 'production.invalid'), url.replace('127.0.0.1', 'localhost'),
    url.replace(':55432', ':5432'), url.replace('vmpix_calendar_test_a1b2c3d4', 'postgres'),
    url.replace('cal06a_owner_a1b2c3d4', 'postgres'), url + '?sslmode=disable', url + '#fragment',
    url.replace('postgresql:', 'https:'), 'not a connection URL', url.replace('synthetic-test-password-only', ''),
  ].map(TEST_DATABASE_URL => ({ ...env, TEST_DATABASE_URL })),
];
for (const item of rejected) assert.throws(() => testConfig(item), { message: 'CALENDAR_TEST_CONFIGURATION_REJECTED' });
for (const max of [0, 9, NaN, 1.5]) assert.throws(() => testConfig(env, max), { message: 'CALENDAR_TEST_CONFIGURATION_REJECTED' });
const identity = { database: config.database, username: config.user, host: config.host, port: config.port,
  instance: config.database, listen_addresses: '127.0.0.1', version_num: 170011, is_owner: true, can_login: true,
  superuser: false, create_database: false, create_role: false, replication: false, bypass_rls: false };
validateIdentity(identity, config);
const mismatches = [null, ...[
  { database: 'production' }, { username: 'postgres' }, { host: '10.0.0.1' }, { port: 5432 },
  { instance: null }, { listen_addresses: '*' }, { version_num: 160000 }, { version_num: 180000 },
  { version_num: NaN }, { is_owner: false }, { can_login: false },
  { superuser: true }, { create_database: true }, { create_role: true }, { replication: true }, { bypass_rls: true },
].map(change => ({ ...identity, ...change }))];
for (const item of mismatches) assert.throws(() => validateIdentity(item, config), { message: 'CALENDAR_TEST_IDENTITY_REJECTED' });
console.log(JSON.stringify({ passed: 2 + rejected.length + 4 + mismatches.length, failed: 0,
  scope: 'isolated configuration and server-identity guards; no network connections' }));
