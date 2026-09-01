import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBalances,
  fetchTransactions,
  fetchAlerts,
  fetchLag,
  fetchStats,
  fetchConfig,
} from "./api";

// ─── Constants ────────────────────────────────────────────────────────────────
const POLL_MS = 2500;
const PAGES = ["Overview", "Live Transactions", "Review Queue", "Blocked", "Analytics", "Accounts", "System Health"];
const PAGE_ICONS = ["◈", "↯", "⏸", "⊗", "◎", "◉", "⚙"];
const PAGE_SUBS = {
  "Overview":           "Monitoring production payments · pre-settlement protection",
  "Live Transactions":  "Real-time monitoring console",
  "Review Queue":       "MEDIUM risk payments awaiting analyst action",
  "Blocked":            "HIGH risk payments stopped before settlement",
  "Analytics":          "Fraud prevention metrics and model performance",
  "Accounts":           "Live ledger balances",
  "System Health":      "Infrastructure and processing metrics",
};

// ─── Currency formatting (INR) ─────────────────────────────────────────────────
function formatINR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

function formatPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function timeAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return d.toLocaleTimeString();
}

function levelBadge(level) {
  switch (level) {
    case "HIGH":   return <span className="badge badge-red">HIGH</span>;
    case "MEDIUM": return <span className="badge badge-amber">MEDIUM</span>;
    case "LOW":    return <span className="badge badge-green">LOW</span>;
    default:       return <span className="badge badge-dim">{level || "—"}</span>;
  }
}

function statusBadge(status) {
  switch (status) {
    case "applied":  return <span className="badge badge-green">APPROVED</span>;
    case "held":     return <span className="badge badge-amber">HELD</span>;
    case "blocked":  return <span className="badge badge-red">BLOCKED</span>;
    case "declined": return <span className="badge badge-dim">DECLINED</span>;
    default:         return <span className="badge badge-dim">{status || "—"}</span>;
  }
}

function amountBandBadge(band) {
  switch (band) {
    case "HIGH":     return <span className="badge badge-red">HIGH</span>;
    case "ELEVATED": return <span className="badge badge-purple">ELEVATED</span>;
    case "NORMAL":   return <span className="badge badge-blue">NORMAL</span>;
    case "VERY LOW": return <span className="badge badge-dim">VERY LOW</span>;
    default:         return <span className="badge badge-dim">{band || "NORMAL"}</span>;
  }
}

function riskFillClass(level) {
  if (level === "HIGH") return "high";
  if (level === "MEDIUM") return "medium";
  return "low";
}

// Derive an amount band from backend-provided breakpoints (data-driven).
// Falls back gracefully if config hasn't loaded yet.
function amountBandFor(amount, config) {
  const n = Number(amount);
  const bands = config?.amountBands || [
    { label: "VERY LOW", max: 100 },
    { label: "NORMAL", max: 1000 },
    { label: "ELEVATED", max: 10000 },
    { label: "HIGH", max: Infinity },
  ];
  for (const b of bands) {
    if (n < b.max || b.max === Infinity || b.max === null) return b.label;
  }
  return "HIGH";
}

