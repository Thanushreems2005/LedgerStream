const { Pool } = require("pg");

// Support DATABASE_URL connection string directly (used by Railway),
// otherwise fall back to local connection parameters.
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        database: "ledgerstream",
        user: "ledger",
        password: "ledger",
        host: process.env.PGHOST || "localhost",
        port: Number(process.env.PGPORT || 5433),
        max: 10,
      }
);

module.exports = { pool };