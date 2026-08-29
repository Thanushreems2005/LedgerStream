"""
LedgerStream Producer (Day 2)

Generates synthetic transfer events and publishes them to the `transactions`
Kafka topic. Each event is keyed by `from_account` so that Kafka guarantees
all events for a given account land on the same partition, in order.

Usage:
    python producer.py                     # default rate ~ every 50-200ms
    python producer.py --rate 0.02         # faster (20ms between events)
    python producer.py --count 500         # stop after 500 events
    python producer.py --inject-bad 0.05   # 5% of events are deliberately malformed
                                            # (useful later for testing the DLQ on Day 4)
"""

import argparse
import json
import random
import time
import uuid
from datetime import datetime, timezone

from confluent_kafka import Producer

TOPIC = "transactions"
BOOTSTRAP_SERVERS = "localhost:9092"

ACCOUNTS = [f"ACC00{i}" for i in range(1, 9)]


def delivery_report(err, msg):
    if err is not None:
        print(f"[producer] delivery failed for {msg.key()}: {err}")


def make_event(inject_bad_rate: float) -> dict:
    from_acc, to_acc = random.sample(ACCOUNTS, 2)
    event = {
        "event_id": str(uuid.uuid4()),
        "from_account": from_acc,
        "to_account": to_acc,
        "amount": round(random.uniform(10, 5000), 2),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # Deliberately corrupt a fraction of events so you have something
    # real to push through the DLQ + replay flow on Day 4.
    if random.random() < inject_bad_rate:
        corruption = random.choice(["missing_field", "negative_amount", "same_account"])
        if corruption == "missing_field":
            del event["to_account"]
        elif corruption == "negative_amount":
            event["amount"] = -abs(event["amount"])
        elif corruption == "same_account":
            event["to_account"] = event["from_account"]
        event["_injected_fault"] = corruption

    return event


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rate", type=float, default=None,
                         help="fixed seconds between events; if omitted, randomizes 0.05-0.2s")
    parser.add_argument("--count", type=int, default=None,
                         help="stop after N events; default runs forever")
    parser.add_argument("--inject-bad", type=float, default=0.0,
                         help="fraction of events (0-1) to deliberately malform, for DLQ testing")
    args = parser.parse_args()

    producer = Producer({"bootstrap.servers": BOOTSTRAP_SERVERS})

    sent = 0
    print(f"[producer] streaming to topic '{TOPIC}' on {BOOTSTRAP_SERVERS} ... Ctrl+C to stop")
    try:
        while args.count is None or sent < args.count:
            event = make_event(args.inject_bad)
            key = event.get("from_account", "unknown").encode("utf-8")
            producer.produce(
                TOPIC,
                key=key,
                value=json.dumps(event).encode("utf-8"),
                callback=delivery_report,
            )
            producer.poll(0)
            sent += 1
            if sent % 50 == 0:
                print(f"[producer] sent {sent} events")

            sleep_for = args.rate if args.rate is not None else random.uniform(0.05, 0.2)
            time.sleep(sleep_for)
    except KeyboardInterrupt:
        print("\n[producer] stopping...")
    finally:
        producer.flush()
        print(f"[producer] done. total sent: {sent}")


if __name__ == "__main__":
    main()
