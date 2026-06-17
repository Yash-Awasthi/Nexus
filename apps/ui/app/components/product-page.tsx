"use client";

import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { ArrowRight, type LucideIcon } from "lucide-react";
import {
  DottedGrid,
  GlowOrbs,
  FadeIn,
  TextShimmer,
  StaggerChildren,
  StaggerItem,
  TiltCard,
  MagneticButton,
  AnimatedIcon,
} from "~/components/animations";

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
}

interface ProductPageProps {
  badge: string;
  title: string;
  titleHighlight?: string;
  subtitle: string;
  features: Feature[];
  howItWorks?: { step: string; title: string; description: string }[];
  ctaText?: string;
  ctaHref?: string;
}

export function ProductPage({
  badge,
  title,
  titleHighlight,
  subtitle,
  features,
  howItWorks,
  ctaText = "Try it Free",
  ctaHref = "/register",
}: ProductPageProps) {
  return (
    <div>
      {/* Hero */}
      <section className="relative py-20 sm:py-28 overflow-hidden">
        <DottedGrid />
        <GlowOrbs className="opacity-50" />

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <FadeIn direction="down" delay={0}>
            <Badge variant="secondary" className="mb-6 text-xs font-medium">
              {badge}
            </Badge>
          </FadeIn>

          <FadeIn delay={0.1}>
            <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight max-w-4xl mx-auto">
              {title}{" "}
              {titleHighlight && (
                <TextShimmer className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight">
                  {titleHighlight}
                </TextShimmer>
              )}
            </h1>
          </FadeIn>

          <FadeIn delay={0.25}>
            <p className="mt-6 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              {subtitle}
            </p>
          </FadeIn>

          <FadeIn delay={0.4}>
            <div className="mt-10 flex items-center justify-center gap-4">
              <MagneticButton>
                <Button size="lg" asChild>
                  <Link to={ctaHref}>
                    {ctaText}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </MagneticButton>
              <MagneticButton>
                <Button size="lg" variant="outline" asChild>
                  <a href="https://github.com/Yash-Awasthi/Nexus" target="_blank" rel="noopener noreferrer">
                    View on GitHub
                  </a>
                </Button>
              </MagneticButton>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Features grid */}
      <section className="py-20 border-t border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <FadeIn className="text-center mb-16">
            <h2 className="font-display text-3xl sm:text-4xl font-bold">Key Features</h2>
          </FadeIn>

          <StaggerChildren className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6" staggerDelay={0.12}>
            {features.map((feature) => (
              <StaggerItem key={feature.title}>
                <TiltCard className="rounded-xl h-full">
                  <div className="group relative rounded-xl border border-white/5 bg-card/50 backdrop-blur-sm p-6 h-full overflow-hidden">
                    {/* Gradient top border on hover */}
                    <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-500/0 to-transparent group-hover:via-blue-500/70 transition-all duration-500" />

                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mb-4">
                      <AnimatedIcon icon={feature.icon} animation="float" size={20} className="text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </TiltCard>
              </StaggerItem>
            ))}
          </StaggerChildren>
        </div>
      </section>

      {/* How it works */}
      {howItWorks && (
        <section className="py-20 border-t border-border">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <FadeIn className="text-center mb-16">
              <h2 className="font-display text-3xl sm:text-4xl font-bold">How It Works</h2>
            </FadeIn>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8 max-w-5xl mx-auto">
              {howItWorks.map((step, i) => (
                <FadeIn key={i} delay={i * 0.15}>
                  <div className="relative">
                    {/* Connecting dashed line between steps */}
                    {i < howItWorks.length - 1 && (
                      <div className="hidden lg:block absolute top-8 left-full w-full h-px">
                        <svg className="w-full h-4 overflow-visible" preserveAspectRatio="none">
                          <line
                            x1="8"
                            y1="8"
                            x2="100%"
                            y2="8"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeDasharray="6 4"
                            className="text-muted-foreground/30"
                          >
                            <animate
                              attributeName="stroke-dashoffset"
                              from="20"
                              to="0"
                              dur="1.5s"
                              repeatCount="indefinite"
                            />
                          </line>
                        </svg>
                      </div>
                    )}

                    {/* Step number with glow */}
                    <div
                      className="text-5xl font-bold font-display mb-4 text-transparent bg-clip-text bg-gradient-to-b from-blue-400 to-violet-500"
                      style={{
                        filter: "drop-shadow(0 0 12px rgba(99,102,241,0.4))",
                      }}
                    >
                      {step.step}
                    </div>
                    <h3 className="text-lg font-semibold mb-2">{step.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                </FadeIn>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA */}
      <section className="relative py-20 border-t border-border overflow-hidden">
        <DottedGrid />

        <FadeIn className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="font-display text-3xl sm:text-4xl font-bold mb-4">Ready to get started?</h2>
          <p className="text-lg text-muted-foreground mb-8 max-w-xl mx-auto">
            Deploy JUDICA in minutes. Open source, self-hosted, and enterprise-ready.
          </p>
          <div className="flex items-center justify-center gap-4">
            <MagneticButton>
              <Button size="lg" asChild>
                <Link to="/register">
                  Start Free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </MagneticButton>
            <MagneticButton>
              <Button size="lg" variant="outline" asChild>
                <Link to="/pricing">View Pricing</Link>
              </Button>
            </MagneticButton>
          </div>
        </FadeIn>
      </section>
    </div>
  );
}
