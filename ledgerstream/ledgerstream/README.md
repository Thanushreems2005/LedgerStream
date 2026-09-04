# LedgerStream

Real-time, exactly-once payment ledger on Apache Kafka. Code for all 6 days
of the roadmap. Read every file before you use it in an interview — the
comments at the top of each file explain *why* it's built that way, which
is exactly what you'll get asked about.

## Run order

```bash
# 1. Infra (Day 1)
docker-compose up -d
docker-compose ps          # wait until both healthy

# 2. Ledger consumer (Day 3/4) — leave running in its own terminal
cd consumer && pip install -r requirements.txt
python ledger_consumer.py

# 3. Producer (Day 2) — separate terminal
cd producer && pip install -r requirements.txt
python producer.py --inject-bad 0.05

# 4. Watch balances change / DLQ fill up
docker exec -it ledgerstream-postgres psql -U ledger -d ledgerstream \
  -c "SELECT * FROM accounts;"

cd dlq && python replay_cli.py list
python replay_cli.py replay <event_id> --fix amount=250.00

# 5. Fraud consumer (Day 5) — needs a trained model first
cd fraud
# download creditcard.csv from Kaggle into this folder first:
# https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud
pip install pandas scikit-learn xgboost
python train_model_v3.py            # trains + persists the V3 HistGradientBoosting model
python fraud_consumer.py            # defaults: LOW=0.01 / HIGH=0.10 (see .env)

# 6. Dashboard (Day 6)
cd dashboard && pip install streamlit pandas psycopg2-binary
streamlit run dashboard.py

# 7. Load test (Day 6)
cd loadtest && python load_test.py --steps 100,500,1000,2000 --duration 20
```

## The exactly-once proof (do this on camera / screen-record it)

1. Start `ledger_consumer.py`, start `producer.py`.
2. Let ~50 events land, then `kill -9 <pid>` the consumer mid-processing.
3. Restart `ledger_consumer.py` — watch the logs. Redelivered events log
   `skip duplicate event_id=... (idempotency guard)`.
4. Query `transactions_log` — confirm no `event_id` appears twice and no
   account balance is wrong. This is your interview demo.

## Things to genuinely understand before you say you built this

- Why offset commit happens **after** the DB commit, not before (see the
  comment block at the top of `ledger_consumer.py` — this is the single
  most-asked question about this project).
- Why partitioning by `from_account` matters for ordering, and what would
  break if you keyed by `event_id` instead (partition assignment would
  scatter a single account's transfers across partitions with no ordering
  guarantee between them).
- The fraud model's feature mismatch is a real, honest simplification —
  see `train_model.py` and `fraud_consumer.py` docstrings. Don't get
  caught claiming the Kaggle PCA features apply directly to your synthetic
  events; explain the engineered-feature workaround instead. This is
  actually a good story about recognizing a train/serve skew problem.
- The load test numbers in `load_test.py`'s output are the ONLY throughput
  number you're allowed to put on your resume. Run it, screenshot it, keep
  the raw CSV output.

## Fraud model — known limitation

The fraud model has an inherent train/serve feature mismatch, and the
numbers below are the honest cost of it. Keep this tradeoff in mind when
you present the project — never oversell fraud precision.

**The mismatch.** The Kaggle `creditcard.csv` classifier was trained on 28
PCA features (`V1..V28`) that contain essentially all of the model's fraud
signal. LedgerStream's synthetic transfer events don't carry those features
(they're an account-to-account ledger, not card swipes), so the original
pipeline zero-padded them and **could never exceed a ~0.01 risk score** — no
alert would ever fire. The consumer was therefore retrained on the 6
features a transfer event actually has: `amount`, `hour-of-day`, the
sender's rolling `velocity` (30-min window), `log_amount`, `is_night`, and
`amount_ratio`, using the *real* Kaggle `Class` labels. This makes alerts
mechanically possible but at real cost.

**Evaluated models, side by side** (held-out 20% stratified split):

| Model | Fraud precision | Fraud recall | AUC-PR |
|------|----------------|--------------|--------|
| Original (28 PCA features, padded/zeroed at serve time) | 0.722 | 0.847 | 0.8634 |
| Retrained V3 (6 features — actually servable) | 0.237 @ thr 0.10 | 0.143 | 0.0637 |

The padded model looks great on paper but is useless at serve time (it can't
score the stream above 0.01). The 6-feature V3 model can run on real events
but is a weak classifier — the amount/velocity outliers that fraud rows share
overlap heavily with normal traffic.

**Chosen thresholds.** `RISK_LOW_THRESHOLD=0.01` / `RISK_HIGH_THRESHOLD=0.10`
by default. The HIGH band sits near the held-out F1-maximizing cutoff
(thr 0.1018 → P≈0.246, R≈0.143, F1≈0.18) while keeping the flag rate low.
Alternatives, all on the same held-out split (V3 scores):
- thr 0.01 → P=0.044, R=0.296 (captures more fraud; ~1.16% flagged)
- thr 0.05 → P=0.165, R=0.153 (~0.16% flagged)
- thr 0.10 → P=0.237, R=0.143 (~0.10% flagged, chosen HIGH default)
- thr 0.50 → P=0.300, R=0.031 (maximize precision; misses most fraud)

The 0.10 HIGH threshold was chosen because precision that matters most in a
fraud-alert topic — every false positive is a human analyst's wasted time —
while keeping a bounded flag rate and the F1-optimal joint performance.

**What a real fix requires.** Either (a) synthetic-labeled ledger fraud data
(events you control, labeled, in the same shape as the live stream) so the
model is trained on exactly what it serves, or (b) richer
stream-derivable features (inter-arrival time, amount quantization anomaly,
sender/target graph features) that separate fraud from normal traffic the
way the PCA components did on card data. Until then, treat the fraud
consumer as a *demo of the streaming/scoring pipeline*, not a production
detector.

## Production-scale writeup (fill this in after you run the load test)

Use this structure for the "at production scale" section:

- **Multi-broker replication**: this setup runs a single Kafka broker with
  replication factor 1 — fine for a demo, but a broker failure loses data.
  Production needs 3+ brokers and `replication.factor=3` /
  `min.insync.replicas=2`.
- **Schema Registry**: events are raw JSON here with no schema
  enforcement. Production would use Avro/Protobuf + Confluent Schema
  Registry so a producer can't silently ship a breaking field change.
- **Partition rebalancing**: with a single partition set and one consumer
  instance per group, there's no rebalancing story to test here. At scale
  you'd run multiple consumer instances per group and need to reason about
  rebalance pauses (`cooperative-sticky` assignor vs. eager).
- **Monitoring/alerting**: this project logs to stdout. Production needs
  consumer lag alerting (Prometheus + Kafka exporter), DLQ depth alerting,
  and balance-reconciliation jobs that catch silent drift.
- **Your actual measured numbers**: paste the `load_test.py` CSV output
  here, plus one sentence on where latency started degrading.
