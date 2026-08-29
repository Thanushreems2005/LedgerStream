"""
LedgerStream Fraud Model Training (Day 5, part 1)

Trains an XGBoost classifier on the Kaggle "Credit Card Fraud Detection"
dataset (download creditcard.csv from Kaggle and place it in this folder -
it's not bundled here due to size/licensing).
https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud

The dataset is heavily imbalanced (~0.17% fraud), so this uses
scale_pos_weight rather than relying on raw accuracy - and reports
precision/recall/AUC-PR instead of accuracy, since accuracy is meaningless
on this class distribution (a model that predicts "not fraud" every time
would score ~99.8% accuracy and be useless).

Feature alignment (read carefully - this was changed deliberately):
The full Kaggle row is Time + V1..V28 + Amount. `fraud_consumer.py` scores
the LIVE synthetic ledger stream, and those transfers carry NO PCA features
(V1..V28) - only amount, a timestamp, and the sender's rolling velocity.
Padding the V-slots with zeros essentially pins every live event to the
model's "not fraud" region (verified: max achievable score ~0.01 against a
0.7 threshold), so the consumer could NEVER alert. To keep training and
production in one honest feature space, we now train on exactly the three
features `fraud_consumer.py` computes from the raw Kaggle row:

    amount      -> Kaggle Amount
    hour        -> time-of-day derived from Kaggle Time (seconds -> hour)
    velocity    -> rolling count of this card's transactions in the prior
                   30 minutes (burstable behaviour, capped at 20 to match
                   the consumer's VELOCITY_WINDOW)

The real fraud/non-fraud Class labels still come from the genuine Kaggle
data. We are only changing WHICH columns feed the model - not inventing
labels or fabricating features. State this plainly in interviews.

Usage:
    python train_model.py
"""

import bisect
import pickle

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, classification_report
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier

DATA_PATH = "creditcard.csv"
MODEL_OUT = "fraud_model.pkl"
VELOCITY_WINDOW_SECONDS = 30 * 60  # prior 30 minutes of a card's activity
MAX_VELOCITY = 20  # matches fraud_consumer.VELOCITY_WINDOW


def build_stream_features(df: pd.DataFrame) -> pd.DataFrame:
    """Project the raw Kaggle rows into the feature space refrained_consumer.py
    actually has at inference time: amount, hour-of-day, sender velocity."""
    t = df["Time"].to_numpy()  # seconds since first transaction (one card per dataset)
    idx = np.argsort(t)
    ordered = t[idx]
    velocities = np.zeros(len(t), dtype=int)
    for i, pos in enumerate(idx):
        end = bisect.bisect_right(ordered, t[pos], 0, i + 1)
        start = bisect.bisect_left(ordered, t[pos] - VELOCITY_WINDOW_SECONDS, 0, end)
        velocities[pos] = min(end - start, MAX_VELOCITY)

    hour = (t // 3600) % 24
    return pd.DataFrame({
        "amount": df["Amount"].astype(float),
        "hour": hour.astype(float),
        "velocity": velocities.astype(float),
    })


def main():
    df = pd.read_csv(DATA_PATH)
    print(f"loaded {len(df)} rows, fraud rate = {df['Class'].mean():.4%}")

    X = build_stream_features(df)
    y = df["Class"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )

    # class imbalance handling: weight the minority (fraud) class instead
    # of resampling, so the model still sees the true data distribution
    neg, pos = np.bincount(y_train)
    scale_pos_weight = neg / pos
    print(f"scale_pos_weight = {scale_pos_weight:.1f}")

    model = XGBClassifier(
        n_estimators=300,
        max_depth=5,
        learning_rate=0.05,
        scale_pos_weight=scale_pos_weight,
        eval_metric="aucpr",
        random_state=42,
    )
    model.fit(X_train, y_train)

    probs = model.predict_proba(X_test)[:, 1]
    preds = (probs >= 0.5).astype(int)

    print("\n--- Test set performance (accuracy is NOT reported - meaningless here) ---")
    print(classification_report(y_test, preds, digits=3))
    print(f"AUC-PR: {average_precision_score(y_test, probs):.4f}")

    with open(MODEL_OUT, "wb") as f:
        pickle.dump(model, f)
    print(f"\nmodel saved to {MODEL_OUT}")


if __name__ == "__main__":
    main()
