# Final Judge Demo Guide
# LedgerStream — Razorpay Track 02 Buildathon

**Duration**: 3–5 minutes  
**Core message**: "Fraud detection is useless if the money has already moved."

---

## Before You Start

1. Run `powershell -File scripts/start_demo.ps1` — wait for all services to be live
2. Open `http://localhost:5173` in a browser
3. Open a second terminal for demo transactions
4. Verify the **LIVE** indicator is green in the top-right of the dashboard

---

## 0:00 — Opening Statement (30 seconds)

**Say:**
> "Every payment system has fraud detection. But most of them detect fraud *after* the money has moved. They flag the transaction, send an alert, and then begin a slow recovery process. The money is already gone."
>
> "LedgerStream takes a different approach. The AI risk model runs *before* the ledger write. If a transaction is suspicious, the money never leaves the sender's account. This is pre-settlement prevention, not post-settlement detection."

**Show:** The top of the dashboard — KPIs showing Blocked and Held counts.

---

## 0:30 — Architecture (30 seconds)

**Say:**
> "The architecture is: Kafka receives the transaction event. The Ledger Consumer reads it and immediately runs it through the XGBoost fraud model — before touching any balance. Based on the score, it either settles, holds, or blocks."

**Point to the Risk Flow Diagram** in the dashboard and trace: LOW → SETTLE, MEDIUM → HOLD, HIGH → BLOCK.

---

## 1:00 — DEMO 1: LOW Risk Transaction (30 seconds)

**Run in terminal:**
```powershell
powershell -File scripts/demo_scenario.ps1 -scenario LOW
```

**Say:**
> "This is a normal, low-risk transaction. The AI scores it below the threshold. Watch the dashboard — it settles automatically."

**Show:**
- Transaction appears in the feed with status **applied**
- Account balances update in the Balances panel
- Risk score is below 50%

---

## 1:30 — DEMO 2: MEDIUM Risk — Hold (60 seconds)

**Run in terminal:**
```powershell
powershell -File scripts/demo_scenario.ps1 -scenario MEDIUM
```

**Say:**
> "This transaction has characteristics the AI considers suspicious — late hour, elevated amount, velocity signals. The score is between 50% and 96%. The AI says: don't settle this yet. Hold it."

**Show:**
- Transaction appears with status **held**
- **The account balances do NOT change** — verify in the Balances panel
- The transaction appears in the **Analyst Review Queue**

**Say:**
> "The money has not moved. The sender's balance is unchanged. The receiver has received nothing. This is the core protection."

**Then:** Click **Approve** in the review queue.

**Say:**
> "An analyst has reviewed the transaction and approved it. Now watch the balances."

**Show:**
- Status changes to **applied**
- Sender balance decreases by the amount
- Receiver balance increases by the amount

---

## 2:30 — DEMO 3: HIGH Risk — Block (30 seconds)

**Run in terminal:**
```powershell
powershell -File scripts/demo_scenario.ps1 -scenario HIGH
```

**Say:**
> "This is a high-risk transaction. Score above 96%. The AI blocks it instantly — no analyst needed."

**Show:**
- Transaction appears with status **blocked**
- It appears in the **Blocked Transactions** panel
- **The account balances do NOT change**

**Say:**
> "No money moved. No manual intervention was required. The system protected the funds automatically in milliseconds."

---

## 3:00 — Business Impact (30 seconds)

**Point to the Business Impact panel:**

**Say:**
> "The Business Impact panel shows the real-world consequence of these decisions. Every blocked transaction represents money that was protected before it could leave the system."

**Point out:**
- Transactions analyzed (total scored)
- Transactions held for review
- Transactions blocked (instant prevention)
- Estimated protected funds (sum of blocked + declined amounts)

---

## 3:30 — Safety Guarantees (30 seconds)

**Say:**
> "The system is built with strict safety guarantees. 25 automated regression tests verify every decision path. The PostgreSQL database commit always happens before the Kafka offset commit — so there is no window for money to disappear. And every transaction is idempotent — even if Kafka delivers the same event twice, the balance only changes once."

**Show:** Point to the System Health section — total balance conserved.

---

## 4:00 — Closing (30 seconds)

**Say:**
> "LedgerStream doesn't just detect financial fraud. It prevents suspicious money from moving in the first place. LOW risk settles instantly. MEDIUM risk waits for analyst review — money frozen. HIGH risk is blocked — money protected, permanently."
>
> "This is what active pre-settlement AI risk management looks like."

---

## Fallback Notes

- If the dashboard shows **OFFLINE**: API may not be running — check `api_launcher.ps1`
- If balances don't update after approval: refresh manually (the dashboard polls every 2.5s)
- If the review queue is cluttered with old held records: note that these are from previous test runs and the demo transaction appears at the top
