# LedgerStream Development Workflow

This is the single recommended way to run LedgerStream locally. It replaces
the previous collection of one-off launcher scripts with a small, consistent
set.

## Prerequisites

- Docker (for Kafka + PostgreSQL via `docker-compose.yml`)
- Python 3.10+ with `consumer/requirements.txt`, `fraud/requirements.txt`,
  `producer/requirements.txt`, `dashboard/requirements.txt` dependencies
- Node 18+ for the API and frontend

## 1. Start infrastructure (Kafka + PostgreSQL)

```powershell
docker compose -f ledgerstream/ledgerstream/docker-compose.yml up -d
```

This starts Kafka on `localhost:9092` and PostgreSQL on `localhost:5433`
with the schema and seed accounts applied.

## 2. Start the backend consumers (risk engines)

Two consumers run as separate processes. Launch each in its own window:

```powershell
.\consumer_launcher.ps1   # ledger consumer — the inline risk/decision engine
.\fraud_launcher.ps1      # fraud consumer — independent monitoring group
```

## 3. Start the API server

```powershell
.\api_launcher.ps1        # Express API on http://localhost:3001
```

## 4. Start the frontend

```powershell
.\frontend_launcher.ps1   # Vite dev server on http://localhost:5173
```

Open http://localhost:5173 for the dashboard.

## 5. (Optional) Produce transactions

```powershell
.\producer_launcher.ps1                                  # stream forever (10–5000 range)
.\producer_launcher.ps1 -Count 200                       # stop after 200, default range
.\producer_launcher.ps1 -InjectBad 0.1                   # 10% malformed -> exercises the DLQ
.\producer_launcher.ps1 -Rate 0.01 -Count 1000           # sustained burst for load testing
```

## 6. (Optional) Seed generic demo transactions

From the UI "System Health" page, or via the API:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/admin/seed-demo
```

Demo transactions are generated generically (real DB accounts, configured
amount range) and flow through the SAME production risk pipeline — the model
and policy decide the outcome, never the generator.

## 7. Run tests

```powershell
python -m unittest discover -s ledgerstream/ledgerstream/tests
```

> Requires the API on `:3001` and PostgreSQL on `:5433` to be running for
> the API/DB integration tests.

## 8. Run load testing

```powershell
python ledgerstream/ledgerstream/loadtest/load_test.py --steps 100,500,1000 --duration 20
```

> Requires Kafka, PostgreSQL, and the ledger consumer to be running.

## Dashboard (optional, Streamlit)

```powershell
.\dashboard_launcher.ps1   # Streamlit dashboard on http://localhost:8501
```

---

## Configuration

All runtime configuration lives in `.env` (see `.env.example`):
- `RISK_LOW_THRESHOLD` / `RISK_HIGH_THRESHOLD` — the only risk-policy knobs.
  The ML model emits a fraud probability; the policy maps that score to
  LOW/MEDIUM/HIGH. The amount is never used to override the decision.
- `DEMO_TRANSACTION_COUNT`, `DEMO_MIN_AMOUNT`, `DEMO_MAX_AMOUNT` — bounds for
  the generic demo generator.
- Kafka / database DSN settings.
