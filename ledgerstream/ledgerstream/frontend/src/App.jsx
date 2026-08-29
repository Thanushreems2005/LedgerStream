import { useEffect, useRef, useState } from "react";
import {
  fetchBalances,
  fetchTransactions,
  fetchAlerts,
  fetchLag,
  fetchStats,
} from "./api";

const POLL_MS = 2500;

// ---- small helpers -------------------------------------------------------

function formatMoney(n) {
  const v = Number(n);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(v);
}

function formatPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function timeAgo(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return d.toLocaleTimeString();
}

function levelClass(level) {
  switch (level) {
    case "HIGH":
      return "level-high";
    case "MEDIUM":
      return "level-medium";
    case "LOW":
      return "level-low";
    default:
      return "level-unknown";
  }
}

function actionClass(action) {
  switch (action) {
    case "APPROVE":
      return "tag-ok";
    case "VERIFY":
      return "tag-verify";
    case "HOLD":
      return "tag-fail";
    default:
      return "tag-unknown";
  }
}

const MODEL_LABEL = "XGBoost, 3-feature retrained model";

// ---- sub-components ------------------------------------------------------

function StatusPill({ connected, lagOk }) {
  const tone = !connected ? "dead" : lagOk ? "live" : "busy";
  return (
    <span className={`pill pill-${tone}`}>
      <span className="dot" />
      {!connected ? "OFFLINE" : lagOk ? "LIVE" : "BUSY"}
    </span>
  );
}

