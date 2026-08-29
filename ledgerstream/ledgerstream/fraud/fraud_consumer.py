"""
LedgerStream Fraud Consumer (Day 5, part 2)

Reads the SAME `transactions` topic as the ledger consumer, but as its own
independent consumer group (`fraud-consumer-group`). Kafka delivers a full
copy of the stream to each consumer group, so this runs in parallel with
zero interference - if this process crashes, ledger processing is
unaffected, and vice versa. That independence is the point: worth calling
out explicitly in interviews.

Feature engineering note (read train_model.py's docstring for the full
explanation): the Kaggle model was trained on real swipe-data PCA features
that don't exist on a synthetic transfer event. Rather than faking those
28 features, this consumer builds a small, honest feature vector from
things the event actually has - amount, hour-of-day, and the sender's
rolling transaction count in the last N events (a simple velocity signal,
recomputed in-memory here; a production version would keep this in Redis).
Padding to the model's expected input width with zeros is a known
simplification - call it out as exactly that in interviews, don't oversell it.

Risk decision layer (Day 1): every scored event gets a decision band derived
only from the risk_score - LOW/APPROVE, MEDIUM/VERIFY, HIGH/HOLD - plus a
human-readable `reasons[]` array built ONLY from amount, hour, and velocity
(the 3 real features). If nothing stands out it says so plainly; no
fabricated explanations. Alerts (score >= threshold) carry all of it.

Validity gate: before scoring, the event must pass the same basic payment
validity check the ledger consumer uses (required fields, from != to,
amount > 0). Malformed / DLQ-bound events are skipped WITHOUT a risk
decision - scoring them would misrepresent what the model protects against.

Usage:
    python fraud_consumer.py --threshold 0.7
"""

import argparse
import json
import pickle
from collections import defaultdict, deque
from datetime import datetime, timezone

import numpy as np
from confluent_kafka import Consumer, KafkaException, Producer

BOOTSTRAP_SERVERS = "localhost:9092"
TOPIC = "transactions"
ALERTS_TOPIC = "fraud-alerts"
GROUP_ID = "fraud-consumer-group"
MODEL_PATH = "fraud_model.pkl"

VELOCITY_WINDOW = 20  # last N transactions per account, kept in memory

# --- Risk decision bands (threshold of the fraud-alerts gate) ------------
# Risky => the higher bands are read-only observability for every event;
# only scores >= threshold emit to the fraud-alerts topic.
LOW_CAP = 0.50          # score < 0.50  -> LOW/APPROVE
VERIFY_CAP = 0.96       # 0.50 <= score < 0.96 -> MEDIUM/VERIFY (default threshold)
# score >= 0.96 -> HIGH/HOLD

# --- Reason heuristics: honestly derived from the event's OWN data only ---
LATE_NIGHT_HOUR_MIN = 6      # 06:00 UTC and later is a normal business hour
LATE_NIGHT_HOUR_FLAG = 23    # >= 23:00 UTC counts as late-night
LATE_NIGHT_HOUR_TEXT_MIN = 0  # 00:00-05:59 also late-night
AMOUNT_HIGH_MULTIPLIER = 3.0  # vs the sender's recent mean transfer amount
MIN_AMOUNT_SAMPLES = 3        # need this many prior transfers before judging
VELOCITY_BURST_THRESHOLD = 10  # events seen for the sender in VELOCITY_WINDOW


def load_model():
    with open(MODEL_PATH, "rb") as f:
        return pickle.load(f)


def decide_risk(score: float):
    """Map the model's risk score to a business decision band."""
    if score < LOW_CAP:
        return "LOW", "APPROVE"
    if score < VERIFY_CAP:
        return "MEDIUM", "VERIFY"
    return "HIGH", "HOLD"


def validate_event(event: dict) -> str | None:
    """Mirror of the ledger consumer's validity check (ledger_consumer.py
    `validate()`): required fields present, from != to, amount > 0.

    Returns an error reason string if invalid, else None. `timestamp` is
    additionally required here because scoring needs it."""
    required = ("event_id", "from_account", "to_account", "amount", "timestamp")
    for field in required:
        if field not in event:
            return f"missing_field:{field}"
    if event["from_account"] == event["to_account"]:
        return "same_account"
    if not isinstance(event["amount"], (int, float)) or event["amount"] <= 0:
        return "invalid_amount"
    return None


