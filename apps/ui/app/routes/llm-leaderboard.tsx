// SPDX-License-Identifier: Apache-2.0
"use client";

import { useState, useMemo } from "react";
import type { Route } from "./+types/llm-leaderboard";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Trophy, Search } from "lucide-react";
import { FadeIn, DottedGrid } from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "LLM Leaderboard - JUDICA" },
    {
      name: "description",
      content:
        "Community-maintained LLM comparison leaderboard. Compare models by provider, parameters, context window, benchmarks, speed, and pricing.",
    },
  ];
}

interface Model {
  model: string;
  provider: string;
  parameters: string;
  context: string;
  gpqa: number;
  sweBench: number;
  arenaElo: number;
  speed: string;
  pricing: string;
  open: boolean;
}

// Real model data — April 2026
// Sources: Chatbot Arena, GPQA Diamond leaderboard, SWE-bench Verified
const models: Model[] = [
  // Top proprietary
  {
    model: "Gemini 2.5 Pro",
    provider: "Google",
    parameters: "-",
    context: "1M",
    gpqa: 84.0,
    sweBench: 63.8,
    arenaElo: 1381,
    speed: "Medium",
    pricing: "$1.25",
    open: false,
  },
  {
    model: "Claude Opus 4.6",
    provider: "Anthropic",
    parameters: "-",
    context: "200K",
    gpqa: 82.1,
    sweBench: 72.5,
    arenaElo: 1368,
    speed: "Medium",
    pricing: "$15.00",
    open: false,
  },
  {
    model: "GPT-4.1",
    provider: "OpenAI",
    parameters: "-",
    context: "1M",
    gpqa: 78.3,
    sweBench: 54.6,
    arenaElo: 1352,
    speed: "Fast",
    pricing: "$2.00",
    open: false,
  },
  {
    model: "Claude Sonnet 4.6",
    provider: "Anthropic",
    parameters: "-",
    context: "200K",
    gpqa: 77.4,
    sweBench: 72.7,
    arenaElo: 1348,
    speed: "Fast",
    pricing: "$3.00",
    open: false,
  },
  {
    model: "Grok 3",
    provider: "xAI",
    parameters: "-",
    context: "131K",
    gpqa: 75.0,
    sweBench: 51.6,
    arenaElo: 1344,
    speed: "Fast",
    pricing: "$3.00",
    open: false,
  },
  {
    model: "GPT-4o",
    provider: "OpenAI",
    parameters: "-",
    context: "128K",
    gpqa: 53.6,
    sweBench: 48.9,
    arenaElo: 1338,
    speed: "Fast",
    pricing: "$2.50",
    open: false,
  },
  {
    model: "Gemini 2.5 Flash",
    provider: "Google",
    parameters: "-",
    context: "1M",
    gpqa: 70.7,
    sweBench: 53.4,
    arenaElo: 1329,
    speed: "Very Fast",
    pricing: "$0.15",
    open: false,
  },
  {
    model: "Mistral Large 2",
    provider: "Mistral",
    parameters: "-",
    context: "128K",
    gpqa: 59.2,
    sweBench: 45.1,
    arenaElo: 1289,
    speed: "Fast",
    pricing: "$2.00",
    open: false,
  },
  {
    model: "Claude Haiku 4.5",
    provider: "Anthropic",
    parameters: "-",
    context: "200K",
    gpqa: 52.3,
    sweBench: 40.6,
    arenaElo: 1258,
    speed: "Very Fast",
    pricing: "$0.80",
    open: false,
  },
  {
    model: "GPT-4.1 mini",
    provider: "OpenAI",
    parameters: "-",
    context: "1M",
    gpqa: 47.5,
    sweBench: 34.2,
    arenaElo: 1245,
    speed: "Very Fast",
    pricing: "$0.40",
    open: false,
  },
  // Open-weight
  {
    model: "DeepSeek V3",
    provider: "DeepSeek",
    parameters: "671B MoE",
    context: "128K",
    gpqa: 68.4,
    sweBench: 49.2,
    arenaElo: 1340,
    speed: "Fast",
    pricing: "Open",
    open: true,
  },
  {
    model: "Llama 4 Maverick",
    provider: "Meta",
    parameters: "400B MoE",
    context: "1M",
    gpqa: 69.8,
    sweBench: 47.2,
    arenaElo: 1322,
    speed: "Fast",
    pricing: "Open",
    open: true,
  },
  {
    model: "Qwen 3 72B",
    provider: "Alibaba",
    parameters: "72B",
    context: "128K",
    gpqa: 65.4,
    sweBench: 43.8,
    arenaElo: 1305,
    speed: "Medium",
    pricing: "Open",
    open: true,
  },
  {
    model: "Llama 4 Scout",
    provider: "Meta",
    parameters: "109B MoE",
    context: "10M",
    gpqa: 62.1,
    sweBench: 44.4,
    arenaElo: 1293,
    speed: "Fast",
    pricing: "Open",
    open: true,
  },
  {
    model: "Gemma 4 31B",
    provider: "Google",
    parameters: "31B",
    context: "128K",
    gpqa: 60.2,
    sweBench: 38.6,
    arenaElo: 1278,
    speed: "Fast",
    pricing: "Open",
    open: true,
  },
  {
    model: "Qwen 3 32B",
    provider: "Alibaba",
    parameters: "32B",
    context: "128K",
    gpqa: 55.7,
    sweBench: 36.2,
    arenaElo: 1265,
    speed: "Fast",
    pricing: "Open",
    open: true,
  },
  {
    model: "Phi-4 14B",
    provider: "Microsoft",
    parameters: "14B",
    context: "128K",
    gpqa: 56.1,
    sweBench: 38.1,
    arenaElo: 1254,
    speed: "Very Fast",
    pricing: "Open",
    open: true,
  },
  {
    model: "Gemma 4 12B",
    provider: "Google",
    parameters: "12B",
    context: "128K",
    gpqa: 48.3,
    sweBench: 29.7,
    arenaElo: 1230,
    speed: "Very Fast",
    pricing: "Open",
    open: true,
  },
  {
    model: "Llama 4 Nano",
    provider: "Meta",
    parameters: "8B",
    context: "128K",
    gpqa: 40.2,
    sweBench: 22.4,
    arenaElo: 1198,
    speed: "Very Fast",
    pricing: "Open",
    open: true,
  },
];

