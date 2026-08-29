const express = require("express");
const cors = require("cors");
const { pool } = require("./db");
const { startAlertsReader, groupLag, getAlerts, getLevelCounts } = require("./kafka");

const app = express();
app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));
app.use(express.json());

const MAX_LIMIT = 200;

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/balances", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT account_id, balance FROM accounts ORDER BY account_id"
    );
    res.json({ ok: true, accounts: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/transactions", async (req, res) => {
  const limit = Math.min(
    Number(req.query.limit) || 50,
    MAX_LIMIT
  );
  try {
    const { rows } = await pool.query(
      `SELECT event_id, from_account, to_account, amount, status, error_reason,
              created_at AT TIME ZONE 'UTC' AS created_at
       FROM transactions_log
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, transactions: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/alerts", (_req, res) => {
  try {
    res.json({ ok: true, alerts: getAlerts() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Risk-overview stats for the dashboard. `analyzed` is a live count of
// applied transactions; high/medium tally every decision ever published to
// the fraud-alerts topic (the API consumer replays it from the start).
// Precision/recall are the held-out test-set numbers from the retrained
// 3-feature model at thr=0.96 - NOT live production stats.
app.get("/api/stats", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS analyzed FROM transactions_log WHERE status = 'applied'"
    );
    const levels = getLevelCounts();
    res.json({
      ok: true,
      analyzed: Number(rows[0].analyzed),
      high: levels.HIGH,
      medium: levels.MEDIUM,
      threshold: 0.96,
      measuredPrecision: 0.206,
      measuredRecall: 0.153,
      measuredAt: "held-out test set (Kaggle creditcard.csv, 3-feature retrained model)",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/lag", async (_req, res) => {
  try {
    const [ledger, fraud] = await Promise.all([
      groupLag("ledger-consumer-group"),
      groupLag("fraud-consumer-group"),
    ]);
    res.json({ ok: true, lag: { ledger, fraud } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

async function main() {
  await startAlertsReader();
  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`[api] LedgerStream API listening on http://localhost:${port}`);
  });
}

main().catch((e) => {
  console.error("[api] fatal startup error:", e);
  process.exit(1);
});