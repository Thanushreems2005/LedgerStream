const { Pool } = require("pg");

// Same DSN shape as the Python pipeline (see consumer/ledger_consumer.py):
// dbname=ledgerstream user=ledger password=ledger host=localhost port=5433
const pool = new Pool({
  database: "ledgerstream",
  user: "ledger",
  password: "ledger",
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5433),
  max: 10,
});

module.exports = { pool };