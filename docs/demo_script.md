# Buildathon Demo Script: Razorpay Track 02 AI Risk Manager

This guide describes how to run and demonstrate the **LedgerStream Active AI Risk Prevention Gateway** to judges during evaluation.

---

## Pitch: "Prevention Before Settlement"
> "Most fraud-monitoring tools are passive—they flag a transaction *after* it settles and the money has left the system. 
> Razorpay AI Risk Manager intercepts transactions *before* they are applied to the ledger. If it's safe (LOW), it settles instantly. If it's suspicious (MEDIUM), we hold settlement and notify analysts. If it's a critical threat (HIGH), we block it instantly, protecting funds without manual intervention."

---

## 1. Startup & Preparation
1. Open PowerShell in the root directory.
2. Launch the entire stack using the unified startup script:
   `powershell -File scripts/start_demo.ps1`
3. Verify that the Docker containers, Python consumers, API backend, and Vite frontend load.
4. Access the operations console at `http://localhost:5173`.
5. Point out that the system balances sum to exactly **$347,000.00** and that total funds remain conserved across all demonstrations.

---

## 2. Demonstration Workflows

### DEMO 1: Automatic LOW-Risk Settlement
* **Concept**: Automatic routing of low-risk transfers.
* **Flow**:
  1. Trigger a safe transaction (e.g. amount $10.00, normal business hour, low account velocity).
  2. Point out that the transaction settles instantly (status `applied`).
  3. Show the ledger updates: the sender's account balance decreases by $10.00, and the receiver's increases by $10.00.

### DEMO 2: MEDIUM-Risk Holding & Analyst Approval
* **Concept**: Suspending settlement for review, followed by successful manual recovery.
* **Flow**:
  1. Trigger a suspicious transaction (e.g. amount $120.00, late-night transfer, moderate velocity).
  2. Point out that the transaction status reads **HELD** and balances are **NOT** modified ($0.00 impact).
  3. Navigate to the **Analyst Review Queue** on the React console.
  4. Show the score, reasons (e.g. late night hour), and transfer details.
  5. Click **Approve**.
  6. Point out that the status changes to `applied` in the logs, and balances now update exactly once.

### DEMO 3: MEDIUM-Risk Holding & Analyst Decline
* **Concept**: Suspending settlement for review, followed by declining the transfer.
* **Flow**:
  1. Trigger another suspicious transaction.
  2. The transaction enters **HELD** state. Balances are unchanged.
  3. Locate it in the review queue and click **Decline**.
  4. Point out that status updates to `declined`, the card leaves the review list, and account balances remain completely untouched.

### DEMO 4: HIGH-Risk Automatic Prevention
* **Concept**: Instant automatic prevention of severe threats.
* **Flow**:
  1. Trigger a high-risk transaction (e.g. amount $900.00, late night hour, velocity threshold violation).
  2. Point out that the transaction is instantly labeled **BLOCKED** by the consumer (status `blocked`).
  3. Balance impact reads **$0.00**. No manual action is available—loss has been fully prevented.
  4. Show the transaction in the **Blocked Transactions (Prevented Fraud)** panel.

---

## 3. Core Evidence Checklist
* **Conserved Balance**: Point out that the sum of balances is still exactly **$347,000.00**, proving transaction integrity.
* **Structured Logs**: Show JSON outputs in the consumer terminal displaying `TRANSACTION_RECEIVED`, `RISK_SCORED`, `TRANSACTION_HELD`, `TRANSACTION_BLOCKED` tags.
* **State Machine Guards**: Explain that double approvals or declined-to-approved transition attempts are fully prevented in the backend by row locks (`SELECT FOR UPDATE`).
