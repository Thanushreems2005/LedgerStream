"""
LedgerStream Dashboard (Day 6)

Streamlit app showing:
  - live account balances (from Postgres)
  - a scrolling transaction feed (from transactions_log)
  - a high-risk / fraud alert table (from the fraud-alerts Kafka topic)
  - consumer lag for both consumer groups (via confluent_kafka AdminClient)

Usage:
    streamlit run dashboard.py
"""

import json
import time

import pandas as pd
import psycopg2
import streamlit as st
from confluent_kafka import Consumer, TopicPartition
from confluent_kafka._model import ConsumerGroupTopicPartitions
from confluent_kafka.admin import AdminClient

BOOTSTRAP_SERVERS = "localhost:9092"
PG_DSN = "dbname=ledgerstream user=ledger password=ledger host=localhost port=5433"

st.set_page_config(page_title="LedgerStream", layout="wide")
st.title("LedgerStream — Live Payment Ledger")


@st.cache_resource
def get_alert_consumer():
    c = Consumer({
        "bootstrap.servers": BOOTSTRAP_SERVERS,
        "group.id": "dashboard-fraud-reader",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": True,
    })
    c.subscribe(["fraud-alerts"])
    return c


def fetch_balances():
    with psycopg2.connect(PG_DSN) as conn:
        return pd.read_sql("SELECT account_id, balance FROM accounts ORDER BY account_id", conn)


def fetch_recent_transactions(limit=50):
    with psycopg2.connect(PG_DSN) as conn:
        return pd.read_sql(
            f"""SELECT event_id, from_account, to_account, amount, status, created_at
                FROM transactions_log ORDER BY created_at DESC LIMIT {limit}""",
            conn,
        )


def fetch_alerts(max_read=50):
    consumer = get_alert_consumer()
    alerts = []
    for _ in range(max_read):
        msg = consumer.poll(0.1)
        if msg is None:
            break
        if msg.error():
            continue
        try:
            alerts.append(json.loads(msg.value()))
        except json.JSONDecodeError:
            continue
    if "fraud_alerts" not in st.session_state:
        st.session_state.fraud_alerts = []
    st.session_state.fraud_alerts = (alerts + st.session_state.fraud_alerts)[:100]
    return pd.DataFrame(st.session_state.fraud_alerts)


def fetch_consumer_lag(group_id: str, topic: str) -> int:
    """Sum of (high watermark - committed offset) across all partitions."""
    admin = AdminClient({"bootstrap.servers": BOOTSTRAP_SERVERS})
    consumer = Consumer({
        "bootstrap.servers": BOOTSTRAP_SERVERS,
        "group.id": group_id + "-lag-probe",
        "enable.auto.commit": False,
    })
    md = admin.list_topics(topic=topic, timeout=5)
    if topic not in md.topics:
        consumer.close()
        return -1
    partitions = sorted(md.topics[topic].partitions.keys())

    # Committed offsets for the TARGET group, via the Admin API (a probe
    # consumer's own committed() would return its own -1 never-committed
    # offsets instead of the shared group's real position).
    request = ConsumerGroupTopicPartitions(
        group_id, [TopicPartition(topic, p) for p in partitions]
    )
    group_result = admin.list_consumer_group_offsets([request], request_timeout=5)[group_id].result()
    committed = {
        tp.partition: tp.offset
        for tp in group_result.topic_partitions
        if tp.topic == topic
    }

    total_lag = 0
    for p in partitions:
        low, high = consumer.get_watermark_offsets(TopicPartition(topic, p), timeout=5)
        current = committed.get(p, low)
        if current < 0:
            current = low
        total_lag += max(high - current, 0)
    consumer.close()
    return total_lag


col1, col2 = st.columns([1, 2])

with col1:
    st.subheader("Account Balances")
    st.dataframe(fetch_balances(), hide_index=True, use_container_width=True)

    st.subheader("Consumer Lag")
    try:
        ledger_lag = fetch_consumer_lag("ledger-consumer-group", "transactions")
        fraud_lag = fetch_consumer_lag("fraud-consumer-group", "transactions")
        st.metric("Ledger consumer lag", ledger_lag)
        st.metric("Fraud consumer lag", fraud_lag)
    except Exception as e:
        st.caption(f"lag unavailable: {e}")

with col2:
    st.subheader("Transaction Feed")
    st.dataframe(fetch_recent_transactions(), hide_index=True, use_container_width=True)

    st.subheader("Fraud Alerts")
    alerts_df = fetch_alerts()
    if alerts_df.empty:
        st.caption("no alerts yet")
    else:
        st.dataframe(alerts_df, hide_index=True, use_container_width=True)

st.caption(f"last refreshed: {time.strftime('%H:%M:%S')}")
time.sleep(2)
st.rerun()
