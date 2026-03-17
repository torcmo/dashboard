// Postgres connection pool for the mcc database
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'mcc',
  user: process.env.PG_USER || 'torbot',
  password: process.env.PG_PASSWORD || 'torbot2026'
});

module.exports = { pool };
