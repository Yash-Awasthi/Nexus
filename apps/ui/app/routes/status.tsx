// SPDX-License-Identifier: Apache-2.0
"use client";

import type { Route } from "./+types/status";
import { useEffect, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardTitle } from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Check, Activity, RefreshCw } from "lucide-react";
import { FadeIn, StaggerChildren, StaggerItem, DottedGrid } from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Status - NEXUS" },
    {
      name: "description",
      content: "NEXUS platform status and service health monitoring.",
    },
  ];
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface HealthLiveness {
  status: "ok" | "error";
  version: string;
  timestamp: string;
}

interface HealthReady {
  status: "ready" | "not_ready";
  checks: Record<string, string>;
}

interface ServiceStatus {
  name: string;
  status: "Operational" | "Degraded" | "Unknown";
  detail: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchLiveness(): Promise<HealthLiveness> {
  const res = await fetch("/health", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<HealthLiveness>;
}

async function fetchReadiness(): Promise<HealthReady> {
  const res = await fetch("/health/ready", { cache: "no-store" });
  // 503 is a valid readiness failure — still parse the body
  return res.json() as Promise<HealthReady>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Status() {
  const [liveness, setLiveness] = useState<HealthLiveness | null>(null);
  const [readiness, setReadiness] = useState<HealthReady | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [live, ready] = await Promise.allSettled([fetchLiveness(), fetchReadiness()]);
      setLiveness(
        live.status === "fulfilled"
          ? live.value
          : { status: "error", version: "unknown", timestamp: new Date().toISOString() },
      );
      setReadiness(
        ready.status === "fulfilled"
          ? ready.value
          : { status: "not_ready", checks: { api: "unreachable" } },
      );
    } finally {
      setLoading(false);
      setLastChecked(new Date());
    }
  };

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Derive service list from liveness + readiness checks
  const services: ServiceStatus[] = [
    {
      name: "API Server",
      status: liveness?.status === "ok" ? "Operational" : liveness ? "Degraded" : "Unknown",
      detail:
        liveness?.status === "ok"
          ? `v${liveness.version}`
          : loading
            ? "Checking..."
            : "Unreachable",
    },
    ...(readiness
      ? Object.entries(readiness.checks).map(([key, val]) => ({
          name: key === "db" ? "PostgreSQL" : key.charAt(0).toUpperCase() + key.slice(1),
          status: (val === "ok" ? "Operational" : "Degraded") as ServiceStatus["status"],
          detail: val === "ok" ? "Connected" : val,
        }))
      : [
          {
            name: "PostgreSQL",
            status: "Unknown" as const,
            detail: loading ? "Checking..." : "Unknown",
          },
        ]),
  ];

  const allOperational = services.every((s) => s.status === "Operational");
  const anyDegraded = services.some((s) => s.status === "Degraded");

  const overallLabel =
    loading && !lastChecked
      ? "Checking services..."
      : allOperational
        ? "All services operational"
        : anyDegraded
          ? "Partial degradation"
          : "Checking services...";

  const overallColor = allOperational ? "emerald" : anyDegraded ? "amber" : "zinc";

  return (
    <div className="min-h-screen">
      <style>
        {`
          @keyframes operationalPulse {
            0%, 100% { box-shadow: 0 0 4px rgba(16,185,129,0.3); opacity: 0.9; }
            50% { box-shadow: 0 0 10px rgba(16,185,129,0.6); opacity: 1; }
          }
          @keyframes greenGlow {
            0%, 100% { box-shadow: 0 0 8px rgba(16,185,129,0.3); }
            50% { box-shadow: 0 0 24px rgba(16,185,129,0.5); }
          }
          @keyframes amberGlow {
            0%, 100% { box-shadow: 0 0 8px rgba(245,158,11,0.3); }
            50% { box-shadow: 0 0 24px rgba(245,158,11,0.5); }
          }
        `}
      </style>

      {/* Hero */}
      <section className="relative border-b border-border/40 bg-gradient-to-b from-background to-muted/20 px-6 py-24 text-center overflow-hidden">
        <DottedGrid />
        <FadeIn>
          <Badge variant="secondary" className="mb-4">
            <Activity className="mr-1 h-3 w-3" />
            System Status
          </Badge>
          <h1 className="font-display mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            Platform Status
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Real-time health monitoring for the NEXUS platform.
          </p>
          {lastChecked && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last checked {lastChecked.toLocaleTimeString()} · auto-refreshes every 30s
            </p>
          )}
        </FadeIn>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-20">
        {/* Overall status banner */}
        <FadeIn>
          <div
            className={`mb-8 flex items-center justify-between gap-3 rounded-lg border p-4 ${
              overallColor === "emerald"
                ? "border-emerald-500/30 bg-emerald-500/5"
                : overallColor === "amber"
                  ? "border-amber-500/30 bg-amber-500/5"
                  : "border-border/40 bg-muted/20"
            }`}
            style={{
              animation:
                overallColor === "emerald"
                  ? "greenGlow 3s ease-in-out infinite"
                  : overallColor === "amber"
                    ? "amberGlow 3s ease-in-out infinite"
                    : undefined,
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className={`h-3 w-3 rounded-full ${
                  overallColor === "emerald"
                    ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                    : overallColor === "amber"
                      ? "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"
                      : "bg-zinc-400"
                }`}
              />
              <span className="font-display text-lg font-semibold">{overallLabel}</span>
            </div>
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <Tabs defaultValue="status">
            <TabsList className="mb-8">
              <TabsTrigger value="status">Status</TabsTrigger>
              <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
              <TabsTrigger value="incidents">Incidents</TabsTrigger>
            </TabsList>

            <TabsContent value="status">
              <StaggerChildren className="space-y-4" staggerDelay={0.1}>
                {services.map((service) => (
                  <StaggerItem key={service.name}>
                    <Card>
                      <CardContent className="py-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div
                              className={`h-2.5 w-2.5 rounded-full ${
                                service.status === "Operational"
                                  ? "bg-emerald-500"
                                  : service.status === "Degraded"
                                    ? "bg-amber-500"
                                    : "bg-zinc-400"
                              }`}
                            />
                            <span className="font-medium">{service.name}</span>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-sm text-muted-foreground font-mono">
                              {service.detail}
                            </span>
                            <Badge
                              variant="secondary"
                              className={
                                service.status === "Operational"
                                  ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                                  : service.status === "Degraded"
                                    ? "border-amber-500/20 bg-amber-500/10 text-amber-400"
                                    : "border-border bg-muted text-muted-foreground"
                              }
                              style={
                                service.status === "Operational"
                                  ? { animation: "operationalPulse 3s ease-in-out infinite" }
                                  : undefined
                              }
                            >
                              {service.status}
                            </Badge>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </StaggerItem>
                ))}
              </StaggerChildren>
              {liveness && (
                <p className="mt-6 text-center text-xs text-muted-foreground font-mono">
                  API timestamp: {new Date(liveness.timestamp).toUTCString()}
                </p>
              )}
            </TabsContent>

            <TabsContent value="maintenance">
              <FadeIn>
                <Card>
                  <CardContent className="flex flex-col items-center py-16 text-center">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                      <Check className="h-6 w-6 text-emerald-500" />
                    </div>
                    <CardTitle className="font-display mb-2">No maintenance scheduled</CardTitle>
                    <CardDescription>
                      There are no upcoming maintenance windows. We&apos;ll post updates here before
                      any planned downtime.
                    </CardDescription>
                  </CardContent>
                </Card>
              </FadeIn>
            </TabsContent>

            <TabsContent value="incidents">
              <FadeIn>
                <Card>
                  <CardContent className="flex flex-col items-center py-16 text-center">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                      <Check className="h-6 w-6 text-emerald-500" />
                    </div>
                    <CardTitle className="font-display mb-2">No incidents reported</CardTitle>
                    <CardDescription>
                      All systems have been operating normally. Past incidents will be documented
                      here.
                    </CardDescription>
                  </CardContent>
                </Card>
              </FadeIn>
            </TabsContent>
          </Tabs>
        </FadeIn>
      </section>
    </div>
  );
}
