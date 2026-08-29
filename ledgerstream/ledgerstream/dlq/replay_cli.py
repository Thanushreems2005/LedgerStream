"""
LedgerStream DLQ Replay CLI (Day 4)

Two commands:

  python replay_cli.py list
      Reads every message currently sitting in `transactions-dlq` and
      prints event_id, error_reason, and original payload. Non-destructive
      (uses its own consumer group so it never interferes with the ledger
      or fraud consumers).

  python replay_cli.py replay <event_id> [--fix key=value ...]
      Finds the matching DLQ message, applies any --fix overrides you pass
      (e.g. to correct a negative amount or fill a missing field), and
      republishes the corrected event back onto the main `transactions`
      topic so the ledger consumer picks it up normally.

Demo flow: run the producer with --inject-bad 0.1, watch bad events land
in the DLQ, `list` them, `replay` one with a fix, confirm it gets applied.
"""

import argparse
import json

from confluent_kafka import Consumer, Producer

BOOTSTRAP_SERVERS = "localhost:9092"
DLQ_TOPIC = "transactions-dlq"
MAIN_TOPIC = "transactions"


def read_dlq_messages(timeout_seconds=5):
    consumer = Consumer({
        "bootstrap.servers": BOOTSTRAP_SERVERS,
        "group.id": "dlq-inspector",  # separate group; safe to re-read anytime
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    })
    consumer.subscribe([DLQ_TOPIC])

    messages = []
    import time
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            continue
        try:
            payload = json.loads(msg.value())
            original = json.loads(payload["original_value"])
            messages.append({
                "event_id": original.get("event_id", "<unparseable>"),
                "error_reason": payload.get("error_reason"),
                "original": original,
            })
        except Exception:
            messages.append({
                "event_id": "<unparseable>",
                "error_reason": "could not parse DLQ payload",
                "original": msg.value().decode("utf-8", errors="replace"),
            })
    consumer.close()
    return messages


def cmd_list(_args):
    messages = read_dlq_messages()
    if not messages:
        print("DLQ is empty (or nothing new within the read window).")
        return
    print(f"{len(messages)} message(s) in {DLQ_TOPIC}:\n")
    for m in messages:
        print(f"- event_id={m['event_id']}  reason={m['error_reason']}")
        print(f"  payload: {m['original']}\n")


def cmd_replay(args):
    fixes = {}
    for pair in args.fix or []:
        k, v = pair.split("=", 1)
        # try to coerce numeric fixes (e.g. amount=250.00)
        try:
            v = float(v)
        except ValueError:
            pass
        fixes[k] = v

    messages = read_dlq_messages()
    match = next((m for m in messages if m["event_id"] == args.event_id), None)
    if match is None:
        print(f"event_id {args.event_id} not found in current DLQ window. "
              f"Try increasing the read window or re-check with `list`.")
        return

    corrected = dict(match["original"])
    corrected.update(fixes)
    corrected.pop("_injected_fault", None)

    producer = Producer({"bootstrap.servers": BOOTSTRAP_SERVERS})
    key = corrected.get("from_account", "unknown").encode("utf-8")
    producer.produce(MAIN_TOPIC, key=key, value=json.dumps(corrected).encode("utf-8"))
    producer.flush()
    print(f"Replayed event_id={args.event_id} back onto '{MAIN_TOPIC}' with fixes {fixes}")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="list messages currently in the DLQ")

    replay_p = sub.add_parser("replay", help="fix and replay a DLQ message")
    replay_p.add_argument("event_id")
    replay_p.add_argument("--fix", action="append", help="key=value override, repeatable")

    args = parser.parse_args()
    if args.command == "list":
        cmd_list(args)
    elif args.command == "replay":
        cmd_replay(args)


if __name__ == "__main__":
    main()
