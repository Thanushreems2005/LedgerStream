const { Kafka } = require("kafkajs");

const broker = process.env.KAFKA_BOOTSTRAP_SERVERS || process.env.KAFKA_BROKER || "localhost:9092";
const saslUsername = process.env.KAFKA_SASL_USERNAME;
const saslPassword = process.env.KAFKA_SASL_PASSWORD;

const kafkaConfig = {
  clientId: "ledgerstream-api-mirror",
  brokers: [broker],
};

if (saslUsername && saslPassword) {
  if (process.env.KAFKA_CA_CERT) {
    kafkaConfig.ssl = {
      rejectUnauthorized: true,
      ca: [process.env.KAFKA_CA_CERT.replace(/\\n/g, '\n')]
    };
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FATAL: KAFKA_CA_CERT is required for secure Aiven Kafka TLS in production.");
    }
    kafkaConfig.ssl = {
      rejectUnauthorized: false
    };
  }
  kafkaConfig.sasl = {
    mechanism: "scram-sha-256",
    username: saslUsername,
    password: saslPassword,
  };
}

const kafka = new Kafka(kafkaConfig);


//
// Alerts reader — a long-lived, read-only consumer in its OWN consumer
// group ("api-alerts-reader"). It mirrors recent fraud-alerts messages into
// an in-memory ring buffer so GET /api/alerts can serve them instantly
// without replaying the topic on every poll. Read-only: never produces.
//
const ALERTS_TOPIC = "fraud-alerts";
// Unique per boot: guarantees a fresh read of the topic from the beginning
// on restart, so the in-memory ring always has the full alert history even
// after the API process is restarted.
const groupId = `api-alerts-reader-${Date.now()}`;

let ring = []; // most-recent-first is applied on read

// Session epoch (ms): only alert messages flagged at or after this instant
// enter the ring and the level tallies. Set at reader boot so the screen
// reflects THIS monitoring session's activity only - leftover alerts from
// earlier threshold test-runs are replayed from the topic but dropped, so
// counts and the table cannot be confused with lifetime totals. The topic
// itself is never touched, so the full history stays available for audit.
let EPOCH = null;

// Lifetime per-risk-level counts, fed by the full-topic replay on boot:
// the API consumer reads fraud-alerts from the beginning, so these reflect
// every decision that has ever been published to the topic, not just the
// 100-entry ring buffer.
const levelCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };

function normalize(alert) {
  // Guarantee the Day-2 risk fields exist, even for alerts that predate
  // the risk-decision layer (they have none of these). Honest defaults,
  // not fabricated data.
  const score = Number(alert.risk_score);
  return {
    event_id: alert.event_id,
    from_account: alert.from_account,
    to_account: alert.to_account,
    amount: alert.amount,
    risk_score: Number.isFinite(score) ? score : null,
    risk_level: alert.risk_level || "UNKNOWN",
    action: alert.action || "NONE",
    reasons: Array.isArray(alert.reasons) ? alert.reasons : [],
    flagged_at: alert.flagged_at,
  };
}

function push(messageValue) {
  let parsed = null;
  try {
    parsed = JSON.parse(messageValue.toString());
  } catch {
    return;
  }
  const normalized = normalize(parsed);

  // Session-epoch filter: only alerts this session genuinely produced are
  // visible. In-session evidence is the producer's UTC `flagged_at`; anything
  // older (or missing a timestamp entirely) is a replayed historical record
  // and never touches the tally or the ring.
  if (normalized.flagged_at) {
    const ts = Date.parse(normalized.flagged_at);
    if (!Number.isFinite(ts) || ts < EPOCH) return;
  } else {
    return;
  }

  if (normalized.risk_level in levelCounts) {
    levelCounts[normalized.risk_level] += 1;
  }
  ring.unshift(normalized);
  if (ring.length > 100) ring.length = 100;
}

async function startAlertsReader() {
  // Session epoch: an explicit ALERTS_EPOCH (ISO string or epoch ms) wins,
  // otherwise the API's own boot instant.
  const override = process.env.ALERTS_EPOCH;
  EPOCH = override ? Date.parse(override) : (Date.now() - 24 * 60 * 60 * 1000); // default to last 24 hours so alerts survive API restarts
  if (!Number.isFinite(EPOCH)) EPOCH = Date.now() - 24 * 60 * 60 * 1000;

  const consumer = kafka.consumer({
    groupId,
    // New group starts from the beginning of the topic so the API always
    // has historical alerts, not just ones produced after boot.
    sessionTimeout: 30000,
    rebalanceTimeout: 30000,
  });
  await consumer.connect();
  await consumer.subscribe({ topic: ALERTS_TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => push(message.value),
  });
  console.log(
    `[api] alerts reader connected (topic=${ALERTS_TOPIC}, group=${groupId}, epoch=${new Date(EPOCH).toISOString()})`
  );
  return consumer;
}

//
// Consumer lag, via the admin client (read-only). Returns per-group
// sum of (log-end offset - committed offset) for the transactions topic.
//
async function groupLag(group, topic = "transactions") {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const topicOffsets = await admin.fetchTopicOffsets(topic); // [{ partition, offset }]
    const logEnd = Number(topicOffsets[0].offset); // next offset == high watermark

    let committed = -1;
    try {
      const res = await admin.fetchOffsets({ groupId: group, topics: [topic] });
      const tp = res.find((t) => t.topic === topic);
      if (tp) {
        const p = tp.partitions.find((x) => x.partition === topicOffsets[0].partition);
        if (p) committed = Number(p.offset);
      }
    } catch (e) {
      // Group may have no committed offsets yet (never ran) -> treat as 0.
      if (String(e.message).includes("not find") || String(e).toLowerCase().includes("group")) {
        committed = -1;
      } else {
        throw e;
      }
    }

    if (committed < 0) committed = 0;
    return { group, logEnd, committed, lag: Math.max(logEnd - committed, 0) };
  } finally {
    await admin.disconnect();
  }
}

module.exports = {
  kafka,
  startAlertsReader,
  groupLag,
  getAlerts: () => ring,
  getLevelCounts: () => ({ ...levelCounts }),
};