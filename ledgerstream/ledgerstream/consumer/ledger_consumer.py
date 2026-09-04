"""
LedgerStream Ledger Consumer (Day 3 - core of the project, + Day 4 DLQ)

Razorpay Track 02 Active Risk Decision Layer:
- Performs inline ML scoring using the pre-trained XGBoost model.
- Automatically locks account balances and updates them only for APPROVED (LOW risk) transactions.
- Holds MEDIUM risk (VERIFY) transactions in PostgreSQL with status 'held' (no balance change).
- Blocks HIGH risk (HOLD) transactions in PostgreSQL with status 'blocked' (no balance change).
"""

import json
import logging
import os
import pickle
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone, timedelta

import numpy as np
import psycopg2
from confluent_kafka import Consumer, KafkaException, Producer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ledger] %(message)s")
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
DLQ_TOPIC = os.environ.get("KAFKA_DLQ_TOPIC", "transactions-dlq")
ALERTS_TOPIC = os.environ.get("KAFKA_ALERTS_TOPIC", "fraud-alerts")
GROUP_ID = "ledger-consumer-group"

PG_DSN = os.environ.get("DATABASE_URL") or os.environ.get("PG_DSN", "dbname=ledgerstream user=ledger password=ledger host=localhost port=5433")

MODEL_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fraud", "fraud_model.pkl"))

LOW_THRESHOLD = float(os.environ.get("RISK_LOW_THRESHOLD", "0.01"))
HIGH_THRESHOLD = float(os.environ.get("RISK_HIGH_THRESHOLD", "0.10"))

if not (0.0 <= LOW_THRESHOLD < HIGH_THRESHOLD <= 1.0):
    raise ValueError(f"Invalid risk threshold configuration: LOW_THRESHOLD={LOW_THRESHOLD}, HIGH_THRESHOLD={HIGH_THRESHOLD}")


# --- V3 shared feature contract (six features) ------------------------------
_FRAUD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fraud"))
if _FRAUD_DIR not in sys.path:
    sys.path.insert(0, _FRAUD_DIR)
from features import build_feature_vector as _v3_build_feature_vector  # noqa: E402
from features import SERVE_HISTORY_CAP  # noqa: E402


def build_feature_vector(event: dict, history, expected_width: int) -> np.ndarray:
    """Compute the six V3 features from an event and its account history.

    ``history`` is an iterable of ``(timestamp_str, amount)`` for this sender,
    with the current event as its LAST element. Delegates to the shared
    builder in ``fraud/features.py`` so serving and training share one
    definition, then validates the width against the loaded model.
    """
    features = _v3_build_feature_vector(event, history)
    if features.shape[1] != expected_width:
        raise ValueError(
            f"feature contract mismatch: model expects {expected_width} features, "
            f"features.py produced {features.shape[1]}"
        )
    return features


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
    """Map the model's fraud-probability score to a business decision band.

    The decision depends ONLY on the ML risk score and the configured
    policy thresholds. It is intentionally independent of transaction
    amount, account IDs, timestamps, or any dataset-specific values.
    The amount may influence the model's prediction, but the business
    classification is driven purely by the model's estimated fraud
    probability.

        score <  LOW_THRESHOLD -> LOW  (APPROVE)
        score <= HIGH_THRESHOLD -> MEDIUM (VERIFY / hold for review)
        otherwise               -> HIGH  (HOLD / block)
    """
    if score < LOW_THRESHOLD:
        return "LOW", "APPROVE"
    if score <= HIGH_THRESHOLD:
        return "MEDIUM", "VERIFY"
    return "HIGH", "HOLD"


def build_reasons(event: dict, history, velocity: int, score: float | None = None) -> list:
    ts = datetime.fromisoformat(event["timestamp"])
    hour = ts.hour
    amount = float(event["amount"])
    reasons = []

    # Risk score signal (the primary driver of the decision)
    if score is not None:
        if score > HIGH_THRESHOLD:
            reasons.append(f"high fraud probability ({score:.2%}) above {HIGH_THRESHOLD:.0%} block threshold")
        elif score >= LOW_THRESHOLD:
            reasons.append(f"moderate fraud probability ({score:.2%}) in {LOW_THRESHOLD:.0%}-{HIGH_THRESHOLD:.0%} review band")

    # Hour signal
    if hour >= 23 or 0 <= hour < 6:
        reasons.append(f"late-night hour {hour:02d} UTC")

    # Velocity signal
    if velocity >= 10:
        reasons.append(f"velocity burst: {velocity} transfers in recent window")
    elif velocity >= 5:
        reasons.append(f"active transfer frequency ({velocity} in window)")

    # History spike signal
    prior_amounts = [amt for (_, amt) in list(history)[:-1]]
    if len(prior_amounts) >= 3:
        avg = sum(prior_amounts) / len(prior_amounts)
        if avg > 0 and amount > 3.0 * avg:
            reasons.append(
                f"amount {amount:,.2f} is {amount / avg:.1f}x the sender's recent average ({avg:,.2f})"
            )

    if not reasons:
        reasons.append("standard transaction characteristics across amount, hour, and velocity")
    return reasons


