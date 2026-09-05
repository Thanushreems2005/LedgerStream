# LedgerStream — AI Payment Risk Manager

> **Razorpay Track 02 Buildathon Submission**  
> Active pre-settlement fraud prevention powered by Kafka, Random Forest V4, and PostgreSQL.

---

## The Problem

Traditional fraud detection is **passive and reactive**. A transaction settles — money moves — and then an alert fires. By that point, the funds have left the system.

```
Traditional:
  Transaction → Settles → Fraud Alert
                ↑
         money already moved
```

---

## The Solution

LedgerStream makes fraud detection **active and preventive**. The AI risk model intercepts every transaction *before* any balance is updated. If the score exceeds a threshold, the money never moves.

```
LedgerStream:
  Transaction → AI Risk Score → DECISION → Settle / Hold / Block
                                   ↑
                        money only moves if APPROVED
```

---

## Key Innovation

> **The AI does not merely detect fraud. It controls whether money is allowed to move.**

- **LOW risk** → transaction settles instantly (balances update)
- **MEDIUM risk** → transaction is HELD (balances untouched, analyst reviews)
- **HIGH risk** → transaction is BLOCKED (balances untouched, permanently prevented)

---

## Architecture

```
Transaction Event (JSON)
        │
        ▼
    Apache Kafka
  (transactions topic)
        │
        ▼
  Ledger Consumer (Python)
        │
        ├── Velocity calculation (per-account, 30-min window)
        ├── Feature extraction [amount, hour, velocity, log_amount, is_night, amount_ratio]
        │
        ▼
  Fraud Risk Model (Random Forest V4)
        │
        ▼
  Risk Decision Engine
        │
   ┌────┴────┬──────────┐
   │         │          │
  LOW      MEDIUM      HIGH
  score   0.01-0.10   score
  <0.01      │        >0.10
   │         │          │
   ▼         ▼          ▼
 SETTLE     HOLD      BLOCK
 (balances  (balances (balances
 update)    frozen)   frozen)
            │
            ▼
      PostgreSQL: status='held'
            │
     React Dashboard
            │
      Analyst Review Queue
            │
       APPROVE / DECLINE
            │
         ▼         ▼
      Settle     Decline
    (balances) (balances
     update)    stay frozen)

Also:
  ┌─ Idempotency: processed_events unique constraint
  ├─ Row locks: SELECT FOR UPDATE on accounts + transaction
  ├─ Commit order: PostgreSQL COMMIT → Kafka offset commit
  ├─ DLQ: transactions-dlq topic for failed events
  └─ Replay: DLQ consumer replays failed events safely
```

---

## Features

| Feature | Status |
|---------|--------|
| Kafka streaming ingestion | ✅ |
| PostgreSQL ledger | ✅ |
| Random Forest V4 fraud detection (6 features) | ✅ |
| **Pre-settlement interception** | ✅ |
| LOW → immediate settlement | ✅ |
| MEDIUM → hold + analyst review | ✅ |
| HIGH → instant block | ✅ |
| Send Transaction simulator (real pipeline) | ✅ |
| Analyst approve/decline API | ✅ |
| Idempotency (duplicate-safe Kafka delivery) | ✅ |
| `SELECT FOR UPDATE` row locking | ✅ |
| DLQ + replay | ✅ |
| Interactive React risk dashboard | ✅ |
| Structured JSON logging | ✅ |
| Environment configuration | ✅ |
| State transition enforcement | ✅ |
| 33 regression tests | ✅ |

---

## Safety Guarantees

Verified by the 33-case automated regression suite:

1. **LOW transactions settle correctly** — balances update once (duplicate-safe)
2. **MEDIUM transactions are held** — balances do NOT change before analyst approval
3. **HIGH transactions are blocked** — balances are NEVER touched
4. **Held → Applied only with explicit Approve** — state transition is guarded
5. **Held → Declined only with explicit Decline** — state transition is guarded
6. **Blocked transactions cannot be approved or declined** — permanently final
7. **Applied/Declined transactions cannot be reprocessed** — terminal states
8. **Duplicate Kafka delivery is idempotent** — same event, same result
9. **Insufficient balance triggers rollback** — no partial debit
10. **Concurrent approve+decline race resolves correctly** — exactly one wins
11. **Database total balance is conserved** — balance conservation verified by the regression suite

---

## Performance

The ledger consumer is **sequential / single-threaded**. Demonstrated sustainable processing is around the tested operating range; higher producer rates can create Kafka backlog. Horizontal scaling through additional Kafka partitions and consumer instances is future work.

> The single-threaded commit loop is a deliberate trade-off to guarantee transactional correctness (PostgreSQL commit → Kafka offset commit ordering).

---

## Quick Start

### Prerequisites
- Docker Desktop
- Node.js 18+
- Python 3.10+

### 1. Start infrastructure

```powershell
docker-compose up -d
```

### 2. Install Python dependencies

