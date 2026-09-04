# Phase 3 Frontend Audit

This document audits the current state of the React frontend in LedgerStream prior to making the Phase 3 enhancements for the Razorpay Buildathon.

---

## 1. Current Frontend Structure
* **`App.jsx`**: Main React container (~500 lines). Houses:
  * Local state variables (`balances`, `txns`, `alerts`, `lag`, `stats`, `selectedId`).
  * A central polling `useEffect` that fetches metrics every 2500ms via `Promise.all`.
  * Helper functions for formatting (`formatMoney`, `formatPct`, `timeAgo`).
  * Direct rendering of layout panels: `RiskOverview`, `RiskDecisionsTable`, `RiskDetail` panel, and `System Health` overview (Account Balances + Transaction Feed).
* **`api.js`**: Contains API fetch wrapper functions (`fetchBalances`, `fetchTransactions`, `fetchAlerts`, `fetchLag`, `fetchStats`).
* **`index.css`**: CSS stylesheet with custom color tokens, layouts, tables, and badge styling.

---

## 2. Existing Reusable Components
* **`StatusPill`**: Renders connection health (OFFLINE, LIVE, BUSY).
* **`OverviewCard`**: KPI card display layout.
* **`RiskOverview`**: Section grouping metric KPI cards.
* **`RiskLevelBadge`**: Visual risk indicators (LOW, MEDIUM, HIGH).
* **`RiskDecisionsTable`**: Interactive alert logger.
* **`RiskDetail`**: Detailed card rendering features/reasons.
* **`BalanceRow`**: Individual account balance list row.
* **`TxRow`**: Transaction feed row.
* **`LagCard`**: Displays queue lag counts.

---

## 3. Available API Data
* `/api/balances`: Returns `{ ok: true, accounts: [{ account_id, balance }] }`.
* `/api/transactions`: Returns `{ ok: true, transactions: [{ event_id, from_account, to_account, amount, status, error_reason, created_at }] }`.
* `/api/alerts`: Returns `{ ok: true, alerts: [{ event_id, from_account, to_account, amount, risk_score, risk_level, action, reasons, flagged_at }] }`.
* `/api/lag`: Returns `{ ok: true, lag: { ledger: { lag, logEnd, committed }, fraud: { lag, logEnd, committed } } }`.
* `/api/stats`: Returns `{ ok: true, analyzed, high, medium, threshold, measuredPrecision, measuredRecall }`.

---

## 4. Missing UI Capabilities (Gaps)
1. **Remediation Action Buttons**: The UI has no buttons for approving or declining held transactions.
2. **Action Feedbacks & Loading States**: The UI does not handle loading spinners, button disabling during action, or success/error banners for api calls.
3. **Transaction detail actions**: The detail panel displays attributes but does not expose interactive remediation actions.
4. **Aggregate state counters**: The current stats API and overview do not display total database aggregates for `'held'`, `'blocked'`, or `'declined'` states.

---

## 5. Exact Files That Need Modification
* [`App.jsx`](file:///c:/my_projects_main/LedgerStream/ledgerstream/ledgerstream/frontend/src/App.jsx): Needs full layout transformation, integration of approve/decline endpoints, action triggers, side drawer/detail panel upgrade, and state counts display.
* [`server.js`](file:///c:/my_projects_main/LedgerStream/ledgerstream/ledgerstream/api/server.js) [BACKEND]: Minor extension to `/api/stats` to run a group-by query and return status aggregations (`held`, `blocked`, `applied`, `declined`).

---

## 6. Exact Files That Should Remain Untouched
* [`main.jsx`](file:///c:/my_projects_main/LedgerStream/ledgerstream/ledgerstream/frontend/src/main.jsx)
* [`api.js`](file:///c:/my_projects_main/LedgerStream/ledgerstream/ledgerstream/frontend/src/api.js) (calls are already covered, we can call them or make inline POST calls).
* [`ledger_consumer.py`](file:///c:/my_projects_main/LedgerStream/ledgerstream/ledgerstream/consumer/ledger_consumer.py)
* [`fraud_consumer.py`](file:///c:/my_projects_main/LedgerStream/ledgerstream/ledgerstream/fraud/fraud_consumer.py)
* [`regression_tests.py`](file:///c:/my_projects_main/LedgerStream/ledgerstream/ledgerstream/tests/regression_tests.py)
