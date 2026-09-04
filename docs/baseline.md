# LedgerStream Baseline Performance Metrics

This document records the verified Phase 1 baseline performance and resource usage metrics before the Razorpay Track 02 Risk Manager implementation.

---

## 1. Throughput & Processing Latency Baseline
Measured on a single-node local environment during a stepped load-test burst:

* **100 EPS Target**:
  * Actual EPS: **100.0**
  * Average Processing Latency: **45 ms**
  * Maximum Processing Latency: **66 ms**
  * Consumer Lag: **0 msgs**

* **500 EPS Target**:
  * Actual EPS: **499.8**
  * Average Processing Latency: **6.688 seconds**
  * Maximum Processing Latency: **13.556 seconds**
  * Consumer Lag: **0 msgs**

* **1000 EPS Target**:
  * Actual EPS: **998.0**
  * Average Processing Latency: **21.096 seconds**
  * Maximum Processing Latency: **41.804 seconds**
  * Consumer Lag: **0 msgs**

---

## 2. Container Resource Baseline (Idle)
Measured via `docker stats --no-stream` under baseline conditions:

* **PostgreSQL Container (`ledgerstream-postgres`)**:
  * CPU Usage: **4.96%**
  * Memory Usage: **179 MiB** (2.3% of 7.6 GiB limit)

* **Kafka Container (`ledgerstream-kafka`)**:
  * CPU Usage: **3.10%**
  * Memory Usage: **1.328 GiB** (17.47% of 7.6 GiB limit)

---

## 3. Notes
* Latency metrics represent database processing delays (producer launch timestamp joined with database log commit timestamp).
* The escalation in latency at higher EPS targets reflects PostgreSQL write queues under single-partition/single-threaded load.
