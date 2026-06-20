// SPDX-License-Identifier: Apache-2.0
"use client";

import type { Route } from "./+types/about";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Code2,
  Eye,
  Shield,
  Cpu,
  Brain,
  Zap,
  Database,
  Globe,
  GitBranch,
  FlaskConical,
  Network,
  BarChart3,
  Lock,
} from "lucide-react";
import {
  FadeIn,
  StaggerChildren,
  StaggerItem,
  TiltCard,
  DottedGrid,
  GlowOrbs,
} from "~/components/animations";

const GithubIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

export function meta({}: Route.MetaArgs) {
  return [
    { title: "About - NEXUS" },
    {
      name: "description",
      content:
        "NEXUS is a multi-agent AI orchestration platform. 107 packages, 15 LLM providers, multi-model council deliberation, pgvector memory, and sandboxed code execution.",
    },
  ];
}

const stats = [
  { value: "107", label: "packages" },
  { value: "15", label: "LLM providers" },
  { value: "100+", label: "UI routes" },
  { value: "61", label: "API modules" },
  { value: "16", label: "data feeds" },
  { value: "4542", label: "tests passing" },
];

const features = [
  {
    icon: Network,
    title: "Multi-model council",
    description:
      "Run N models in parallel via Promise.allSettled. One failure never breaks the vote. Supports unanimous, majority, and weighted modes across 11 AI archetypes.",
  },
  {
    icon: Cpu,
    title: "Code execution sandbox",
    description:
      "Python, TypeScript, Bash, Go, Rust, Ruby, and R via Piston. Docker REPL for long-running sessions with --network none, 256 MB cap, and read-only filesystem.",
  },
  {
    icon: Brain,
    title: "Long-term memory",
    description:
      "pgvector embeddings + MemoryGraph BFS with score × edgeWeight decay. BM25+RRF hybrid retrieval, TTL expiry, and per-tenant access control.",
  },
  {
    icon: Zap,
    title: "Provider failover",
    description:
      "classifyFailoverError() recognises 30+ error patterns across 3 categories. FallbackChain retries across providers automatically — no manual intervention.",
  },
  {
    icon: Database,
    title: "Document pipeline",
    description:
      "Full ingestion stack: extract → classify → OCR → chunk → embed → index. 7 OCR modes, 11 layout categories, RAG with sub-query decomposition.",
  },
  {
    icon: Globe,
    title: "16 domain feeds",
    description:
      "Aviation, climate, conflict, economic, cyber, health, seismology, wildfire, maritime, sanctions, radiation, space, and more. BullMQ repeatable jobs with Redis locking.",
  },
  {
    icon: GitBranch,
    title: "Agent orchestration",
    description:
      "VersionedPlan with 13 lifecycle states and immutable snapshots. PlanningEngine with 11 blueprints. GovernanceEngine for constraints and guardrails.",
  },
  {
    icon: FlaskConical,
    title: "Gauntlet & evals",
    description:
      "Race 47 models in waves of 12 with 150 ms stagger. scoreResponse() 0–100 across 5 speed tiers. RLHF pipeline, SFT auto-tagger, corpus builder.",
  },
  {
    icon: BarChart3,
    title: "Full observability",
    description:
      "OpenTelemetry traces, Prometheus metrics, Grafana dashboards pre-provisioned. HMAC-SHA256-chained audit logs — every event tamper-evident.",
  },
];

const values = [
  {
    icon: Code2,
    title: "Open source",
    description:
      "Apache 2.0 licensed. Every line of code is public. Fork it, extend it, self-host it — no lock-in, no hidden pricing tier.",
  },
  {
    icon: Eye,
    title: "Transparent by design",
    description:
      "Every reasoning step is visible. See how agents vote, what they disagree on, and why a consensus was reached. Audit logs make tampering detectable.",
  },
  {
    icon: Lock,
    title: "BYOK — your data, your keys",
    description:
      "No AI spend on our side. Connect your own LLM API keys. Nothing leaves your deployment. Self-host on a single Docker Compose stack or Kubernetes.",
  },
  {
    icon: Shield,
    title: "Production-grade security",
    description:
      "Code runs in an isolated sandbox: no network access, read-only filesystem, memory-capped. JWT auth, RBAC, and HMAC-chained audit logs included.",
  },
];

const stack = [
  { name: "TypeScript 5.4", role: "End-to-end type safety across 107 packages" },
  { name: "React Router v7", role: "SPA dashboard with 100+ routes" },
  { name: "Fastify", role: "High-throughput API with SSE streaming" },
  { name: "BullMQ", role: "Distributed job queue for feed polling and tasks" },
  { name: "pgvector", role: "Embedding storage and ANN search" },
  { name: "Drizzle ORM", role: "Type-safe migrations and 7 DB schemas" },
  { name: "OpenTelemetry", role: "Traces, metrics, and audit logs" },
  { name: "Docker", role: "Sandboxed code execution and self-hosting" },
  { name: "Piston", role: "Multi-language code execution API" },
];

