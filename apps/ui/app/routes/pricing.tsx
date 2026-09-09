// SPDX-License-Identifier: Apache-2.0
import type { Route } from "./+types/pricing";
import { Link } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Check } from "lucide-react";
import { FadeIn, DottedGrid, TextShimmer } from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Pricing - JUDICA" },
    {
      name: "description",
      content:
        "JUDICA (Nexus) is free and open source. Bring your own API keys — there is no paid tier and never will be.",
    },
  ];
}

const includedFeatures = [
  "Multi-agent deliberation with scored consensus",
  "5 deliberation modes (Socratic, Red/Blue, …)",
  "Knowledge bases, RAG, and topic-graph memory",
  "Visual workflow builder",
  "14 agent archetypes + custom archetypes",
  "MCP protocol support",
  "Self-hosted — your data stays yours",
];

export default function Pricing() {
  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative border-b border-border/40 bg-gradient-to-b from-background to-muted/20 px-6 py-24 text-center overflow-hidden">
        <DottedGrid />
        <FadeIn>
          <Badge variant="secondary" className="mb-4">
            Pricing
          </Badge>
          <h1 className="font-display mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            It's <TextShimmer>free</TextShimmer>. Open source, no tiers.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Nexus is open-source community software — not a subscription product. There is no paid
            tier, no billing provider, and no trial that expires.
          </p>
        </FadeIn>
      </section>

      {/* What you get */}
      <section className="mx-auto max-w-3xl px-6 py-20">
        <div className="rounded-xl border border-white/10 bg-card/80 backdrop-blur-md">
          <div className="border-b border-border/40 px-8 py-6">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-4xl font-bold">$0</span>
              <span className="text-muted-foreground">forever, self-hosted</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Run the whole platform yourself — every feature is included.
            </p>
          </div>
          <ul className="space-y-3 px-8 py-8">
            {includedFeatures.map((feature) => (
              <li key={feature} className="flex items-start gap-3">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <span className="text-sm">{feature}</span>
              </li>
            ))}
          </ul>
          <div className="px-8 pb-8">
            <Button className="w-full sm:w-auto" size="lg" asChild>
              <Link to="/register">Create your free account</Link>
            </Button>
          </div>
        </div>

        {/* BYOK model */}
        <div className="mt-8 rounded-xl border border-white/10 bg-card/80 p-8 backdrop-blur-md">
          <h2 className="font-display text-xl font-bold">Bring your own keys (BYOK)</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Model access runs on <span className="text-foreground">your own</span> provider API keys
            (OpenAI, Anthropic, Gemini, Groq, OpenRouter, local Ollama, and more), stored per-user
            and billed by the provider directly — Nexus never sits between you and an invoice. Spend
            guards on your own keys are built in; charging for Nexus is not.
          </p>
        </div>
      </section>
    </div>
  );
}
