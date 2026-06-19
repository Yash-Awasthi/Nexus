// SPDX-License-Identifier: Apache-2.0
"use client";

import type { Route } from "./+types/careers";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { MessageSquare, Code2, Palette, Brain, Server, FileText, ArrowRight } from "lucide-react";

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
  MagneticButton,
  DottedGrid,
  GlowOrbs,
} from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Careers & Contributing - JUDICA" },
    {
      name: "description",
      content:
        "Help build the future of AI deliberation. JUDICA is open source -- contribute as a developer, designer, researcher, or writer.",
    },
  ];
}

const roles = [
  {
    icon: Code2,
    title: "Core Engine",
    tech: "Rust / TypeScript",
    description:
      "Work on the deliberation engine, agent orchestration, consensus algorithms, and the core runtime that powers multi-agent reasoning.",
  },
  {
    icon: Palette,
    title: "Frontend",
    tech: "React / Tailwind",
    description:
      "Build the UI for agent councils, workflow builders, knowledge base management, and the real-time deliberation viewer.",
  },
  {
    icon: Brain,
    title: "AI Research",
    tech: "Agent Design / Deliberation Theory",
    description:
      "Design new agent archetypes, improve deliberation modes, research consensus mechanisms, and push the boundaries of multi-agent AI.",
  },
  {
    icon: Server,
    title: "DevOps",
    tech: "Kubernetes / Observability",
    description:
      "Build and maintain deployment infrastructure, CI/CD pipelines, monitoring, and tooling for self-hosted and cloud deployments.",
  },
  {
    icon: FileText,
    title: "Documentation",
    tech: "Technical Writing",
    description:
      "Write guides, API docs, tutorials, and architecture documentation. Help users and contributors understand and adopt JUDICA.",
  },
];

export default function Careers() {
  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative border-b border-border/40 bg-gradient-to-b from-background to-muted/20 px-6 py-24 text-center overflow-hidden">
        <DottedGrid />
        <FadeIn>
          <Badge variant="secondary" className="mb-4">
            Contribute
          </Badge>
          <h1 className="font-display mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            Help build the future of AI deliberation
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            JUDICA is open source. Whether you're a developer, designer, or AI researcher, there's a
            place for you.
          </p>
        </FadeIn>
      </section>

      {/* Roles */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <FadeIn>
          <h2 className="font-display mb-2 text-center text-3xl font-bold">
            Open Contribution Areas
          </h2>
          <p className="mb-12 text-center text-muted-foreground">
            Pick an area that matches your skills and interests.
          </p>
        </FadeIn>

        <StaggerChildren className="grid gap-6 md:grid-cols-2 lg:grid-cols-3" staggerDelay={0.1}>
          {roles.map((role) => (
            <StaggerItem key={role.title}>
              <TiltCard className="rounded-xl h-full" tiltAmount={5}>
                <Card className="flex flex-col h-full">
                  <CardHeader>
                    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <role.icon className="h-5 w-5 text-primary" />
                    </div>
                    <CardTitle className="font-display">{role.title}</CardTitle>
                    <Badge variant="secondary" className="w-fit">
                      {role.tech}
                    </Badge>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <CardDescription className="text-sm leading-relaxed">
                      {role.description}
                    </CardDescription>
                  </CardContent>
                  <div className="px-5 pb-4">
                    <MagneticButton className="w-full">
                      <Button variant="outline" size="sm" className="w-full" asChild>
                        <a
                          href="https://github.com/Nexus"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <GithubIcon className="mr-2 h-3.5 w-3.5" />
                          Apply on GitHub
                          <ArrowRight className="ml-2 h-3.5 w-3.5" />
                        </a>
                      </Button>
                    </MagneticButton>
                  </div>
                </Card>
              </TiltCard>
            </StaggerItem>
          ))}
        </StaggerChildren>
      </section>

      {/* Discord CTA */}
      <section className="relative border-t border-border/40 bg-muted/10 px-6 py-20 text-center overflow-hidden">
        <GlowOrbs />
        <FadeIn>
          <div className="relative mx-auto max-w-2xl">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <MessageSquare className="h-7 w-7 text-primary" />
            </div>
            <h2 className="font-display text-3xl font-bold">Join our Discord community</h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Connect with other contributors, ask questions, share ideas, and stay up to date on
              development progress.
            </p>
            <MagneticButton className="mt-8">
              <Button size="lg" asChild>
                <a href="https://discord.gg/Nexus" target="_blank" rel="noopener noreferrer">
                  <MessageSquare className="mr-2 h-4 w-4" />
                  Join Discord
                </a>
              </Button>
            </MagneticButton>
          </div>
        </FadeIn>
      </section>
    </div>
  );
}