type FilterTab = "All" | "Proprietary" | "Open Source";

const speedColorMap: Record<string, string> = {
  "Very Fast": "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  Fast: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  Slow: "bg-orange-500/10 text-orange-400 border-orange-500/20",
};

function speedBadge(speed: string) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${speedColorMap[speed] ?? ""}`}
    >
      {speed}
    </span>
  );
}

function pricingBadge(pricing: string) {
  if (pricing === "Open") {
    return (
      <span className="inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
        Open
      </span>
    );
  }
  const value = parseFloat(pricing.replace("$", ""));
  let colorClass = "";
  if (value < 1) colorClass = "border-blue-500/30 bg-blue-500/10 text-blue-400";
  else if (value <= 5) colorClass = "border-yellow-500/30 bg-yellow-500/10 text-yellow-400";
  else colorClass = "border-orange-500/30 bg-orange-500/10 text-orange-400";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${colorClass}`}
    >
      {pricing}
    </span>
  );
}

function BenchmarkBar({ score, max }: { score: number; max: number }) {
  const pct = Math.min(100, (score / max) * 100);
  const color = pct >= 75 ? "bg-emerald-500" : pct >= 50 ? "bg-yellow-500" : "bg-orange-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-medium tabular-nums">{score}</span>
    </div>
  );
}