def send_fraud_alert(producer: Producer, event: dict, score: float, risk_level: str, action: str, reasons: list):
    alert = {
        "event_id": event["event_id"],
        "from_account": event["from_account"],
        "to_account": event.get("to_account"),
        "amount": event["amount"],
        "risk_score": round(score, 4),
        "risk_level": risk_level,
        "action": action,
        "reasons": reasons,
        "flagged_at": datetime.now(timezone.utc).isoformat(),
    }
    producer.produce(
        ALERTS_TOPIC,
        key=event["from_account"].encode("utf-8"),
        value=json.dumps(alert).encode("utf-8"),
    )
    producer.flush()


def get_db_conn():
    conn = psycopg2.connect(PG_DSN)
    conn.autocommit = False
    return conn


def validate(event: dict) -> str | None:
    """Returns an error reason string if invalid, else None."""
    required = ("event_id", "from_account", "to_account", "amount", "timestamp")
    for field in required:
        if field not in event:
            return f"missing_field:{field}"
    if event["from_account"] == event["to_account"]:
        return "same_account"
    if not isinstance(event["amount"], (int, float)) or event["amount"] <= 0:
        return "invalid_amount"
    return None


def already_processed(conn, event_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM processed_events WHERE event_id = %s", (event_id,))
        return cur.fetchone() is not None


def apply_transfer(conn, event: dict, risk_level: str, action: str, score: float | None = None, reasons: list | None = None) -> str:
    """Runs debit + credit + audit rows inside a single DB transaction.
    If action is 'VERIFY' (MEDIUM risk) or 'HOLD' (HIGH risk), no balance modifications occur;
    instead, the transaction is logged with status 'held' or 'blocked' respectively."""
    event_id = event["event_id"]
    from_acc = event["from_account"]
    to_acc = event["to_account"]
    amount = event["amount"]
    
    reasons_str = " · ".join(reasons) if reasons else None

    with conn.cursor() as cur:
        if action == "APPROVE":  # LOW Risk
            # Lock the sender's row to prevent a race against a concurrent transfer
            cur.execute("SELECT balance FROM accounts WHERE account_id = %s FOR UPDATE", (from_acc,))
            row = cur.fetchone()
            if row is None:
                raise ValueError(f"unknown_account:{from_acc}")
            sender_balance = row[0]

            cur.execute("SELECT 1 FROM accounts WHERE account_id = %s", (to_acc,))
            if cur.fetchone() is None:
                raise ValueError(f"unknown_account:{to_acc}")

            if sender_balance < amount:
                raise ValueError("insufficient_balance")

            cur.execute("UPDATE accounts SET balance = balance - %s WHERE account_id = %s", (amount, from_acc))
            cur.execute("UPDATE accounts SET balance = balance + %s WHERE account_id = %s", (amount, to_acc))
            
            db_status = "applied"
        elif action == "VERIFY":  # MEDIUM Risk -> HOLD
            # Verify accounts exist
            cur.execute("SELECT 1 FROM accounts WHERE account_id = %s", (from_acc,))
            if cur.fetchone() is None:
                raise ValueError(f"unknown_account:{from_acc}")
            cur.execute("SELECT 1 FROM accounts WHERE account_id = %s", (to_acc,))
            if cur.fetchone() is None:
                raise ValueError(f"unknown_account:{to_acc}")
            db_status = "held"
        else:  # HIGH Risk -> HOLD/BLOCK
            # Verify accounts exist
            cur.execute("SELECT 1 FROM accounts WHERE account_id = %s", (from_acc,))
            if cur.fetchone() is None:
                raise ValueError(f"unknown_account:{from_acc}")
            cur.execute("SELECT 1 FROM accounts WHERE account_id = %s", (to_acc,))
            if cur.fetchone() is None:
                raise ValueError(f"unknown_account:{to_acc}")
            db_status = "blocked"

        cur.execute(
            "INSERT INTO processed_events (event_id, status) VALUES (%s, %s)",
            (event_id, db_status),
        )
        cur.execute(
            """INSERT INTO transactions_log (event_id, from_account, to_account, amount, status, risk_score, risk_level, reasons)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (event_id, from_acc, to_acc, amount, db_status, score, risk_level, reasons_str),
        )
    conn.commit()
    return db_status


def send_to_dlq(dlq_producer: Producer, raw_value: bytes, key: bytes | None, reason: str):
    payload = {
        "original_value": raw_value.decode("utf-8", errors="replace"),
        "error_reason": reason,
    }
    dlq_producer.produce(DLQ_TOPIC, key=key, value=json.dumps(payload).encode("utf-8"))
    dlq_producer.flush()


def main():
    consumer_opts = {
        "bootstrap.servers": BOOTSTRAP_SERVERS,
        "group.id": GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,  # we commit manually, only after DB commit
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

    dlq_producer = Producer(producer_opts)
    conn = get_db_conn()
    model = load_model()
    expected_width = model.n_features_in_
    
    # Track per-account timestamped history for the V3 features.
    # Capacity is larger than a 30-minute window so `amount_ratio` uses the
    # same uncapped window mean that training sees.
    recent_by_account = defaultdict(lambda: deque(maxlen=SERVE_HISTORY_CAP))

    log.info("ledger consumer started, group=%s", GROUP_ID)
    try:
        while True:
            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                raise KafkaException(msg.error())

            raw_value = msg.value()
            if raw_value is None:
                send_to_dlq(dlq_producer, b"", msg.key(), "empty_payload")
                log_structured_event("TRANSACTION_DLQ", "", 0.0, "", "", reason="empty_payload")
                consumer.commit(message=msg)
                continue
            try:
                event = json.loads(raw_value)
            except json.JSONDecodeError:
                send_to_dlq(dlq_producer, raw_value, msg.key(), "invalid_json")
                log_structured_event("TRANSACTION_DLQ", "", 0.0, "", "", reason="invalid_json")
                consumer.commit(message=msg)
                continue

            error = validate(event)
            if error:
                log.warning("validation failed event_id=%s reason=%s", event.get("event_id"), error)
                send_to_dlq(dlq_producer, raw_value, msg.key(), error)
                log_structured_event("TRANSACTION_DLQ", event.get("event_id", ""), event.get("amount", 0.0), event.get("from_account", ""), event.get("to_account", ""), reason=error)
                consumer.commit(message=msg)
                continue

            event_id = event["event_id"]
            account = event["from_account"]
            to_acc = event["to_account"]
            amount = event["amount"]
            
            log_structured_event("TRANSACTION_RECEIVED", event_id, amount, account, to_acc)

            # Track history (V3 window-based features). The current event is
            # appended before scoring so the 30-minute window includes it,
            # exactly matching how training builds the window.
            history = recent_by_account[account]
            history.append((event["timestamp"], event["amount"]))

            # Velocity for reason text = count in the 30-minute time window.
            cutoff = datetime.fromisoformat(event["timestamp"]) - timedelta(seconds=30 * 60)
            velocity = sum(
                1 for (ts_str, _) in history
                if datetime.fromisoformat(ts_str) >= cutoff
            )

            try:
                if already_processed(conn, event_id):
                    log.warning("skip duplicate event_id=%s (idempotency guard)", event_id)
                    log_structured_event("TRANSACTION_DUPLICATE", event_id, amount, account, to_acc)
                    consumer.commit(message=msg)  # still commit - we're caught up either way
                    continue

                # Run inline ML scoring
                features = build_feature_vector(event, history, expected_width)
                probs = model.predict_proba(features)
                score = float(probs[0, 1])

                risk_level, action = decide_risk(score)
                reasons = build_reasons(event, history, velocity, score)
                
                log_structured_event("RISK_SCORED", event_id, amount, account, to_acc, score, risk_level, action)

                db_status = apply_transfer(conn, event, risk_level, action, score, reasons)
                
                if db_status == "applied":
                    log_structured_event("TRANSACTION_APPLIED", event_id, amount, account, to_acc, score, risk_level, action, db_status)
                elif db_status == "held":
                    log_structured_event("TRANSACTION_HELD", event_id, amount, account, to_acc, score, risk_level, action, db_status)
                elif db_status == "blocked":
                    log_structured_event("TRANSACTION_BLOCKED", event_id, amount, account, to_acc, score, risk_level, action, db_status)
                
                # If MEDIUM or HIGH, publish an alert to fraud-alerts
                if action in ("VERIFY", "HOLD"):
                    send_fraud_alert(dlq_producer, event, score, risk_level, action, reasons)

                # Offset is committed ONLY after the DB transaction succeeded.
                consumer.commit(message=msg)

            except Exception as e:
                conn.rollback()
                log.warning("processing failed event_id=%s reason=%s", event_id, e)
                send_to_dlq(dlq_producer, raw_value, msg.key(), str(e))
                log_structured_event("TRANSACTION_DLQ", event_id, amount, account, to_acc, reason=str(e))
                consumer.commit(message=msg)

    except KeyboardInterrupt:
        log.info("shutting down...")
    finally:
        consumer.close()
        conn.close()


if __name__ == "__main__":
    main()