def build_reasons(event: dict, history, velocity: int) -> list:
    """Explain the decision using ONLY amount, hour, and velocity.

    Heuristic thresholds are fixed here and deliberately modest; if nothing
    stands out we say exactly that - no invented explanations.
    """
    ts = datetime.fromisoformat(event["timestamp"])
    hour = ts.hour
    amount = float(event["amount"])
    reasons = []

    if hour >= LATE_NIGHT_HOUR_FLAG or LATE_NIGHT_HOUR_TEXT_MIN <= hour < LATE_NIGHT_HOUR_MIN:
        reasons.append(f"late-night hour {hour:02d} UTC")

    prior_amounts = [amt for (_, amt) in list(history)[:-1]]
    if len(prior_amounts) >= MIN_AMOUNT_SAMPLES:
        avg = sum(prior_amounts) / len(prior_amounts)
        if avg > 0 and amount > AMOUNT_HIGH_MULTIPLIER * avg:
            reasons.append(
                f"amount {amount:.2f} is {amount / avg:.1f}x the sender's "
                f"recent average {avg:.2f}"
            )

    if velocity >= VELOCITY_BURST_THRESHOLD:
        reasons.append(f"velocity burst: {velocity} transfers in the recent window")

    if not reasons:
        reasons.append("no unusual signals in amount, hour, or velocity")
    return reasons


def build_feature_vector(event: dict, velocity: int, expected_width: int) -> np.ndarray:
    ts = datetime.fromisoformat(event["timestamp"])
    hour = ts.hour
    amount = event["amount"]

    engineered = np.array([amount, hour, velocity], dtype=float)
    padding = np.zeros(max(expected_width - len(engineered), 0))
    features = np.concatenate([engineered, padding])[:expected_width].reshape(1, -1)
    return features


def main():
    parser = argparse.ArgumentParser()
    # Threshold chosen from held-out PR-curve analysis: max F1 for the fraud
    # class on the retrained 3-feature model is at thr=0.96 (P=0.21, R=0.15).
    # Known limitation (do NOT oversell): AUC-PR=0.0488 and fraud-class
    # precision ~0.007@thr=0.5 on this 3-feature model - the Kaggle PCA
    # features that carried the real signal don't exist on ledger transfers.
    parser.add_argument("--threshold", type=float, default=0.96,
                         help="risk score above which a transaction is flagged")
    args = parser.parse_args()

    model = load_model()
    expected_width = model.n_features_in_

    consumer = Consumer({
        "bootstrap.servers": BOOTSTRAP_SERVERS,
        "group.id": GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": True,  # scoring is not the source of truth; simple auto-commit is fine here
    })
    consumer.subscribe([TOPIC])

    alert_producer = Producer({"bootstrap.servers": BOOTSTRAP_SERVERS})
    recent_by_account = defaultdict(lambda: deque(maxlen=VELOCITY_WINDOW))

    band_counts = {"LOW": 0, "MEDIUM": 0, "HIGH": 0}
    processed = 0
    alert_count = 0

    print(f"[fraud] consumer started, group={GROUP_ID}, threshold={args.threshold}")
    try:
        while True:
            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                raise KafkaException(msg.error())

            try:
                event = json.loads(msg.value())
            except json.JSONDecodeError:
                continue  # malformed events are the ledger consumer's / DLQ's problem, not ours

            invalid = validate_event(event)
            if invalid:
                # Malformed / DLQ-bound event: NOT a real payment risk case.
                # Skip scoring entirely - no risk decision, no alert - so the
                # model output isn't skewed by events it was never meant to
                # protect against. (The ledger consumer routes these to the DLQ.)
                print(
                    f"[fraud] SKIP event={event.get('event_id')} "
                    f"reason={invalid} (malformed, not scored)"
                )
                continue

            account = event["from_account"]
            history = recent_by_account[account]
            history.append((event["timestamp"], event["amount"]))
            velocity = len(history)

            try:
                features = build_feature_vector(event, velocity, expected_width)
                score = float(model.predict_proba(features)[0, 1])
            except Exception as e:
                print(f"[fraud] scoring error for event {event.get('event_id')}: {e}")
                continue

            risk_level, action = decide_risk(score)
            reasons = build_reasons(event, history, velocity)
            band_counts[risk_level] += 1
            processed += 1

            print(
                f"[fraud] event={event['event_id']} score={score:.3f} "
                f"level={risk_level} action={action} reasons={reasons}"
            )

            if score >= args.threshold:
                alert = {
                    "event_id": event["event_id"],
                    "from_account": account,
                    "to_account": event.get("to_account"),
                    "amount": event["amount"],
                    "risk_score": round(score, 4),
                    "risk_level": risk_level,
                    "action": action,
                    "reasons": reasons,
                    "flagged_at": datetime.now(timezone.utc).isoformat(),
                }
                alert_producer.produce(
                    ALERTS_TOPIC,
                    key=account.encode("utf-8"),
                    value=json.dumps(alert).encode("utf-8"),
                )
                alert_producer.poll(0)
                alert_count += 1
                print(f"[fraud] ALERT event_id={event['event_id']} score={score:.3f} action={action}")

            if processed and processed % 200 == 0:
                print(
                    f"[fraud] tallies after {processed} events: "
                    f"LOW={band_counts['LOW']} MEDIUM={band_counts['MEDIUM']} "
                    f"HIGH={band_counts['HIGH']} alerts={alert_count}"
                )

    except KeyboardInterrupt:
        print("\n[fraud] shutting down...")
    finally:
        alert_producer.flush()
        consumer.close()


if __name__ == "__main__":
    main()
