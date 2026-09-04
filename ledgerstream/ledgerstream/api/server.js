const fs = require("fs");
const path = require("path");

// --- Load Environment Variables (Step 3) ---
function loadEnv() {
  const envPath = path.resolve(__dirname, "../../.env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    content.split("\n").forEach((line) => {
      line = line.trim();
      if (line && !line.startsWith("#") && line.includes("=")) {
        const [k, ...vParts] = line.split("=");
        const kClean = k.trim();
        const vClean = vParts.join("=").trim().replace(/^['"]|['"]$/g, "");
        process.env[kClean] = vClean;
      }
    });
  }
}
loadEnv();

const express = require("express");
const cors = require("cors");
const { pool } = require("./db");
const { startAlertsReader, groupLag, getAlerts, getLevelCounts } = require("./kafka");

const app = express();
const allowedOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";
app.use(
  cors({
    origin: [allowedOrigin, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
  })
);
app.use(express.json());

// Serve static assets from Express public folder
app.use(express.static(path.join(__dirname, "public")));

const MAX_LIMIT = 200;

// --- Centralized risk policy (single source of truth for the backend) ------
const RISK_LOW_THRESHOLD = Number(process.env.RISK_LOW_THRESHOLD || 0.01);
const RISK_HIGH_THRESHOLD = Number(process.env.RISK_HIGH_THRESHOLD || 0.10);
if (!(RISK_LOW_THRESHOLD >= 0 && RISK_LOW_THRESHOLD < RISK_HIGH_THRESHOLD && RISK_HIGH_THRESHOLD <= 1)) {
  throw new Error(`Invalid risk threshold configuration: ${RISK_LOW_THRESHOLD}, ${RISK_HIGH_THRESHOLD}`);
}

// Demo generation configuration (optional overrides)
const DEMO_COUNT = Number(process.env.DEMO_TRANSACTION_COUNT || 20);
const DEMO_MIN_AMOUNT = Number(process.env.DEMO_MIN_AMOUNT || 10);
const DEMO_MAX_AMOUNT = Number(process.env.DEMO_MAX_AMOUNT || 50000);

// --- Structured Logging Helper (Step 2) ---
function logStructuredEvent(eventType, eventId, amount, sender, receiver, score = null, riskLevel = "", decision = "", status = "", reason = "") {
  const logObj = {
    event_type: eventType,
    event_id: eventId,
    amount: amount ? Number(amount) : null,
    sender: sender || "",
    receiver: receiver || "",
    risk_score: score !== null ? Number(score) : null,
    risk_level: riskLevel,
    decision: decision,
    status: status,
    error_reason: reason,
    timestamp: new Date().toISOString()
  };
  console.log(`[JSON_EVENT] ${JSON.stringify(logObj)}`);
}

// --- Parameter Validation helper (Step 4) ---
function validateEventId(eventId) {
  const regex = /^[a-zA-Z0-9_\-]+$/;
  return regex.test(eventId);
}

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
              risk_score, risk_level, reasons,
              CASE
                WHEN amount < $2 THEN '${AMOUNT_BANDS[0].label}'
                WHEN amount <= $3 THEN '${AMOUNT_BANDS[1].label}'
                WHEN amount <= $4 THEN '${AMOUNT_BANDS[2].label}'
                ELSE '${AMOUNT_BANDS[3].label}'
              END AS amount_band,
              created_at AT TIME ZONE 'UTC' AS created_at
       FROM transactions_log
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit, AMOUNT_BANDS[0].max, AMOUNT_BANDS[1].max, AMOUNT_BANDS[2].max]
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

