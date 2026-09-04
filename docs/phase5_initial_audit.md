# Phase 5 Initial Audit Report

This report presents a strict technical audit of the complete LedgerStream architecture, data flow, logging, error handling, security, and configuration elements prior to Phase 5 hardening.

---

## 1. Current Architecture & request/data Flow
* **Flow**:
  1. Transaction events are published to Kafka `transactions` topic.
  2. `ledger_consumer.py` pulls events, tracks velocity, constructs feature arrays `[amount, hour, velocity]`, runs inline scoring using XGBoost (`fraud_model.pkl`), evaluates risk decision (`APPROVE`/`VERIFY`/`HOLD`), and conditionally updates PostgreSQL `accounts` balances.
  3. `fraud_consumer.py` runs in parallel, scoring and publishing events >= 0.50 as alerts to the `fraud-alerts` topic.
  4. The React dashboard polls the Express API `/api/stats`, `/api/alerts`, `/api/balances`, and `/api/transactions` every 2500ms.
  5. The analyst can Approve or Decline HELD payments, calling the transactional row-locked write endpoints in the API.

---

## 2. Security & Configuration Weaknesses
* **Hardcoded configurations**: PostgreSQL credentials and Kafka bootstrap servers are hardcoded as local string constants in `ledger_consumer.py`, `fraud_consumer.py`, and `server.js`.
* **State transitions**: State transitions inside `server.js` are protected, but could benefit from a explicit state-machine validator to guarantee no invalid transitions (e.g. decline to applied, block to applied).
* **Logging**: Outputs are simple print/log statements, lacking standardized structured event types (e.g. `TRANSACTION_RECEIVED`, `RISK_SCORED`).

---

## 3. Performance Limitations
* Sequentially committing ledger consumer limits transaction capacity to ~93 EPS due to synchronous disk and network round-trips. Backlog queueing latency occurs if production rate exceeds this capacity.

---

## 4. Live Demonstration Risks
* If Kafka or PostgreSQL crashes mid-run, the console will show connection error banners.
* Starting all 6 services (Kafka, Postgres, ledger consumer, fraud consumer, API, Vite frontend) requires running multiple separate launchers. A unified powershell script is needed to improve demo reliability.

---

## Overall Assessment

| Component | Status | Evidence |
| :--- | :--- | :--- |
| **Backend Safety** | PASS | Safe pre-settlement blocking and row locks. |
| **Idempotency** | PASS | Uniqueness constraint on `processed_events`. |
| **Fraud Model** | PASS | Loaded once; features ordering matches training. |
| **Alert Pipeline** | PASS | Dynamic status mapping on alert rows. |
| **API validations** | PASS | Transition blocks on state mismatches. |
| **React dashboard** | PASS | UI compiles and updates dynamically on action. |
| **Configuration** | NEEDS IMPROVEMENT | Hardcoded local secrets and variables. |
| **Observability** | NEEDS IMPROVEMENT | Swallowed traces; lacking event tags. |
| **Demo Setup** | NEEDS IMPROVEMENT | Services started individually. |
