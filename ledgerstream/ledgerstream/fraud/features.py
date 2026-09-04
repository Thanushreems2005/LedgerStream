"""
LedgerStream shared V3 feature contract.

Single source of truth for the six V3 features the trained
HistGradientBoostingClassifier expects, in this exact order:

    [amount, hour, velocity, log_amount, is_night, amount_ratio]

There are two entry points:

* ``build_features_v3(df)``   - used at TRAIN time on the raw Kaggle
  DataFrame. `hour` is derived from the dataset's `Time` column
  (seconds-since-first-transaction), matching the validated audit exactly.

* ``build_feature_vector(event, history)`` - used at SERVE time on an
  incoming Kafka event. `hour` / `is_night` use the real UTC hour-of-day
  from the event timestamp (the same convention the shipped V1 model already
  uses); `velocity` and `amount_ratio` are recomputed from the account's
  timestamped 30-minute history in a way that matches training.

Both keep the SAME column order and the same time-window semantics for the
history-dependent features, so a cleanly loaded model is fed exactly the six
columns it was fitted on.
"""

from datetime import datetime, timedelta

import numpy as np
import pandas as pd

FEATURE_NAMES = ["amount", "hour", "velocity", "log_amount", "is_night", "amount_ratio"]
VELOCITY_WINDOW_SECONDS = 30 * 60  # prior 30 minutes, matching training
MAX_VELOCITY = 20  # matches training cap
# Serve-side history capacity: comfortably larger than the 30-minute window so
# that `amount_ratio` uses the same UNcapped window mean that training sees.
SERVE_HISTORY_CAP = 500


def build_features_v3(df: pd.DataFrame) -> pd.DataFrame:
    """EXACT validated V3 feature builder (identical to the audit)."""
    t = df["Time"].to_numpy()
    amount = df["Amount"].to_numpy()
    idx = np.argsort(t)
    ordered = t[idx]
    ordered_amounts = amount[idx]

    velocities = np.zeros(len(t), dtype=int)
    amount_means = np.zeros(len(t), dtype=float)

    for i, pos in enumerate(idx):
        end = _bisect_right(ordered, t[pos], 0, i + 1)
        start = _bisect_left(ordered, t[pos] - VELOCITY_WINDOW_SECONDS, 0, end)
        velocities[pos] = min(end - start, MAX_VELOCITY)
        window_amounts = ordered_amounts[start:end]
        if len(window_amounts) > 1:
            amount_means[pos] = window_amounts.mean()
        else:
            amount_means[pos] = amount[pos]

    hour = (t // 3600) % 24
    log_amount = np.log1p(amount)
    is_night = ((hour < 6) | (hour >= 23)).astype(float)
    with np.errstate(divide="ignore", invalid="ignore"):
        amount_ratio = np.where(amount_means > 0, amount / amount_means, 1.0)

    return pd.DataFrame({
        "amount": amount.astype(float),
        "hour": hour.astype(float),
        "velocity": velocities.astype(float),
        "log_amount": log_amount.astype(float),
        "is_night": is_night,
        "amount_ratio": amount_ratio.astype(float),
    })


def _bisect_right(a, x, lo, hi):
    while lo < hi:
        mid = (lo + hi) // 2
        if x < a[mid]:
            hi = mid
        else:
            lo = mid + 1
    return lo


def _bisect_left(a, x, lo, hi):
    while lo < hi:
        mid = (lo + hi) // 2
        if a[mid] < x:
            lo = mid + 1
        else:
            hi = mid
    return lo


def build_feature_vector(event: dict, history) -> np.ndarray:
    """Compute the six V3 features for a live event.

    ``history`` is an iterable of ``(timestamp_str, amount)`` for this account,
    including the current event as its LAST element, with ``maxlen`` large
    enough to hold a 30-minute window (see SERVE_HISTORY_CAP).

    Returns a ``(1, 6)`` float array ordered exactly like FEATURE_NAMES.
    """
    current_ts = datetime.fromisoformat(event["timestamp"])
    amount = float(event["amount"])
    hour = float(current_ts.hour)

    # Velocity + amount_ratio use the 30-minute TIME window (including the
    # current transaction), identical to training semantics.
    # Lower bound is INCLUSIVE to exactly mirror training's
    # `bisect_left(ordered, t[pos] - VELOCITY_WINDOW_SECONDS)`.
    window_cutoff = current_ts - timedelta(seconds=VELOCITY_WINDOW_SECONDS)
    window_amounts = []
    for ts_str, amt in history:
        ts = datetime.fromisoformat(ts_str)
        if ts >= window_cutoff:
            window_amounts.append(float(amt))

    velocity = float(min(len(window_amounts), MAX_VELOCITY))

    if len(window_amounts) > 1:
        mean = float(np.mean(window_amounts))
    elif len(window_amounts) == 1:
        mean = float(window_amounts[0])
    else:
        mean = 0.0

    if mean > 0:
        amount_ratio = amount / mean
    else:
        amount_ratio = 1.0

    is_night = 1.0 if (hour < 6 or hour >= 23) else 0.0
    log_amount = np.log1p(amount)

    return np.array(
        [amount, hour, velocity, log_amount, is_night, amount_ratio],
        dtype=float,
    ).reshape(1, -1)
