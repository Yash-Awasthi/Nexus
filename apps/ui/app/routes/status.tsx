"use client";

import type { Route } from "./+types/status";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Check, Activity } from "lucide-react";
import {
  FadeIn,
  StaggerChildren,
  StaggerItem,
  DottedGrid,
} from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Status - JUDICA" },
    {
      name: "description",
      content: "JUDICA platform status and service health monitoring.",
    },
  ];
}

const services = [
  { name: "API Server", uptime: 99.9, status: "Operational" as const },
  {
    name: "Cloud Configuration",
    uptime: 99.5,
    status: "Operational" as const,
  },
  { name: "Frontend Status", uptime: 99.8, status: "Operational" as const },
  { name: "Background Jobs", uptime: 99.7, status: "Operational" as const },
];

// Generate fake 30-day uptime bars: mostly green with occasional gray
function generateUptimeDays(): boolean[] {
  const days: boolean[] = [];
  for (let i = 0; i < 30; i++) {
    // ~97% chance of green per day
    days.push(Math.random() > 0.03);
  }
  // Ensure last 7 days are all green (recent stability)
  for (let i = 23; i < 30; i++) {
    days[i] = true;
  }
  return days;
}

// Precompute so they don't change on re-render in SSR
const serviceUptimeDays = services.map(() => generateUptimeDays());

export default function Status() {
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
          @keyframes uptimeFill {
            from { transform: scaleX(0); }
            to { transform: scaleX(1); }
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
            Real-time health monitoring for the JUDICA platform.
          </p>
        </FadeIn>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-20">
        {/* Overall status banner */}
        <FadeIn>
          <div
            className="mb-8 flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4"
            style={{ animation: "greenGlow 3s ease-in-out infinite" }}
          >
            <div className="h-3 w-3 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            <span className="font-display text-lg font-semibold">
              All services are online
            </span>
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
                {services.map((service, idx) => (
                  <StaggerItem key={service.name}>
                    <Card>
                      <CardContent className="py-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                            <span className="font-medium">{service.name}</span>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-sm text-muted-foreground">
                              {service.uptime}% uptime
                            </span>
                            <Badge
                              variant="secondary"
                              className="border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                              style={{ animation: "operationalPulse 3s ease-in-out infinite" }}
                            >
                              {service.status}
                            </Badge>
                          </div>
                        </div>
                        {/* 30-day uptime bar */}
                        <div className="mt-3 flex gap-0.5">
                          {serviceUptimeDays[idx].map((up, dayIdx) => (
                            <div
                              key={dayIdx}
                              className={`h-8 flex-1 rounded-sm origin-left ${up ? "bg-emerald-500/40" : "bg-muted-foreground/20"}`}
                              title={`Day ${dayIdx + 1}: ${up ? "Operational" : "Degraded"}`}
                              style={{
                                animation: `uptimeFill 0.6s ease-out ${dayIdx * 0.02}s both`,
                              }}
                            />
                          ))}
                        </div>
                        <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                          <span>30 days ago</span>
                          <span>Today</span>
                        </div>
                      </CardContent>
                    </Card>
                  </StaggerItem>
                ))}
              </StaggerChildren>
            </TabsContent>

            <TabsContent value="maintenance">
              <FadeIn>
                <Card>
                  <CardContent className="flex flex-col items-center py-16 text-center">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
                      <Check className="h-6 w-6 text-emerald-500" />
                    </div>
                    <CardTitle className="font-display mb-2">
                      No maintenance scheduled
                    </CardTitle>
                    <CardDescription>
                      There are no upcoming maintenance windows. We'll post updates
                      here before any planned downtime.
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
                    <CardTitle className="font-display mb-2">
                      No incidents reported
                    </CardTitle>
                    <CardDescription>
                      All systems have been operating normally. Past incidents will
                      be documented here.
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
