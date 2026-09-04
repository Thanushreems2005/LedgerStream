# Phase 8 - Railway Production Deployment Architecture

**Date**: 2026-08-30  
**Purpose**: Map out the multi-service topology for the production release on Railway.

---

## 1. Topography Map

```
                     ┌────────────────────────┐
                     │   React/Vite Frontend  │
                     │  (Vite Build / Preview)│
                     └───────────┬────────────┘
                                 │
                                 │ HTTP requests (CORS enabled)
                                 ▼
                     ┌────────────────────────┐
                     │    Node/Express API    │
                     │    (Port: ${PORT})     │
                     └─────┬───────────┬──────┘
                           │           │
       SQL Queries / Pool  │           │ Kafka Pub/Sub
                           ▼           ▼
  ┌────────────────────────┐           ┌────────────────────────┐
  │   PostgreSQL Database  │           │      Kafka Cluster     │
  │     (Railway Native)   │           │      (Kraft Mode)      │
  └────────────────────────┘           └──────────┬─────────────┘
               ▲                                  │
               │                                  │
               │ SQL updates                      │ Poll / Push
               │                                  │
     ┌─────────┴─────────┐              ┌─────────┴─────────┐
     │  Ledger Consumer  │              │   Fraud Consumer  │
     │  (Python Worker)  │              │  (Python Worker)  │
     └───────────────────┘              └───────────────────┘
```

---

## 2. Service Definitions

We will provision **6 distinct services** in the Railway project to replicate the local system with maximum modularity and reliability:

### 1. Database Service (PostgreSQL)
- **Type**: Railway Native PostgreSQL.
- **Role**: State storage for `accounts`, `transactions_log`, and `processed_events`.
- **Environment Variables Provided**: `DATABASE_URL` (automatically injected by Railway to other services via reference, e.g. `${{Postgres.DATABASE_URL}}`).

### 2. Kafka Service (Message Broker)
- **Type**: Docker image service (`confluentinc/cp-kafka:7.6.0`).
- **Role**: Ingestion pipeline broker in KRaft mode.
- **Port**: `9092` (internal) and a TCP proxy port for external client connections.
- **Environment Variables**:
  - `KAFKA_NODE_ID`: `1`
  - `KAFKA_PROCESS_ROLES`: `broker,controller`
  - `KAFKA_LISTENERS`: `PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093`
  - `KAFKA_ADVERTISED_LISTENERS`: `PLAINTEXT://ledgerstream-kafka.railway.internal:9092` (or Railway internal reference)
  - `KAFKA_LISTENER_SECURITY_PROTOCOL_MAP`: `CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT`
  - `KAFKA_CONTROLLER_LISTENER_NAMES`: `CONTROLLER`
  - `KAFKA_CONTROLLER_QUORUM_VOTERS`: `1@localhost:9093`
  - `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR`: `1`
  - `KAFKA_AUTO_CREATE_TOPICS_ENABLE`: `true`
  - `CLUSTER_ID`: `lZWk5Yw0Tiq9ONZadOe9oA==`

### 3. API Service (Backend)
- **Type**: Node.js/Express service.
- **Source Directory**: `ledgerstream/ledgerstream/api/`
- **Role**: Handles client endpoints, queries Postgres, monitors Kafka lag, and streams alerts.
- **Port**: Dynamic `${PORT}` mapped to private/public domain.
- **Environment Variables**:
  - `PORT`: `${{PORT}}`
  - `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
  - `KAFKA_BROKER`: `ledgerstream-kafka.railway.internal:9092`
  - `CORS_ORIGIN`: `${{Frontend.RAILWAY_STATIC_URL}}`

### 4. Frontend Service
- **Type**: Static/Vite Node build.
- **Source Directory**: `ledgerstream/ledgerstream/frontend/`
- **Role**: React dashboard console.
- **Environment Variables**:
  - `VITE_API_URL`: `${{API.RAILWAY_STATIC_URL}}`

### 5. Ledger Consumer Service
- **Type**: Python background worker (no public ports).
- **Source Directory**: `ledgerstream/ledgerstream/consumer/`
- **Role**: Sequential pre-settlement AI check and Postgres balance lock/commit.
- **Environment Variables**:
  - `PG_DSN`: `${{Postgres.DATABASE_URL}}`
  - `KAFKA_BOOTSTRAP_SERVERS`: `ledgerstream-kafka.railway.internal:9092`
  - `RISK_LOW_THRESHOLD`: `0.50`
  - `RISK_HIGH_THRESHOLD`: `0.96`

### 6. Fraud Consumer Service
- **Type**: Python background worker (no public ports).
- **Source Directory**: `ledgerstream/ledgerstream/fraud/`
- **Role**: Mirror consumer for logging fraud-alerts topic statistics.
- **Environment Variables**:
  - `KAFKA_BOOTSTRAP_SERVERS`: `ledgerstream-kafka.railway.internal:9092`
