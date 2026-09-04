"""
LedgerStream Fraud Consumer (Day 5, part 2)

Reads the SAME `transactions` topic as the ledger consumer, but as its own
independent consumer group (`fraud-consumer-group`). Kafka delivers a full
copy of the stream to each consumer group, so this runs in parallel with
zero interference.
"""

import argparse
import json
import logging
import os
import pickle
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone, timedelta

import numpy as np
from confluent_kafka import Consumer, KafkaException, Producer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [fraud] %(message)s")
log = logging.getLogger(__name__)

# --- Environment Configurations (Step 3) -----------------------------------
def load_env_file():
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))
    if not os.path.exists(path):
        path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".env"))
    if not os.path.exists(path):
        path = ".env"
    if os.path.exists(path):
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    os.environ[k] = v

load_env_file()

BOOTSTRAP_SERVERS = os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
TOPIC = os.environ.get("KAFKA_TRANSACTIONS_TOPIC", "transactions")
ALERTS_TOPIC = os.environ.get("KAFKA_ALERTS_TOPIC", "fraud-alerts")
GROUP_ID = "fraud-consumer-group"

MODEL_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "fraud_model.pkl"))
if not os.path.exists(MODEL_PATH):
    MODEL_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fraud", "fraud_model.pkl"))

# Same business-policy thresholds as the ledger consumer. Both consumers read
# from the same central configuration so the risk classification is identical.
LOW_CAP = float(os.environ.get("RISK_LOW_THRESHOLD", "0.01"))
VERIFY_CAP = float(os.environ.get("RISK_HIGH_THRESHOLD", "0.10"))

if not (0.0 <= LOW_CAP < VERIFY_CAP <= 1.0):
    raise ValueError(f"Invalid risk threshold configuration: LOW_CAP={LOW_CAP}, VERIFY_CAP={VERIFY_CAP}")


# --- V3 shared feature contract (six features) ------------------------------
from features import build_feature_vector as _v3_build_feature_vector  # noqa: E402
from features import SERVE_HISTORY_CAP  # noqa: E402
from features import VELOCITY_WINDOW_SECONDS  # noqa: E402

VELOCITY_WINDOW = 20  # last N transactions per account (legacy label, unused for scoring)


