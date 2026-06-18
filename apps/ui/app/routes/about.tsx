"use client";

import type { Route } from "./+types/about";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Code2, Eye, Shield } from "lucide-react";

const GithubIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
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
    { title: "About - JUDICA" },
    {
      name: "description",
      content:
        "JUDICA exists because single-model AI isn't good enough. Learn about our mission, values, and the team building the future of AI reasoning.",
    },
  ];
}

const values = [
  {
    icon: Code2,
    title: "Open Source",
    description:
      "MIT licensed and community-driven. Every line of code is public. Fork it, extend it, make it yours.",
  },
  {
    icon: Eye,
    title: "Transparency",
    description:
      "Every reasoning step is visible and verifiable. See how agents debate, what they disagree on, and why the consensus was reached.",
  },
  {
    icon: Shield,
    title: "Enterprise Ready",
    description:
      "SSO, RBAC, compliance controls, audit logs, and self-hosted deployment. Built for organizations that can't compromise on security.",
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
            Building the future of AI reasoning
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            JUDICA exists because single-model AI isn't good enough. When the
            stakes are high, you need multiple perspectives, structured debate, and
            verified consensus.
          </p>
        </FadeIn>
      </section>

      {/* Mission */}
      <section className="mx-auto max-w-4xl px-6 py-20">
        <FadeIn delay={0.2}>
          <div className="text-center">
            <h2 className="font-display text-3xl font-bold">Our Mission</h2>
            <p className="mx-auto mt-6 max-w-3xl text-lg leading-relaxed text-muted-foreground">
              Today's AI gives you one model's best guess. That's not good enough
              for decisions that matter -- legal analysis, medical research,
              financial planning, engineering design. JUDICA runs 4-7 AI agents
              simultaneously that debate, critique each other, and produce a scored
              consensus you can actually verify. We believe the future of AI isn't
              a single, more powerful model. It's structured deliberation across
              multiple perspectives.
            </p>
          </div>
        </FadeIn>
      </section>

      {/* Values */}
      <section className="border-y border-border/40 bg-muted/10 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <FadeIn>
            <h2 className="font-display mb-12 text-center text-3xl font-bold">
              Our Values
            </h2>
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

      {/* Team */}
      <section className="mx-auto max-w-4xl px-6 py-20 text-center">
        <FadeIn>
          <h2 className="font-display text-3xl font-bold">
            Built by the community
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            JUDICA was created by{" "}
            <span className="font-medium text-foreground">Yash Awasthi</span> and
            is built in the open by contributors around the world. We believe the
            best AI tools are shaped by the people who use them.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Button variant="outline" size="lg" asChild>
              <a
                href="https://github.com/Nexus"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GithubIcon className="mr-2 h-4 w-4" />
                View on GitHub
              </a>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <a
                href="https://github.com/Nexus/graphs/contributors"
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
