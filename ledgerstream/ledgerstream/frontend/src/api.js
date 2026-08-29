const API_BASE = "/api";

async function get(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export const fetchBalances = () => get("/balances");
export const fetchTransactions = (limit = 50) => get(`/transactions?limit=${limit}`);
export const fetchAlerts = () => get("/alerts");
export const fetchLag = () => get("/lag");
export const fetchStats = () => get("/stats");