# Production Readiness Document

This document details the configuration, security, failure models, testing scope, and deployment semantics of the LedgerStream AI Payment Risk Manager.

---

## 1. System Architecture
LedgerStream is a pre-settlement payment risk gateway:
* **Ingestion (Kafka)**: Ingests event stream on `transactions` topic.
* **Inline Scoring (Python)**: `ledger_consumer.py` intercepts transactions, scores them using XGBoost, and decides on risk policy prior to database writes.
* **Ledger Database (PostgreSQL)**: Stores balances, idempotency locks, and transaction logs.
* **Observability (Kafka)**: Publishes medium and high alerts to `fraud-alerts`.
* **Remediation API (Express)**: Manages analyst decisions (Approve/Decline) with pessimistic concurrency database locks.
* **Operations UI (React)**: An interactive visual dashboard displaying metrics, alerts, hold reviews, and blocked logs.

---

## 2. Transaction & Risk Lifecycles
* **LOW Risk** (`score < 0.50`): Transaction resolved to `applied` and settles balances immediately inside Postgres.
* **MEDIUM Risk** (`0.50 <= score < 0.96`): Transaction resolved to `held`. Balances are untouched. Analyst manual review required to transition to `applied` or `declined`.
* **HIGH Risk** (`score >= 0.96`): Transaction resolved to `blocked`. Balances are untouched. Prevention is instant and final.

---

## 3. Valid State Transitions
The system enforces the following transaction state matrix:
```
applied  -> applied       [REJECT]
applied  -> declined      [REJECT]
declined -> applied       [REJECT]
declined -> declined      [REJECT]
blocked  -> applied       [REJECT]
blocked  -> declined      [REJECT]
held     -> applied       [ALLOW] (Approve Action)
held     -> declined      [ALLOW] (Decline Action)
```

---

## 4. API Endpoints
* `GET /api/balances`: Fetches live Postgres balances.
* `GET /api/transactions`: Fetches logs from `transactions_log`.
* `GET /api/alerts`: Fetches recent alerts from `fraud-alerts`.
* `GET /api/stats`: Fetches total aggregates from `transactions_log`.
* `POST /api/transactions/:id/approve`: Settles a HELD transaction after balance checks.
* `POST /api/transactions/:id/decline`: Declines a HELD transaction.

---

## 5. Failure Semantics & Idempotency
* **Exactly-Once Writing**: The Postgres write, balance updates, and `processed_events` uniqueness log occur inside a single SQL transaction.
* **Commit Sequence**:
  `PostgreSQL Transaction Commit` -> `Kafka Offset Commit`
* **Idempotency Guard**: `processed_events` unique constraint rejects duplicate Kafka delivery, preventing double-debits or double-credits.
* **Rollbacks**: Database exceptions (e.g. balance check failures) trigger explicit transaction rollbacks and route events to the DLQ (`transactions-dlq`).

---

## 6. Performance Profile
* Processing latency is **10.76ms** (0.76ms model inference, 8ms Postgres lock commit, 2ms Kafka commit).
* Maximum sequential throughput is ~93 EPS. Arrival rates exceeding this capacity build up Kafka consumer lag.

---

## 7. Security Considerations
* **SQL Injection**: Parameterized SQL queries protect database statements from injection risks.
* **CORS**: Allowed origin is strictly matched to local hosts (`localhost` and `127.0.0.1`).
* **Input Checks**: Parameter routes validate parameters against alphanumeric patterns.
* **Secrets**: Kept in `.env` configurations (e.g. `PG_DSN`, `API_PORT`).

---

## 8. Test Scope & Verification
* Automated test suite comprises **25 tests** validating ledger states, duplicate events, DLQ routing, model shapes, boundary sweeps, state invalidations, rollbacks, and concurrent approve/decline locks.
* Balance conservation is verified at exactly **$347,000.00**.