function OverviewCard({ label, value, sub, accent }) {
  return (
    <div className={`kpi risk-kpi ${accent || ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function RiskOverview({ stats }) {
  return (
    <section className="kpis risk-overview">
      <OverviewCard
        label="Transactions analyzed"
        value={Number(stats?.analyzed ?? 0).toLocaleString()}
        sub="applied · transactions_log"
        accent="hero"
      />
      <OverviewCard
        label="High risk (this session)"
        value={Number(stats?.high ?? 0).toLocaleString()}
        sub="risk_level HIGH — hover HOLD"
        accent="accent"
      />
      <OverviewCard
        label="Needs review (this session)"
        value={Number(stats?.medium ?? 0).toLocaleString()}
        sub="risk_level MEDIUM — action VERIFY"
        accent="warn"
      />
      <OverviewCard
        label="Current threshold"
        value={Number(stats?.threshold ?? 0.96).toFixed(2)}
        sub="fraud consumer decision gate"
      />
      <OverviewCard
        label="Model precision / recall"
        value={`${formatPct(stats?.measuredPrecision)} / ${formatPct(
          stats?.measuredRecall
        )}`}
        sub="measured on held-out test set"
      />
    </section>
  );
}

function RiskLevelBadge({ level }) {
  return <span className={`level-badge ${levelClass(level)}`}>{level || "—"}</span>;
}

function RiskDecisionsTable({ alerts, onSelect, selectedId }) {
  return (
    <div className="table-wrap">
      <table className="risk-table">
        <thead>
          <tr>
            <th>transaction</th>
            <th>amount</th>
            <th>risk score</th>
            <th>risk level</th>
            <th>action</th>
            <th>reasons</th>
          </tr>
        </thead>
        <tbody>
          {alerts.slice(0, 25).map((a) => (
            <tr
              key={a.event_id}
              className={`clickable ${a.event_id === selectedId ? "sel" : ""}`}
              onClick={() => onSelect(a.event_id)}
            >
              <td className="mono dim">{a.event_id.slice(0, 8)}</td>
              <td className="mono amt">{formatMoney(a.amount)}</td>
              <td className="mono">{formatPct(a.risk_score)}</td>
              <td>
                <RiskLevelBadge level={a.risk_level} />
              </td>
              <td>
                <span className={`tag ${actionClass(a.action)}`}>{a.action}</span>
              </td>
              <td className="dim reasons-cell">
                {a.reasons && a.reasons.length ? a.reasons.join(", ") : "—"}
              </td>
            </tr>
          ))}
          {alerts.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                no risk decisions yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RiskDetail({ alert, threshold, onClose }) {
  if (!alert) return null;
  return (
    <div className="panel detail-panel">
      <div className="panel-head">
        <h2>
          <span className="panel-dot purple" /> Transaction Risk Detail
        </h2>
        <button className="close-btn" onClick={onClose}>
          ✕ close
        </button>
      </div>
      <div className="detail-grid">
        <div className="detail-block wide">
          <div className="detail-label">event_id</div>
          <div className="detail-value mono wrap">{alert.event_id}</div>
        </div>
        <div className="detail-block">
          <div className="detail-label">amount</div>
          <div className="detail-value mono">{formatMoney(alert.amount)}</div>
        </div>
        <div className="detail-block">
          <div className="detail-label">from / to</div>
          <div className="detail-value mono">
            {alert.from_account} → {alert.to_account}
          </div>
        </div>
        <div className="detail-block">
          <div className="detail-label">flagged at</div>
          <div className="detail-value mono">{timeAgo(alert.flagged_at)}</div>
        </div>
        <div className="detail-block">
          <div className="detail-label">risk score</div>
          <div className="detail-value mono">{formatPct(alert.risk_score)}</div>
        </div>
        <div className="detail-block">
          <div className="detail-label">risk level</div>
          <div className="detail-value">
            <RiskLevelBadge level={alert.risk_level} />
          </div>
        </div>
        <div className="detail-block">
          <div className="detail-label">recommended action</div>
          <div className="detail-value">
            <span className={`tag ${actionClass(alert.action)}`}>{alert.action}</span>
          </div>
        </div>
        <div className="detail-block">
          <div className="detail-label">threshold</div>
          <div className="detail-value mono">{Number(threshold ?? 0.96).toFixed(2)}</div>
        </div>
        <div className="detail-block">
          <div className="detail-label">model</div>
          <div className="detail-value">{MODEL_LABEL}</div>
        </div>
        <div className="detail-block wide">
          <div className="detail-label">reasons</div>
          {alert.reasons && alert.reasons.length ? (
            <ul className="detail-reasons">
              {alert.reasons.map((r, i) => (
                <li key={i} className="mono">
                  {r}
                </li>
              ))}
            </ul>
          ) : (
            <div className="detail-value dim">—</div>
          )}
        </div>
      </div>
    </div>
  );
}

function BalanceRow({ account }) {
  const bal = Number(account.balance);
  return (
    <div className="balance-row">
      <span className="acct mono">{account.account_id}</span>
      <span className={`bal ${bal < 0 ? "neg" : ""}`}>{formatMoney(bal)}</span>
    </div>
  );
}

function TxRow({ tx }) {
  return (
    <tr>
      <td className="mono dim">{tx.event_id.slice(0, 8)}</td>
      <td className="mono">{tx.from_account}</td>
      <td className="arrow">→</td>
      <td className="mono">{tx.to_account}</td>
      <td className="mono amt">+{formatMoney(tx.amount)}</td>
      <td>
        <span className={`tag tag-${tx.status === "applied" ? "ok" : "fail"}`}>
          {tx.status}
        </span>
      </td>
      <td className="dim t-right mono">{timeAgo(tx.created_at)}</td>
    </tr>
  );
}

function LagCard({ title, data }) {
  const lag = Number(data?.lag ?? 0);
  const cls = lag === 0 ? "ok" : lag < 100 ? "warn" : "bad";
  return (
    <div className={`kpi ${cls}`}>
      <div className="kpi-label">{title}</div>
      <div className="kpi-value mono">
        {data ? lag.toLocaleString() : "—"}
        <span className="kpi-unit">msgs</span>
      </div>
      <div className="kpi-sub">
        {data
          ? `log-end ${Number(data.logEnd).toLocaleString()} · committed ${Number(
              data.committed
            ).toLocaleString()}`
          : "no data"}
      </div>
    </div>
  );
}

// ---- main app ------------------------------------------------------------

export default function App() {
  const [balances, setBalances] = useState([]);
  const [txns, setTxns] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [lag, setLag] = useState(null);
  const [stats, setStats] = useState(null);
  const [connected, setConnected] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const selectedAlertRef = useRef(null);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const [b, t, a, l, s] = await Promise.all([
          fetchBalances(),
          fetchTransactions(50),
          fetchAlerts(),
          fetchLag(),
          fetchStats(),
        ]);

        if (stopped) return;
        setBalances(b.accounts);
        setTxns(t.transactions);
        setAlerts(a.alerts);
        setLag(l.lag);
        setStats(s);
        setConnected(true);
        setError(null);
        setLastRefresh(new Date());
      } catch (e) {
        if (stopped) return;
        setConnected(false);
        setError(e.message);
      }
    }

    poll(); // immediate first pull
    const id = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const totalBalance = balances.reduce((s, a) => s + Number(a.balance), 0);
  const fraudLag = lag?.fraud?.lag ?? 0;
  const ledgerLag = lag?.ledger?.lag ?? 0;

  // The detail panel snapshots the clicked decision so it stays visible even
  // as the live feed rotates before it.
  const selectedAlert = alerts.find((a) => a.event_id === selectedId);
  if (selectedAlert) selectedAlertRef.current = selectedAlert;
  const detailAlert = selectedAlert || selectedAlertRef.current;

  function selectAlert(id) {
    setSelectedId(id === selectedId ? null : id);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">L</div>
          <div>
            <h1>LedgerStream</h1>
            <p className="tagline">Real-time payment ledger · Apache Kafka</p>
          </div>
        </div>
        <div className="status-area">
          <span className="info-sep">
            refreshed {lastRefresh ? timeAgo(lastRefresh.toISOString()) : "…"}
          </span>
          <StatusPill connected={connected} lagOk={ledgerLag === 0} />
        </div>
      </header>

      {error && (
        <div className="banner">
          ⚠ API unreachable: {error} — retrying every {POLL_MS / 1000}s
        </div>
      )}

      {/* 2. Risk overview — top of the dashboard */}
      <RiskOverview stats={stats} />

      {/* 3. Live risk decisions */}
      <section className="panel risk-panel">
        <div className="panel-head">
          <h2>
            <span className="panel-dot purple" /> Live Risk Decisions
          </h2>
          <span className="panel-meta">
            latest {alerts.slice(0, 25).length} · fraud-alerts topic · click a row
            for detail
          </span>
        </div>
        <RiskDecisionsTable
          alerts={alerts}
          selectedId={selectedAlert?.event_id}
          onSelect={selectAlert}
        />
      </section>

      {/* 4. Risk detail (expands on row click) */}
      {detailAlert && (
        <RiskDetail
          alert={detailAlert}
          threshold={stats?.threshold}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* 5. System health — existing sections, kept as-is, moved below */}
      <h2 className="section-heading">
        <span className="panel-dot green" /> System Health
      </h2>

      <section className="kpis">
        <div className="kpi hero">
          <div className="kpi-label">Total in system</div>
          <div className="kpi-value mono">{formatMoney(totalBalance)}</div>
          <div className="kpi-sub">{balances.length} accounts · all live</div>
        </div>
        <LagCard title="Ledger consumer lag" data={lag?.ledger} />
        <LagCard title="Fraud consumer lag" data={lag?.fraud} />
      </section>

      <section className="panels">
        <div className="panel">
          <div className="panel-head">
            <h2>
              <span className="panel-dot green" /> Account Balances
            </h2>
            <span className="panel-meta">accounts · Postgres</span>
          </div>
          <div className="balance-grid">
            {balances.map((a) => (
              <BalanceRow key={a.account_id} account={a} />
            ))}
            <div className="balance-row total">
              <span>Total</span>
              <span className="mono">{formatMoney(totalBalance)}</span>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>
              <span className="panel-dot blue" /> Transaction Feed
            </h2>
            <span className="panel-meta">{txns.length} latest · transactions_log</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>event</th>
                  <th>from</th>
                  <th />
                  <th>to</th>
                  <th>amount</th>
                  <th>status</th>
                  <th className="t-right">when</th>
                </tr>
              </thead>
              <tbody>
                {txns.slice(0, 14).map((tx) => (
                  <TxRow key={tx.event_id} tx={tx} />
                ))}
                {txns.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      no transactions yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <footer>
        LedgerStream monitoring UI · polls live sources every {POLL_MS / 1000}s ·
        read-only (no writes to pipeline)
      </footer>
    </div>
  );
}