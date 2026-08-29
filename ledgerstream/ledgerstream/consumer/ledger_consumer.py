"""
LedgerStream Ledger Consumer (Day 3 - core of the project, + Day 4 DLQ)

Guarantees exactly-once application of transfer events:

1. Manual offset commit (enable.auto.commit=False) - we control exactly when
   an offset is considered "done".
2. Idempotency check against `processed_events.event_id` (UNIQUE constraint)
   BEFORE applying any balance change. If the event was already processed
   (e.g. Kafka redelivered it after a crash), we skip it and still commit
   the offset - never double-apply.
3. The debit, the credit, and the insert into `processed_events` /
   `transactions_log` all happen inside ONE Postgres transaction. Either
   all of it lands, or none of it does.
4. The Kafka offset is committed ONLY after that DB transaction has
   successfully committed. This is the piece that prevents the "lost
   update" failure mode: if the process dies between the DB commit and the
   offset commit, Kafka will simply redeliver the message - and step 2
   will catch it as a duplicate and skip it safely.
5. Anything that fails validation or hits a DB error is NOT retried inline.
   It's published as-is (plus an error reason) to `transactions-dlq`, and
   the offset is committed so the bad message doesn't block the partition.

To prove exactly-once for yourself: run this consumer, run the producer,
then kill this process (Ctrl+C or `kill -9`) mid-run and restart it. Check
`transactions_log` - you should never see the same event_id applied twice,
and no account balance should ever go negative or "double up".
"""

import json
import logging

import psycopg2
from confluent_kafka import Consumer, KafkaException, Producer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ledger] %(message)s")
log = logging.getLogger(__name__)

BOOTSTRAP_SERVERS = "localhost:9092"
TOPIC = "transactions"
DLQ_TOPIC = "transactions-dlq"
GROUP_ID = "ledger-consumer-group"

PG_DSN = "dbname=ledgerstream user=ledger password=ledger host=localhost port=5433"


def get_db_conn():
    conn = psycopg2.connect(PG_DSN)
    conn.autocommit = False
    return conn


def validate(event: dict) -> str | None:
    """Returns an error reason string if invalid, else None."""
    required = ("event_id", "from_account", "to_account", "amount")
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


def apply_transfer(conn, event: dict):
    """Runs debit + credit + audit rows inside a single DB transaction.
    Raises on insufficient balance or missing account so the caller can
    route the event to the DLQ instead of crashing the consumer."""
    event_id = event["event_id"]
    from_acc = event["from_account"]
    to_acc = event["to_account"]
    amount = event["amount"]

    with conn.cursor() as cur:
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
        cur.execute(
            "INSERT INTO processed_events (event_id, status) VALUES (%s, 'applied')",
            (event_id,),
        )
        cur.execute(
            """INSERT INTO transactions_log (event_id, from_account, to_account, amount, status)
               VALUES (%s, %s, %s, %s, 'applied')""",
            (event_id, from_acc, to_acc, amount),
        )
    conn.commit()


def send_to_dlq(dlq_producer: Producer, raw_value: bytes, key: bytes, reason: str):
    payload = {
        "original_value": raw_value.decode("utf-8", errors="replace"),
        "error_reason": reason,
    }
    dlq_producer.produce(DLQ_TOPIC, key=key, value=json.dumps(payload).encode("utf-8"))
    dlq_producer.flush()


def main():
    consumer = Consumer({
        "bootstrap.servers": BOOTSTRAP_SERVERS,
        "group.id": GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,  # we commit manually, only after DB commit
    })
    consumer.subscribe([TOPIC])

    dlq_producer = Producer({"bootstrap.servers": BOOTSTRAP_SERVERS})
    conn = get_db_conn()

    log.info("ledger consumer started, group=%s", GROUP_ID)
    try:
        while True:
            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                raise KafkaException(msg.error())

            raw_value = msg.value()
            try:
                event = json.loads(raw_value)
            except json.JSONDecodeError:
                send_to_dlq(dlq_producer, raw_value, msg.key(), "invalid_json")
                consumer.commit(msg)
                continue

            error = validate(event)
            if error:
                log.warning("validation failed event_id=%s reason=%s", event.get("event_id"), error)
                send_to_dlq(dlq_producer, raw_value, msg.key(), error)
                consumer.commit(msg)
                continue

            event_id = event["event_id"]

            try:
                if already_processed(conn, event_id):
                    log.info("skip duplicate event_id=%s (idempotency guard)", event_id)
                    consumer.commit(msg)  # still commit - we're caught up either way
                    continue

                apply_transfer(conn, event)
                log.info(
                    "applied event_id=%s %s -> %s amount=%s",
                    event_id, event["from_account"], event["to_account"], event["amount"],
                )
                # Offset is committed ONLY after the DB transaction succeeded.
                consumer.commit(msg)

            except Exception as e:
                conn.rollback()
                log.warning("processing failed event_id=%s reason=%s", event_id, e)
                send_to_dlq(dlq_producer, raw_value, msg.key(), str(e))
                consumer.commit(msg)

    except KeyboardInterrupt:
        log.info("shutting down...")
    finally:
        consumer.close()
        conn.close()


if __name__ == "__main__":
    main()
