# Final Buildathon Checklist

**LedgerStream — Razorpay Track 02**  
Run through this checklist before the judging session.

---

## SYSTEM STARTUP

- [ ] Docker containers started (`docker-compose up -d`)
- [ ] PostgreSQL accessible on port 5433
- [ ] Kafka accessible on port 9092
- [ ] Ledger consumer running and loading model
- [ ] Fraud consumer running
- [ ] API server running on port 3001
- [ ] React dashboard running on port 5173
- [ ] Dashboard shows **LIVE** status (green dot)

Verify with: `powershell -File scripts/start_demo.ps1`

---

## SAFETY — TRANSACTION DECISIONS

- [ ] LOW transaction (score < 0.50) → status `applied`, balances change
- [ ] MEDIUM transaction (0.50 ≤ score < 0.96) → status `held`, balances unchanged
- [ ] HIGH transaction (score ≥ 0.96) → status `blocked`, balances unchanged
- [ ] Approve action on `held` → status `applied`, balances change
- [ ] Decline action on `held` → status `declined`, balances unchanged
- [ ] Approve on `blocked` → rejected with 400 error
- [ ] Decline on `blocked` → rejected with 400 error
- [ ] Double-approve → rejected with 400 error
- [ ] Double-decline → rejected with 400 error
- [ ] Duplicate Kafka delivery (same event_id) → idempotent, no double-debit
- [ ] DLQ routing on malformed events → verified
- [ ] Database total balance = $347,000.00 (`SELECT SUM(balance) FROM accounts`)

---

## AI MODEL

- [ ] Model features confirmed as `[amount, hour, velocity]` (3 features)
- [ ] LOW threshold = 0.50 (from .env)
- [ ] HIGH threshold = 0.96 (from .env)
- [ ] Model evaluation documented (AUC-ROC: 0.7928, AUC-PR: 0.0488)
- [ ] Risk reasons labeled as heuristic (not SHAP)

---

## DASHBOARD

- [ ] Risk Flow Diagram visible at top (TRANSACTION → AI → LOW/MEDIUM/HIGH)
- [ ] KPIs show: Blocked count, Held count, Approved count, Declined count, Total analyzed
- [ ] Analyst Review Queue shows held transactions with MONEY MOVED: NO
- [ ] Approve/Decline buttons work from review queue
- [ ] Blocked Transactions panel shows blocked items with MONEY MOVED: NO
- [ ] Transaction detail panel shows: event_id, amount, sender, receiver, score, level, status, money moved
- [ ] Business Impact panel shows: blocked count, held count, declined count, funds protected
- [ ] System Health panel shows total balance and Kafka lag
- [ ] Account Balances panel shows live balances
- [ ] Transaction Feed shows recent transactions with status badges
- [ ] Toast notifications appear on approve/decline actions
- [ ] OFFLINE banner appears when API is unreachable
- [ ] Dashboard polls every 2.5s (updates without manual refresh)

---

## DEMO SCENARIOS

- [ ] `powershell -File scripts/demo_scenario.ps1 -scenario LOW` → transaction settles
- [ ] `powershell -File scripts/demo_scenario.ps1 -scenario MEDIUM` → transaction held
- [ ] Approve from UI → transaction settles, balances change
- [ ] `powershell -File scripts/demo_scenario.ps1 -scenario MEDIUM` → transaction held
- [ ] Decline from UI → transaction declined, balances unchanged
- [ ] `powershell -File scripts/demo_scenario.ps1 -scenario HIGH` → transaction blocked

---

## DOCUMENTATION

- [ ] `README.md` exists with architecture, features, safety guarantees, demo commands
- [ ] `docs/production_readiness.md` — deployment and failure semantics
- [ ] `docs/performance_summary.md` — Phase 1 vs Phase 2 vs current latency comparison
- [ ] `docs/final_judge_demo.md` — 3-5 minute demo guide
- [ ] `docs/final_buildathon_checklist.md` — this file
- [ ] `docs/phase6_final_report.md` — final scorecard

---

## REGRESSION TESTS

Run: `python ../tests/regression_tests.py` from `ledgerstream/ledgerstream/fraud`

Expected: **25 tests, 0 failures**

---

## BALANCE CONSERVATION VERIFICATION

Run:
```sql
SELECT SUM(balance) FROM accounts;
```
Expected: **$347,000.00**

---

## CLOSING STATEMENT

> "LedgerStream doesn't just detect financial fraud.  
> It prevents suspicious money from moving in the first place."
