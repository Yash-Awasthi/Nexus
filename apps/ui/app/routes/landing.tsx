// SPDX-License-Identifier: Apache-2.0
"use client";

import type { Route } from "./+types/landing";
import { Link } from "react-router";
import { useEffect, useRef, Component, type ReactNode } from "react";

class SplineErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Users,
  Search,
  Workflow,
  ArrowRight,
  Plug,
  MessageSquare,
  Code2,
  Shield,
  Brain,
  Check,
  X,
  Sparkles,
} from "lucide-react";

const GithubIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);
import { SplineScene } from "~/components/ui/splite";
import { Spotlight } from "~/components/ui/spotlight";
import {
  DottedGrid,
  GlowOrbs,
  TextShimmer,
  Typewriter,
  FadeIn,
  StaggerChildren,
  StaggerItem,
  TiltCard,
  MagneticButton,
  AnimatedCounter,
  AnimatedIcon,
} from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "JUDICA - Multi-Agent Deliberative AI Platform" },
    {
      name: "description",
      content:
        "Instead of trusting one model's best guess, JUDICA runs a council of AI agents that argue, critique each other, and produce a scored consensus you can actually verify.",
    },
    {
      property: "og:title",
      content: "JUDICA - Don't trust one AI. Make them debate.",
    },
    {
      property: "og:description",
      content:
        "Open-source multi-agent AI platform. 4-7 agents deliberate, critique, and produce scored consensus.",
    },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
    {
      name: "twitter:title",
      content: "JUDICA - Multi-Agent Deliberative AI Platform",
    },
    {
      name: "twitter:description",
      content: "Don't trust one AI. Make them debate. Open-source multi-agent deliberation.",
    },
  ];
}

const comparisonRows = [
  { label: "Perspectives", single: "1 model", council: "4-7 agents" },
  { label: "Quality Check", single: "None", council: "Peer review" },
  { label: "Confidence", single: "Hallucinated", council: "Empirically scored" },
  { label: "Contradictions", single: "Hidden", council: "Detected & resolved" },
  { label: "Memory", single: "Stateless", council: "Topic graph with decay" },
  { label: "Provider Lock-in", single: "Complete", council: "19+ providers" },
  { label: "Cost", single: "Hidden", council: "Per-query breakdown" },
];

const platformFeatures = [
  {
    icon: Users,
    title: "Multi-Agent Deliberation",
    description:
      "14 agent archetypes engage in structured peer review, conflict detection, and cold validation to produce consensus you can trust.",
    animation: "float" as const,
  },
  {
    icon: Brain,
    title: "Knowledge That Remembers",
    description:
      "Topic graphs with vector similarity search, 14-day temporal decay, and contradiction tracking. Your AI actually builds understanding over time.",
    animation: "glow" as const,
  },
  {
    icon: Workflow,
    title: "Build and Automate",
    description:
      "Visual workflow builder with 12 node types, conditional branching, human-in-the-loop gates, and deep research mode.",
    animation: "pulse" as const,
  },
];

const featureGrid = [
  {
    icon: Plug,
    title: "19 LLM Providers",
    description:
      "OpenAI, Anthropic, Gemini, Groq, Ollama, Mistral, and more with circuit breaker protection.",
    animation: "bounce" as const,
  },
  {
    icon: Search,
    title: "51 Data Connectors",
    description:
      "Notion, Slack, GitHub, Confluence, Jira, Google Drive, Salesforce, Dropbox, and 43 more sources.",
    animation: "float" as const,
  },
  {
    icon: MessageSquare,
    title: "5 Deliberation Modes",
    description: "Standard, Socratic, Red/Blue, Hypothesis, Confidence-weighted.",
    animation: "pulse" as const,
  },
  {
    icon: Code2,
    title: "Advanced RAG",
    description:
      "HyDE query expansion, federated search, parent-child chunking, RRF reranking, and contradiction tracking.",
    animation: "spin" as const,
  },
  {
    icon: Brain,
    title: "Evaluation Framework",
    description:
      "Local runner, Braintrust integration, and RAGBench scoring to measure and improve output quality.",
    animation: "glow" as const,
  },
  {
    icon: Shield,
    title: "Enterprise Ready",
    description: "SSO, SCIM, RBAC, audit logs, Stripe billing, org isolation.",
    animation: "bounce" as const,
  },
];

const stats = [
  { value: 19, suffix: "+", label: "LLM Providers" },
  { value: 51, suffix: "", label: "Data Connectors" },
  { value: 14, suffix: "", label: "Agent Archetypes" },
  { value: 5, suffix: "", label: "Deliberation Modes" },
];

