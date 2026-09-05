const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function get(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}


export const fetchBalances = () => get("/balances");
export const fetchTransactions = (limit = 50, range) => get(`/transactions?limit=${limit}${range ? `&range=${range}` : ""}`);
export const fetchAlerts = () => get("/alerts");
export const fetchLag = () => get("/lag");
export const fetchStats = (range) => get(range ? `/stats?range=${range}` : "/stats");
export const fetchConfig = () => get("/config");

export async function sendTransaction({ from, to, amount }) {
  const res = await fetch(`${API_BASE}/admin/send-transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_account: from, to_account: to, amount }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}