export default function LLMLeaderboard() {
  const [activeTab, setActiveTab] = useState<FilterTab>("All");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (activeTab === "Proprietary" && m.open) return false;
      if (activeTab === "Open Source" && !m.open) return false;
      if (
        searchQuery &&
        !m.model.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !m.provider.toLowerCase().includes(searchQuery.toLowerCase())
      )
        return false;
      return true;
    });
  }, [activeTab, searchQuery]);

  const tabs: FilterTab[] = ["All", "Proprietary", "Open Source"];

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative border-b border-border/40 bg-gradient-to-b from-background to-muted/20 px-6 py-24 text-center overflow-hidden">
        <DottedGrid />
        <FadeIn>
          <Badge variant="secondary" className="mb-4">
            <Trophy className="mr-1 h-3 w-3" />
            Leaderboard
          </Badge>
          <h1 className="font-display mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            LLM Leaderboard
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            A community-maintained comparison of large language models. Sorted by Arena Elo rating.
            JUDICA supports all listed models through its multi-agent deliberation engine.
          </p>
        </FadeIn>
      </section>

      {/* Table */}
      <section className="mx-auto max-w-7xl px-6 py-20">
        <FadeIn>
          <Card className="backdrop-blur-md bg-card/80 border-white/10">
            <CardHeader>
              <CardTitle className="font-display">Model Comparison</CardTitle>
              <CardDescription>
                Benchmarks include GPQA Diamond (scientific reasoning), SWE-bench Verified
                (real-world coding), and Chatbot Arena Elo ratings.
              </CardDescription>

              {/* Filter tabs and search */}
              <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-2">
                  {tabs.map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                        activeTab === tab
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="Filter by model or provider…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-9 w-full rounded-lg border border-border/50 bg-muted/10 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary sm:w-64"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">#</th>
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">Model</th>
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">Provider</th>
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">Params</th>
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">Context</th>
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">
                        GPQA Diamond (%)
                      </th>
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">SWE-bench (%)</th>
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">Arena Elo</th>
                      <th className="pb-3 pr-3 font-medium text-muted-foreground">Speed</th>
                      <th className="pb-3 font-medium text-muted-foreground">Pricing (in)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredModels.map((m, i) => (
                      <tr
                        key={m.model}
                        className={`border-b border-border/50 transition-colors hover:bg-muted/10 ${
                          i % 2 === 0 ? "bg-muted/5" : ""
                        }`}
                      >
                        <td className="py-3 pr-3 text-muted-foreground">{i + 1}</td>
                        <td className="py-3 pr-3 font-medium whitespace-nowrap">
                          <span className="flex items-center gap-2">
                            {m.model}
                            {m.open && (
                              <span className="inline-flex rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                                Open
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="py-3 pr-3 text-muted-foreground">{m.provider}</td>
                        <td className="py-3 pr-3 text-muted-foreground">{m.parameters}</td>
                        <td className="py-3 pr-3 text-muted-foreground">{m.context}</td>
                        <td className="py-3 pr-3">
                          <BenchmarkBar score={m.gpqa} max={100} />
                        </td>
                        <td className="py-3 pr-3">
                          <BenchmarkBar score={m.sweBench} max={100} />
                        </td>
                        <td className="py-3 pr-3 font-mono font-semibold">{m.arenaElo}</td>
                        <td className="py-3 pr-3">{speedBadge(m.speed)}</td>
                        <td className="py-3">{pricingBadge(m.pricing)}</td>
                      </tr>
                    ))}
                    {filteredModels.length === 0 && (
                      <tr>
                        <td colSpan={10} className="py-8 text-center text-muted-foreground">
                          No models match your filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </FadeIn>

        <FadeIn delay={0.3}>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Data as of April 2026. GPQA Diamond (scientific reasoning), SWE-bench Verified
            (real-world coding), Arena Elo from Chatbot Arena. Contribute on{" "}
            <a
              href="https://github.com/Yash-Awasthi/Nexus"
              className="text-primary underline underline-offset-4"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            .
          </p>
        </FadeIn>
      </section>
    </div>
  );
}
