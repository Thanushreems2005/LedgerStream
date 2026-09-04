"""
LedgerStream Fraud Model Training (V4 — winning model, controlled experiment)

Model selection (Phase 4–6 of the ML experiment):
The RandomForestClassifier on the SAME six V3 features materially and robustly
outperforms the V3 HistGradientBoostingClassifier on PR-AUC (primary ranking
metric) and on the operating-threshold precision/recall/F1, while keeping the
exact 6-feature contract that the inference pipeline and regression suite lock:

    [amount, hour, velocity, log_amount, is_night, amount_ratio]

Metrics (held-out test, test_size=0.20, stratify=y, random_state=42,
56,962 rows / 98 fraud / 56,864 non-fraud):

    HGB (V3):  PR-AUC 0.0637 | best F1 0.1806 | @0.10 P=0.237 R=0.143 F1=0.178
    RF  (V4):  PR-AUC 0.1131 | best F1 0.2570 | @0.10 P=0.269 R=0.214 F1=0.239

Bootstrap (1000 resamples, PR-AUC diff vs V3): mean +0.052, 95% CI
[+0.0065, +0.1028] (excludes 0), P(diff>0)=0.986 -> statistically meaningful.

The feature contract is UNCHANGED from V3, so:
  - `features.py` is untouched (6 features, same order, same semantics).
  - live inference `build_feature_vector` is unchanged.
  - regression tests remain 33/33 (they assert the 6-feature contract, not the
    algorithm).
  - risk thresholds (LOW=0.01, HIGH=0.10) are unchanged.

Usage:
    python train_model_v4.py
"""
import json
import pickle

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import average_precision_score, precision_recall_curve
from sklearn.model_selection import train_test_split

from features import FEATURE_NAMES, build_features_v3

DATA_PATH = "creditcard.csv"
MODEL_OUT = "fraud_model_v4.pkl"
METADATA_OUT = "fraud_model_v4.metadata.json"

N_ESTIMATORS = 300
MAX_DEPTH = 10
RANDOM_STATE = 42

# Expected held-out results (sanity gate).
EXPECTED_N_TEST = 56962
EXPECTED_N_FRAUD = 98
EXPECTED_AUCPR = 0.1131


def _find_best_f1(probs, y_true):
    precision, recall, thresholds = precision_recall_curve(y_true, probs)
    with np.errstate(divide="ignore", invalid="ignore"):
        f1 = np.where(
            (precision + recall) > 0,
            2 * precision * recall / (precision + recall),
            0.0,
        )
    best = int(np.argmax(f1))
    thr = thresholds[best] if best < len(thresholds) else thresholds[-1]
    return thr, precision[best], recall[best], f1[best]


def main():
    df = pd.read_csv(DATA_PATH)
    y = df["Class"]
    print(f"loaded {len(df)} rows, fraud rate = {y.mean():.4%}")

    X = build_features_v3(df)
    assert list(X.columns) == FEATURE_NAMES, (list(X.columns), FEATURE_NAMES)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )

    n_test = len(y_test)
    n_fraud = int(y_test.sum())
    n_non = n_test - n_fraud
    print(f"\nTest samples:  {n_test} "
          f"(fraud {n_fraud}, non-fraud {n_non}, rate {n_fraud / n_test:.4%})")
    if n_test != EXPECTED_N_TEST or n_fraud != EXPECTED_N_FRAUD:
        raise SystemExit(
            f"split mismatch: got {n_test}/{n_fraud}, "
            f"expected {EXPECTED_N_TEST}/{EXPECTED_N_FRAUD}"
        )

    model = RandomForestClassifier(
        n_estimators=N_ESTIMATORS,
        max_depth=MAX_DEPTH,
        random_state=RANDOM_STATE,
        n_jobs=-1,
    )
    # Fit on a positional numpy array (column order == FEATURE_NAMES) so the
    # persisted model does not expect DataFrame column names at serve time.
    model.fit(X_train.to_numpy(), y_train)

    probs = model.predict_proba(X_test.to_numpy())[:, 1]
    aucpr = average_precision_score(y_test, probs)
    best_thr, bp, br, bf1 = _find_best_f1(probs, y_test)

    print(f"\nV4 (RF) AUC-PR:  {aucpr:.4f}  (audit 0.1131)")
    print(f"V4 (RF) best-F1: thr={best_thr:.4f} P={bp:.4f} R={br:.4f} F1={bf1:.4f}")

    for thr in (0.01, 0.05, 0.10, 0.50):
        flag = probs > thr
        prec = flag.sum() == 0 and 0.0 or (y_test[flag].sum() / flag.sum())
        rec = y_test[flag].sum() / n_fraud
        print(f"  @{thr:<.2f} prec={prec:.4f} rec={rec:.4f} flag%={(flag.sum() / n_test) * 100:.2f}%")

    if abs(aucpr - EXPECTED_AUCPR) > 0.005:
        print("WARNING: AUC-PR deviates from audit; not persisting.")
        return

    with open(MODEL_OUT, "wb") as f:
        pickle.dump(model, f)

    metadata = {
        "model_type": "RandomForestClassifier",
        "model_version": "V4",
        "selected_over": "V3 (HistGradientBoostingClassifier) - meaningful PR-AUC "
                         "and operating-threshold improvement on identical 6-feature contract",
        "hyperparameters": {
            "n_estimators": N_ESTIMATORS,
            "max_depth": MAX_DEPTH,
            "random_state": RANDOM_STATE,
        },
        "feature_names": FEATURE_NAMES,
        "n_features": len(FEATURE_NAMES),
        "feature_order": FEATURE_NAMES,
        "target": "Class",
        "probability_output": "predict_proba[:, 1]",
        "split": {
            "test_size": 0.2,
            "stratify": "y",
            "random_state": 42,
            "n_test": n_test,
            "n_fraud": n_fraud,
            "n_non_fraud": n_non,
        },
        "held_out_metrics": {
            "auc_pr": round(aucpr, 4),
            "best_f1": round(bf1, 4),
            "best_f1_threshold": round(best_thr, 4),
        },
        "audit_gate": {"expected_auc_pr": EXPECTED_AUCPR},
    }
    with open(METADATA_OUT, "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\nsaved model to {MODEL_OUT}")
    print(f"saved metadata to {METADATA_OUT}")


if __name__ == "__main__":
    main()
