# Phase 3 Final Report: Interactive AI Risk Management Dashboard

This report documents the design, implementation, and verification of the **Interactive AI Risk Management Console** for Razorpay Buildathon Track 02.

---

## 1. Existing Frontend Architecture
The React application is a single-page application built on Vite:
* `main.jsx`: Handles boot and React DOM insertion.
* `App.jsx`: Contains the entire view components, layouts, state hooks, and action handlers.
* `api.js`: Standardizes the HTTP get routes for polling.
* `index.css`: Styles layouts, badge markers, table listings, and grid layouts.

---

## 2. Components Modified & Created
All dashboard elements are refactored inside `App.jsx` for clean code structure and optimal component reuse:
* **`RiskOverview`**: Re-routed to display real Postgres aggregates (Scored, Approved & Settled, Needs Review, Blocked) fetched from `/api/stats`.
* **`RiskDecisionsTable`**: Displays live decision states (Applied, Held, Blocked, Declined) matched in real-time from the transaction feed logs.
* **`RiskDetail` (Detail Drawer/Modal)**: Enforces visual balance impact displays (e.g. `-$100.00` for Applied vs `$0.00` for Held/Blocked) and embeds contextual Approve/Decline actions when the selected item reads `'held'`.
* **`Analyst Review Queue` (New Panel)**: Renders stopped `MEDIUM` risk transactions with active `Approve` and `Decline` action triggers.
* **`Blocked Transactions` (New Panel)**: Lists `HIGH` risk transactions blocked by the AI engine.

---

## 3. API Endpoints Used
* `/api/balances` [GET]: Live PostgreSQL account balances.
* `/api/transactions` [GET]: Latest 50 transaction records in `transactions_log`.
* `/api/alerts` [GET]: Latest Kafka events published to `fraud-alerts`.
* `/api/lag` [GET]: Ledger and fraud consumer Kafka offsets lag.
* `/api/stats` [GET]: Returns status aggregates (`appliedCount`, `heldCount`, `blockedCount`, `declinedCount`).
* `/api/transactions/:id/approve` [POST]: Remediates a held payment to `'applied'`.
* `/api/transactions/:id/decline` [POST]: Remediates a held payment to `'declined'`.

---

## 4. Dashboard Implementation Details

### A. Risk Overview
Displays database aggregates to prioritize payment risk signals over infrastructure logs. The top KPIs show total scored payments, settled payments, active holds, and blocked high-risk events.

### B. Review Queue
Provides an analyst interface displaying stopped payments, associated amounts, ML risk scores, and alert reasons. Renders distinct [ Approve ] and [ Decline ] buttons that link to write endpoints.

### C. Blocked Transactions View
Shows high-risk blocked transactions with a prominent red left-border indicator. Settlement status reads `NOT EXECUTED` with zero balance movement, verifying the active blocker functionality.

### D. Model Performance & Business Impact
* **Model Performance**: Exposes offline test metrics (Threshold `0.96`, Precision `20.6%`, Recall `15.3%`) labeled clearly as offline test-set evaluations.
* **Business Impact**: Calculates "Estimated Protected Funds" (summing blocked and declined payments) to represent the business value of the risk manager.

---

## 5. Live Verification & Action Feedback
* Polling interval is kept at **2500ms**, executing a unified API fetch inside a single React cycle to prevent polling multiplication.
* Action feedback uses a custom state toast (`setToast`) displaying success and error messages on screen.
* Buttons display loading indicators and disable during network operations (`actionPending = true`) to prevent race conditions or double submissions.
* Upon successful action, the stats and feeds re-fetch instantly to clear processed items from queues.

---

## 6. Regression Test Results
Ran the backend test suite:
* **Passed**: 16
* **Failed**: 0
* **Skipped**: 0

The 16 tests successfully verify that manual API approval/decline triggers, duplicate Kafka deliveries, unique constraint guards, and out-of-order state transitions remain safe.

---

## Scorecard

```
RISK OVERVIEW               PASS
RISK DECISION QUEUE         PASS
MEDIUM REVIEW QUEUE         PASS
TRANSACTION DETAIL          PASS
APPROVE ACTION              PASS
DECLINE ACTION              PASS
BLOCKED TRANSACTIONS        PASS
ACTION FEEDBACK             PASS
LIVE DATA                   PASS
SYSTEM HEALTH               PASS
MODEL PERFORMANCE           PASS
BUSINESS IMPACT             PASS
RESPONSIVE UI               PASS
API INTEGRATION             PASS
REGRESSION SAFETY           PASS
DEMO FLOW                   PASS
```