export default function About() {
  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative border-b border-border/40 bg-gradient-to-b from-background to-muted/20 px-6 py-24 text-center overflow-hidden">
        <DottedGrid />
        <GlowOrbs />
        <FadeIn>
          <Badge variant="secondary" className="mb-4">
            Open Source · Apache 2.0
          </Badge>
          <h1 className="font-display mx-auto max-w-3xl text-5xl font-bold tracking-tight sm:text-6xl">
            NEXUS
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-xl leading-relaxed text-muted-foreground">
            Multi-agent AI orchestration platform. From a single prompt to a self-coordinating
            swarm — with 15 LLM providers, multi-model council deliberation, sandboxed code
            execution, and long-term vector memory.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" asChild>
              <a
                href="https://github.com/Yash-Awasthi/Nexus"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GithubIcon className="mr-2 h-4 w-4" />
                View on GitHub
              </a>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <a
                href="https://github.com/Yash-Awasthi/Nexus#running-nexus"
                target="_blank"
                rel="noopener noreferrer"
              >
                Quick Start
              </a>
            </Button>
          </div>
        </FadeIn>
      </section>

      {/* Stats */}
      <section className="border-b border-border/40 bg-muted/10 px-6 py-12">
        <FadeIn>
          <div className="mx-auto max-w-5xl">
            <div className="grid grid-cols-3 gap-6 sm:grid-cols-6">
              {stats.map((s) => (
                <div key={s.label} className="text-center">
                  <div className="font-display text-3xl font-bold text-foreground">{s.value}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>
      </section>

      {/* What it does */}
      <section className="mx-auto max-w-4xl px-6 py-20">
        <FadeIn delay={0.1}>
          <div className="text-center">
            <h2 className="font-display text-3xl font-bold">What it does</h2>
            <p className="mx-auto mt-6 max-w-3xl text-lg leading-relaxed text-muted-foreground">
              NEXUS routes prompts across 15 LLM providers, runs multi-model council votes via{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono text-foreground">
                Promise.allSettled
              </code>
              , manages long-term memory in pgvector with graph-based retrieval, executes
              sandboxed code across 8 languages, ingests data from 16 global domain feeds, and
              processes documents through a full extract → classify → OCR → index pipeline. The
              Fastify API has 61 route modules. The React UI has 100+ routes all wired to real
              backends.
            </p>
          </div>
        </FadeIn>
      </section>

      {/* Features grid */}
      <section className="border-y border-border/40 bg-muted/5 px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <FadeIn>
            <h2 className="font-display mb-12 text-center text-3xl font-bold">Capabilities</h2>
          </FadeIn>
          <StaggerChildren className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" staggerDelay={0.08}>
            {features.map((f) => (
              <StaggerItem key={f.title}>
                <TiltCard className="rounded-xl h-full" tiltAmount={4}>
                  <Card className="h-full border-border/60 transition-colors hover:border-primary/40">
                    <CardHeader className="pb-3">
                      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        <f.icon className="h-5 w-5 text-primary" />
                      </div>
                      <CardTitle className="font-display text-base">{f.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-sm leading-relaxed">
                        {f.description}
                      </CardDescription>
                    </CardContent>
                  </Card>
                </TiltCard>
              </StaggerItem>
            ))}
          </StaggerChildren>
        </div>
      </section>

      {/* Principles */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <FadeIn>
            <h2 className="font-display mb-12 text-center text-3xl font-bold">Principles</h2>
          </FadeIn>
          <StaggerChildren className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4" staggerDelay={0.12}>
            {values.map((v) => (
              <StaggerItem key={v.title}>
                <TiltCard className="rounded-xl h-full" tiltAmount={5}>
                  <Card className="text-center h-full">
                    <CardHeader>
                      <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                        <v.icon className="h-6 w-6 text-primary" />
                      </div>
                      <CardTitle className="font-display text-sm">{v.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-sm leading-relaxed">
                        {v.description}
                      </CardDescription>
                    </CardContent>
                  </Card>
                </TiltCard>
              </StaggerItem>
            ))}
          </StaggerChildren>
        </div>
      </section>

      {/* Tech stack */}
      <section className="border-y border-border/40 bg-muted/10 px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <FadeIn>
            <h2 className="font-display mb-12 text-center text-3xl font-bold">Built with</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {stack.map((s) => (
                <div
                  key={s.name}
                  className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-background px-4 py-3"
                >
                  <span className="font-mono text-sm font-semibold text-foreground">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{s.role}</span>
                </div>
              ))}
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Built by */}
      <section className="mx-auto max-w-4xl px-6 py-20 text-center">
        <FadeIn>
          <h2 className="font-display text-3xl font-bold">Built by</h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            NEXUS was created by{" "}
            <a
              href="https://github.com/Yash-Awasthi"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Yash Awasthi
            </a>{" "}
            and is open to contributors. Apache 2.0 licensed — fork it, deploy it, make it yours.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Button size="lg" asChild>
              <a
                href="https://github.com/Yash-Awasthi/Nexus"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GithubIcon className="mr-2 h-4 w-4" />
                View on GitHub
              </a>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <a
                href="https://github.com/Yash-Awasthi/Nexus/graphs/contributors"
                target="_blank"
                rel="noopener noreferrer"
              >
                Contributors
              </a>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <a
                href="https://github.com/Yash-Awasthi/Nexus/issues/new"
                target="_blank"
                rel="noopener noreferrer"
              >
                Report an issue
              </a>
            </Button>
          </div>
        </FadeIn>
      </section>
    </div>
  );
}