// Amount-band display breakpoints (cosmetic, NOT used in risk decisions).
// These are configurable so the UI can adapt to a different dataset's amounts
// without code changes. They never feed the risk policy.
const AMOUNT_BANDS = [
  { label: "VERY LOW", max: Number(process.env.BAND_VERY_LOW_MAX || 100) },
  { label: "NORMAL",   max: Number(process.env.BAND_NORMAL_MAX   || 1000) },
  { label: "ELEVATED", max: Number(process.env.BAND_ELEVATED_MAX || 10000) },
  { label: "HIGH",     max: Infinity },
];

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    riskPolicy: {
      lowThreshold: RISK_LOW_THRESHOLD,
      highThreshold: RISK_HIGH_THRESHOLD,
      lowLabel: "LOW",
      lowAction: "APPROVE",
      mediumLabel: "MEDIUM",
      mediumAction: "VERIFY",
      highLabel: "HIGH",
      highAction: "HOLD",
    },
    amountBands: AMOUNT_BANDS,
  });
});

app.get("/api/stats", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS count FROM transactions_log"
    );
    const countsRes = await pool.query(
      "SELECT status, COUNT(*) AS count FROM transactions_log GROUP BY status"
    );
    const counts = { applied: 0, held: 0, blocked: 0, declined: 0 };
    countsRes.rows.forEach(r => {
      if (r.status in counts) {
        counts[r.status] = Number(r.count);
      }
    });

    // Backend-derived aggregate from PostgreSQL (single source of truth).
    // The frontend uses these to display blocked count and blocked value so
    // the figures are never limited by the transactions-list page size.
    const blockedValueRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS value, COUNT(*) AS count FROM transactions_log WHERE status = 'blocked'"
    );
    const blockedValue = Number(blockedValueRes.rows[0].value);
    const blockedDbCount = Number(blockedValueRes.rows[0].count);

    const levels = getLevelCounts();
    res.json({
      ok: true,
      analyzed: Number(rows[0].count),
      high: levels.HIGH,
      medium: levels.MEDIUM,
      appliedCount: counts.applied,
      heldCount: counts.held,
      blockedCount: counts.blocked,
      blockedValue,
      blockedDbCount,
      declinedCount: counts.declined,
      threshold: RISK_HIGH_THRESHOLD,
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

app.post("/api/transactions/:event_id/approve", async (req, res) => {
  const { event_id } = req.params;
  
  if (!validateEventId(event_id)) {
    logStructuredEvent("TRANSACTION_ERROR", event_id, null, "", "", null, "", "", "", "Malformed event ID");
    return res.status(400).json({ ok: false, error: "Malformed event ID" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Select and lock transaction row
    const txRes = await client.query(
      "SELECT from_account, to_account, amount, status FROM transactions_log WHERE event_id = $1 FOR UPDATE",
      [event_id]
    );
    if (txRes.rows.length === 0) {
      throw new Error("Transaction not found");
    }
    
    const tx = txRes.rows[0];
    
    // Enforce explicit state transitions (Step 5)
    if (tx.status === "applied") {
      throw new Error("Transaction already approved");
    }
    if (tx.status === "declined") {
      throw new Error("Cannot approve declined transaction");
    }
    if (tx.status === "blocked") {
      throw new Error("Cannot approve blocked transaction");
    }
    if (tx.status !== "held") {
      throw new Error(`Invalid state transition from ${tx.status}`);
    }

    const { from_account, to_account, amount } = tx;

    // Lock the sender's row
    const senderRes = await client.query(
      "SELECT balance FROM accounts WHERE account_id = $1 FOR UPDATE",
      [from_account]
    );
    if (senderRes.rows.length === 0) {
      throw new Error(`Sender account ${from_account} not found`);
    }
    const balance = Number(senderRes.rows[0].balance);
    if (balance < Number(amount)) {
      throw new Error("Insufficient balance");
    }

    // Apply debit/credit
    await client.query(
      "UPDATE accounts SET balance = balance - $1 WHERE account_id = $2",
      [amount, from_account]
    );
    await client.query(
      "UPDATE accounts SET balance = balance + $1 WHERE account_id = $2",
      [amount, to_account]
    );

    // Update statuses to 'applied'
    await client.query(
      "UPDATE transactions_log SET status = 'applied' WHERE event_id = $1",
      [event_id]
    );
    await client.query(
      "UPDATE processed_events SET status = 'applied' WHERE event_id = $1",
      [event_id]
    );

    await client.query("COMMIT");
    
    logStructuredEvent("TRANSACTION_APPROVED", event_id, amount, from_account, to_account, null, "MEDIUM", "VERIFY", "applied");
    res.json({ ok: true, status: "applied" });
  } catch (e) {
    await client.query("ROLLBACK");
    logStructuredEvent("TRANSACTION_ERROR", event_id, null, "", "", null, "", "", "", e.message || String(e));
    res.status(400).json({ ok: false, error: e.message || String(e) });
  } finally {
    client.release();
  }
});

app.post("/api/transactions/:event_id/decline", async (req, res) => {
  const { event_id } = req.params;
  
  if (!validateEventId(event_id)) {
    logStructuredEvent("TRANSACTION_ERROR", event_id, null, "", "", null, "", "", "", "Malformed event ID");
    return res.status(400).json({ ok: false, error: "Malformed event ID" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Select and lock transaction row
    const txRes = await client.query(
      "SELECT from_account, to_account, amount, status FROM transactions_log WHERE event_id = $1 FOR UPDATE",
      [event_id]
    );
    if (txRes.rows.length === 0) {
      throw new Error("Transaction not found");
    }
    
    const tx = txRes.rows[0];
    
    // Enforce explicit state transitions (Step 5)
    if (tx.status === "applied") {
      throw new Error("Cannot decline approved transaction");
    }
    if (tx.status === "declined") {
      throw new Error("Transaction already declined");
    }
    if (tx.status === "blocked") {
      throw new Error("Cannot decline blocked transaction");
    }
    if (tx.status !== "held") {
      throw new Error(`Invalid state transition from ${tx.status}`);
    }

    const { from_account, to_account, amount } = tx;

    // Update statuses to 'declined'
    await client.query(
      "UPDATE transactions_log SET status = 'declined' WHERE event_id = $1",
      [event_id]
    );
    await client.query(
      "UPDATE processed_events SET status = 'declined' WHERE event_id = $1",
      [event_id]
    );

    await client.query("COMMIT");
    
    logStructuredEvent("TRANSACTION_DECLINED", event_id, amount, from_account, to_account, null, "MEDIUM", "VERIFY", "declined");
    res.json({ ok: true, status: "declined" });
  } catch (e) {
    await client.query("ROLLBACK");
    logStructuredEvent("TRANSACTION_ERROR", event_id, null, "", "", null, "", "", "", e.message || String(e));
    res.status(400).json({ ok: false, error: e.message || String(e) });
  } finally {
    client.release();
  }
});

const crypto = require("crypto");
const { kafka } = require("./kafka");

app.post("/api/admin/seed-demo", async (req, res) => {
  let producer;
  try {
    console.log("[api] Initializing generic demo data seeding...");
    producer = kafka.producer();
    await producer.connect();

    // Fetch accounts with their CURRENT available balances so every generated
    // amount is financially plausible and never exceeds the sender's balance.
    const { rows } = await pool.query(
      "SELECT account_id, balance FROM accounts ORDER BY account_id"
    );
    const accounts = rows.map((r) => ({ id: r.account_id, balance: Number(r.balance) }));
    if (accounts.length < 2) {
      throw new Error("At least 2 accounts are required to seed demo transactions");
    }

    // Generate a count so the demo never depends on a fixed dataset size.
    const count = req.body && Number.isFinite(Number(req.body.count))
      ? Math.min(Math.max(Number(req.body.count), 1), 200)
      : DEMO_COUNT;

    const events = [];
    const now = Date.now();
    // Guard against attempts when no sender can fund a (min) valid amount.
    const minAmount = Math.max(Number(DEMO_MIN_AMOUNT) || 0, 0.01);
    const maxAttempts = Math.max(count * 20, 100);
    for (let attempt = 0; attempt < maxAttempts && events.length < count; attempt++) {
      // Only senders whose available balance can at least cover DEMO_MIN_AMOUNT
      const eligible = accounts.filter((a) => a.balance >= minAmount);
      if (eligible.length === 0) {
        console.warn(
          "[api] No sender account has enough balance to satisfy DEMO_MIN_AMOUNT; skipping remaining events"
        );
        break;
      }
      const sender = eligible[Math.floor(Math.random() * eligible.length)];

      // Amount must never exceed the sender's available balance; cap at max.
      const upperBound = Math.min(Number(DEMO_MAX_AMOUNT) || minAmount, sender.balance);
      if (upperBound < minAmount) {
        continue; // no valid amount for this sender; try another
      }
      const amount = Math.round(
        (minAmount + Math.random() * (upperBound - minAmount)) * 100
      ) / 100;

      // Random receiver distinct from the sender (any real account)
      let toAcc = accounts[Math.floor(Math.random() * accounts.length)].id;
      while (toAcc === sender.id) {
        toAcc = accounts[Math.floor(Math.random() * accounts.length)].id;
      }
      // Realistic timestamp: random offset over the past 24 hours
      const ts = new Date(now - Math.floor(Math.random() * 24 * 60 * 60 * 1000));
      const event = {
        event_id: `demo-${crypto.randomUUID()}`,
        from_account: sender.id,
        to_account: toAcc,
        amount: Number(amount.toFixed(2)),
        timestamp: ts.toISOString().replace(/Z$/, "+00:00"),
      };
      events.push(event);
    }

    console.log(`[api] Publishing ${events.length} generic demo events to Kafka...`);
    const records = events.map(event => ({
      key: event.from_account,
      value: JSON.stringify(event)
    }));

    await producer.send({
      topic: process.env.KAFKA_TRANSACTIONS_TOPIC || "transactions",
      messages: records
    });

    console.log("[api] Seeding completed successfully!");
    res.json({ ok: true, count: events.length });
  } catch (e) {
    console.error("[api] Seeding error:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally {
    if (producer) {
      try {
        await producer.disconnect();
      } catch (e) {
        console.error("[api] Error disconnecting seed producer:", e);
      }
    }
  }
});

const { spawn } = require("child_process");
const activeWorkers = [];

function startPythonWorker(scriptPath, name) {
  console.log(`[manager] Spawning background worker: ${name} (${scriptPath})`);
  const proc = spawn("python", [scriptPath], {
    env: { ...process.env, PYTHONPATH: path.join(__dirname, "..") },
    stdio: "inherit"
  });
  activeWorkers.push(proc);
  proc.on("close", (code) => {
    console.error(`[manager] Worker ${name} exited with code ${code}`);
    const index = activeWorkers.indexOf(proc);
    if (index > -1) activeWorkers.splice(index, 1);
  });
}

function shutdown() {
  console.log("[manager] Shutdown signal received. Terminating workers...");
  for (const worker of activeWorkers) {
    try {
      worker.kill("SIGTERM");
    } catch (e) {
      console.error(`Error terminating worker: ${e.message}`);
    }
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);


// wildcard route to serve index.html for React SPA
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function main() {
  await startAlertsReader();

  if (process.env.NODE_ENV === "production" || process.env.START_WORKERS === "true") {
    startPythonWorker(path.join(__dirname, "../consumer/ledger_consumer.py"), "ledger_consumer");
    startPythonWorker(path.join(__dirname, "../fraud/fraud_consumer.py"), "fraud_consumer");
  }

  const port = Number(process.env.API_PORT || process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`[api] LedgerStream API listening on http://localhost:${port}`);
  });
}

main().catch((e) => {
  console.error("[api] fatal startup error:", e);
  process.exit(1);
});