/* ------------------------------------------------------------------ */
/*  Orbiting Agents Graphic                                            */
/* ------------------------------------------------------------------ */
function OrbitingAgents() {
  const agents = Array.from({ length: 8 });
  return (
    <div className="relative mx-auto mt-16 h-[220px] w-[220px] sm:h-[280px] sm:w-[280px]">
      <style>
        {`
          @keyframes orbitSpin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
          @keyframes orbitCounterSpin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(-360deg); }
          }
          @keyframes corePulse {
            0%, 100% { transform: scale(1); opacity: 0.7; }
            50%      { transform: scale(1.15); opacity: 1; }
          }
          @keyframes connectionPulse {
            0%, 100% { opacity: 0.15; }
            50%      { opacity: 0.35; }
          }
        `}
      </style>

      {/* Central core */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div
          className="h-4 w-4 rounded-full bg-gradient-to-br from-blue-400 to-violet-500"
          style={{ animation: "corePulse 3s ease-in-out infinite" }}
        />
      </div>

      {/* Orbit ring 1 */}
      <div
        className="absolute inset-[25%] rounded-full border border-white/[0.06]"
        style={{ animation: "orbitSpin 20s linear infinite" }}
      >
        {agents.slice(0, 4).map((_, i) => {
          const angle = (i / 4) * 360;
          return (
            <div
              key={`inner-${i}`}
              className="absolute left-1/2 top-1/2"
              style={{
                transform: `rotate(${angle}deg) translateX(100%) rotate(-${angle}deg)`,
              }}
            >
              <div
                className="h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-400/80 shadow-[0_0_8px_rgba(96,165,250,0.5)]"
                style={{ animation: "orbitCounterSpin 20s linear infinite" }}
              />
            </div>
          );
        })}
      </div>

      {/* Orbit ring 2 */}
      <div
        className="absolute inset-[8%] rounded-full border border-white/[0.04]"
        style={{ animation: "orbitSpin 35s linear infinite reverse" }}
      >
        {agents.slice(4).map((_, i) => {
          const angle = (i / 4) * 360 + 45;
          return (
            <div
              key={`outer-${i}`}
              className="absolute left-1/2 top-1/2"
              style={{
                transform: `rotate(${angle}deg) translateX(100%) rotate(-${angle}deg)`,
              }}
            >
              <div
                className="h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-400/70 shadow-[0_0_6px_rgba(167,139,250,0.4)]"
                style={{ animation: "orbitCounterSpin 35s linear infinite reverse" }}
              />
            </div>
          );
        })}
      </div>

      {/* Connection lines (decorative) */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 280 280">
        <line
          x1="140"
          y1="140"
          x2="70"
          y2="70"
          stroke="url(#connGrad)"
          strokeWidth="0.5"
          style={{ animation: "connectionPulse 4s ease-in-out infinite" }}
        />
        <line
          x1="140"
          y1="140"
          x2="210"
          y2="90"
          stroke="url(#connGrad)"
          strokeWidth="0.5"
          style={{ animation: "connectionPulse 4s ease-in-out infinite 1s" }}
        />
        <line
          x1="140"
          y1="140"
          x2="80"
          y2="200"
          stroke="url(#connGrad)"
          strokeWidth="0.5"
          style={{ animation: "connectionPulse 4s ease-in-out infinite 2s" }}
        />
        <line
          x1="140"
          y1="140"
          x2="220"
          y2="190"
          stroke="url(#connGrad)"
          strokeWidth="0.5"
          style={{ animation: "connectionPulse 4s ease-in-out infinite 0.5s" }}
        />
        <defs>
          <linearGradient id="connGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(96,165,250,0.4)" />
            <stop offset="100%" stopColor="rgba(167,139,250,0.4)" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */
export default function Home() {
  const splineContainerRef = useRef<HTMLDivElement>(null);
  const heroSectionRef = useRef<HTMLElement>(null);

  // Forward pointer events to Spline canvas scoped to hero section only
  useEffect(() => {
    function forwardToCanvas(e: PointerEvent) {
      if (!splineContainerRef.current || !heroSectionRef.current) return;
      const heroRect = heroSectionRef.current.getBoundingClientRect();
      if (e.clientY > heroRect.bottom) return;
      const canvas = splineContainerRef.current.querySelector("canvas");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const over =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (over) return;
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: false,
          cancelable: true,
          clientX: e.clientX,
          clientY: e.clientY,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    }
    window.addEventListener("pointermove", forwardToCanvas);
    return () => window.removeEventListener("pointermove", forwardToCanvas);
  }, []);

  return (
    <div className="relative">
      {/* ============================================================ */}
      {/*  HERO — Spline full background, text overlaid on left        */}
      {/* ============================================================ */}
      {/* No card box — Spline fills the section edge-to-edge, no visible boundary */}
      <section ref={heroSectionRef} className="relative h-[620px] sm:h-[680px] overflow-hidden">
        <DottedGrid className="-z-20 opacity-30" />

        {/* Spline as full-bleed section background */}
        <div ref={splineContainerRef} className="absolute inset-0">
          <SplineErrorBoundary fallback={<OrbitingAgents />}>
            <SplineScene
              scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode"
              className="w-full h-full"
            />
          </SplineErrorBoundary>
        </div>

        <Spotlight className="-top-40 left-0 md:left-60 md:-top-20" fill="white" />

        {/* Gradient: readable text on left, robot visible on right */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/20 to-transparent pointer-events-none" />

        {/* Text — pointer-events-none wrapper, only buttons clickable */}
        <div className="absolute inset-0 flex items-center pointer-events-none">
          <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
            <div className="w-full max-w-[52%] sm:max-w-[48%]">
              <FadeIn direction="down" delay={0.05}>
                <Badge
                  variant="outline"
                  className="mb-5 w-fit px-3 py-1 text-xs font-medium border-white/10 bg-white/[0.03] backdrop-blur-sm"
                >
                  Open-source multi-agent AI platform
                </Badge>
              </FadeIn>

              <FadeIn delay={0.15}>
                <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl text-white leading-tight">
                  Don't trust one AI.
                  <br />
                  <TextShimmer className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
                    Make them debate.
                  </TextShimmer>
                </h1>
              </FadeIn>

              <FadeIn delay={0.28}>
                <p className="mt-4 text-sm text-neutral-400 sm:text-base leading-relaxed">
                  Instead of trusting one model's best guess, JUDICA runs a council of AI agents
                  that argue, critique each other, and produce a scored consensus you can actually
                  verify.
                </p>
              </FadeIn>

              <FadeIn delay={0.38}>
                <div className="mt-3 h-6 flex items-center">
                  <span className="text-sm text-neutral-500 mr-1.5">→</span>
                  <Typewriter
                    texts={[
                      "Multi-agent deliberation",
                      "Scored consensus",
                      "Verified reasoning",
                      "14 agent archetypes",
                      "19 LLM providers",
                    ]}
                    speed={45}
                    delay={2200}
                    className="text-sm font-medium bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent"
                  />
                </div>
              </FadeIn>

              <FadeIn delay={0.5}>
                <div className="mt-7 flex flex-wrap gap-2.5 pointer-events-auto">
                  <MagneticButton>
                    <Button size="sm" asChild className="h-9 px-4">
                      <Link to="/chat">
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        Try Demo
                      </Link>
                    </Button>
                  </MagneticButton>
                  <MagneticButton>
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="h-9 px-4 border-white/20 text-white hover:bg-white/10"
                    >
                      <Link to="/register">
                        Try for Free
                        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </MagneticButton>
                  <MagneticButton>
                    <Button
                      variant="ghost"
                      size="sm"
                      asChild
                      className="h-9 px-4 text-neutral-400 hover:text-white"
                    >
                      <a
                        href="https://github.com/Yash-Awasthi/Nexus"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <GithubIcon className="mr-1.5 h-3.5 w-3.5" />
                        GitHub
                      </a>
                    </Button>
                  </MagneticButton>
                </div>
              </FadeIn>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  PROBLEM / COMPARISON                                        */}
      {/* ============================================================ */}
      <section className="py-20 sm:py-28 border-t border-border/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <FadeIn>
            <div className="text-center mb-12">
              <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                The problem with single-model AI
              </h2>
            </div>
          </FadeIn>

          <FadeIn delay={0.15}>
            <div className="mx-auto max-w-3xl">
              <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30 backdrop-blur-sm">
                {/* Table header */}
                <div className="grid grid-cols-3 bg-muted/50 border-b border-border">
                  <div className="px-4 py-3 text-xs font-medium text-muted-foreground" />
                  <div className="px-4 py-3 text-xs font-medium text-muted-foreground text-center">
                    Single Model
                  </div>
                  <div className="px-4 py-3 text-xs font-medium text-center relative">
                    {/* Subtle glow behind JUDICA column header */}
                    <span className="relative z-10 bg-gradient-to-r from-blue-500 to-violet-500 bg-clip-text text-transparent font-semibold">
                      JUDICA Council
                    </span>
                  </div>
                </div>

                {/* Table rows — staggered */}
                <StaggerChildren staggerDelay={0.06}>
                  {comparisonRows.map((row, i) => (
                    <StaggerItem key={row.label}>
                      <div
                        className={`grid grid-cols-3 ${
                          i < comparisonRows.length - 1 ? "border-b border-border/40" : ""
                        }`}
                      >
                        <div className="px-4 py-3 text-sm font-medium">{row.label}</div>
                        <div className="px-4 py-3 text-sm text-muted-foreground text-center flex items-center justify-center gap-1.5">
                          <X className="h-3.5 w-3.5 text-red-400 shrink-0" />
                          {row.single}
                        </div>
                        <div className="px-4 py-3 text-sm text-center flex items-center justify-center gap-1.5 bg-blue-500/[0.03]">
                          <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                          {row.council}
                        </div>
                      </div>
                    </StaggerItem>
                  ))}
                </StaggerChildren>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  PLATFORM — 3 BIG CARDS                                      */}
      {/* ============================================================ */}
      <section className="py-20 sm:py-28 border-t border-border/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <FadeIn>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                Not just a chat interface
              </h2>
              <p className="mt-3 text-muted-foreground text-base sm:text-lg max-w-2xl mx-auto">
                A full deliberation engine with real features you can use today.
              </p>
            </div>
          </FadeIn>

          <StaggerChildren className="grid grid-cols-1 md:grid-cols-3 gap-6" staggerDelay={0.12}>
            {platformFeatures.map((feature) => (
              <StaggerItem key={feature.title}>
                <TiltCard className="h-full rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm transition-all duration-300 hover:border-blue-500/20 hover:bg-card/70">
                  <Card className="border-0 bg-transparent shadow-none h-full">
                    <CardHeader>
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mb-2">
                        <AnimatedIcon
                          icon={feature.icon}
                          animation={feature.animation}
                          size={20}
                          className="text-primary"
                        />
                      </div>
                      <CardTitle className="text-base font-semibold">{feature.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {feature.description}
                      </p>
                    </CardContent>
                  </Card>
                </TiltCard>
              </StaggerItem>
            ))}
          </StaggerChildren>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  FEATURES GRID — 6 CARDS                                     */}
      {/* ============================================================ */}
      <section className="py-20 sm:py-28 border-t border-border/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <FadeIn>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                Everything you need
              </h2>
            </div>
          </FadeIn>

          <StaggerChildren
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6"
            staggerDelay={0.08}
          >
            {featureGrid.map((feature) => (
              <StaggerItem key={feature.title}>
                <FadeIn>
                  <Card className="border-white/10 bg-card/50 backdrop-blur-sm shadow-none hover:bg-card/70 hover:border-white/15 transition-all duration-300 h-full">
                    <CardHeader>
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted/80 mb-1">
                        <AnimatedIcon
                          icon={feature.icon}
                          animation={feature.animation}
                          size={16}
                          className="text-foreground"
                        />
                      </div>
                      <CardTitle className="text-sm font-semibold">{feature.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {feature.description}
                      </p>
                    </CardContent>
                  </Card>
                </FadeIn>
              </StaggerItem>
            ))}
          </StaggerChildren>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  NUMBERS                                                     */}
      {/* ============================================================ */}
      <section className="py-20 sm:py-28 border-t border-border/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <StaggerChildren
            className="grid grid-cols-2 lg:grid-cols-4 gap-8 text-center"
            staggerDelay={0.1}
          >
            {stats.map((stat) => (
              <StaggerItem key={stat.label}>
                <div>
                  <div className="font-display text-4xl font-bold tracking-tight sm:text-5xl bg-gradient-to-r from-blue-500 to-violet-500 bg-clip-text text-transparent">
                    <AnimatedCounter target={stat.value} suffix={stat.suffix} duration={2.5} />
                  </div>
                  {/* Gradient underline */}
                  <div className="mx-auto mt-2 h-px w-12 bg-gradient-to-r from-blue-500/60 to-violet-500/60 rounded-full" />
                  <div className="mt-3 text-sm text-muted-foreground">{stat.label}</div>
                </div>
              </StaggerItem>
            ))}
          </StaggerChildren>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  BOTTOM CTA                                                  */}
      {/* ============================================================ */}
      <section className="relative py-20 sm:py-28 border-t border-border/50 overflow-hidden">
        <DottedGrid className="-z-20 opacity-40" />
        <GlowOrbs className="-z-10" />

        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center relative z-10">
          <FadeIn>
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Ready to rethink how you use AI?
            </h2>
            <p className="mt-4 text-muted-foreground text-base sm:text-lg max-w-xl mx-auto">
              Deploy JUDICA in minutes. Self-hosted, open source, enterprise-ready.
            </p>
          </FadeIn>

          <FadeIn delay={0.2}>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
              <MagneticButton>
                <Button size="lg" asChild className="w-full sm:w-auto">
                  <Link to="/chat">
                    <Sparkles className="mr-1.5 h-4 w-4" />
                    Try Demo
                  </Link>
                </Button>
              </MagneticButton>
              <MagneticButton>
                <Button variant="outline" size="lg" asChild className="w-full sm:w-auto">
                  <Link to="/register">
                    Start Free
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Link>
                </Button>
              </MagneticButton>
              <MagneticButton>
                <Button variant="ghost" size="lg" asChild className="w-full sm:w-auto">
                  <Link to="/pricing">View Pricing</Link>
                </Button>
              </MagneticButton>
            </div>
          </FadeIn>
        </div>
      </section>
    </div>
  );
}
