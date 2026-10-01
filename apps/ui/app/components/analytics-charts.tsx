// SPDX-License-Identifier: Apache-2.0
/**
 * analytics-charts.tsx
 *
 * All Recharts components live here and are lazy-loaded from admin-analytics.tsx
 * via React.lazy(). This prevents Recharts from running during SSR, which causes
 * "window is not defined" errors in React Router 7 / Cloudflare Workers.
 *
 * Data comes from:
 *   GET /api/analytics/daily?days=7     — bar chart
 *   GET /api/analytics/daily?days=30    — line chart
 *   GET /api/analytics/providers        — pie chart
 *   GET /api/analytics/models?limit=5   — top models table
 * Falls back to deterministic static data if any call fails.
 */
import { Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  type PieLabelRenderProps,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";

const PIE_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4"];

// ─── Shared chart theme ────────────────────────────────────────────────────────

const TOOLTIP_STYLE = {
  backgroundColor: "#1c1c1c",
  border: "1px solid #333",
  borderRadius: 8,
  fontSize: 12,
};

const GRID_PROPS = {
  strokeDasharray: "3 3" as const,
  stroke: "#333",
};

const AXIS_PROPS = {
  stroke: "#888" as const,
  fontSize: 12,
  tickLine: false,
  axisLine: false,
};

// ─── Custom PieChart label ─────────────────────────────────────────────────────

function renderPieLabel(props: PieLabelRenderProps) {
  // Recharts types these as number | string | undefined; by render time they are numbers.
  const n = (v: unknown) => Number(v ?? 0);
  const [cx, cy, midAngle, innerRadius, outerRadius, percent] = [
    props.cx,
    props.cy,
    props.midAngle,
    props.innerRadius,
    props.outerRadius,
    props.percent,
  ].map(n) as [number, number, number, number, number, number];
  if (percent < 0.08) return null;
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text
      x={x}
      y={y}
      fill="#fff"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={11}
      fontWeight={500}
    >
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface DailyPoint7 {
  day: string;
  count: number;
}
interface DailyPoint30 {
  date: string;
  requests: number;
  cost: number;
}
interface ProviderSlice {
  name: string;
  value: number;
  color: string;
}
interface ModelRow {
  name: string;
  provider: string;
  requests: number;
  tokens: string;
  cost: string;
}

// ─── Default export (consumed by React.lazy in admin-analytics.tsx) ───────────

export default function AnalyticsCharts() {
  const [daily7, setDaily7] = useState<DailyPoint7[] | null>(null);
  const [daily30, setDaily30] = useState<DailyPoint30[] | null>(null);
  const [providers, setProviders] = useState<ProviderSlice[] | null>(null);
  const [topModels, setTopModels] = useState<ModelRow[] | null>(null);

  useEffect(() => {
    // Each series shows what the server recorded; a failed load shows as empty, never invented.
    const load = async <T,>(url: string): Promise<T[]> => {
      const res = await fetch(url).catch(() => null);
      if (!res?.ok) return [];
      const body = (await res.json().catch(() => null)) as { data?: T[] } | null;
      return body?.data ?? [];
    };
    const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
    const compact = (n: number) =>
      n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1000
          ? `${Math.round(n / 1000)}K`
          : String(n);
    type Day = { date: string; conversations: number; cost: number };

    void load<Day>("/api/analytics/daily?days=7").then((rows) =>
      setDaily7(
        rows.map((d) => ({
          day: new Date(`${d.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "short" }),
          count: d.conversations,
        })),
      ),
    );
    void load<Day>("/api/analytics/daily?days=30").then((rows) =>
      setDaily30(
        rows.map((d) => ({
          date: new Date(`${d.date}T00:00:00`).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          requests: d.conversations,
          cost: d.cost,
        })),
      ),
    );
    void load<{ provider: string; requests: number }>("/api/analytics/providers").then((rows) =>
      setProviders(
        rows
          .sort((x, y) => y.requests - x.requests)
          .map((p, i, all) => ({
            name: p.provider,
            value: Math.round((p.requests / all.reduce((sum, q) => sum + q.requests, 0)) * 100),
            color: PIE_COLORS[i % PIE_COLORS.length]!,
          })),
      ),
    );
    void load<{ model: string; requests: number; tokens: number; cost: number }>(
      "/api/analytics/models?limit=5",
    ).then((rows) =>
      setTopModels(
        rows.map((m) => ({
          name: m.model,
          provider: m.model.includes("/") ? m.model.split("/")[0]! : "",
          requests: m.requests,
          tokens: compact(m.tokens),
          cost: money(m.cost),
        })),
      ),
    );
  }, []);

  const xAxisTickFormatter30 = (_: string, index: number) =>
    index % 5 === 0 ? (daily30?.[index]?.date ?? "") : "";

  const chartData7 = daily7 ?? [];
  const chartData30 = daily30 ?? [];
  const providerData = providers ?? [];
  const modelsData = topModels ?? [];
  const isLoading = daily7 === null || daily30 === null || providers === null || topModels === null;

  return (
    <div className="space-y-4">
      {/* Row: Bar chart + Pie chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Daily conversations bar chart */}
        <Card>
          <CardHeader>
            <CardTitle>Daily Requests</CardTitle>
            <CardDescription>Last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-[200px] flex items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData7} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="day" {...AXIS_PROPS} />
                  <YAxis {...AXIS_PROPS} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelStyle={{ color: "#ccc" }}
                    itemStyle={{ color: "#10b981" }}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} name="Requests" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Provider usage pie chart */}
        <Card>
          <CardHeader>
            <CardTitle>Provider Usage</CardTitle>
            <CardDescription>Request distribution across providers</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-[200px] flex items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : providerData.length === 0 ? (
              <p className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                No model calls recorded yet.
              </p>
            ) : (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width="60%" height={200}>
                  <PieChart>
                    <Pie
                      data={providerData.map((p) => ({ ...p, fill: p.color }))}
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      dataKey="value"
                      labelLine={false}
                      label={renderPieLabel}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      itemStyle={{ color: "#ccc" }}
                      formatter={(value) => [`${value}%`, "Share"]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-col gap-2 flex-1">
                  {providerData.map((p) => (
                    <div key={p.name} className="flex items-center gap-2 text-sm">
                      <span
                        className="size-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: p.color }}
                      />
                      <span className="text-muted-foreground flex-1">{p.name}</span>
                      <span className="font-medium tabular-nums">{p.value}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 30-day line chart */}
      <Card>
        <CardHeader>
          <CardTitle>Requests &amp; Costs Over Time</CardTitle>
          <CardDescription>Last 30 days</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-[240px] flex items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={chartData30} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="date"
                    {...AXIS_PROPS}
                    tickFormatter={xAxisTickFormatter30}
                    interval={0}
                  />
                  <YAxis yAxisId="left" {...AXIS_PROPS} />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    {...AXIS_PROPS}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelStyle={{ color: "#ccc" }}
                    itemStyle={{ fontSize: 12 }}
                    cursor={{ stroke: "#444" }}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="requests"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    name="Requests"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cost"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={false}
                    name="Cost ($)"
                  />
                </LineChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground justify-center">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-success inline-block" />
                  Requests
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-warning inline-block" />
                  Cost
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Top models table */}
      <Card>
        <CardHeader>
          <CardTitle>Top Models</CardTitle>
          <CardDescription>Most used models by request count</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                      Model
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                      Provider
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3">
                      Requests
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3">
                      Tokens
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {modelsData.map((model) => (
                    <tr key={model.name} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="px-4 py-3 text-sm font-medium font-mono">{model.name}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{model.provider}</td>
                      <td className="px-4 py-3 text-sm text-right tabular-nums">
                        {model.requests.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-muted-foreground tabular-nums">
                        {model.tokens}
                      </td>
                      <td className="px-4 py-3 text-sm text-right tabular-nums">{model.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
