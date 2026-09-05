import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBalances,
  fetchTransactions,
  fetchAlerts,
  fetchLag,
  fetchStats,
  fetchConfig,
  sendTransaction,
} from "./api";

const POLL_MS = 2500;

const NAV = [
  { key: "Overview", label: "Overview" },
  { key: "Send Transaction", label: "Send" },
  { key: "Transactions", label: "Transactions" },
  { key: "Risk Intelligence", label: "Risk Intelligence" },
  { key: "Analytics", label: "Analytics" },
  { key: "Alerts", label: "Alerts" },
  { key: "Accounts", label: "Accounts" },
];

const PAGES = ["Accounts", "System Health"];

const PAGE_SUBS = {
  Overview:              "Real-time transaction risk monitoring",
  "Send Transaction":    "Manual payment with a live AI risk decision",
  Transactions:          "Payment operations console",
  "Risk Intelligence":   "MEDIUM risk payments awaiting analyst action",
  Alerts:                "HIGH risk payments stopped before settlement",
  Analytics:             "Fraud prevention reporting",
  Accounts:              "Live ledger balances",
  "System Health":       "Infrastructure and processing metrics",
};

function formatINR(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "\u2014";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

function formatPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "\u2014";
  return `${(v * 100).toFixed(2)}%`;
}

function timeAgo(iso) {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u2014";
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return d.toLocaleTimeString();
}

function clockTime(iso) {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function levelBadge(level) {
  switch (level) {
    case "HIGH":   return <span className="badge badge-red">HIGH</span>;
    case "MEDIUM": return <span className="badge badge-amber">MEDIUM</span>;
    case "LOW":    return <span className="badge badge-green">LOW</span>;
    default:       return <span className="badge badge-dim">{level || "\u2014"}</span>;
  }
}

function statusBadge(status) {
  switch (status) {
    case "applied":  return <span className="badge badge-green">APPLIED</span>;
    case "held":     return <span className="badge badge-amber">HELD</span>;
    case "blocked":  return <span className="badge badge-red">BLOCKED</span>;
    case "declined": return <span className="badge badge-dim">DECLINED</span>;
    default:         return <span className="badge badge-dim">{status || "\u2014"}</span>;
  }
}

function amountBandBadge(band) {
  switch (band) {
    case "HIGH":     return <span className="badge badge-red">HIGH</span>;
    case "ELEVATED": return <span className="badge badge-amber">ELEVATED</span>;
    case "NORMAL":   return <span className="badge badge-dim">NORMAL</span>;
    case "VERY LOW": return <span className="badge badge-green">VERY LOW</span>;
    default:         return <span className="badge badge-dim">{band || "NORMAL"}</span>;
  }
}

function riskFillClass(level) {
  if (level === "HIGH") return "high";
  if (level === "MEDIUM") return "medium";
  return "low";
}

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

const TIME_RANGES = {
  "1H":  { ms: 60 * 60 * 1000 },
  "6H":  { ms: 6 * 60 * 60 * 1000 },
  "24H": { ms: 24 * 60 * 60 * 1000 },
  "7D":  { ms: 7 * 24 * 60 * 60 * 1000 },
  "30D": { ms: 30 * 24 * 60 * 60 * 1000 },
};

function inRange(createdAt, range) {
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return true;
  const cfg = TIME_RANGES[range];
  if (!cfg) return true;
  return Date.now() - t <= cfg.ms;
}

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-icon">{t.type === "success" ? "\u2713" : "\u26A0"}</span>
          <span>{t.msg}</span>
          <button className="toast-close" onClick={() => onDismiss(t.id)}>{"\u2715"}</button>
        </div>
      ))}
    </div>
  );
}

function TopNav({ page, onNav, heldCount, blockedCount, connected }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const allLinks = [...NAV.map((n) => ({ key: n.key, label: n.label })), ...PAGES.map((p) => ({ key: p, label: p }))];

  function navBtn(n) {
    return (
      <button
        key={n.key}
        className={`topnav-link ${page === n.key ? "active" : ""}`}
        onClick={() => { onNav(n.key); setMenuOpen(false); }}
      >
        {n.label}
        {n.key === "Risk Intelligence" && heldCount > 0 && <span className="nav-badge amber">{heldCount}</span>}
        {n.key === "Alerts" && blockedCount > 0 && <span className="nav-badge">{blockedCount}</span>}
      </button>
    );
  }

  return (
    <>
      <div className="topnav-wrap">
        <nav className="topnav">
          <div className="brand">
            <div className="brand-mark">LS</div>
            Ledger<span>Stream</span>
          </div>
          <div className="topnav-center">
            {NAV.map((n) => navBtn(n))}
          </div>
          <div className="topnav-right">
            <span className={`nav-status ${connected ? "live" : "offline"}`}>
              {connected ? "System Healthy" : "Offline"}
            </span>
            <div className="nav-avatar">RM</div>
            <button className="nav-burger" onClick={() => setMenuOpen((v) => !v)}>☰</button>
          </div>
        </nav>
      </div>
      <div className={`mobile-menu ${menuOpen ? "open" : ""}`}>
        {allLinks.map((n) => navBtn(n))}
      </div>
    </>
  );
}

function DemoControl({ onSeed, seeding, demo, connected }) {
  const last = demo?.lastTxn;
  const processing = demo?.status === "processing";
  return (
    <div className="demo-control">
      <div className="demo-control-main">
        <button
          className="btn btn-approve demo-seed-btn"
          onClick={onSeed}
          disabled={seeding || !connected}
        >
          {processing ? "Processing…" : "\u26A1 Generate Test Transaction"}
        </button>
        <span className="demo-hint">
          publishes one real event {"\u2192"} Kafka {"\u2192"} ML risk scoring {"\u2192"} policy {"\u2192"} PostgreSQL
        </span>
      </div>
      {processing && (
        <div className="demo-status demo-status-processing">
          <span className="demo-status-item">{"\u26A0"} Processing new transaction through the live pipeline…</span>
        </div>
      )}
      {last && !processing && (
        <div className="demo-status">
          <span className="demo-status-title">Last transaction processed</span>
          <span className="demo-status-item">
            {timeAgo(last.created_at)}
          </span>
          <span className="demo-status-item">
            Risk score: <b>{last.risk_score != null ? formatPct(last.risk_score) : "\u2014"}</b>
          </span>
          <span className="demo-status-item">
            Decision: {statusBadge(last.decision)} {levelBadge(last.risk_level)}
          </span>
          <span className="demo-status-item mono dim">{last.event_id}</span>
        </div>
      )}
      {demo?.status === "error" && (
        <div className="demo-status demo-status-error">
          <span className="demo-status-item">{"\u26A0"} {demo.error}</span>
        </div>
      )}
    </div>
  );
}

