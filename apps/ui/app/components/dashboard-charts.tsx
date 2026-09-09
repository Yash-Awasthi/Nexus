// SPDX-License-Identifier: Apache-2.0
/**
 * dashboard-charts.tsx
 *
 * Chart used by the dashboard (home.tsx). Lazy-loaded via React.lazy() so
 * Recharts never runs during SSR (React Router 7 / Cloudflare Workers) —
 * same convention as analytics-charts.tsx.
 *
 * Data comes from GET /api/dashboard?days=N → series: [{date, requests,
 * tokens, costUsd}]. The page slices the series to the selected window; when
 * the Today window is chosen it renders the trailing 7 days with today's
 * tick label emphasized (a 1-point chart is unreadable, showing the trailing
 * week keeps the connection honest).
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type XAxisTickContentProps,
} from "recharts";

export interface UsagePoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "0.5rem",
  fontSize: "12px",
  color: "hsl(var(--popover-foreground))",
};

export function UsageChart({
  data,
  highlightDate,
}: {
  data: UsagePoint[];
  /** Emphasize this date's tick label (used for the Today window). */
  highlightDate?: string;
}) {
  const rows = data.map((d) => ({
    ...d,
    label: new Date(`${d.date}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  }));
  const highlight = highlightDate
    ? new Date(`${highlightDate}T00:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : undefined;

  // Ticks provably render through the axis machinery; highlighting today's
  // label avoids the ReferenceArea band-scale edge cases entirely.
  const renderTick = ({ x, y, payload }: XAxisTickContentProps) => {
    const isToday = payload.value === highlight;
    return (
      <text
        x={x}
        y={y}
        dy={12}
        textAnchor="middle"
        fontSize={11}
        fontWeight={isToday ? 700 : 400}
        fill={isToday ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))"}
      >
        {payload.value}
      </text>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="reqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border)/0.5)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={highlight ? renderTick : { fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={{ fontWeight: 600 }}
          formatter={(value, name) =>
            name === "costUsd"
              ? [`$${Number(value ?? 0).toFixed(4)}`, "Cost"]
              : [Number(value ?? 0).toLocaleString(), "Requests"]
          }
        />
        <Area
          type="monotone"
          dataKey="requests"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill="url(#reqGrad)"
        />
        <Line
          type="monotone"
          dataKey="costUsd"
          stroke="hsl(var(--chart-2, 142 71% 45%))"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          yAxisId="right"
        />
        <YAxis yAxisId="right" orientation="right" hide domain={["dataMin", "dataMax"]} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