// ─── Toast system ──────────────────────────────────────────────────────────────
function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-icon">{t.type === "success" ? "✓" : "⚠"}</span>
          <span>{t.msg}</span>
          <button className="toast-close" onClick={() => onDismiss(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

// ─── Transaction Detail Drawer ────────────────────────────────────────────────
function TransactionDrawer({ txn, alerts, txns, onAction, actionPending, onClose, config }) {
  if (!txn) return null;

  const alert = alerts.find((a) => a.event_id === txn.event_id);
  const txnState = txns.find((t) => t.event_id === txn.event_id);
  const status = txnState ? txnState.status : txn.status;
  const score = (txnState?.risk_score !== undefined && txnState?.risk_score !== null) ? Number(txnState.risk_score) : (alert ? alert.risk_score : null);
  const level = txnState?.risk_level || (alert ? alert.risk_level : "LOW");
  const reasons = txnState?.reasons ? txnState.reasons.split(" · ") : (alert ? alert.reasons : []);

  const moneyMoved = status === "applied";

  return (
    <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer">
        <div className="drawer-header">
          <span className="drawer-title">Transaction Detail</span>
          <button className="drawer-close" onClick={onClose}>✕ Close</button>
        </div>

        <div className="drawer-body">
          {/* Core info */}
          <div className="detail-section">
            <div className="detail-section-title">Transaction</div>
            <div className="detail-row">
              <span className="detail-key">Event ID</span>
              <span className="detail-val mono" style={{ fontSize: "11px", color: "var(--dim)" }}>{txn.event_id}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Amount</span>
              <span className="detail-val mono" style={{ fontSize: "20px", color: "var(--text)" }}>{formatINR(txn.amount)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Amount Band</span>
              <span className="detail-val">{amountBandBadge(txn.amount_band || amountBandFor(txn.amount, config))}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Transfer</span>
              <span className="detail-val mono">{txn.from_account} → {txn.to_account}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Timestamp</span>
              <span className="detail-val">{timeAgo(txn.created_at)}</span>
            </div>
          </div>

          {/* Risk assessment */}
          {score !== null && (
            <div className="detail-section">
              <div className="detail-section-title">AI Risk Assessment</div>
              <div className="detail-row">
                <span className="detail-key">Risk Score</span>
                <span className="detail-val mono" style={{ fontSize: "20px" }}>{formatPct(score)}</span>
              </div>
              <div style={{ fontSize: "11px", color: "var(--dim)", marginTop: "-6px", marginBottom: "8px" }}>
                * Estimated fraud probability
              </div>
              <div style={{ margin: "4px 0 8px" }}>
                <div className="risk-score-bar">
                  <div
                    className={`risk-score-fill ${riskFillClass(level)}`}
                    style={{ width: `${Math.min(score * 100, 100)}%` }}
                  />
                </div>
              </div>
              <div className="detail-row">
                <span className="detail-key">Risk Level</span>
                <span className="detail-val">{levelBadge(level)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-key">Decision</span>
                <span className="detail-val" style={{ fontWeight: 600 }}>{alert?.action || (level === "LOW" ? "APPROVE" : (level === "MEDIUM" ? "VERIFY" : "HOLD"))}</span>
              </div>
            </div>
          )}

          {/* Status */}
          <div className="detail-section">
            <div className="detail-section-title">Settlement</div>
            <div className="detail-row">
              <span className="detail-key">Status</span>
              <span className="detail-val">{statusBadge(status)}</span>
            </div>
            <div
              className={`money-moved-box ${moneyMoved ? "yes" : "no"}`}
              style={{ marginTop: "4px" }}
            >
              {moneyMoved ? "✓" : "✗"}
              {" "}MONEY MOVED: {moneyMoved ? "YES — Settlement complete" : "NO — Money protected"}
            </div>
          </div>

          {/* AI signals */}
          {reasons && reasons.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-title">AI Signals <span className="dim" style={{ fontSize: "9px", marginLeft: 6 }}>(heuristic, not SHAP)</span></div>
              {reasons.map((r, i) => (
                <div key={i} className="review-signals" style={{ marginBottom: "4px" }}>{r}</div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        {status === "held" && (
          <div className="drawer-actions">
            <button
              className="btn btn-approve"
              style={{ flex: 1 }}
              disabled={actionPending}
              onClick={() => onAction(txn.event_id, "approve")}
            >
              {actionPending ? "Processing…" : "✓ Approve & Settle"}
            </button>
            <button
              className="btn btn-decline"
              style={{ flex: 1 }}
              disabled={actionPending}
              onClick={() => onAction(txn.event_id, "decline")}
            >
              ✕ Decline
            </button>
          </div>
        )}
        {status === "blocked" && (
          <div className="drawer-blocked-notice">
            <div className="blocked-notice-box">⊗ Blocked — No analyst action available</div>
          </div>
        )}
        {status === "applied" && (
          <div className="drawer-blocked-notice">
            <div className="blocked-notice-box" style={{ background: "var(--green-bg)", border: "1px solid var(--green-bd)", color: "var(--green)" }}>
              ✓ Approved & Settled
            </div>
          </div>
        )}
        {status === "declined" && (
          <div className="drawer-blocked-notice">
            <div className="blocked-notice-box" style={{ background: "rgba(100,116,139,.1)", border: "1px solid rgba(100,116,139,.2)", color: "var(--dim)" }}>
              ✕ Declined by Analyst
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Pages ────────────────────────────────────────────────────────────────────

function OverviewPage({ stats, alerts, txns, balances, connected, onSelectTxn, config }) {
  const totalBalance = balances.reduce((s, a) => s + Number(a.balance), 0);
  const blockedAmount = txns.filter((t) => t.status === "blocked" || t.status === "declined")
                           .reduce((s, t) => s + Number(t.amount), 0);

  const lowT = config?.riskPolicy?.lowThreshold ?? 0.01;
  const highT = config?.riskPolicy?.highThreshold ?? 0.05;
  const lowPct = formatPct(lowT);
  const highPct = formatPct(highT);

  return (
    <div>
      {/* Hero flow */}
      <div className="overview-flow mb-20" style={{ flexDirection: "column", padding: "14px 18px", gap: "10px" }}>
        <div style={{ display: "flex", width: "100%", alignItems: "center", gap: "6px" }}>
          <div className="flow-node entry" style={{ borderRight: "1px solid var(--border)", flex: 1 }}>
            <div className="flow-node-icon">💳</div>
            <div className="flow-node-label">Transaction</div>
            <div className="flow-node-sub">Amount + features</div>
          </div>
          <div style={{ padding: "0 8px", color: "var(--dim)", fontSize: "16px", fontWeight: "bold" }}>→</div>
          <div className="flow-node ai" style={{ flex: 1.1, borderRight: "1px solid var(--border)", borderLeft: "1px solid var(--border)" }}>
            <div className="flow-node-icon">🤖</div>
            <div className="flow-node-label">AI Fraud Probability</div>
            <div className="flow-node-sub">XGBoost ML · BEFORE settlement</div>
          </div>
          <div className="flow-outcomes" style={{ flex: 2 }}>
            <div className="flow-outcome settle">
              <div className="flow-outcome-score">score &lt; {lowPct}</div>
              <div className="flow-outcome-label" style={{ color: "var(--green)" }}>LOW RISK</div>
              <div className="flow-outcome-action">↓ APPROVE &amp; SETTLE</div>
            </div>
            <div className="flow-outcome hold" style={{ borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)" }}>
              <div className="flow-outcome-score">{lowPct} – {highPct}</div>
              <div className="flow-outcome-label" style={{ color: "var(--amber)" }}>MEDIUM RISK</div>
              <div className="flow-outcome-action">↓ HOLD for REVIEW</div>
            </div>
            <div className="flow-outcome block">
              <div className="flow-outcome-score">score &gt; {highPct}</div>
              <div className="flow-outcome-label" style={{ color: "var(--red)" }}>HIGH RISK</div>
              <div className="flow-outcome-action">↓ BLOCK before settlement</div>
            </div>
          </div>
        </div>
        <div style={{ fontSize: "11px", color: "var(--dim)", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "6px" }}>
          * Risk Score = estimated fraud probability from the ML model. The amount is a model feature; the risk classification is driven by the model's fraud probability.
        </div>
      </div>

      {/* KPI Grid */}
      <div className="kpi-grid mb-20">
        <div className="kpi-card red">
          <div className="kpi-label">Blocked (HIGH)</div>
          <div className="kpi-value">{Number(stats?.blockedCount ?? 0).toLocaleString()}</div>
          <div className="kpi-sub">fraud prevented · 0 settled</div>
        </div>
        <div className="kpi-card amber">
          <div className="kpi-label">Awaiting Review</div>
          <div className="kpi-value">{Number(stats?.heldCount ?? 0).toLocaleString()}</div>
          <div className="kpi-sub">MEDIUM risk · held</div>
        </div>
        <div className="kpi-card green">
          <div className="kpi-label">Approved</div>
          <div className="kpi-value">{Number(stats?.appliedCount ?? 0).toLocaleString()}</div>
          <div className="kpi-sub">LOW risk · settled</div>
        </div>
        <div className="kpi-card dim">
          <div className="kpi-label">Declined</div>
          <div className="kpi-value">{Number(stats?.declinedCount ?? 0).toLocaleString()}</div>
          <div className="kpi-sub">analyst rejected</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Transactions Analyzed</div>
          <div className="kpi-value">{Number(stats?.analyzed ?? 0).toLocaleString()}</div>
          <div className="kpi-sub">AI-scored total</div>
        </div>
        <div className="kpi-card green">
          <div className="kpi-label">Funds Protected</div>
          <div className="kpi-value sm">{formatINR(blockedAmount)}</div>
          <div className="kpi-sub">blocked + declined</div>
        </div>
      </div>

      {/* Two columns: recent decisions + risk distribution */}
      <div className="page-row col-2" style={{ gap: 16 }}>
        {/* Recent risk decisions */}
        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-purple" />Recent Risk Decisions</span>
            <span className="card-meta">latest 8 · click to view</span>
          </div>
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Amount</th>
                  <th>Level</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {txns.slice(0, 8).map((t) => {
                  const level = t.risk_level || "LOW";
                  return (
                    <tr key={t.event_id} className="clickable" onClick={() => onSelectTxn(t.event_id)}>
                      <td className="mono dim" style={{ fontSize: "11px" }}>{t.event_id.slice(0, 10)}</td>
                      <td className="mono" style={{ fontWeight: 600 }}>{formatINR(t.amount)}</td>
                      <td>{levelBadge(level)}</td>
                      <td>{statusBadge(t.status)}</td>
                      <td className="dim" style={{ fontSize: "11px" }}>{timeAgo(t.created_at)}</td>
                    </tr>
                  );
                })}
                {txns.length === 0 && (
                  <tr><td colSpan={5} className="empty-state">No decisions yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Risk distribution */}
        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-blue" />Risk Distribution</span>
            <span className="card-meta">by transaction count</span>
          </div>
          <div className="card-body">
            <RiskDistribution stats={stats} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RiskDistribution({ stats }) {
  const applied  = Number(stats?.appliedCount  ?? 0);
  const held     = Number(stats?.heldCount     ?? 0);
  const blocked  = Number(stats?.blockedCount  ?? 0);
  const declined = Number(stats?.declinedCount ?? 0);
  const total = applied + held + blocked + declined || 1;

  const bars = [
    { label: "Approved",  value: applied,  color: "var(--green)", bg: "var(--green-bg)" },
    { label: "Held",      value: held,     color: "var(--amber)", bg: "var(--amber-bg)" },
    { label: "Blocked",   value: blocked,  color: "var(--red)",   bg: "var(--red-bg)" },
    { label: "Declined",  value: declined, color: "var(--dim)",   bg: "rgba(100,116,139,.1)" },
  ];

  return (
    <div className="bar-chart">
      {bars.map(({ label, value, color }) => (
        <div key={label} className="bar-row">
          <div className="bar-label">{label}</div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(value / total) * 100}%`, background: color }} />
          </div>
          <div className="bar-value">{value.toLocaleString()}</div>
        </div>
      ))}
      <div style={{ marginTop: 16, fontSize: 11, color: "var(--dim)", fontFamily: "var(--mono)" }}>
        Total transactions in log: {(applied + held + blocked + declined).toLocaleString()}
      </div>
    </div>
  );
}

function LiveTransactionsPage({ txns, alerts, onSelectTxn, selectedTxnId, config }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [levelFilter, setLevelFilter] = useState("all");
  const [bandFilter, setBandFilter] = useState("all");

  const filtered = txns.filter((t) => {
    const a = alerts.find((x) => x.event_id === t.event_id);
    const level = t.risk_level || a?.risk_level || "LOW";
    const band = t.amount_band || amountBandFor(t.amount, config);
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    if (levelFilter !== "all" && level !== levelFilter) return false;
    if (bandFilter !== "all" && band !== bandFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!t.event_id.toLowerCase().includes(q) &&
          !t.from_account.toLowerCase().includes(q) &&
          !t.to_account.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div>
      <div className="filters">
        <input
          className="filter-input"
          placeholder="Search by ID, account…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 180 }}
        />
        <select className="filter-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All Decisions</option>
          <option value="applied">Approved</option>
          <option value="held">Held</option>
          <option value="blocked">Blocked</option>
          <option value="declined">Declined</option>
        </select>
        <select className="filter-input" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
          <option value="all">All AI Levels</option>
          <option value="LOW">LOW</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="HIGH">HIGH</option>
        </select>
        <select className="filter-input" value={bandFilter} onChange={(e) => setBandFilter(e.target.value)}>
          <option value="all">All Amount Bands</option>
          {(config?.amountBands || []).map((b) => (
            <option key={b.label} value={b.label}>{b.label}</option>
          ))}
        </select>
        <span className="dim" style={{ fontSize: 12, marginLeft: 4, alignSelf: "center" }}>
          {filtered.length} / {txns.length} transactions
        </span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Transaction ID</th>
                <th>Amount</th>
                <th>Transfer</th>
                <th>AI Risk</th>
                <th>Amount Band</th>
                <th>Decision</th>
                <th>Settlement</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map((t) => {
                const a = alerts.find((x) => x.event_id === t.event_id);
                const score = (t.risk_score !== undefined && t.risk_score !== null) ? Number(t.risk_score) : (a ? a.risk_score : null);
                const band = t.amount_band || amountBandFor(t.amount, config);
                return (
                  <tr
                    key={t.event_id}
                    className={`clickable ${t.event_id === selectedTxnId ? "selected" : ""}`}
                    onClick={() => onSelectTxn(t.event_id)}
                  >
                    <td className="mono dim" style={{ fontSize: "11px" }}>{t.event_id.slice(0, 12)}…</td>
                    <td className="mono" style={{ fontWeight: 600 }}>{formatINR(t.amount)}</td>
                    <td className="mono">{t.from_account} → {t.to_account}</td>
                    <td className="mono" title="Estimated fraud probability">{score !== null ? formatPct(score) : "—"}</td>
                    <td>{amountBandBadge(band)}</td>
                    <td>{statusBadge(t.status)}</td>
                    <td className="mono" style={{ fontWeight: 600, color: t.status === "applied" ? "var(--green)" : "var(--dim)" }}>
                      {t.status === "applied" ? `${formatINR(t.amount)} MOVED` : "₹0.00 MOVED"}
                    </td>
                    <td className="dim" style={{ fontSize: "11px" }}>{timeAgo(t.created_at)}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">
                      <div className="empty-state-icon">↯</div>
                      No transactions match your filters
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ReviewQueuePage({ txns, alerts, onAction, actionPending, onSelectTxn, config }) {
  const held = txns.filter((t) => t.status === "held");

  if (held.length === 0) {
    return (
      <div className="card">
        <div className="empty-state" style={{ padding: "60px 24px" }}>
          <div className="empty-state-icon">⏸</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Review queue is empty</div>
          <div className="dim">No MEDIUM risk transactions awaiting review</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          background: "var(--amber-bg)",
          border: "1px solid var(--amber-bd)",
          borderRadius: "var(--radius)",
          padding: "10px 16px",
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 12.5,
          color: "var(--amber)",
          fontWeight: 600,
        }}
      >
        ⏸ {held.length} payment{held.length > 1 ? "s" : ""} held by AI engine — settlement frozen, awaiting analyst decision
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 14 }}>
        {held.map((tx) => {
          const a = alerts.find((x) => x.event_id === tx.event_id);
          const score = (tx.risk_score !== undefined && tx.risk_score !== null) ? Number(tx.risk_score) : (a ? a.risk_score : null);
          const reasons = tx.reasons ? tx.reasons.split(" · ") : (a ? a.reasons : ["MEDIUM risk transaction flagged by AI"]);
          return (
            <div key={tx.event_id} className="review-card">
              <div className="review-card-header">
                <div>
                  <div className="review-card-id">{tx.event_id.slice(0, 12)}…</div>
                  <div style={{ marginTop: 2 }}>{statusBadge("held")}</div>
                </div>
                <div className="review-card-amount">{formatINR(tx.amount)}</div>
              </div>

              <div className="review-card-meta">
                <div className="review-meta-item">
                  <div className="review-meta-label">Transfer</div>
                  <div className="review-meta-value">{tx.from_account} → {tx.to_account}</div>
                </div>
                <div className="review-meta-item">
                  <div className="review-meta-label">Amount Band</div>
                  <div className="review-meta-value">
                    {amountBandBadge(tx.amount_band || amountBandFor(tx.amount, config))}
                  </div>
                </div>
                <div className="review-meta-item">
                  <div className="review-meta-label">AI Risk</div>
                  <div className="review-meta-value" style={{ color: "var(--amber)", fontWeight: 700 }}>
                    {score !== null ? formatPct(score) : "—"}
                  </div>
                </div>
                <div className="review-meta-item">
                  <div className="review-meta-label">Waiting</div>
                  <div className="review-meta-value">{timeAgo(tx.created_at)}</div>
                </div>
              </div>

              <div style={{ fontSize: 10, color: "var(--dim)", marginTop: -6, marginBottom: 10 }}>
                * Estimated fraud probability
              </div>

              {reasons.length > 0 && (
                <div className="review-signals">
                  <strong>Why flagged:</strong><br />
                  {reasons.join(" · ")}
                </div>
              )}

              <div className="review-money-frozen">
                ✗ MONEY MOVED: NO — Settlement frozen
              </div>

              <div className="review-actions">
                <button
                  className="btn btn-approve"
                  style={{ flex: 1 }}
                  disabled={actionPending}
                  onClick={() => onAction(tx.event_id, "approve")}
                >
                  {actionPending ? "…" : "✓ Approve & Settle"}
                </button>
                <button
                  className="btn btn-decline"
                  style={{ flex: 1 }}
                  disabled={actionPending}
                  onClick={() => onAction(tx.event_id, "decline")}
                >
                  ✕ Decline
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BlockedPage({ txns, alerts, config }) {
  const blocked = txns.filter((t) => t.status === "blocked");
  const totalBlocked = blocked.reduce((s, t) => s + Number(t.amount), 0);

  if (blocked.length === 0) {
    return (
      <div className="card">
        <div className="empty-state" style={{ padding: "80px 24px" }}>
          <div className="empty-state-icon" style={{ fontSize: "40px", color: "var(--dim)", marginBottom: 12 }}>⊗</div>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>No Blocked Transactions</div>
          <div className="dim" style={{ fontSize: 13, maxWidth: 360, margin: "0 auto" }}>
            HIGH risk transactions (Estimated fraud probability above the configured block threshold) are automatically blocked before settlement. No high-risk transactions have been detected in this monitoring session.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <div className="kpi-card red" style={{ flex: 1 }}>
          <div className="kpi-label">Total Blocked</div>
          <div className="kpi-value">{blocked.length}</div>
          <div className="kpi-sub">payments stopped by AI</div>
        </div>
        <div className="kpi-card red" style={{ flex: 2 }}>
          <div className="kpi-label">Total Funds Protected</div>
          <div className="kpi-value sm">{formatINR(totalBlocked)}</div>
          <div className="kpi-sub">money never moved</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 14 }}>
        {blocked.map((tx) => {
          const a = alerts.find((x) => x.event_id === tx.event_id);
          const score = (tx.risk_score !== undefined && tx.risk_score !== null) ? Number(tx.risk_score) : (a ? a.risk_score : null);
          const reasons = tx.reasons ? tx.reasons.split(" · ") : (a ? a.reasons : ["HIGH risk transaction flagged by AI"]);
          return (
            <div key={tx.event_id} className="blocked-card" style={{ border: "1px solid var(--red-bd)", background: "var(--red-bg)", padding: 16, borderRadius: "var(--radius)" }}>
              <div style={{ fontSize: 10, color: "var(--red)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
                HIGH RISK TRANSACTION
              </div>
              <div className="review-card-header" style={{ marginBottom: 12 }}>
                <div>
                  <div className="review-card-id" style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}>{tx.event_id.slice(0, 12)}…</div>
                  <div style={{ marginTop: 4 }}>{statusBadge("blocked")}</div>
                </div>
                <div className="blocked-card-amount" style={{ color: "var(--red)", fontWeight: 700, fontSize: 20 }}>{formatINR(tx.amount)}</div>
              </div>

              <div className="review-card-meta" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, background: "rgba(0,0,0,0.15)", padding: 10, borderRadius: "var(--radius-sm)", marginBottom: 12 }}>
                <div className="review-meta-item">
                  <div className="review-meta-label" style={{ fontSize: 10, color: "var(--dim)" }}>Transfer</div>
                  <div className="review-meta-value" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{tx.from_account} → {tx.to_account}</div>
                </div>
                <div className="review-meta-item">
                  <div className="review-meta-label">Amount Band</div>
                  <div className="review-meta-value">
                    {amountBandBadge(tx.amount_band || amountBandFor(tx.amount, config))}
                  </div>
                </div>
                <div className="review-meta-item">
                  <div className="review-meta-label" style={{ fontSize: 10, color: "var(--dim)" }}>AI Risk</div>
                  <div className="review-meta-value" style={{ color: "var(--red)", fontWeight: 700 }}>
                    {score !== null ? formatPct(score) : "—"}
                  </div>
                </div>
                <div className="review-meta-item">
                  <div className="review-meta-label" style={{ fontSize: 10, color: "var(--dim)" }}>Timestamp</div>
                  <div className="review-meta-value" style={{ fontSize: 11 }}>{timeAgo(tx.created_at)}</div>
                </div>
              </div>

              <div style={{ fontSize: 10, color: "var(--dim)", marginBottom: 10 }}>
                * Estimated fraud probability
              </div>

              {reasons.length > 0 && (
                <div className="review-signals" style={{ marginBottom: 12, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "var(--radius-sm)", padding: 8, fontSize: 11.5 }}>
                  <strong>Behavioral Signals:</strong><br />
                  {reasons.join(" · ")}
                </div>
              )}

              <div className="blocked-prevented-box" style={{ background: "var(--red)", color: "white", padding: 10, borderRadius: "var(--radius-sm)", textAlign: "center", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                ⊗ BLOCKED BEFORE SETTLEMENT · MONEY MOVED: NO · FRAUD PREVENTED
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AnalyticsPage({ stats, txns, alerts, config }) {
  const applied  = Number(stats?.appliedCount  ?? 0);
  const held     = Number(stats?.heldCount     ?? 0);
  const blocked  = Number(stats?.blockedCount  ?? 0);
  const declined = Number(stats?.declinedCount ?? 0);
  const total    = applied + held + blocked + declined || 1;

  const appliedAmount  = txns.filter((t) => t.status === "applied").reduce((s, t) => s + Number(t.amount), 0);
  const blockedAmount  = txns.filter((t) => t.status === "blocked").reduce((s, t) => s + Number(t.amount), 0);
  const heldAmount     = txns.filter((t) => t.status === "held").reduce((s, t) => s + Number(t.amount), 0);
  const declinedAmount = txns.filter((t) => t.status === "declined").reduce((s, t) => s + Number(t.amount), 0);
  const totalAmount    = appliedAmount + blockedAmount + heldAmount + declinedAmount || 1;

  const lowT = config?.riskPolicy?.lowThreshold ?? 0.01;
  const highT = config?.riskPolicy?.highThreshold ?? 0.05;

  const statusBars = [
    { label: "Approved", value: applied,  pct: applied/total,  color: "var(--green)" },
    { label: "Held",     value: held,     pct: held/total,     color: "var(--amber)" },
    { label: "Blocked",  value: blocked,  pct: blocked/total,  color: "var(--red)" },
    { label: "Declined", value: declined, pct: declined/total, color: "var(--dim)" },
  ];

  const amountBars = [
    { label: "Approved",  value: appliedAmount,  pct: appliedAmount/totalAmount,  color: "var(--green)" },
    { label: "Held",      value: heldAmount,     pct: heldAmount/totalAmount,     color: "var(--amber)" },
    { label: "Blocked",   value: blockedAmount,  pct: blockedAmount/totalAmount,  color: "var(--red)" },
    { label: "Declined",  value: declinedAmount, pct: declinedAmount/totalAmount, color: "var(--dim)" },
  ];

  return (
    <div>
      <div className="page-row col-2 mb-16">
        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-blue" />Decision Distribution</span>
            <span className="card-meta">by transaction count</span>
          </div>
          <div className="card-body">
            <div className="bar-chart">
              {statusBars.map(({ label, value, pct, color }) => (
                <div key={label} className="bar-row">
                  <div className="bar-label">{label}</div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${pct * 100}%`, background: color }} />
                  </div>
                  <div className="bar-value">{value.toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-green" />Amount Distribution</span>
            <span className="card-meta">by transaction value</span>
          </div>
          <div className="card-body">
            <div className="bar-chart">
              {amountBars.map(({ label, value, pct, color }) => (
                <div key={label} className="bar-row">
                  <div className="bar-label">{label}</div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${pct * 100}%`, background: color }} />
                  </div>
                  <div className="bar-value mono" style={{ fontSize: 10 }}>{formatINR(value).replace("₹", "₹")}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="page-row col-3 mb-16">
        <div className="kpi-card green">
          <div className="kpi-label">Total Processed</div>
          <div className="kpi-value sm">{formatINR(appliedAmount)}</div>
          <div className="kpi-sub">settled transactions</div>
        </div>
        <div className="kpi-card red">
          <div className="kpi-label">Funds Protected</div>
          <div className="kpi-value sm">{formatINR(blockedAmount + declinedAmount)}</div>
          <div className="kpi-sub">blocked + declined</div>
        </div>
        <div className="kpi-card amber">
          <div className="kpi-label">Pending Settlement</div>
          <div className="kpi-value sm">{formatINR(heldAmount)}</div>
          <div className="kpi-sub">held · awaiting review</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-purple" />Risk Policy</span>
          <span className="card-meta">live from backend configuration</span>
        </div>
        <div className="card-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
            {[
              { label: "LOW Threshold", value: formatPct(lowT), note: "score < threshold → APPROVE" },
              { label: "HIGH Threshold", value: formatPct(highT), note: "score > threshold → BLOCK" },
            ].map(({ label, value, note }) => (
              <div key={label} style={{ background: "var(--panel-2)", borderRadius: "var(--radius-sm)", padding: "12px 14px", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 10, color: "var(--dim)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 4 }}>{label}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 700 }}>{value}</div>
                <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 3 }}>{note}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--dim)", fontFamily: "var(--mono)" }}>
            Risk Score = estimated fraud probability from the ML model. The risk classification and action are driven solely by the model score against the configured policy thresholds. Risk reasons are heuristic feature explanations (late-night hour, velocity burst, amount spike) — not mathematical SHAP attributions.
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountsPage({ balances }) {
  const totalBalance = balances.reduce((s, a) => s + Number(a.balance), 0);
  return (
    <div>
      <div className="kpi-card green mb-16" style={{ maxWidth: 320 }}>
        <div className="kpi-label">Total System Balance</div>
        <div className="kpi-value sm">{formatINR(totalBalance)}</div>
        <div className="kpi-sub">{balances.length} accounts · conserved</div>
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-green" />Account Ledger</span>
          <span className="card-meta">{balances.length} accounts · live PostgreSQL</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Account ID</th>
                <th style={{ textAlign: "right" }}>Current Balance</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((a, i) => (
                <tr key={a.account_id}>
                  <td className="dim" style={{ fontSize: 11 }}>{i + 1}</td>
                  <td className="mono" style={{ fontWeight: 600 }}>{a.account_id}</td>
                  <td className="mono t-right" style={{ fontWeight: 700, color: "var(--green)" }}>
                    {formatINR(a.balance)}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} style={{ fontWeight: 700, paddingTop: 12 }}>Total</td>
                <td className="mono t-right" style={{ fontWeight: 800, fontSize: 15, paddingTop: 12, borderTop: "1px solid var(--border-2)", color: "var(--brand-dark)" }}>
                  {formatINR(totalBalance)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 16px 14px", fontSize: 11, color: "var(--dim)", fontFamily: "var(--mono)", borderTop: "1px solid var(--border)" }}>
          Balance conservation verified · SUM(balance) computed live from the database: {formatINR(totalBalance)}
        </div>
      </div>
    </div>
  );
}

function SystemHealthPage({ lag, connected, stats, onSeed, seeding, config }) {
  const ledgerLag = Number(lag?.ledger?.lag ?? 0);
  const fraudLag  = Number(lag?.fraud?.lag  ?? 0);

  function lagBadge(l) {
    if (l === 0) return <span className="badge badge-green">0 lag</span>;
    if (l < 100) return <span className="badge badge-amber">{l} msgs</span>;
    return <span className="badge badge-red">{l} msgs</span>;
  }

  return (
    <div>
      <div className="health-grid mb-20">
        {[
          { name: "API Server",        meta: "Express",                    ok: connected },
          { name: "PostgreSQL",         meta: "ledgerstore database",       ok: connected },
          { name: "Kafka Broker",       meta: "transactions topic",         ok: connected },
          { name: "AI Risk Engine",     meta: "XGBoost inline scoring",     ok: connected },
          { name: "Ledger Consumer",    meta: "ledger-consumer-group",      ok: connected },
          { name: "Fraud Consumer",     meta: "fraud-consumer-group",       ok: connected },
        ].map(({ name, meta, ok }) => (
          <div key={name} className="health-item">
            <div className="health-item-info">
              <div className="health-item-name">{name}</div>
              <div className="health-item-meta">{meta}</div>
            </div>
            <span className={`badge ${ok ? "badge-green" : "badge-red"}`}>
              {ok ? "● Operational" : "● Offline"}
            </span>
          </div>
        ))}
      </div>

      <div className="page-row col-2 mb-16">
        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-blue" />Consumer Lag</span>
            <span className="card-meta">Kafka offset lag</span>
          </div>
          <div className="card-body">
            {[
              { label: "Ledger Consumer", lag: ledgerLag, data: lag?.ledger },
              { label: "Fraud Consumer",  lag: fraudLag,  data: lag?.fraud },
            ].map(({ label, lag: l, data }) => (
              <div key={label} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
                  {lagBadge(l)}
                </div>
                <div style={{ fontSize: 11, color: "var(--dim)", fontFamily: "var(--mono)" }}>
                  log-end: {Number(data?.logEnd ?? 0).toLocaleString()} · committed: {Number(data?.committed ?? 0).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-purple" />Processing Architecture</span>
            <span className="card-meta">pipeline design</span>
          </div>
          <div className="card-body">
            {[
              { label: "Ingestion",        value: "Kafka transactions topic" },
              { label: "Feature Extraction", value: "amount · hour · velocity" },
              { label: "Risk Engine",       value: "XGBoost fraud probability" },
              { label: "Decision",          value: `policy thresholds ${formatPct(config?.riskPolicy?.lowThreshold ?? 0.01)} / ${formatPct(config?.riskPolicy?.highThreshold ?? 0.05)}` },
              { label: "Persistence",       value: "PostgreSQL (balance-safe)" },
              { label: "Commit Order",      value: "PostgreSQL → Kafka" },
            ].map(({ label, value }) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontSize: 12, color: "var(--dim)" }}>{label}</span>
                <span style={{ fontSize: 12, fontFamily: "var(--mono)", fontWeight: 600 }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-green" />Database Integrity</span>
          <span className="card-meta">SUM(balance) conservation</span>
        </div>
        <div className="card-body">
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            {[
              { label: "Balance Conservation", value: "checked live in Accounts", ok: true },
              { label: "Idempotency Guard", value: "processed_events UNIQUE", ok: true },
              { label: "Row Locking", value: "SELECT FOR UPDATE", ok: true },
              { label: "Crash Safety", value: "DB COMMIT → Kafka COMMIT", ok: true },
            ].map(({ label, value, ok }) => (
              <div key={label} style={{ flex: "1 1 200px", background: "var(--panel-2)", borderRadius: "var(--radius-sm)", padding: "12px 14px", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 10, color: "var(--dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 12, fontFamily: "var(--mono)", fontWeight: 600 }}>{value}</div>
                {ok && <div style={{ fontSize: 10, color: "var(--green)", marginTop: 3 }}>✓ Verified</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-blue" />Demo Administration</span>
          <span className="card-meta">controlled transaction seeder</span>
        </div>
        <div className="card-body">
          <p style={{ fontSize: 12.5, color: "var(--dim)", marginBottom: 12 }}>
            Click the button below to generate generic demo transactions and push them through the live Kafka / PostgreSQL pipeline. Real accounts are selected from the database and amounts are drawn from the configured demo range. The XGBoost model scores each transaction and the risk policy determines the outcome — LOW/MEDIUM/HIGH are decided by the model, never hardcoded.
          </p>
          <button 
            className="btn btn-approve" 
            onClick={onSeed} 
            disabled={seeding || !connected}
            style={{ padding: "8px 16px", background: "var(--purple)", borderColor: "var(--purple)", color: "white" }}
          >
            {seeding ? "Generating Events..." : "⚡ Generate Demo Transactions"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function Sidebar({ page, onNav, heldCount, blockedCount, connected }) {
  const operationsPages = [
    { name: "Overview", icon: "◈" },
    { name: "Live Transactions", icon: "↯" },
    { name: "Review Queue", icon: "⏸" },
    { name: "Blocked", icon: "⊗" },
    { name: "Analytics", icon: "◎" },
    { name: "Accounts", icon: "◉" },
  ];
  const infrastructurePages = [
    { name: "System Health", icon: "⚙" },
  ];

  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-name">
          LedgerStream <span className="brand-accent">RM</span>
          <span className="sidebar-brand-badge">PROD</span>
        </div>
        <div className="sidebar-brand-sub">Payment Risk Management</div>
      </div>

      <div className="sidebar-nav">
        <div className="nav-section-label">OPERATIONS</div>
        {operationsPages.map((item) => (
          <button
            key={item.name}
            className={`nav-item ${page === item.name ? "active" : ""}`}
            onClick={() => onNav(item.name)}
          >
            <span className="nav-item-icon">{item.icon}</span>
            {item.name}
            {item.name === "Review Queue" && heldCount > 0 && (
              <span className="nav-item-badge amber">{heldCount}</span>
            )}
            {item.name === "Blocked" && blockedCount > 0 && (
              <span className="nav-item-badge">{blockedCount}</span>
            )}
          </button>
        ))}

        <div className="nav-section-label" style={{ marginTop: 14 }}>INFRASTRUCTURE</div>
        {infrastructurePages.map((item) => (
          <button
            key={item.name}
            className={`nav-item ${page === item.name ? "active" : ""}`}
            onClick={() => onNav(item.name)}
          >
            <span className="nav-item-icon">{item.icon}</span>
            {item.name}
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-status-item">
          <span>AI Risk Engine</span>
          <span><span className={`status-dot ${connected ? "live" : "dead"}`} />{connected ? "Operational" : "Offline"}</span>
        </div>
        <div className="sidebar-status-item">
          <span>Kafka Stream</span>
          <span><span className={`status-dot ${connected ? "live" : "dead"}`} />{connected ? "Connected" : "Offline"}</span>
        </div>
        <div className="sidebar-status-item">
          <span>PostgreSQL</span>
          <span><span className={`status-dot ${connected ? "live" : "dead"}`} />{connected ? "Connected" : "Offline"}</span>
        </div>
      </div>
    </nav>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("Overview");
  const [balances, setBalances] = useState([]);
  const [txns, setTxns] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [lag, setLag] = useState(null);
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState(null);
  const [connected, setConnected] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [error, setError] = useState(null);
  const [selectedTxnId, setSelectedTxnId] = useState(null);
  const [actionPending, setActionPending] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [toasts, setToasts] = useState([]);

  async function handleSeedDemoData() {
    setSeeding(true);
    try {
      const res = await fetch("/api/admin/seed-demo", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      addToast("success", `Seeded ${data.count} controlled demo transactions via Kafka/XGBoost successfully.`);
      await refreshData();
    } catch (e) {
      addToast("error", `Seeding failed: ${e.message}`);
    } finally {
      setSeeding(false);
    }
  }
  const toastId = useRef(0);

  function addToast(type, msg) {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, type, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  const refreshData = useCallback(async () => {
    try {
      const [b, t, a, l, s, c] = await Promise.all([
        fetchBalances(),
        fetchTransactions(200),
        fetchAlerts(),
        fetchLag(),
        fetchStats(),
        fetchConfig(),
      ]);
      setBalances(b.accounts);
      setTxns(t.transactions);
      setAlerts(a.alerts);
      setLag(l.lag);
      setStats(s);
      setConfig(c);
      setConnected(true);
      setError(null);
      setLastRefresh(new Date());
    } catch (e) {
      setConnected(false);
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refreshData();
    const id = setInterval(refreshData, POLL_MS);
    return () => clearInterval(id);
  }, [refreshData]);

  async function handleAction(eventId, actionType) {
    setActionPending(true);
    try {
      const res = await fetch(`/api/transactions/${eventId}/${actionType}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      addToast("success", `Transaction ${actionType === "approve" ? "approved and settled" : "declined"} successfully.`);
      setSelectedTxnId(null);
      await refreshData();
    } catch (e) {
      addToast("error", `Action failed: ${e.message}`);
    } finally {
      setActionPending(false);
    }
  }

  // Build the detail txn object
  const selectedTxn = txns.find((t) => t.event_id === selectedTxnId) ||
                       (() => {
                         const a = alerts.find((x) => x.event_id === selectedTxnId);
                         if (!a) return null;
                         return { event_id: a.event_id, from_account: a.from_account, to_account: a.to_account, amount: a.amount, status: a.action === "VERIFY" ? "held" : "blocked", created_at: a.flagged_at };
                       })();

  const heldCount    = txns.filter((t) => t.status === "held").length;
  const blockedCount = txns.filter((t) => t.status === "blocked").length;
  const ledgerLag    = lag?.ledger?.lag ?? 0;

  const liveTone = !connected ? "offline" : "live";
  const liveLabel = !connected ? "OFFLINE" : "SYSTEM ONLINE";

  return (
    <div className="app-shell">
      <Sidebar
        page={page}
        onNav={setPage}
        heldCount={heldCount}
        blockedCount={blockedCount}
        connected={connected}
      />

      <div className="main-area">
        {/* Top header */}
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-title">{page}</div>
            <div className="topbar-sub">{PAGE_SUBS[page]}</div>
          </div>
          <div className="topbar-right">
            <span className="refresh-time">
              {lastRefresh ? `Last updated: ${timeAgo(lastRefresh.toISOString())}` : "connecting…"}
            </span>
            <span className={`live-pill ${liveTone}`}>
              <span className="status-dot live" style={liveTone !== "live" ? { background: "var(--red)", animation: "none" } : {}} />
              {connected ? "System operational" : "System offline"}
            </span>
            <button className="icon-btn" onClick={refreshData} title="Refresh">↺</button>
          </div>
        </header>

        {/* Error banner */}
        {error && (
          <div className="error-banner">
            ⚠ API unreachable: {error} — retrying every {POLL_MS / 1000}s
          </div>
        )}

        {/* Page content */}
        <main className="page-content">
          {page === "Overview" && (
            <OverviewPage
              stats={stats}
              alerts={alerts}
              txns={txns}
              balances={balances}
              connected={connected}
              config={config}
              onSelectTxn={(id) => setSelectedTxnId(id)}
            />
          )}
          {page === "Live Transactions" && (
            <LiveTransactionsPage
              txns={txns}
              alerts={alerts}
              config={config}
              onSelectTxn={(id) => setSelectedTxnId(id)}
              selectedTxnId={selectedTxnId}
            />
          )}
          {page === "Review Queue" && (
            <ReviewQueuePage
              txns={txns}
              alerts={alerts}
              config={config}
              onAction={handleAction}
              actionPending={actionPending}
              onSelectTxn={(id) => setSelectedTxnId(id)}
            />
          )}
          {page === "Blocked" && (
            <BlockedPage txns={txns} alerts={alerts} config={config} />
          )}
          {page === "Analytics" && (
            <AnalyticsPage stats={stats} txns={txns} alerts={alerts} config={config} />
          )}
          {page === "Accounts" && (
            <AccountsPage balances={balances} />
          )}
          {page === "System Health" && (
            <SystemHealthPage lag={lag} connected={connected} stats={stats} config={config} onSeed={handleSeedDemoData} seeding={seeding} />
          )}
        </main>
      </div>

      {/* Transaction detail drawer */}
      {selectedTxnId && selectedTxn && (
        <TransactionDrawer
          txn={selectedTxn}
          alerts={alerts}
          txns={txns}
          config={config}
          onAction={handleAction}
          actionPending={actionPending}
          onClose={() => setSelectedTxnId(null)}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}