```powershell
cd ledgerstream
pip install -r requirements.txt
```

### 3. Install Node dependencies

```powershell
cd ledgerstream/api && npm install
cd ../frontend && npm install
```

### 4. Launch everything (unified)

```powershell
powershell -File scripts/start_demo.ps1
```

Or launch individually:

```powershell
# Ledger Consumer (AI Risk Engine)
powershell -File consumer_launcher.ps1

# Fraud Consumer (Alert Publisher)
powershell -File fraud_launcher.ps1

# API Server
powershell -File api_launcher.ps1

# React Dashboard
powershell -File frontend_launcher.ps1
```

### 5. Open dashboard

```
http://localhost:5173
```

---

## Demo Scenarios

Open the **Send Transaction** page for a live end-to-end demo:

```
From Account → To Account → Amount → Send Payment
        ↓
Kafka transaction topic → Python ledger consumer
        ↓
Feature calculation [amount, hour, velocity, log_amount, is_night, amount_ratio]
        ↓
Random Forest V4 → risk score → policy decision
        ↓
PostgreSQL → API → dashboard
```

The demo uses **synthetic transaction events** published through the real pipeline. Risk scores and decisions come from the actual backend model and are read back from the database — not a frontend simulation.

- **LOW** → settlement may proceed (balances update)
- **MEDIUM** → settlement held for analyst review (balances frozen); the analyst can approve or decline
- **HIGH** → settlement blocked (balances untouched)

Outcome scenarios exercised by the demo:

```
# Scenario 1: LOW risk → auto-settle
# Scenario 2: MEDIUM risk → hold → approve
# Scenario 3: MEDIUM risk → hold → decline
# Scenario 4: HIGH risk → instant block
```

---

## Testing

```powershell
cd ledgerstream/ledgerstream/fraud
python ../tests/regression_tests.py
```

Expected:

```
.................................
Ran 33 tests — 33 passed, 0 failed, 0 skipped
OK
```

---

## Environment Configuration

Copy `.env.example` to `.env` and set:

```ini
KAFKA_BOOTSTRAP_SERVERS=localhost:9092
PG_DSN=dbname=ledgerstream user=ledger password=ledger host=localhost port=5433
API_PORT=3001
RISK_LOW_THRESHOLD=0.01
RISK_HIGH_THRESHOLD=0.10
```

---

## Model Details

- **Classifier**: RandomForestClassifier — Random Forest V4 (scikit-learn)
- **Training data**: Kaggle `creditcard.csv` (284,807 transactions, 492 fraudulent)
- **Features**: `[amount, hour, velocity, log_amount, is_night, amount_ratio]` (6 features)
- **Decision thresholds** (score-only, independent of amount):
  - score < 0.01 → LOW → APPROVE
  - 0.01 ≤ score ≤ 0.10 → MEDIUM → VERIFY / hold for review
  - score > 0.10 → HIGH → BLOCK
- **Held-out evaluation** (test set of 56,962 transactions; 98 positive fraud examples; ~0.172% fraud base rate):
  - PR-AUC: 0.1131
  - Precision @ 0.10 threshold: 26.9%
  - Recall @ 0.10 threshold: 21.4%
  - F1 @ 0.10 threshold: 23.9%

Fraud is highly imbalanced (~0.172% of the held-out set), so PR-AUC, precision, and recall are more informative than raw accuracy.

---

## Limitations

1. **Throughput**: The single-threaded consumer limits processing capacity; higher producer rates can create Kafka backlog. Horizontal scaling via additional Kafka partitions and consumer instances is future work.
2. **Model features**: The model uses six engineered transaction/temporal features (`amount, hour, velocity, log_amount, is_night, amount_ratio`) rather than richer production signals (device fingerprint, IP reputation, merchant category, etc.).
3. **Explainability**: Risk reasons shown in the UI are supporting rule-based signals, not SHAP attributions.
4. **Horizontal scaling**: Not implemented (by design — adding concurrent consumers requires careful partition assignment to avoid duplicate processing).

---

## Future Work

- Multi-partition Kafka assignment + multiple consumer instances for horizontal EPS scaling
- SHAP-based model explainability
- Richer feature engineering (device, IP, merchant signals)
- Time-windowed velocity calculation using Redis sorted sets
- Prometheus metrics endpoint + Grafana dashboard
- Webhook notifications for analyst review alerts

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/production_readiness.md`](docs/production_readiness.md) | Architecture, state transitions, failure semantics |
| [`docs/performance_summary.md`](docs/performance_summary.md) | Latency and throughput measurements |
| [`docs/final_judge_demo.md`](docs/final_judge_demo.md) | 3–5 minute demo guide for judges |
| [`docs/final_buildathon_checklist.md`](docs/final_buildathon_checklist.md) | Pre-demo verification checklist |
| [`docs/phase6_final_report.md`](docs/phase6_final_report.md) | Final buildathon scorecard |
