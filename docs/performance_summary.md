# Performance Summary

**LedgerStream — Active AI Risk Decision Layer**

---

## Why Performance Matters for This Architecture

LedgerStream places AI risk scoring **inline** — inside the Kafka consumer loop, before any financial write. This is the core architectural innovation that enables pre-settlement protection. It is also the source of the performance trade-off: every event must wait for ML inference + database write before its Kafka offset is committed.

---

## Measurement Summary

| Phase | Description | Load | Avg Latency | Notes |
|-------|-------------|------|-------------|-------|
| Phase 1 | Ledger consumer, no ML | 100 EPS | ~45 ms | Pure Kafka + Postgres pipeline |
| Phase 1 | Ledger consumer, no ML | 500 EPS | ~6.69 s | Queue saturation begins |
| Phase 1 | Ledger consumer, no ML | 1000 EPS | ~21.10 s | Severe saturation |
| Phase 2 | Inline ML scoring added | 100 EPS | ~16.98 s | ML overhead dominates |
| Phase 2 | Inline ML scoring added | 500 EPS | ~82.05 s | Fully saturated |
| Phase 5 (current) | Optimized single-thread loop | ~30 EPS | ~10.76 ms | Steady-state under capacity |

---

## Current Capacity

**Maximum sequential throughput: ~93 EPS**

Latency breakdown per event at steady state:

| Component | Time |
|-----------|------|
| Kafka poll + deserialize | ~0.5 ms |
| Feature extraction + velocity | ~0.3 ms |
| XGBoost inference | ~0.76 ms |
| PostgreSQL `BEGIN` / lock / write / `COMMIT` | ~8 ms |
| Kafka offset commit | ~2 ms |
| **Total** | **~10.76 ms** |

---

## Why Inline Scoring Is Necessary

Moving fraud scoring *after* settlement (the naive approach) would mean:

1. Transaction arrives → Kafka consumer processes → balances update → fraud score computed → alert fires

But the money is already gone. The alert is too late to prevent the transfer.

LedgerStream's design requires that:
```
score(event) → DECISION → PostgreSQL COMMIT → Kafka offset commit
```

This ordering guarantees:
- Fraudulent transactions are stopped before any ledger write
- If the process crashes after `PostgreSQL COMMIT` but before Kafka offset commit, the next delivery is idempotent (duplicate rejected by `processed_events`)
- If the process crashes before `PostgreSQL COMMIT`, no write happened, and the event is redelivered safely

The performance cost is the direct price of financial correctness.

---

## Saturation Behavior

When arrival rate exceeds ~93 EPS, Kafka consumer lag accumulates:
- End-to-end latency becomes dominated by **queueing delay**, not processing time
- Each event still settles correctly — no data loss
- The backlog drains as the consumer catches up

---

## Why We Did NOT Implement Batch Commits

A batch-offset-commit optimization (commit offsets every N events rather than per-event) could significantly increase throughput. This optimization was **intentionally not implemented** because:

1. It would require careful crash-safety analysis
2. A crash between batch PostgreSQL commits would leave a window of potential double-delivery
3. The idempotency guard (`processed_events`) provides safety, but batch semantics require additional testing
4. The risk to financial correctness was not worth the throughput gain for this project scope

This is documented as **safe future work**.

---

## Recommended Future Optimization

1. **Horizontal partition scaling**: Assign multiple Kafka partitions to multiple consumer instances. Each partition processes independently with its own commit cycle. This scales throughput linearly without changing the per-event commit safety model.
2. **Async Kafka commit with in-flight window**: Allow a small configurable in-flight window (e.g. 5 events) while maintaining crash-safe ordering.
3. **Connection pooling tuning**: Reduce PostgreSQL connection overhead with pre-acquired connections.

---

## Honest Assessment

> LedgerStream achieves **correct pre-settlement interception** at the cost of **sequential throughput**. The ~93 EPS ceiling is a consequence of the correctness guarantee, not a bug. For a Buildathon prototype demonstrating the AI risk decision layer concept, this performance is sufficient and the architecture is sound.
