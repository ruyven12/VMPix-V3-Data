'use strict';

const { Pool } = require('pg');
const { installPoolSafety } = require('./db-resilience');

const connectionString = String(process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString,
  // Bound checkout/connection establishment; pg's default is unlimited.
  connectionTimeoutMillis: 10000,
  ssl: connectionString ? { rejectUnauthorized: false } : false
});

module.exports = installPoolSafety(pool);