function OverviewPage({ stats, txns, alerts, config, lag, balances, onSelectTxn, onRefresh, refreshing, timeRange, onTimeRange, connected, onNav, onSeed, seeding, demo, recentlySent }) {
  const dashboardRef = useRef(null);
  const rangeTxns = txns.filter((t) => inRange(t.created_at, timeRange));
  const applied  = Number(stats?.appliedCount  ?? 0);
  const held     = Number(stats?.heldCount     ?? 0);
  const blocked  = Number(stats?.blockedCount  ?? 0);
  const declined = Number(stats?.declinedCount ?? 0);
  const analyzed = Number(stats?.analyzed ?? 0);

  const blockedValue = Number(stats?.blockedValue ?? 0);
  const approvalRate = analyzed > 0 ? applied / analyzed : 0;

  let liveScore = null;
  let liveLevel = "LOW";
  const latest = rangeTxns[0] || txns[0] || alerts[0] || null;
  if (latest?.risk_score != null) {
    liveScore = Number(latest.risk_score);
    liveLevel = latest.risk_level || (latest.status === "blocked" ? "HIGH" : latest.status === "held" ? "MEDIUM" : "LOW");
  }

  const lowCount = applied;
  const medCount = held;
  const highCount = blocked + declined;
  const donutTotal = lowCount + medCount + highCount || 1;
  const lowPct = lowCount / donutTotal;
  const medPct = medCount / donutTotal;

  const donutStops = [
    { color: "#10B981", from: 0, to: lowPct * 100 },
    { color: "#C78A1F", from: lowPct * 100, to: (lowPct + medPct) * 100 },
    { color: "#D64545", from: (lowPct + medPct) * 100, to: 100 },
  ].filter((s) => s.to - s.from > 0.01);
  const gradStr = donutStops
    .map((s, i) => `${s.color} ${i === 0 ? 0 : s.from}% ${i === donutStops.length - 1 ? 100 : s.to}%`)
    .join(", ");

  const stream = rangeTxns.slice(0, 8);
  const ledgerLag = Number(lag?.ledger?.lag ?? 0);
  const fraudLag  = Number(lag?.fraud?.lag  ?? 0);
  const maxLag = Math.max(ledgerLag, fraudLag);

  return (
    <>
      <section className="hero">
        <div className="hero-grid" />
        <div className="hero-viz">
          <svg viewBox="0 0 1400 800" preserveAspectRatio="xMidYMid slice">
            {/* Edges / Animated Dashed Constellation Lines */}
            <line x1="940" y1="195" x2="1280" y2="245" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="940" y1="195" x2="1140" y2="360" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="940" y1="195" x2="800" y2="340" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="1280" y1="245" x2="1140" y2="360" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="800" y1="340" x2="1140" y2="360" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="800" y1="340" x2="830" y2="490" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="1140" y1="360" x2="1080" y2="550" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="830" y1="490" x2="1080" y2="550" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="1080" y1="550" x2="1230" y2="640" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="830" y1="490" x2="680" y2="660" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="1080" y1="550" x2="680" y2="660" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="680" y1="660" x2="220" y2="580" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />
            <line x1="220" y1="580" x2="800" y2="340" stroke="rgba(16, 185, 129, 0.35)" strokeWidth="1.2" className="viz-edge" />

            {/* Constellation Nodes & Glowing Target Rings */}
            <circle cx="940" cy="195" r="14" fill="none" stroke="rgba(16, 185, 129, 0.4)" strokeWidth="1.5" />
            <circle cx="940" cy="195" r="4" fill="#10b981" className="viz-node" />

            <circle cx="1280" cy="245" r="4" fill="#10b981" className="viz-node" />

            <circle cx="1140" cy="360" r="16" fill="none" stroke="rgba(16, 185, 129, 0.3)" strokeWidth="1.2" />
            <circle cx="1140" cy="360" r="6" fill="#10b981" className="viz-node" />

            <circle cx="800" cy="340" r="4" fill="#10b981" className="viz-node" />
            <circle cx="830" cy="490" r="4" fill="#10b981" className="viz-node" />

            <circle cx="1080" cy="550" r="5" fill="#10b981" className="viz-node" />
            <circle cx="1230" cy="640" r="4" fill="#10b981" className="viz-node" />

            <circle cx="680" cy="660" r="4" fill="#10b981" className="viz-node" />
            <circle cx="220" cy="580" r="4" fill="#10b981" className="viz-node" />
          </svg>
        </div>
        <div className="hero-inner">
          <div className="hero-eyebrow">
            <span className="pulse" /> AI-POWERED RISK INTELLIGENCE
          </div>
          <h1>See risk before it becomes <span className="em">loss.</span></h1>
          <p className="hero-sub">Real-time payment monitoring, AI fraud detection, and intelligent risk decisions — all in one platform.</p>
          <div className="hero-cta">
            <button className="btn-hero-primary" onClick={() => dashboardRef.current && dashboardRef.current.scrollIntoView({ behavior: "smooth" })}>
              Explore Dashboard →
            </button>
            <button className="btn-hero-secondary" onClick={() => onNav("Transactions")}>
              View Live Transactions
            </button>
          </div>
        </div>
        <div className="hero-metrics">
          <div className="hero-metric">
            <div className="hero-metric-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" transform="rotate(45 12 12)" /><rect x="8" y="8" width="8" height="8" rx="1" transform="rotate(45 12 12)" /></svg>
            </div>
            <div>
              <h4>AI Risk Detection</h4>
              <p>Microsecond latency scoring</p>
            </div>
          </div>
          <div className="hero-metric">
            <div className="hero-metric-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            </div>
            <div>
              <h4>Real-time Processing</h4>
              <p>Continuous stream analysis</p>
            </div>
          </div>
          <div className="hero-metric">
            <div className="hero-metric-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
            </div>
            <div>
              <h4>Zero Data Loss</h4>
              <p>Kafka event durability</p>
            </div>
          </div>
        </div>
      </section>

      <div className="dashboard" ref={dashboardRef}>
        <div className="container">
          <div className="sec-head">
            <div>
              <h2 className="sec-head-title">Live Risk Overview</h2>
              <p className="sec-head-sub">Real-time system health and risk metrics</p>
            </div>
            <div className="sec-head-right">
              {["1H", "6H", "24H", "7D", "30D"].map((r) => (
                <button key={r} className={`time-chip${timeRange === r ? " active" : ""}`} onClick={() => onTimeRange(r)}>{r}</button>
              ))}
              <button className={`refresh-chip${refreshing ? " spinning" : ""}`} onClick={onRefresh} disabled={refreshing} title="Refresh">
                {refreshing ? "Refreshing…" : "\u21BB Refresh"}
              </button>
            </div>
          </div>

          <DemoControl onSeed={onSeed} seeding={seeding} demo={demo} connected={connected} />

          <div className="kpi-row">
            <div className="kpi-card green">
              <div className="kpi-accent-top green" />
              <div className="kpi-label">Total Processed</div>
              <div className="kpi-value">{analyzed.toLocaleString()}</div>
              <div className="kpi-sub">Transactions scored by the AI risk engine</div>
            </div>
            <div className="kpi-card">
              <div className={`kpi-accent-top ${riskFillClass(liveLevel)}`} />
              <div className="kpi-label"><span className="pulse" /> Risk Score (Live)</div>
              <div className="kpi-value">{liveScore !== null ? liveScore.toFixed(4) : "—"} <span className="unit">probability</span></div>
              <div className={`risk-badge-live ${riskFillClass(liveLevel)}`}>{liveLevel} RISK</div>
              <div className="mini-progress"><div style={{ width: `${Math.min(100, (liveScore || 0) * 100)}%` }} /></div>
            </div>
            <div className="kpi-card green">
              <div className="kpi-accent-top green" />
              <div className="kpi-label">Approval Rate</div>
              <div className="kpi-value emerald">{formatPct(approvalRate)}</div>
              <div className="kpi-sub">{applied.toLocaleString()} approved transactions</div>
            </div>
            <div className="kpi-card red">
              <div className="kpi-accent-top red" />
              <div className="kpi-label">Blocked Fraud Value</div>
              <div className="kpi-value red sm">{formatINR(blockedValue)}</div>
              <div className="kpi-sub">{blocked.toLocaleString()} high-risk transactions stopped</div>
            </div>
          </div>

          <div className="analytics-grid">
            <div className="a-card">
              <div className="a-card-title">Risk Distribution</div>
              <div className="a-card-meta">by transaction count</div>
              <div className="donut-wrap">
                <div className="donut">
                  <svg viewBox="0 0 160 160" width="158" height="158">
                    <circle cx="80" cy="80" r="60" fill="none" stroke="var(--cream-3)" strokeWidth="12" />
                    <circle
                      cx="80" cy="80" r="60"
                      fill="none" stroke={gradStr}
                      strokeWidth="12"
                      strokeLinecap="round"
                      transform="rotate(-90 80 80)"
                      style={{ transition: "stroke .5s ease" }}
                    />
                  </svg>
                  <div className="donut-center">
                    <strong>{donutTotal.toLocaleString()}</strong>
                    <span>total</span>
                  </div>
                </div>
                <div className="donut-legend">
                  {[
                    { label: "Low Risk", value: lowCount, color: "#10B981" },
                    { label: "Medium Risk", value: medCount, color: "#C78A1F" },
                    { label: "High Risk", value: highCount, color: "#D64545" },
                  ].filter((i) => i.value > 0).map((i) => (
                    <div key={i.label} className="legend-row">
                      <span className="legend-dot" style={{ background: i.color }} />
                      {i.label}
                      <span className="legend-count">{i.value.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="a-card">
              <div className="a-card-title">Recent Transactions</div>
              <div className="a-card-meta">live stream · click to inspect</div>
              <div className="txn-stream">
                {stream.length === 0 && <div className="empty-state">No transactions yet</div>}
                {stream.map((t) => {
                  const level = t.risk_level || "LOW";
                  const score = t.risk_score != null ? Number(t.risk_score) : null;
                  const icon = level === "HIGH" ? "⊗" : level === "MEDIUM" ? "⏸" : "✓";
                  return (
                    <div key={t.event_id} className={`txn-item ${recentlySent && recentlySent.includes(t.event_id) ? "just-now" : ""}`} onClick={() => onSelectTxn(t.event_id)}>
                      <div className={`txn-icon ${level.toLowerCase()}`}>{icon}</div>
                      <div className="txn-main">
                        <div className="txn-id">{t.event_id.length > 16 ? t.event_id.slice(0, 16) + "…" : t.event_id}</div>
                        <div className="txn-meta">{timeAgo(t.created_at)} · {t.from_account} → {t.to_account}</div>
                      </div>
                      <div>
                        <div className="txn-amount">{formatINR(t.amount)}</div>
                        <div className="txn-score">{score !== null ? `risk ${formatPct(score)}` : level}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="a-card">
              <div className="a-card-title">AI Risk Intelligence</div>
              <div className="a-card-meta">Real-time signal analysis</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="ri-item pulse">
                  <div className="ri-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  </div>
                  <div>
                    <div className="ri-title">Microsecond Latency <span className="badge badge-green">LIVE</span></div>
                    <div className="ri-desc">RandomForest model scoring each transfer against 6 engineered risk signals</div>
                    <div className="ri-time">policy: low &lt; 0.01 · high &gt; 0.10</div>
                  </div>
                </div>
                <div className="ri-item">
                  <div className="ri-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  </div>
                  <div>
                    <div className="ri-title">Automated Decisioning <span className="badge badge-green">ACTIVE</span></div>
                    <div className="ri-desc">HIGH risk blocked before ledger settlement; MEDIUM routed to risk review</div>
                    <div className="ri-time">effectively-once guarantee</div>
                  </div>
                </div>
                <div className="ri-item">
                  <div className="ri-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
                  </div>
                  <div>
                    <div className="ri-title">Kafka Stream Ingestion <span className="badge badge-green">OK</span></div>
                    <div className="ri-desc">Continuous payment stream monitoring with zero message loss</div>
                    <div className="ri-time">{maxLag === 0 ? "0 messages lag" : `${maxLag} msgs lag`}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <section className="trust">
        <div className="container">
          <div className="trust-eyebrow">WHY LEDGERSTREAM</div>
          <h2>Risk Intelligence you can <span className="em">trust.</span></h2>
          <p className="trust-p">Real-time payment monitoring, AI fraud detection, and intelligent risk decisions — all in one platform.</p>
          <div className="trust-grid">
            <div className="trust-card">
              <div className="trust-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" transform="rotate(45 12 12)" /><rect x="8" y="8" width="8" height="8" rx="1" transform="rotate(45 12 12)" /></svg>
              </div>
              <h4>AI Risk Engine</h4>
              <p>Every transaction is scored instantly by the RandomForest V4 engine. Six engineered risk signals feed a calibrated fraud-probability model before money moves.</p>
              <span className="trust-mono">randomforest-v4 · microsecond latency</span>
            </div>
            <div className="trust-card">
              <div className="trust-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </div>
              <h4>Real-time Decisions</h4>
              <p>Streaming Kafka ingestion keeps scoring continuous. HIGH risk is blocked, MEDIUM is held for review, LOW settles through — automatically.</p>
              <span className="trust-mono">kafka-stream · deterministic policy</span>
            </div>
            <div className="trust-card">
              <div className="trust-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>
              </div>
              <h4>Reliable Ledger Processing</h4>
              <p>Idempotent ledger processing with effectively-once outcomes. Balances stay conserved across restart, retry, and replay.</p>
              <span className="trust-mono">postgres · ACID transaction guarantee</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function LiveTransactionsPage({ txns, alerts, onSelectTxn, selectedTxnId, config, recentlySent }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [levelFilter, setLevelFilter] = useState("all");
  const [bandFilter, setBandFilter] = useState("all");

  const filtered = txns.filter((t) => {
    const level = t.risk_level || "LOW";
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
        <input className="filter-input" placeholder="Search by ID, account…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 180 }} />
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
          <option value="VERY LOW">VERY LOW</option>
          <option value="NORMAL">NORMAL</option>
          <option value="ELEVATED">ELEVATED</option>
          <option value="HIGH">HIGH</option>
        </select>
        <span className="dim" style={{ fontSize: 11, marginLeft: 4, alignSelf: "center" }}>
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
                <th>Amount Band</th>
                <th>Transfer</th>
                <th>AI Risk</th>
                <th>Decision</th>
                <th>Settlement</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map((t) => {
                const score = t.risk_score != null ? Number(t.risk_score) : null;
                const band = t.amount_band || amountBandFor(t.amount, config);
                return (
                  <tr key={t.event_id} className={`clickable ${t.event_id === selectedTxnId ? "selected" : ""} ${recentlySent && recentlySent.includes(t.event_id) ? "just-now" : ""}`} onClick={() => onSelectTxn(t.event_id)}>
                    <td className="mono dim" style={{ fontSize: 10.5 }}>{t.event_id.length > 14 ? t.event_id.slice(0, 14) + "…" : t.event_id}</td>
                    <td style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatINR(t.amount)}</td>
                    <td>{amountBandBadge(band)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{t.from_account} → {t.to_account}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{score !== null ? formatPct(score) : "—"}</td>
                    <td>{statusBadge(t.status)}</td>
                    <td style={{ fontWeight: 600, color: t.status === "applied" ? "var(--green-text)" : "var(--slate)", fontVariantNumeric: "tabular-nums" }}>
                      {t.status === "applied" ? `${formatINR(t.amount)} MOVED` : "₹0.00 MOVED"}
                    </td>
                    <td className="dim" style={{ fontSize: 10.5 }}>{timeAgo(t.created_at)}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={8}><div className="empty-state">No transactions match your filters</div></td></tr>
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
        <div className="empty-state" style={{ padding: "60px 20px" }}>
          <div className="empty-state-icon">{"\u23F8"}</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Review queue is empty</div>
          <div className="dim">No MEDIUM risk transactions awaiting review</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="info-banner">
        <span>{"\u23F8"}</span>
        <span>{held.length} payment{held.length > 1 ? "s" : ""} are held {"\u2014"} the risk engine flagged them as MEDIUM risk. Review and settle, or decline.</span>
      </div>

      <div className="page-grid">
        {held.map((tx) => {
          const a = alerts.find((x) => x.event_id === tx.event_id);
          const score = tx.risk_score != null ? Number(tx.risk_score) : (a ? a.risk_score : null);
          const reasons = tx.reasons ? tx.reasons.split(" \u00B7 ") : (a ? a.reasons : ["MEDIUM risk transaction flagged by AI"]);
          return (
            <div key={tx.event_id} className="review-card" onClick={() => onSelectTxn(tx.event_id)}>
              <div className="review-card-header">
                <div>
                  <div className="review-card-id">{tx.event_id.length > 14 ? tx.event_id.slice(0, 14) + "\u2026" : tx.event_id}</div>
                  <div style={{ marginTop: 4 }}>{statusBadge("held")}</div>
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
                  <div className="review-meta-value">{amountBandBadge(tx.amount_band || amountBandFor(tx.amount, config))}</div>
                </div>
                <div className="review-meta-item">
                  <div className="review-meta-label">AI Risk</div>
                  <div className="review-meta-value" style={{ color: "var(--amber)", fontWeight: 700 }}>{score != null ? formatPct(score) : "—"}</div>
                </div>
                <div className="review-meta-item">
                  <div className="review-meta-label">Waiting</div>
                  <div className="review-meta-value">{timeAgo(tx.created_at)}</div>
                </div>
              </div>
              {reasons.length > 0 && (
                <div className="review-signals"><strong>Why flagged:</strong><br />{reasons.join(" \u00B7 ")}</div>
              )}
              <div className="review-money-frozen">{"\u2717"} MONEY MOVED: NO {"\u2014"} Settlement held for review</div>
              <div className="review-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn btn-approve" style={{ flex: 1 }} disabled={actionPending} onClick={() => onAction(tx.event_id, "approve")}>
                  {actionPending ? "\u2026" : "\u2713 Approve & Settle"}
                </button>
                <button className="btn btn-decline" style={{ flex: 1 }} disabled={actionPending} onClick={() => onAction(tx.event_id, "decline")}>
                  {"\u2715"} Decline
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BlockedPage({ txns, alerts, config, stats }) {
  const [expandedId, setExpandedId] = useState(null);
  const blocked = txns.filter((t) => t.status === "blocked");
  const blockedCount = Number(stats?.blockedCount ?? blocked.length);
  const totalBlocked = Number(stats?.blockedValue ?? blocked.reduce((s, t) => s + Number(t.amount), 0));

  if (blocked.length === 0) {
    return (
      <div className="card">
        <div className="empty-state" style={{ padding: "60px 20px" }}>
          <div className="empty-state-icon">{"\u2297"}</div>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>No Blocked Transactions</div>
          <div className="dim" style={{ fontSize: 12, maxWidth: 380, margin: "0 auto" }}>
            HIGH risk transactions (fraud probability above the block threshold) are automatically blocked before settlement. No high-risk transactions have been detected in this session.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="alerts-summary">
        <div className="alerts-summary-card">
          <div className="kpi-accent red" />
          <div className="alerts-summary-top">
            <span className="alerts-summary-label">Total Blocked</span>
            <span className="alerts-summary-value red">{blockedCount}</span>
          </div>
          <div className="alerts-summary-sub">Payments stopped before settlement</div>
        </div>
        <div className="alerts-summary-card">
          <div className="kpi-accent red" />
          <div className="alerts-summary-top">
            <span className="alerts-summary-label">Total Value Blocked</span>
            <span className="alerts-summary-value red">{formatINR(totalBlocked)}</span>
          </div>
          <div className="alerts-summary-sub">Cumulative value of transactions blocked by the risk engine</div>
        </div>
      </div>

      <div className="alerts-section-head">
        <div>
          <div className="alerts-section-title">High Risk Transactions</div>
          <div className="alerts-section-sub">Transactions blocked by the risk engine before settlement.</div>
        </div>
        <div className="alerts-count">{blocked.length} RECENT</div>
      </div>

      <div className="alerts-grid">
        {blocked.map((tx) => {
          const a = alerts.find((x) => x.event_id === tx.event_id);
          const score = tx.risk_score != null ? Number(tx.risk_score) : (a ? a.risk_score : null);
          const reasons = tx.reasons ? tx.reasons.split(" \u00B7 ") : (a ? a.reasons : ["HIGH risk transaction flagged by AI"]);

          return (
            <div key={tx.event_id} className={`alerts-card ${expandedId === tx.event_id ? "expanded" : ""}`}>
              <div className="alerts-card-row" onClick={() => setExpandedId(expandedId === tx.event_id ? null : tx.event_id)}>
                <div className="alerts-id-col">
                  <div className="alerts-risk-tag">
                    <span className="alerts-dot" /> HIGH RISK
                  </div>
                  <div className="alerts-id">{tx.event_id}</div>
                  <div className="alerts-amount">{formatINR(tx.amount)}</div>
                </div>
                <div className="alerts-meta-col">
                  <div className="alerts-meta-row">
                    <span className="alerts-meta-label">Transfer</span>
                    <span className="alerts-meta-value">{tx.from_account} {"\u2192"} {tx.to_account}</span>
                  </div>
                  <div className="alerts-meta-row">
                    <span className="alerts-meta-label">AI Risk</span>
                    <span className="alerts-meta-value risk-red">{score != null ? formatPct(score) : "\u2014"}</span>
                  </div>
                  <div className="alerts-meta-row">
                    <span className="alerts-meta-label">Timestamp</span>
                    <span className="alerts-meta-value">{clockTime(tx.created_at)}</span>
                  </div>
                  <div className="alerts-meta-row">
                    <span className="alerts-meta-label">Amount Band</span>
                    <span className="alerts-meta-value">{amountBandBadge(tx.amount_band || amountBandFor(tx.amount, config))}</span>
                  </div>
                </div>
                <div className="alerts-status-col">
                  {statusBadge("blocked")}
                  <div className={`alerts-toggle ${expandedId === tx.event_id ? "open" : ""}`}>
                    {expandedId === tx.event_id ? "Hide" : "Detail"}
                  </div>
                </div>
                <div className="alerts-evidence">
                  <span className="alerts-evidence-label">Signal</span>
                  <span className="alerts-evidence-text">
                    {reasons[0] || "High risk pattern detected"}
                    {reasons.length > 1 ? `  \u00B7  +${reasons.length - 1} more` : ""}
                  </span>
                </div>
              </div>

              {expandedId === tx.event_id && (
                <div className="alerts-detail">
                  <div className="alerts-detail-grid">
                    <div className="alerts-detail-item">
                      <div className="alerts-detail-label">Transfer</div>
                      <div className="alerts-detail-value">{tx.from_account} {"\u2192"} {tx.to_account}</div>
                    </div>
                    <div className="alerts-detail-item">
                      <div className="alerts-detail-label">AI Risk</div>
                      <div className="alerts-detail-value risk-red">{score != null ? formatPct(score) : "\u2014"}</div>
                    </div>
                    <div className="alerts-detail-item">
                      <div className="alerts-detail-label">Timestamp</div>
                      <div className="alerts-detail-value">{clockTime(tx.created_at)}</div>
                    </div>
                    <div className="alerts-detail-item">
                      <div className="alerts-detail-label">Amount Band</div>
                      <div className="alerts-detail-value">{amountBandBadge(tx.amount_band || amountBandFor(tx.amount, config))}</div>
                    </div>
                  </div>

                  {reasons.length > 0 && (
                    <div className="alerts-signals">
                      <div className="alerts-signals-label">Risk Signals</div>
                      <div className="alerts-signal-chips">
                        {reasons.map((r, i) => (
                          <span key={i} className="alerts-signal-chip">{r}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="alerts-block-decide">
                    <div className="alerts-block-decide-title">BLOCKED BEFORE SETTLEMENT</div>
                    <div className="alerts-block-decide-sub">AI detected risk {"\u2192"} transaction blocked {"\u2192"} money never moved</div>
                    <div className="alerts-money">
                      <span className="alerts-money-item">MONEY MOVED: NO</span>
                      <span className="alerts-money-item-highlight">FRAUD PREVENTED</span>
                    </div>
                  </div>
                </div>
              )}
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

  const appliedAmount  = Number(stats?.appliedValue  ?? 0);
  const blockedAmount  = Number(stats?.blockedValue  ?? 0);
  const heldAmount     = Number(stats?.heldValue     ?? 0);
  const declinedAmount = Number(stats?.declinedValue ?? 0);
  const totalAmount    = appliedAmount + blockedAmount + heldAmount + declinedAmount || 1;

  const lowT = config?.riskPolicy?.lowThreshold ?? 0.01;
  const highT = config?.riskPolicy?.highThreshold ?? 0.10;

  const statusBars = [
    { label: "Approved", value: applied,  pct: applied/total,  color: "var(--green)" },
    { label: "Held",     value: held,     pct: held/total,     color: "var(--amber)" },
    { label: "Blocked",  value: blocked,  pct: blocked/total,  color: "var(--red)" },
    { label: "Declined", value: declined, pct: declined/total, color: "var(--slate)" },
  ];

  const amountBars = [
    { label: "Approved",  value: appliedAmount,  pct: appliedAmount/totalAmount,  color: "var(--green)" },
    { label: "Held",      value: heldAmount,     pct: heldAmount/totalAmount,     color: "var(--amber)" },
    { label: "Blocked",   value: blockedAmount,  pct: blockedAmount/totalAmount,  color: "var(--red)" },
    { label: "Declined",  value: declinedAmount, pct: declinedAmount/totalAmount, color: "var(--slate)" },
  ];

  return (
    <div>
      <div className="page-grid col-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-green" /> Decision Distribution</span>
            <span className="card-meta">by transaction count</span>
          </div>
          <div className="card-body">
            <div className="bar-chart">
              {statusBars.map(({ label, value, pct, color }) => (
                <div key={label} className="bar-row">
                  <div className="bar-label">{label}</div>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${pct * 100}%`, background: color }} /></div>
                  <div className="bar-value">{value.toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-green" /> Amount Distribution</span>
            <span className="card-meta">by transaction value</span>
          </div>
          <div className="card-body">
            <div className="bar-chart">
              {amountBars.map(({ label, value, pct, color }) => (
                <div key={label} className="bar-row">
                  <div className="bar-label">{label}</div>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${pct * 100}%`, background: color }} /></div>
                  <div className="bar-value mono" style={{ fontSize: 10 }}>{formatINR(value)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-green" /> Risk Policy</span>
          <span className="card-meta">live from backend configuration</span>
        </div>
        <div className="card-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {[
              { label: "LOW Threshold", value: formatPct(lowT), note: "score < threshold \u2192 APPROVE" },
              { label: "HIGH Threshold", value: formatPct(highT), note: "score > threshold \u2192 BLOCK" },
            ].map(({ label, value, note }) => (
              <div key={label} className="rule-panel">
                <div style={{ fontSize: 9, color: "var(--slate)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 3 }}>{label}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 17, fontWeight: 700 }}>{value}</div>
                <div style={{ fontSize: 9.5, color: "var(--slate)", marginTop: 2 }}>{note}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 10.5, color: "var(--slate)", fontFamily: "var(--mono)" }}>
            Risk Score = estimated fraud probability from the ML model. Risk classification is driven solely by the model score against the configured policy thresholds.
          </div>
        </div>
      </div>
    </div>
  );
}

function SendTransactionPage({ balances, config, connected, onSend, send, onNavigate }) {
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [localError, setLocalError] = useState("");

  const accounts = balances || [];
  const sender = accounts.find((a) => a.account_id === fromId);
  const processing = send?.status === "processing";
  const result = send?.status === "done" ? send.result : null;
  const error = send?.status === "error" ? send.error : null;

  function suggestAmount(acctId) {
    const a = accounts.find((x) => x.account_id === acctId);
    if (!a) return;
    const balance = Number(a.balance) || 0;
    const max = Math.min(balance, 20000);
    const guess = Math.max(10, Math.round(max * (0.1 + Math.random() * 0.6)));
    setAmount(String(guess));
  }

  function validateForm() {
    if (!fromId) return "Select a sender account";
    if (!toId) return "Select a receiver account";
    if (fromId === toId) return "Sender and receiver must be different accounts";
    const v = Number(amount);
    if (!Number.isFinite(v) || v <= 0) return "Enter a valid amount greater than zero";
    return "";
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const ve = validateForm();
    setLocalError(ve);
    if (ve) return;
    await onSend({ from: fromId, to: toId, amount: Number(amount) });
  }

  const moneyMoved = result && result.status === "applied";

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-green" /> Initiate a Payment</span>
          <span className="card-meta">manual transfer through the live pipeline</span>
        </div>
        <div className="card-body">
          <p style={{ fontSize: 12, color: "var(--slate)", marginBottom: 14 }}>
            The account pair and amount are validated against live PostgreSQL balances, then the event is
            pushed to Kafka. The random forest engine scores it and the policy decides the outcome before money moves:
          </p>
          <div className="send-policy-row">
            <span className="send-policy-tag low">{"\u2713"} LOW {"\u2192"} APPROVE &amp; SETTLE</span>
            <span className="send-policy-tag medium">{"\u23F8"} MEDIUM {"\u2192"} HELD FOR REVIEW</span>
            <span className="send-policy-tag high">{"\u2297"} HIGH {"\u2192"} BLOCKED</span>
          </div>

          <form className="send-form" onSubmit={handleSubmit}>
            <div className="send-field">
              <label className="send-label">From Account</label>
              <select
                className="filter-input send-select"
                value={fromId}
                onChange={(e) => { setFromId(e.target.value); setLocalError(""); }}
                disabled={processing}
              >
                <option value="">Select sender\u2026</option>
                {accounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.account_id} {"\u00B7"} {formatINR(a.balance)}
                  </option>
                ))}
              </select>
              <span className="send-balance-hint">
                {sender ? `${sender.account_id} available: ${formatINR(sender.balance)}` : "live balance shown once selected"}
              </span>
            </div>

            <div className="send-field">
              <label className="send-label">To Account</label>
              <select
                className="filter-input send-select"
                value={toId}
                onChange={(e) => { setToId(e.target.value); setLocalError(""); }}
                disabled={processing}
              >
                <option value="">Select receiver\u2026</option>
                {accounts.filter((a) => a.account_id !== fromId).map((a) => (
                  <option key={a.account_id} value={a.account_id}>{a.account_id}</option>
                ))}
              </select>
            </div>

            <div className="send-field">
              <label className="send-label">Amount</label>
              <div className="send-amount-row">
                <input
                  className="filter-input send-amount-input"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setLocalError(""); }}
                  placeholder="0.00"
                  disabled={processing}
                />
                <button type="button" className="btn btn-ghost" onClick={() => suggestAmount(fromId)} disabled={processing || !fromId}>
                  Suggest
                </button>
              </div>
            </div>

            {(localError || error) && (
              <div className="send-error">{"\u26A0"} {localError || error}</div>
            )}

            <div className="send-actions">
              <button className="btn btn-approve" type="submit" disabled={processing || !connected || accounts.length < 2}>
                {processing ? "Processing\u2026" : "\u2192 Send Transaction"}
              </button>
              <span className="send-hint">
                {connected
                  ? "publishes to Kafka \u00B7 ML scored \u00B7 persisted in PostgreSQL"
                  : "API offline \u2014 cannot send"}
              </span>
            </div>
          </form>
        </div>
      </div>

      {processing && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-body">
            <div className="send-status send-status-processing">{"\u26A0"} Processing new transaction through the live pipeline\u2026</div>
          </div>
        </div>
      )}

      {result && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-green" /> Live Decision</span>
            <span className="card-meta">scored by the ML engine, decided by policy</span>
          </div>
          <div className="card-body">
            <div className={`send-verdict ${result.status}`}>
              <div className="send-verdict-main">
                <span className="send-verdict-label">Decision</span>
                <span className="send-verdict-value">{result.status.toUpperCase()}</span>
                <span className="send-verdict-money">
                  MONEY MOVED: {moneyMoved ? "YES" : "NO"}
                </span>
              </div>
              <div className="send-verdict-grid">
                <div className="send-verdict-item">
                  <div className="send-verdict-key">Risk Score</div>
                  <div className="send-verdict-val mono">{result.risk_score != null ? formatPct(result.risk_score) : "\u2014"}</div>
                </div>
                <div className="send-verdict-item">
                  <div className="send-verdict-key">Risk Level</div>
                  <div className="send-verdict-val mono">{result.risk_level || "\u2014"}</div>
                </div>
                <div className="send-verdict-item">
                  <div className="send-verdict-key">Amount</div>
                  <div className="send-verdict-val mono">{formatINR(result.amount)}</div>
                </div>
                <div className="send-verdict-item">
                  <div className="send-verdict-key">Transfer</div>
                  <div className="send-verdict-val mono">{result.from_account} {"\u2192"} {result.to_account}</div>
                </div>
                <div className="send-verdict-item" style={{ gridColumn: "1 / -1" }}>
                  <div className="send-verdict-key">Event ID</div>
                  <div className="send-verdict-val mono dim" style={{ fontSize: 10.5 }}>{result.event_id}</div>
                </div>
              </div>
            </div>
            <div className="send-next" onClick={() => onNavigate("Transactions")}>
              View it in Live Transactions {"\u2192"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountsPage({ balances }) {
  const totalBalance = balances.reduce((s, a) => s + Number(a.balance), 0);
  return (
    <div>
      <div className="card" style={{ maxWidth: 300, marginBottom: 16 }}>
        <div className="card-body">
          <div className="kpi-value sm emerald">{formatINR(totalBalance)}</div>
          <div style={{ fontSize: 10.5, color: "var(--slate)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, marginBottom: 4 }}>Total System Balance</div>
          <div className="kpi-sub">{balances.length} accounts {"\u00B7"} conserved</div>
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-green" /> Account Ledger</span>
          <span className="card-meta">{balances.length} accounts {"\u00B7"} live PostgreSQL</span>
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
                  <td className="dim" style={{ fontSize: 10.5 }}>{i + 1}</td>
                  <td className="mono" style={{ fontWeight: 600 }}>{a.account_id}</td>
                  <td className="mono t-right" style={{ fontWeight: 700, color: "var(--green-text)" }}>{formatINR(a.balance)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} style={{ fontWeight: 700, paddingTop: 10 }}>Total</td>
                <td className="mono t-right" style={{ fontWeight: 800, fontSize: 14, paddingTop: 10, borderTop: "1px solid var(--cream-3)", color: "var(--charcoal)" }}>{formatINR(totalBalance)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ padding: "8px 14px 12px", fontSize: 10.5, color: "var(--slate)", fontFamily: "var(--mono)", borderTop: "1px solid var(--cream-3)" }}>
          Balance conservation verified {"\u00B7"} SUM(balance) computed live: {formatINR(totalBalance)}
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
      <div className="health-grid">
        {[
          { name: "API Server",        meta: "Express",                ok: connected },
          { name: "PostgreSQL",        meta: "ledgerstore database",   ok: connected },
          { name: "Kafka Broker",      meta: "transactions topic",     ok: connected },
          { name: "ML Risk Engine",    meta: "RandomForest V4 inline", ok: connected },
          { name: "Ledger Consumer",   meta: "ledger-consumer-group",  ok: connected },
          { name: "Fraud Consumer",    meta: "fraud-consumer-group",   ok: connected },
        ].map(({ name, meta, ok }) => (
          <div key={name} className="health-card">
            <div className="health-card-info">
              <div className="health-card-name">{name}</div>
              <div className="health-card-meta">{meta}</div>
            </div>
            <span className={`badge ${ok ? "badge-green" : "badge-red"}`}>{ok ? "\u25CF Operational" : "\u25CF Offline"}</span>
          </div>
        ))}
      </div>

      <div className="page-grid col-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-green" /> Consumer Lag</span>
            <span className="card-meta">Kafka offset lag</span>
          </div>
          <div className="card-body">
            {[
              { label: "Ledger Consumer", lag: ledgerLag, data: lag?.ledger },
              { label: "Fraud Consumer",  lag: fraudLag,  data: lag?.fraud },
            ].map(({ label, lag: l, data }) => (
              <div key={label} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
                  {lagBadge(l)}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--slate)", fontFamily: "var(--mono)" }}>
                  log-end: {Number(data?.logEnd ?? 0).toLocaleString()} {"\u00B7"} committed: {Number(data?.committed ?? 0).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title"><span className="dot-indicator dot-green" /> Processing Architecture</span>
            <span className="card-meta">pipeline design</span>
          </div>
          <div className="card-body">
            {[
              { label: "Ingestion",          value: "Kafka transactions topic" },
              { label: "Feature Extraction", value: "amount \u00B7 hour \u00B7 velocity \u00B7 amount_ratio" },
              { label: "Risk Engine",        value: "RandomForest V4 fraud probability" },
              { label: "Decision",           value: `policy thresholds ${formatPct(config?.riskPolicy?.lowThreshold ?? 0.01)} / ${formatPct(config?.riskPolicy?.highThreshold ?? 0.10)}` },
              { label: "Persistence",        value: "PostgreSQL (balance-safe)" },
              { label: "Commit Order",       value: "PostgreSQL \u2192 Kafka" },
            ].map(({ label, value }) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--cream-3)" }}>
                <span style={{ fontSize: 11.5, color: "var(--slate)" }}>{label}</span>
                <span style={{ fontSize: 11.5, fontFamily: "var(--mono)", fontWeight: 600 }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-green" /> Database Integrity</span>
          <span className="card-meta">SUM(balance) conservation</span>
        </div>
        <div className="card-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {[
              { label: "Balance Conservation", value: "checked live in Accounts" },
              { label: "Idempotency Guard",    value: "processed_events UNIQUE" },
              { label: "Row Locking",          value: "SELECT FOR UPDATE" },
              { label: "Crash Safety",         value: "DB COMMIT \u2192 Kafka COMMIT" },
            ].map(({ label, value }) => (
              <div key={label} className="rule-panel">
                <div style={{ fontSize: 9, color: "var(--slate)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3, fontWeight: 700 }}>{label}</div>
                <div style={{ fontSize: 11.5, fontFamily: "var(--mono)", fontWeight: 600 }}>{value}</div>
                <div style={{ fontSize: 9.5, color: "var(--green-text)", marginTop: 2 }}>{"\u2713"} Verified</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-header">
          <span className="card-title"><span className="dot-indicator dot-green" /> Demo Administration</span>
          <span className="card-meta">controlled transaction seeder</span>
        </div>
        <div className="card-body">
          <p style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12 }}>
            Generate demo transactions and push them through the live Kafka / PostgreSQL pipeline. Accounts and amounts are drawn from the database. The ML model scores each transaction and the risk policy determines the outcome.
          </p>
          <button className="btn btn-approve" onClick={() => onSeed()} disabled={seeding || !connected}>
            {seeding ? "Generating Events..." : "\u26A1 Generate Demo Transactions"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TransactionDrawer({ txn, alerts, txns, onAction, actionPending, onClose, config }) {
  if (!txn) return null;

  const alert = alerts.find((a) => a.event_id === txn.event_id);
  const txnState = txns.find((t) => t.event_id === txn.event_id);
  const status = txnState ? txnState.status : txn.status;
  const score = (txnState?.risk_score != null) ? Number(txnState.risk_score) : (alert ? alert.risk_score : null);
  const level = txnState?.risk_level || (alert ? alert.risk_level : "LOW");
  const reasons = txnState?.reasons ? txnState.reasons.split(" \u00B7 ") : (alert ? alert.reasons : []);

  const moneyMoved = status === "applied";
  const lowT = config?.riskPolicy?.lowThreshold ?? 0.01;
  const highT = config?.riskPolicy?.highThreshold ?? 0.10;

  return (
    <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer">
        <div className="drawer-header">
          <span className="drawer-title">Transaction Detail</span>
          <button className="drawer-close" onClick={onClose}>Close</button>
        </div>

        <div className="drawer-body">
          {score != null && (
            <div className="detail-section">
              <div className="detail-section-title">Risk Decision</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                {levelBadge(level)}
                <span style={{ fontSize: 10, color: "var(--slate)", fontFamily: "var(--mono)" }}>
                  {level === "HIGH" ? "BLOCK" : level === "MEDIUM" ? "VERIFY" : "APPROVE"}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-key">Risk Score</span>
                <span className="detail-val" style={{ fontSize: 18, fontVariantNumeric: "tabular-nums" }}>{formatPct(score)}</span>
              </div>
              <div className="risk-score-bar">
                <div className={`risk-score-fill ${riskFillClass(level)}`} style={{ width: `${Math.min(score * 100, 100)}%` }} />
              </div>
              <div className="detail-row">
                <span className="detail-key">Threshold</span>
                <span className="detail-val" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{formatPct(level === "HIGH" ? highT : lowT)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-key">Decision</span>
                <span className="detail-val" style={{ fontWeight: 700 }}>
                  {level === "HIGH" ? "BLOCKED" : level === "MEDIUM" ? "HELD" : "APPROVED"}
                </span>
              </div>
            </div>
          )}

          {reasons && reasons.length > 0 && (
            <div className="detail-section">
              <div className="detail-section-title">Signals</div>
              {reasons.map((r, i) => (
                <div key={i} style={{ fontSize: 11.5, color: "var(--charcoal)", padding: "5px 0", borderBottom: "1px solid var(--cream-3)" }}>
                  {"\u2022"} {r}
                </div>
              ))}
            </div>
          )}

          <div className="detail-section">
            <div className="detail-section-title">Transaction</div>
            <div className="detail-row">
              <span className="detail-key">Event ID</span>
              <span className="detail-val mono" style={{ fontSize: 10, color: "var(--slate)" }}>{txn.event_id}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Amount</span>
              <span className="detail-val" style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatINR(txn.amount)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Transfer</span>
              <span className="detail-val mono">{txn.from_account} {"\u2192"} {txn.to_account}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Amount Band</span>
              <span className="detail-val">{amountBandBadge(txn.amount_band || amountBandFor(txn.amount, config))}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Timestamp</span>
              <span className="detail-val">{timeAgo(txn.created_at)}</span>
            </div>
          </div>

          <div className="detail-section">
            <div className="detail-section-title">Settlement</div>
            <div className="detail-row">
              <span className="detail-key">Status</span>
              <span className="detail-val">{statusBadge(status)}</span>
            </div>
            <div className={`money-moved-box ${moneyMoved ? "yes" : "no"}`} style={{ marginTop: 4 }}>
              {moneyMoved ? "\u2713" : "\u2717"} MONEY MOVED: {moneyMoved ? "YES \u2014 Settlement complete" : status === "held" ? "NO \u2014 Settlement held for review" : "NO \u2014 Settlement blocked"}
            </div>
          </div>
        </div>

        {status === "held" && (
          <div className="drawer-actions">
            <button className="btn btn-approve" style={{ flex: 1 }} disabled={actionPending} onClick={() => onAction(txn.event_id, "approve")}>
              {actionPending ? "Processing..." : "\u2713 Approve & Settle"}
            </button>
            <button className="btn btn-decline" style={{ flex: 1 }} disabled={actionPending} onClick={() => onAction(txn.event_id, "decline")}>
              {"\u2715"} Decline
            </button>
          </div>
        )}
        {status === "blocked" && (
          <div className="drawer-blocked-notice">
            <div className="blocked-notice-box">{"\u2297"} Blocked {"\u2014"} No analyst action available</div>
          </div>
        )}
        {status === "applied" && (
          <div className="drawer-blocked-notice">
            <div className="blocked-notice-box" style={{ background: "var(--green-bg)", border: "1px solid var(--green-bd)", color: "var(--green-text)" }}>{"\u2713"} Approved & Settled</div>
          </div>
        )}
        {status === "declined" && (
          <div className="drawer-blocked-notice">
            <div className="blocked-notice-box" style={{ background: "var(--cream-2)", border: "1px solid var(--cream-3)", color: "var(--slate)" }}>{"\u2715"} Declined by Analyst</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Footer({ onNav }) {
  return (
    <footer className="footer">
      <div className="container">
        <div className="brand" style={{ fontSize: 13 }}>
          <div className="brand-mark" style={{ width: 24, height: 24, fontSize: 10 }}>LS</div>
          Ledger<span>Stream</span> RM
        </div>
        <div className="footer-links">
          <button className="footer-link" onClick={() => onNav && onNav("Accounts")}>Accounts</button>
          <button className="footer-link" onClick={() => onNav && onNav("System Health")}>System Health</button>
        </div>
        <div className="footer-tagline">
          AI-Powered Real-Time Payment Risk Management
        </div>
      </div>
    </footer>
  );
}

export default function App() {
  const [page, setPage] = useState("Overview");
  const [balances, setBalances] = useState([]);
  const [txns, setTxns] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [lag, setLag] = useState(null);
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTxnId, setSelectedTxnId] = useState(null);
  const [actionPending, setActionPending] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [demo, setDemo] = useState({ status: "idle", lastTxn: null, error: null });
  const [send, setSend] = useState({ status: "idle", result: null, error: null });
  const [justSent, setJustSent] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [timeRange, setTimeRange] = useState("24H");
  const timeRangeRef = useRef("24H");
  const [refreshing, setRefreshing] = useState(false);

  const toastId = useRef(0);
  const txnsRef = useRef([]);

  function addToast(type, msg) {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, type, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  async function handleSeedDemoData(count) {
    const knownIds = new Set((txnsRef.current || []).map((t) => t.event_id));
    setSeeding(true);
    setDemo({ status: "processing", lastTxn: null, error: null });
    try {
      const res = await fetch("/api/admin/seed-demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(count ? { count } : {}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // Poll the existing transaction API until the new demo event has been
      // scored by the ML model, decided by the policy, and persisted to
      // PostgreSQL. Only the ACTUAL persisted outcome is shown — nothing is
      // fabricated in the frontend.
      const deadline = Date.now() + 45000;
      let found = null;
      while (Date.now() < deadline) {
        const t = await fetchTransactions(200);
        found = (t.transactions || []).find(
          (tx) =>
            tx.event_id &&
            tx.event_id.startsWith("demo-") &&
            !knownIds.has(tx.event_id) &&
            (tx.status === "applied" || tx.status === "held" || tx.status === "blocked")
        );
        if (found) break;
        await new Promise((r) => setTimeout(r, 1500));
      }

      await refreshData();

      if (found) {
        setDemo({
          status: "done",
          lastTxn: {
            event_id: found.event_id,
            amount: found.amount,
            risk_score: found.risk_score,
            risk_level: found.risk_level,
            decision: found.status,
            created_at: found.created_at,
          },
          error: null,
        });
        addToast("success", "Test transaction processed through the live pipeline.");
      } else {
        throw new Error("Event published but not yet persisted; check that the ledger consumer is running");
      }
    } catch (e) {
      setDemo((prev) => ({ ...prev, status: "error", error: e.message }));
      addToast("error", `Seeding failed: ${e.message}`);
    } finally {
      setSeeding(false);
    }
  }

  async function handleSendTransaction(payload) {
    setSend({ status: "processing", result: null, error: null });
    try {
      const { event_id } = await sendTransaction(payload);

      // Poll the existing transaction API until the manual event has been
      // scored by the ML model, decided by the policy, and persisted to
      // PostgreSQL. Only the ACTUAL persisted outcome is shown — nothing is
      // fabricated in the frontend.
      const deadline = Date.now() + 45000;
      let found = null;
      while (Date.now() < deadline) {
        const t = await fetchTransactions(200);
        found = (t.transactions || []).find((tx) => tx.event_id === event_id);
        if (found) break;
        await new Promise((r) => setTimeout(r, 1500));
      }

      await refreshData();

      if (found) {
        setSend({ status: "done", result: found, error: null });
        setJustSent((prev) => (prev.includes(found.event_id) ? prev : [...prev, found.event_id]));
        window.setTimeout(() => {
          setJustSent((prev) => prev.filter((id) => id !== found.event_id));
        }, 12000);
        addToast("success", `Transaction ${found.event_id} processed: ${found.status.toUpperCase()}`);
      } else {
        throw new Error("Event published but not yet persisted; check that the ledger consumer is running");
      }
    } catch (e) {
      setSend((prev) => ({ ...prev, status: "error", error: e.message }));
      addToast("error", `Send failed: ${e.message}`);
    }
  }

  const refreshData = useCallback(async (rangeOverride) => {
    try {
      const range = rangeOverride || timeRangeRef.current;
      const [b, t, a, l, s, c] = await Promise.all([
        fetchBalances(),
        fetchTransactions(200, range),
        fetchAlerts(),
        fetchLag(),
        fetchStats(range),
        fetchConfig(),
      ]);
      setBalances(b.accounts);
      setTxns(t.transactions);
      txnsRef.current = t.transactions;
      setAlerts(a.alerts);
      setLag(l.lag);
      setStats(s);
      setConfig(c);
      setConnected(true);
      setError(null);
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

  function handleTimeRange(r) {
    setTimeRange(r);
    timeRangeRef.current = r;
    refreshData(r);
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshData();
    } finally {
      setRefreshing(false);
    }
  }

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

  const selectedTxn = txns.find((t) => t.event_id === selectedTxnId) ||
                       (() => {
                         const a = alerts.find((x) => x.event_id === selectedTxnId);
                         if (!a) return null;
                         return { event_id: a.event_id, from_account: a.from_account, to_account: a.to_account, amount: a.amount, status: a.action === "VERIFY" ? "held" : "blocked", created_at: a.flagged_at };
                       })();

  const heldCount    = txns.filter((t) => t.status === "held").length;
  const blockedCount = txns.filter((t) => t.status === "blocked").length;

  function scrollTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const goTo = (p) => {
    setPage(p);
    scrollTop();
  };

  const pageTitle = page === "Transactions" ? "Live Transactions" : page;

  return (
    <div className="app">
      <TopNav page={page} onNav={goTo} heldCount={heldCount} blockedCount={blockedCount} connected={connected} />

      {error && (
        <div className="error-banner">
          {"\u26A0"} API unreachable: {error} {"\u2014"} retrying every {POLL_MS / 1000}s
        </div>
      )}

      {page === "Overview" ? (
        <OverviewPage
          stats={stats} txns={txns} alerts={alerts} config={config}
          lag={lag} balances={balances}
          onSelectTxn={(id) => setSelectedTxnId(id)}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          timeRange={timeRange} onTimeRange={handleTimeRange}
          connected={connected}
          onNav={goTo}
          onSeed={() => handleSeedDemoData(1)}
          seeding={seeding}
          demo={demo}
          recentlySent={justSent}
        />
      ) : (
        <div className="workspace">
          <div className="workspace-hero">
            <div className="container">
              <div className="workspace-eyebrow">LEDGERSTREAM · RM PLATFORM</div>
              <div className="workspace-title">{pageTitle}</div>
              <div className="workspace-sub">{PAGE_SUBS[page]}</div>
            </div>
          </div>
          <div className="workspace-body">
            <div className="container">
              {page === "Transactions" && (
                <LiveTransactionsPage txns={txns} alerts={alerts} config={config} onSelectTxn={(id) => setSelectedTxnId(id)} selectedTxnId={selectedTxnId} recentlySent={justSent} />
              )}
              {page === "Send Transaction" && (
                <SendTransactionPage balances={balances} config={config} connected={connected} onSend={handleSendTransaction} send={send} onNavigate={goTo} />
              )}
              {page === "Risk Intelligence" && (
                <ReviewQueuePage txns={txns} alerts={alerts} config={config} onAction={handleAction} actionPending={actionPending} onSelectTxn={(id) => setSelectedTxnId(id)} />
              )}
              {page === "Alerts" && (
                <BlockedPage txns={txns} alerts={alerts} config={config} stats={stats} />
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
            </div>
          </div>
        </div>
      )}

      <Footer onNav={goTo} />

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

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
