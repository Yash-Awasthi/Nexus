// SPDX-License-Identifier: Apache-2.0
/**
 * useDashboard — owns every piece of non-notification data the dashboard page
 * renders, so the route stays a composition of data + layout:
 *
 *   GET /api/dashboard     — usage aggregate (stats + 7-day series + research)
 *   GET /health/ready      — dependency health (checks are "ok"/"down" strings)
 *   GET /api/v1/connectors — connector summary
 *   GET /api/providers     — provider availability + per-provider model counts
 *
 * The notification tray is deliberately NOT here — it has one owner, the
 * NotificationsContext — so the bell and the Activity card never disagree.
 * Everything falls back to an empty shape when a call fails (dashboard renders
 * zeros rather than erroring).
 */
import { useCallback, useEffect, useState } from "react";

import { authFetch } from "~/lib/api";

export interface DashboardStats {
  requests: number;
  tokens: number;
  costUsd: number;
  latencyP50ms: number;
  latencyP99ms: number;
  errorRate: number;
  source: string;
}

export interface UsagePoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

export interface ResearchSummary {
  running: number;
  recent: { id: string; query: string; status: string; createdAt: string }[];
}

export interface DashboardPayload {
  stats: DashboardStats;
  series: UsagePoint[];
  research: ResearchSummary;
  generatedAt: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  models: number;
  connected: boolean;
}

export interface ConnectorCount {
  total: number;
  connected: number;
  errors: number;
}

interface ProviderPayload {
  providers?: { id?: string; name?: string; available?: boolean }[];
  models?: { provider?: string }[];
}

// Provider ids on /api/providers use "gemini"; the UI keys the display set by
// "google". Normalize once, here, not inside the component.
const PROVIDER_DISPLAY: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  groq: "Groq",
  ollama: "Ollama",
  openrouter: "OpenRouter",
  mistral: "Mistral",
};

const CANONICAL_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "ollama",
  "openrouter",
  "mistral",
];

function toDisplayId(id: string): string {
  return id === "gemini" ? "google" : id.toLowerCase();
}

export function useDashboard() {
  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [health, setHealth] = useState<Record<string, string> | null>(null);
  const [connectorCount, setConnectorCount] = useState<ConnectorCount | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);

    await Promise.allSettled([
      // Usage aggregate (stats + 30-day series + research). The page derives
      // its Today/7d/30d windows from the series — one round-trip covers all.
      authFetch("/api/dashboard?days=30")
        .then((r) => (r.ok ? r.json() : null))
        .then((data: DashboardPayload | null) => {
          if (data) setDash(data);
        })
        .catch(() => {}),

      // Dependency health — db / kv readiness (checks values are "ok"/"down").
      fetch("/health/ready")
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { checks?: Record<string, string> } | null) => {
          if (data?.checks) setHealth(data.checks);
        })
        .catch(() => {}),

      // Connector summary.
      fetch("/api/v1/connectors?limit=100")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return;
          const list = (data.connectors ?? []) as { status?: string }[];
          setConnectorCount({
            total: list.length,
            connected: list.filter((c) => c.status === "connected").length,
            errors: list.filter((c) => c.status === "error").length,
          });
        })
        .catch(() => {}),

      // Provider availability, always listing the canonical seven (unavailable
      // ones render "Not connected") with model counts tallied per provider.
      fetch("/api/providers")
        .then((r) => (r.ok ? r.json() : null))
        .then((data: ProviderPayload | null) => {
          if (!data?.providers) return;
          const modelCounts = new Map<string, number>();
          for (const m of data.models ?? []) {
            const key = toDisplayId(m.provider ?? "custom");
            modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1);
          }
          const seen = new Set<string>();
          const list: ProviderStatus[] = [];
          for (const p of data.providers) {
            const id = toDisplayId(p.id ?? "custom");
            if (seen.has(id)) continue;
            seen.add(id);
            list.push({
              id,
              name: PROVIDER_DISPLAY[id] ?? p.name ?? id,
              models: modelCounts.get(id) ?? 0,
              connected: !!p.available,
            });
          }
          for (const id of CANONICAL_PROVIDERS) {
            if (!seen.has(id)) {
              list.push({ id, name: PROVIDER_DISPLAY[id] ?? id, models: 0, connected: false });
            }
          }
          setProviders(list);
        })
        .catch(() => {}),
    ]);

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { dash, health, connectorCount, providers, loading, refreshing, refresh };
}
