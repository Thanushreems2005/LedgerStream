# Phase 4 Initial Audit Report

This report presents the initial audit of risk classification thresholds, feature ordering, and risk policies across the LedgerStream codebase.

---

## 1. Threshold Definitions
The repository was audited for risk threshold declarations (`0.50`, `0.96`, `LOW`, `MEDIUM`, `HIGH`, `APPROVE`, `VERIFY`, `HOLD`, `BLOCK`).

The definitions are consolidated and identical in all consumers:
* **`ledger_consumer.py`**:
  * `LOW_CAP = 0.50`
  * `VERIFY_CAP = 0.96`
  * Policies: score < `0.50` -> LOW/APPROVE, `[0.50, 0.96)` -> MEDIUM/VERIFY, >= `0.96` -> HIGH/HOLD.
* **`fraud_consumer.py`**:
  * `LOW_CAP = 0.50`
  * `VERIFY_CAP = 0.96`
  * Policies match ledger consumer exactly.
* **`server.js`**:
  * Returns `threshold: 0.96` in `/api/stats` for front-end rendering.
* **`App.jsx`**:
  * Mapped to the same risk score bands.

No conflicting risk policies or duplicated/contradictory decision gates exist.

---

## 2. Feature Schema & Order
The model inputs are structured exactly identically during training (`train_model.py`) and inference serving (`ledger_consumer.py` / `fraud_consumer.py`):
1. **`amount`** (float) -> Direct transfer value.
2. **`hour`** (float) -> Time-of-day integer extracted from timestamp string.
3. **`velocity`** (float) -> Rolling transaction count of the account (window size 20).

No train/serve feature skew exists.

---

## 3. Explanations
* **Explanations Mechanism**: The risk reasons rendered in the UI are **heuristic rule explanations** derived from the inputs (late-night hours, velocity bursts, and spikes in transaction averages), not model-native attributions (SHAP values).
* **Readiness**: This is documented clearly to avoid false model-native explainability claims.
