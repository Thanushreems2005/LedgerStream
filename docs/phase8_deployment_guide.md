# LedgerStream RM — Railway & Aiven Deployment Guide

This guide describes how to deploy **LedgerStream RM** to production using **Railway's Free Plan** and **Aiven's Free Kafka** tier.

---

## 1. Architecture Overview

To stay within the constraints of Railway's Free Plan, the deployment topology is consolidated into **two services**:

1. **PostgreSQL Service (Railway Native)**: Handles accounts state, processed events, and transaction logging.
2. **LedgerStream RM App Service (Consolidated)**: A single Node.js runtime Docker container that:
   - Serves the compiled React static frontend files (`public/`).
   - Runs the Express API server (port 3001/dynamic `${PORT}`).
   - Spawns the Ledger Consumer (AI check & PG settlements) as a background process.
   - Spawns the Fraud Consumer (alerts logger) as a background process.

The message broker uses **Aiven Apache Kafka (Free Tier)** over a secure `SASL_SSL` (SCRAM-SHA-256) connection.

---

## 2. Aiven Kafka Broker Setup

1. Go to the [Aiven Console](https://console.aiven.io/) and create an **Apache Kafka** service.
2. Choose the **Free** tier (AWS/GCP, no credit card required).
3. Once running, go to the **Topics** tab and add three topics with **1 partition** each:
   - `transactions`
   - `fraud-alerts`
   - `transactions-dlq`
4. From the **Overview** tab, copy:
   - **Service URI**: This is `KAFKA_BOOTSTRAP_SERVERS`.
   - **SASL Username**: `avnadmin`.
   - **SASL Password**: Retrieved from the Users section.

---

## 3. Railway Database Provisioning

If not already provisioned:
1. Create a new project named `LedgerStream-RM` on Railway:
   ```bash
   railway init --name LedgerStream-RM
   ```
2. Provision PostgreSQL:
   ```bash
   railway add --database postgres --json
   ```
3. Expose the Postgres port locally using a TCP proxy to run the database setup:
   ```bash
   railway tcp-proxy create --port 5432 --service Postgres
   ```
4. Set the local variable and execute the init script:
   ```powershell
   $env:DATABASE_URL="postgresql://postgres:{password}@{tcp-proxy-endpoint}/railway"
   python init-db/init_production_db.py
   ```

---

## 4. Deploying the Application

1. Add a new service for the consolidated application:
   ```bash
   railway add --service app --json
   ```
2. Link the environment variables on the `app` service:
   - `KAFKA_BOOTSTRAP_SERVERS` = *(Aiven Service URI)*
   - `KAFKA_SASL_USERNAME` = `avnadmin`
   - `KAFKA_SASL_PASSWORD` = *(Aiven password)*
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `NODE_ENV` = `production`
   - `API_PORT` = `3001`
   - `RISK_LOW_THRESHOLD` = `0.50`
   - `RISK_HIGH_THRESHOLD` = `0.96`
3. Execute the deployment upload from `ledgerstream/ledgerstream/` directory:
   ```bash
   railway up --service app
   ```
4. Once deployed, Railway will generate a public domain (e.g. `https://app-production.up.railway.app`). Set this domain in the `CORS_ORIGIN` variable of the app service if needed.