# --- Structured Logging Helper (Step 2) ------------------------------------
def log_structured_event(event_type: str, event_id: str, amount: float, sender: str, receiver: str, score: float | None = None, risk_level: str = "", decision: str = "", status: str = "", reason: str = ""):
    log_obj = {
        "event_type": event_type,
        "event_id": event_id,
        "amount": amount,
        "sender": sender,
        "receiver": receiver,
        "risk_score": round(score, 4) if score is not None else None,
        "risk_level": risk_level,
        "decision": decision,
        "status": status,
        "error_reason": reason,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    log.info("[JSON_EVENT] %s", json.dumps(log_obj))


# --- Reason heuristics: honestly derived from the event's OWN data only ---
LATE_NIGHT_HOUR_MIN = 6      # 06:00 UTC and later is a normal business hour
LATE_NIGHT_HOUR_FLAG = 23    # >= 23:00 UTC counts as late-night
LATE_NIGHT_HOUR_TEXT_MIN = 0  # 00:00-05:59 also late-night
AMOUNT_HIGH_MULTIPLIER = 3.0  # vs the sender's recent mean transfer amount
MIN_AMOUNT_SAMPLES = 3        # need this many prior transfers before judging
VELOCITY_BURST_THRESHOLD = 10  # events seen for the sender in VELOCITY_WINDOW


def load_model():
    path = MODEL_PATH
    if not os.path.exists(path):
        path = "fraud_model.pkl"
    if not os.path.exists(path):
        path = os.path.join("fraud", "fraud_model.pkl")
    if not os.path.exists(path):
        path = os.path.join("..", "fraud", "fraud_model.pkl")
    if not os.path.exists(path):
        raise FileNotFoundError(f"Model file not found at expected paths.")
    with open(path, "rb") as f:
        return pickle.load(f)


def decide_risk(score: float):
    """Map the model's risk score to a business decision band.

    Matches the ledger consumer's inclusive semantics so the two consumers
    agree at the boundary:
        score <  LOW_CAP           -> LOW     (APPROVE)
        score <= VERIFY_CAP        -> MEDIUM  (VERIFY)
        otherwise                  -> HIGH    (HOLD)
    """
    if score < LOW_CAP:
        return "LOW", "APPROVE"
    if score <= VERIFY_CAP:
        return "MEDIUM", "VERIFY"
    return "HIGH", "HOLD"


def validate_event(event: dict) -> str | None:
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


def build_feature_vector(event: dict, history, expected_width: int) -> np.ndarray:
    """Six V3 features via the shared builder; validates width against the model."""
    features = _v3_build_feature_vector(event, history)
    if features.shape[1] != expected_width:
        raise ValueError(
            f"feature contract mismatch: model expects {expected_width} features, "
            f"features.py produced {features.shape[1]}"
        )
    return features


def main():
    model = load_model()
    expected_width = model.n_features_in_

    consumer_opts = {
        "bootstrap.servers": BOOTSTRAP_SERVERS,
        "group.id": GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": True,  # scoring is not the source of truth; simple auto-commit is fine here
    }
    producer_opts = {
        "bootstrap.servers": BOOTSTRAP_SERVERS,
    }

    sasl_user = os.environ.get("KAFKA_SASL_USERNAME")
    sasl_pass = os.environ.get("KAFKA_SASL_PASSWORD")

    if sasl_user and sasl_pass:
        sasl_config = {
            "security.protocol": "SASL_SSL",
            "sasl.mechanisms": "SCRAM-SHA-256",
            "sasl.username": sasl_user,
            "sasl.password": sasl_pass,
        }
        ca_cert_content = os.environ.get("KAFKA_CA_CERT")
        if ca_cert_content:
            ca_cert_content = ca_cert_content.replace("\\n", "\n")
            ca_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "ca.pem"))
            with open(ca_path, "w") as f:
                f.write(ca_cert_content)
            sasl_config["ssl.ca.location"] = ca_path
            sasl_config["enable.ssl.certificate.verification"] = "true"
        else:
            if os.environ.get("NODE_ENV") == "production":
                raise ValueError("FATAL: KAFKA_CA_CERT is required for secure Aiven Kafka TLS in production.")
            sasl_config["enable.ssl.certificate.verification"] = "false"
        consumer_opts.update(sasl_config)
        producer_opts.update(sasl_config)

    consumer = Consumer(consumer_opts)
    consumer.subscribe([TOPIC])

    alert_producer = Producer(producer_opts)
    recent_by_account = defaultdict(lambda: deque(maxlen=SERVE_HISTORY_CAP))

    log.info("fraud consumer started, group=%s", GROUP_ID)
    try:
        while True:
            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                raise KafkaException(msg.error())

            raw_value = msg.value()
            if raw_value is None:
                continue
            try:
                event = json.loads(raw_value)
            except json.JSONDecodeError:
                continue  # malformed events are the ledger consumer's / DLQ's problem, not ours

            invalid = validate_event(event)
            if invalid:
                log.warning("validation failed event_id=%s reason=%s", event.get("event_id"), invalid)
                continue

            event_id = event["event_id"]
            account = event["from_account"]
            to_acc = event["to_account"]
            amount = event["amount"]
            
            log_structured_event("TRANSACTION_RECEIVED", event_id, amount, account, to_acc)

            history = recent_by_account[account]
            history.append((event["timestamp"], event["amount"]))

            # Velocity for reason text = count in the 30-minute time window.
            cutoff = datetime.fromisoformat(event["timestamp"]) - timedelta(seconds=VELOCITY_WINDOW_SECONDS)
            velocity = sum(
                1 for (ts_str, _) in history
                if datetime.fromisoformat(ts_str) >= cutoff
            )

            try:
                features = build_feature_vector(event, history, expected_width)
                score = float(model.predict_proba(features)[0, 1])
            except Exception as e:
                log.warning("scoring error for event_id=%s reason=%s", event_id, e)
                continue

            risk_level, action = decide_risk(score)
            reasons = build_reasons(event, history, velocity)

            log_structured_event("RISK_SCORED", event_id, amount, account, to_acc, score, risk_level, action)

            if score >= LOW_CAP:  # publish both MEDIUM and HIGH alerts (LOW_CAP is the low threshold)
                alert = {
                    "event_id": event_id,
                    "from_account": account,
                    "to_account": to_acc,
                    "amount": amount,
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
                
                log_structured_event("TRANSACTION_HELD" if risk_level == "MEDIUM" else "TRANSACTION_BLOCKED",
                                     event_id, amount, account, to_acc, score, risk_level, action)

    except KeyboardInterrupt:
        log.info("shutting down...")
    finally:
        alert_producer.flush()
        consumer.close()


if __name__ == "__main__":
    main()
