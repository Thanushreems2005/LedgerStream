"""
LedgerStream Load Test (Day 6)

Ramps up producer send rate in steps, and at each step measures:
  - actual achieved throughput (events/sec)
  - end-to-end latency estimate (producer send time -> ledger consumer's
    processed_at time, joined via event_id)
  - consumer lag at end of each step

This is what turns "I load-tested it" into a real, defensible number
instead of a guess. Run this AFTER kafka/postgres are up and the ledger
consumer is running.

Usage:
    python load_test.py --steps 200,500,1000,2000 --duration 30
        (steps are events/sec targets; duration is seconds per step)
"""

import argparse
import json
import time
import uuid
from datetime import datetime, timezone

import psycopg2
from confluent_kafka import Consumer, Producer, TopicPartition
from confluent_kafka._model import ConsumerGroupTopicPartitions
from confluent_kafka.admin import AdminClient

BOOTSTRAP_SERVERS = "localhost:9092"
TOPIC = "transactions"
PG_DSN = "dbname=ledgerstream user=ledger password=ledger host=localhost port=5433"
ACCOUNTS = [f"ACC00{i}" for i in range(1, 9)]


def send_burst(producer: Producer, target_rate: int, duration: int) -> list:
    """Sends events at target_rate events/sec for `duration` seconds.
    Returns list of (event_id, sent_at) for latency measurement."""
    import random

    sent = []
    interval = 1.0 / target_rate
    end_time = time.time() + duration
    next_send = time.time()

    while time.time() < end_time:
        if time.time() >= next_send:
            from_acc, to_acc = random.sample(ACCOUNTS, 2)
            event_id = str(uuid.uuid4())
            event = {
                "event_id": event_id,
                "from_account": from_acc,
                "to_account": to_acc,
                "amount": round(random.uniform(10, 500), 2),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            producer.produce(TOPIC, key=from_acc.encode(), value=json.dumps(event).encode())
            producer.poll(0)
            sent.append((event_id, time.time()))
            next_send += interval
    producer.flush()
    return sent


def measure_processed(event_ids: set, sent_at: dict, timeout_seconds: int = 90) -> dict:
    """Polls transactions_log until all sent events are applied (or timeout),
    then computes end-to-end latency and the group's Kafka lag."""
    group = "ledger-consumer-group"
    admin = AdminClient({"bootstrap.servers": BOOTSTRAP_SERVERS})
    probe = Consumer({
        "bootstrap.servers": BOOTSTRAP_SERVERS,
        "group.id": group + "-measure-probe",
        "enable.auto.commit": False,
    })

    def _count_processed():
        with psycopg2.connect(PG_DSN) as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT event_id, created_at FROM transactions_log
                   WHERE event_id = ANY(%s)""",
                (list(event_ids),),
            )
            return cur.fetchall()

    deadline = time.time() + timeout_seconds
    rows = []
    while time.time() < deadline:
        rows = _count_processed()
        if len(rows) >= len(event_ids):
            break
        time.sleep(2)

    sent_count = len(event_ids)
    sent_set = set(sent_at.keys())
    latencies = []
    for event_id, created_at in rows:
        if event_id in sent_set:
            # created_at is a naive UTC timestamp from Postgres; mark it UTC
            # before .timestamp() so it is NOT reinterpreted as local time.
            created_at = created_at.replace(tzinfo=timezone.utc)
            latencies.append(created_at.timestamp() - sent_at[event_id])

    # Kafka lag for the ledger group (sum over partitions).
    try:
        md = admin.list_topics(topic=TOPIC, timeout=5)
        parts = sorted(md.topics[TOPIC].partitions.keys())
        req = ConsumerGroupTopicPartitions(group, [TopicPartition(TOPIC, p) for p in parts])
        group_result = admin.list_consumer_group_offsets([req], request_timeout=5)[group].result()
        committed = {
            tp.partition: tp.offset
            for tp in group_result.topic_partitions
            if tp.topic == TOPIC
        }
        total_lag = 0
        for p in parts:
            low, high = probe.get_watermark_offsets(TopicPartition(TOPIC, p), timeout=5)
            current = committed.get(p, low)
            if current < 0:
                current = low
            total_lag += max(high - current, 0)
    except Exception as e:
        print(f"warning: lag unavailable ({e})")
        total_lag = -1
    finally:
        probe.close()

    return {
        "sent": sent_count,
        "processed": len(rows),
        "avg_latency_sec": f"{sum(latencies) / len(latencies):.3f}" if latencies else None,
        "max_latency_sec": f"{max(latencies):.3f}" if latencies else None,
        "lag": total_lag,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=str, default="100,500,1000,2000",
                         help="comma-separated target events/sec per step")
    parser.add_argument("--duration", type=int, default=20, help="seconds per step")
    args = parser.parse_args()

    steps = [int(s) for s in args.steps.split(",")]
    producer = Producer({"bootstrap.servers": BOOTSTRAP_SERVERS, "linger.ms": 5})

    print("step_target_eps,actual_eps,processed,sent,avg_latency_sec,max_latency_sec,lag")
    for target in steps:
        start = time.time()
        sent = send_burst(producer, target, args.duration)
        elapsed = time.time() - start
        actual_eps = round(len(sent) / elapsed, 1)

        sent_at = dict(sent)
        result = measure_processed(set(sent_at.keys()), sent_at, timeout_seconds=150)

        print(f"{target},{actual_eps},{result['processed']},{result['sent']},"
              f"{result['avg_latency_sec']},{result['max_latency_sec']},{result['lag']}")

    print("\nCopy this table into your resume/writeup as your MEASURED throughput -"
          " do not round up or estimate beyond what actually printed above.")


if __name__ == "__main__":
    main()
