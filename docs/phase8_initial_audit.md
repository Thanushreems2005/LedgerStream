# Phase 8 - Railway Production Deployment Audit

**Date**: 2026-08-30  
**Repository State**: Hardened Phase 7 console with React/Vite dashboard, Express API, Python inline risk consumer, fraud consumer, and XGBoost ML model.

---

## 1. Repository Components & Files

The LedgerStream RM codebase is structured as follows:
- **Frontend** (`ledgerstream/ledgerstream/frontend/`): React/Vite SPA. Uses a proxy for `/api` during development, calls `api.js` for fetches.
- **Express API** (`ledgerstream/ledgerstream/api/`): Handles client requests, queries Postgres pool, connects to Kafka for lag, and spawns the alerts mirror reader.
- **Ledger Consumer** (`ledgerstream/ledgerstream/consumer/ledger_consumer.py`): Core pre-settlement blocker. Sequentially polls Kafka `transactions`, scores with XGBoost, and commits to PostgreSQL.
- **Fraud Consumer** (`ledgerstream/ledgerstream/fraud/fraud_consumer.py`): Mirror consumer logging alerts to fraud alert files.
- **ML Model** (`ledgerstream/ledgerstream/fraud/fraud_model.pkl`): XGBoost classifier trained on CreditCard fraud dataset using features: `[amount, hour, velocity]`.
- **Database Schema** (`ledgerstream/ledgerstream/init-db/schema.sql`): Seeds `accounts` and initializes `processed_events` and `transactions_log`.

---

## 2. Localhost Assumptions & Hardcoding

The following configurations require adjustments for a multi-service cloud environment:
1. **Frontend API URL**: `const API_BASE = "/api"` in `api.js`. Requires configurable production domain fallback via environment variable `VITE_API_URL` when deployed separately.
2. **Vite Proxy**: Configured in `vite.config.js` to proxy `/api` locally to `http://localhost:3001`. On production, the frontend and API can run as distinct services.
3. **Database DSN**: Hardcoded port `5433` and host `localhost` in Node API (`db.js`) and Python consumer (`ledger_consumer.py`). Needs standard `DATABASE_URL` (Node) or `PG_DSN` (Python) injection.
4. **Kafka Bootstrap Servers**: Defaults to `localhost:9092`. Needs dynamic configuration for cloud-deployed Kafka (internal or external).
5. **Express CORS**: Currently restricted to localhost regex: `/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/`. Needs to support the dynamically generated Railway frontend domain.
6. **Express Listen**: Listens on `API_PORT` (falls back to `3001`). Railway injects a dynamic `PORT` variable which Express must respect.

---

## 3. Deployment Preparation Check

- [x] Identify package.json entry points and scripts
- [x] Verify Vite build commands compile cleanly
- [x] Audit database schemas and tables (`accounts`, `processed_events`, `transactions_log`)
- [x] Track ML model feature schema (`[amount, hour, velocity]`)
- [x] Prepare environment variable fallback overrides
