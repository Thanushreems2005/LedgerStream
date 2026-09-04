# LedgerStream Fraud Model Metadata

This file documents the ML model contract that the inference pipeline
(`consumer/ledger_consumer.py` and `fraud/fraud_consumer.py`) depends on.
It is intentionally dataset-agnostic: the exact feature values change when
the training dataset changes, but the *contract* (feature names, order, and
preprocessing) does not.

## Feature Contract

The served `RandomForestClassifier` expects exactly **6 numeric
features**, in this order:

| Index | Feature       | Source / construction                                             |
|-------|---------------|-------------------------------------------------------------------|
| 0     | `amount`      | transaction `amount` field (float)                                |
| 1     | `hour`        | hour-of-day (UTC) of transaction `timestamp`, 0–23                |
| 2     | `velocity`    | count of this sender's txs in the prior 30-min window (incl. current), capped at 20 |
| 3     | `log_amount`  | `log1p(amount)`                                                   |
| 4     | `is_night`    | `1.0` if hour < 6 or hour >= 23 else `0.0`                        |
| 5     | `amount_ratio`| `amount / mean(window amounts)` (mean over the 30-min window incl. current; `1.0` if mean <= 0) |

The single source of truth is `fraud/features.py`:
- `build_features_v3(df)` is used at train time by `train_model_v3.py`.
- `build_feature_vector(event, history)` is used at serve time by both
  consumers. The two share one definition for `velocity` and `amount_ratio`,
  guaranteeing train/serve parity for the window-based features.

At inference, each consumer's `build_feature_vector(event, history,
expected_width)` delegates to the shared builder and validates the width
against `model.n_features_in_`.

## Model Details

- **Algorithm**: `RandomForestClassifier` (scikit-learn)
- **Hyper-parameters**: `n_estimators=300, max_depth=10, random_state=42`
- **Artifact**: persisted to `fraud/fraud_model_v4.pkl` (the V4 training
  entrypoint is `fraud/train_model_v4.py`). The model weights are copied to the
  served locations `fraud/fraud_model.pkl` and `consumer/fraud_model.pkl`.
  Sidecar metadata: `fraud/fraud_model_v4.metadata.json`.
- **Target column**: `Class` (1 = fraud, 0 = not fraud)
- **Held-out split**: `train_test_split(test_size=0.2, stratify=y,
  random_state=42)` -> 56,962 test rows, 98 fraud, 56,864 non-fraud.
- **Held-out metrics**: AUC-PR 0.1131; best F1 0.2570 @ threshold 0.0897.
- **Probability output**: `predict_proba(...)[:, 1]` is the *estimated fraud
  probability* (0.0–1.0) used as the `risk_score`.

### Model Version History (controlled experiment)

- **V3 (superseded)**: `HistGradientBoostingClassifier` (`max_iter=300,
  max_depth=5, learning_rate=0.05`), AUC-PR 0.0637, best F1 0.1806. Retained
  as `fraud/fraud_model_v3.pkl` and `fraud/train_model_v3.py` for reference.
- **V4 (selected)**: `RandomForestClassifier` on the **identical six-feature
  contract**. Selected because it is a robust, statistically meaningful
  improvement on the primary ranking metric (PR-AUC 0.0637 -> 0.1131,
  bootstrap 95% CI relative to V3 excludes 0) and on the operating-threshold
  metrics (precision/recall/F1 all improve at the 0.10 HIGH threshold, e.g.
  F1 0.178 -> 0.239). The feature set, ordering, train/serve semantics, risk
  thresholds (LOW=0.01, HIGH=0.10), and live-inference path are all unchanged
  from V3, so no regression suite changes were needed (33/33 pass).

## Risk Policy (independent of the model / dataset)

The model emits only a fraud probability. A **separate** policy layer maps it
to a decision using thresholds that live in one central location
(`.env` / env vars, served to the frontend at `GET /api/config`):

```
score <  RISK_LOW_THRESHOLD           -> LOW   (APPROVE)
RISK_LOW_THRESHOLD <= score <= HIGH   -> MEDIUM(VERIFY/hold)
score >  RISK_HIGH_THRESHOLD          -> HIGH  (HOLD/block)
```

Thresholds: `RISK_LOW_THRESHOLD=0.01`, `RISK_HIGH_THRESHOLD=0.10` by default
(`<= HIGH` is MEDIUM, so `HIGH` means `score > 0.10`).

The risk classification NEVER depends on the transaction amount, account IDs,
timestamps, or any dataset-specific value. The amount is only an input feature
to the model.

## Replacing the Dataset

To retrain on a different fraud/payment dataset, generate these features from
that dataset's own amount/time/repetition semantics by editing
`fraud/features.py` (used by both training and serving), then run
`train_model_v3.py`. As long as the feature order and the `predict_proba[:,1]`
convention are preserved, inference, the risk policy, the demo generator, and
the frontend continue to work without code changes — only the model weights
and the resulting score distribution change.
