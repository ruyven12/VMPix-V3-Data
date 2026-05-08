'use strict';

const { Pool } = require('pg');

const connectionString = String(process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false
});

module.exports = pool;
