"use client";

import type { Route } from "./+types/blog";
import { Link } from "react-router";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { ArrowRight } from "lucide-react";
import {
  FadeIn,
  StaggerChildren,
  StaggerItem,
  TiltCard,
  DottedGrid,
} from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Blog - JUDICA" },
    {
      name: "description",
      content:
        "Insights on multi-agent AI, deliberative intelligence, RAG, workflow automation, and self-hosting.",
    },
  ];
}

const posts = [
  {
    title: "Introducing JUDICA: Multi-Agent Deliberation for Everyone",
    date: "April 2026",
    category: "Announcement",
    description:
      "We're launching JUDICA -- an open-source platform that runs 4-7 AI agents simultaneously to debate, critique, and produce scored consensus you can actually verify.",
    comingSoon: false,
  },
  {
    title: "Why One AI Isn't Enough: The Case for Deliberative Intelligence",
    date: "April 2026",
    category: "Research",
    description:
      "Single-model AI gives you one perspective. Deliberative AI gives you structured debate across multiple models, reducing hallucinations and improving reliability.",
    comingSoon: false,
  },
  {
    title: "Building Custom Agent Archetypes",
    date: "March 2026",
    category: "Tutorial",
    description:
      "Learn how to design and deploy custom agent archetypes that specialize in your domain -- from legal analysis to medical research.",
    comingSoon: true,
  },
  {
    title: "RAG Done Right: HyDE, Federated Search & RRF",
    date: "March 2026",
    category: "Engineering",
    description:
      "A deep dive into hypothetical document embeddings, federated search across knowledge bases, and reciprocal rank fusion for better retrieval.",
    comingSoon: true,
  },
  {
    title: "Workflow Automation with Human-in-the-Loop Gates",
    date: "February 2026",
    category: "Product",
    description:
      "How to build AI-powered workflows that pause for human approval at critical decision points, combining automation with oversight.",
    comingSoon: true,
  },
  {
    title: "Self-Hosting JUDICA: Docker to Kubernetes",
    date: "February 2026",
    category: "DevOps",
    description:
      "A complete guide to running JUDICA on your own infrastructure -- from a single Docker container to a production Kubernetes cluster.",
    comingSoon: true,
  },
];

const categoryColors: Record<string, string> = {
  Announcement: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Research: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  Tutorial: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  Engineering: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Product: "bg-pink-500/10 text-pink-400 border-pink-500/20",
  DevOps: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
};

const categoryGlowColors: Record<string, string> = {
  Announcement: "rgba(59,130,246,0.5)",
  Research: "rgba(168,85,247,0.5)",
  Tutorial: "rgba(16,185,129,0.5)",
  Engineering: "rgba(249,115,22,0.5)",
  Product: "rgba(236,72,153,0.5)",
  DevOps: "rgba(6,182,212,0.5)",
};

export default function Blog() {
  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative border-b border-border/40 bg-gradient-to-b from-background to-muted/20 px-6 py-24 text-center overflow-hidden">
        <DottedGrid />
        <FadeIn>
          <Badge variant="secondary" className="mb-4">
            Blog
          </Badge>
          <h1 className="font-display mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            Insights & Updates
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Engineering deep dives, product updates, and research on multi-agent
            deliberation.
          </p>
        </FadeIn>
      </section>

      {/* Posts grid */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <StaggerChildren className="grid gap-6 md:grid-cols-2 lg:grid-cols-3" staggerDelay={0.1}>
          {posts.map((post) => (
            <StaggerItem key={post.title}>
              <TiltCard className="rounded-xl h-full" tiltAmount={5}>
                <Link to="#" className="group block h-full">
                  <Card className="relative flex h-full flex-col transition-colors group-hover:border-primary/30 overflow-hidden">
                    {post.comingSoon && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center backdrop-blur-sm bg-background/60 rounded-[inherit]">
                        <span className="px-4 py-2 rounded-lg border border-white/10 bg-card/80 backdrop-blur-md text-sm font-medium text-muted-foreground shadow-lg">
                          Coming Soon
                        </span>
                      </div>
                    )}
                    <CardHeader>
                      <div className="mb-2 flex items-center gap-2">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium transition-shadow duration-300 hover:shadow-[0_0_8px_var(--glow-color)] ${categoryColors[post.category] ?? ""}`}
                          style={
                            {
                              "--glow-color":
                                categoryGlowColors[post.category] ?? "transparent",
                            } as React.CSSProperties
                          }
                        >
                          {post.category}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {post.date}
                        </span>
                      </div>
                      <CardTitle className="font-display text-lg leading-snug">
                        {post.title}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1">
                      <CardDescription className="text-sm leading-relaxed">
                        {post.description}
                      </CardDescription>
                    </CardContent>
                    <div className="px-5 pb-4">
                      <span className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-all group-hover:gap-2">
                        Read more <ArrowRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                  </Card>
                </Link>
              </TiltCard>
            </StaggerItem>
          ))}
        </StaggerChildren>
      </section>
    </div>
  );
}
