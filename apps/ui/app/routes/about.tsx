// SPDX-License-Identifier: Apache-2.0
"use client";

import type { Route } from "./+types/about";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Code2, Eye, Shield } from "lucide-react";

const GithubIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);
import {
  FadeIn,
  StaggerChildren,
  StaggerItem,
  TiltCard,
  DottedGrid,
  GlowOrbs,
} from "~/components/animations";

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

const values = [
  {
    icon: Code2,
    title: "Open Source",
    description:
      "Apache 2.0 licensed. Every line of code is public. Fork it, extend it, make it yours.",
  },
  {
    icon: Eye,
    title: "Transparent by design",
    description:
      "Every reasoning step is visible. See how agents vote, what they disagree on, and why a consensus was reached. HMAC-chained audit logs make tampering detectable.",
  },
  {
    icon: Shield,
    title: "Self-hosted",
    description:
      "Runs on a single Docker Compose stack or Kubernetes. SSO, RBAC, and audit logs included. No cloud dependency.",
  },
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
            About
          </Badge>
          <h1 className="font-display mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            NEXUS
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            A TypeScript monorepo for running multi-agent AI workflows. 107 packages, 15 LLM
            providers, multi-model council deliberation, pgvector memory, sandboxed code execution,
            and a React dashboard wired to all of it.
          </p>
        </FadeIn>
      </section>

      {/* What it is */}
      <section className="mx-auto max-w-4xl px-6 py-20">
        <FadeIn delay={0.2}>
          <div className="text-center">
            <h2 className="font-display text-3xl font-bold">What it does</h2>
            <p className="mx-auto mt-6 max-w-3xl text-lg leading-relaxed text-muted-foreground">
              NEXUS routes prompts across 15 LLM providers, runs multi-model council votes via{" "}
              <code className="text-sm font-mono text-foreground">Promise.allSettled</code>, manages
              long-term memory in pgvector with graph-based retrieval, executes sandboxed code in
              Docker containers, ingests data from 16 domain feeds, and processes documents through
              a full extract → classify → OCR → index pipeline. The Fastify API has 61 route
              modules. The React UI has 100+ routes all wired to real backends.
            </p>
          </div>
        </FadeIn>
      </section>

      {/* Values */}
      <section className="border-y border-border/40 bg-muted/10 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <FadeIn>
            <h2 className="font-display mb-12 text-center text-3xl font-bold">Principles</h2>
          </FadeIn>
          <StaggerChildren className="grid gap-6 md:grid-cols-3" staggerDelay={0.15}>
            {values.map((value) => (
              <StaggerItem key={value.title}>
                <TiltCard className="rounded-xl h-full" tiltAmount={5}>
                  <Card className="text-center h-full">
                    <CardHeader>
                      <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                        <value.icon className="h-6 w-6 text-primary" />
                      </div>
                      <CardTitle className="font-display">{value.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-sm leading-relaxed">
                        {value.description}
                      </CardDescription>
                    </CardContent>
                  </Card>
                </TiltCard>
              </StaggerItem>
            ))}
          </StaggerChildren>
        </div>
      </section>

      {/* Built by */}
      <section className="mx-auto max-w-4xl px-6 py-20 text-center">
        <FadeIn>
          <h2 className="font-display text-3xl font-bold">Built by</h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            NEXUS was created by <span className="font-medium text-foreground">Yash Awasthi</span>{" "}
            and is open to contributors. Apache 2.0 licensed.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Button variant="outline" size="lg" asChild>
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
                See Contributors
              </a>
            </Button>
          </div>
        </FadeIn>
      </section>
    </div>
  );
}
