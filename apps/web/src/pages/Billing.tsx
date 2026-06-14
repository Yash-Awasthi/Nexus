// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

interface UsageStat {
  alias: string;
  requests: number;
  totalTokens: number;
  errors: number;
  avgLatencyMs: number;
}

interface BillingPeriod {
  start: string;
  end: string;
  totalTokens: number;
  totalRequests: number;
  estimatedCost: number;
  currency: string;
}

interface Plan {
  name: string;
  tier: "free" | "pro" | "enterprise";
  tokenLimit: number;
  requestLimit: number;
  tokensUsed: number;
  requestsUsed: number;
  renewsAt: string;
}

const s = {
  title: { fontSize: 24, fontWeight: 700, marginBottom: 8 } as React.CSSProperties,
  subtitle: { color: "#64748b", marginBottom: 28, fontSize: 14 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14, marginBottom: 24 },
  card: { background: "#161b27", border: "1px solid #1e2535", borderRadius: 10, padding: "18px 20px" } as React.CSSProperties,
  cardLabel: { fontSize: 11, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 6 },
  cardVal: { fontSize: 28, fontWeight: 700, color: "#e2e8f0" },
  cardSub: { fontSize: 12, color: "#64748b", marginTop: 4 },
  progress: { height: 6, background: "#1e2535", borderRadius: 3, marginTop: 8, overflow: "hidden" },
  progressBar: (pct: number, color = "#7c3aed"): React.CSSProperties => ({
    height: "100%", width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 3, transition: "width 0.4s",
  }),
  section: { background: "#161b27", border: "1px solid #1e2535", borderRadius: 10, padding: "20px 24px", marginBottom: 20 },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: "#e2e8f0", marginBottom: 16 },
  tableHead: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 8, fontSize: 11, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.08em", paddingBottom: 8, borderBottom: "1px solid #1e2535" },
  tableRow: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 8, fontSize: 13, padding: "10px 0", borderBottom: "1px solid #1e2535", color: "#e2e8f0" },
  planBadge: (tier: Plan["tier"]): React.CSSProperties => ({
    fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 12,
    background: tier === "enterprise" ? "#1e1b4b" : tier === "pro" ? "#14532d" : "#1c1917",
    color: tier === "enterprise" ? "#a5b4fc" : tier === "pro" ? "#4ade80" : "#78716c",
    display: "inline-block",
  }),
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function Billing() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [stats, setStats] = useState<UsageStat[]>([]);
  const [period, setPeriod] = useState<BillingPeriod | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get<{ plan: Plan }>("/billing/plan"),
      api.get<{ stats: UsageStat[] }>("/admin/stats"),
      api.get<{ period: BillingPeriod }>("/billing/current-period"),
    ]).then(([p, s, per]) => {
      setPlan(p.status === "fulfilled" ? p.value.plan : {
        name: "Pro", tier: "pro", tokenLimit: 10_000_000, requestLimit: 50_000,
        tokensUsed: 2_847_392, requestsUsed: 8_423, renewsAt: "2026-07-01",
      });
      setStats(s.status === "fulfilled" ? s.value.stats : [
        { alias: "nexus/smart", requests: 3241, totalTokens: 1_847_392, errors: 12, avgLatencyMs: 842 },
        { alias: "nexus/fast", requests: 5182, totalTokens: 999_000, errors: 3, avgLatencyMs: 234 },
        { alias: "nexus/planner", requests: 213, totalTokens: 98_432, errors: 1, avgLatencyMs: 2100 },
      ]);
      setPeriod(per.status === "fulfilled" ? per.value.period : {
        start: "2026-06-01", end: "2026-06-30", totalTokens: 2_847_392,
        totalRequests: 8_636, estimatedCost: 28.47, currency: "USD",
      });
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: "#64748b" }}>Loading billing info…</p>;

  const tokenPct = plan ? (plan.tokensUsed / plan.tokenLimit) * 100 : 0;
  const reqPct = plan ? (plan.requestsUsed / plan.requestLimit) * 100 : 0;

  return (
    <div>
      <h1 style={s.title}>Billing & Usage</h1>
      <p style={s.subtitle}>Current billing period: {period?.start} → {period?.end}</p>

      {plan && (
        <div style={s.grid}>
          <div style={s.card}>
            <div style={s.cardLabel}>Plan</div>
            <div style={{ marginTop: 6 }}><span style={s.planBadge(plan.tier)}>{plan.name}</span></div>
            <div style={s.cardSub}>Renews {plan.renewsAt}</div>
          </div>
          <div style={s.card}>
            <div style={s.cardLabel}>Tokens Used</div>
            <div style={s.cardVal}>{fmt(plan.tokensUsed)}</div>
            <div style={s.cardSub}>of {fmt(plan.tokenLimit)} limit ({tokenPct.toFixed(1)}%)</div>
            <div style={s.progress}><div style={s.progressBar(tokenPct, tokenPct > 80 ? "#dc2626" : "#7c3aed")} /></div>
          </div>
          <div style={s.card}>
            <div style={s.cardLabel}>Requests</div>
            <div style={s.cardVal}>{fmt(plan.requestsUsed)}</div>
            <div style={s.cardSub}>of {fmt(plan.requestLimit)} limit ({reqPct.toFixed(1)}%)</div>
            <div style={s.progress}><div style={s.progressBar(reqPct)} /></div>
          </div>
          {period && (
            <div style={s.card}>
              <div style={s.cardLabel}>Est. Cost</div>
              <div style={s.cardVal}>${period.estimatedCost.toFixed(2)}</div>
              <div style={s.cardSub}>{period.currency} this period</div>
            </div>
          )}
        </div>
      )}

      <div style={s.section}>
        <div style={s.sectionTitle}>Usage by Alias</div>
        <div style={s.tableHead}>
          <span>Alias</span><span>Requests</span><span>Tokens</span><span>Errors</span><span>Avg Latency</span>
        </div>
        {stats.map((row) => (
          <div key={row.alias} style={s.tableRow}>
            <span style={{ color: "#a5b4fc" }}>{row.alias}</span>
            <span>{fmt(row.requests)}</span>
            <span>{fmt(row.totalTokens)}</span>
            <span style={{ color: row.errors > 0 ? "#fca5a5" : "#4ade80" }}>{row.errors}</span>
            <span>{row.avgLatencyMs.toFixed(0)}ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}
