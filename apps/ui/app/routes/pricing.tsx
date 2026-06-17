"use client";

import type { Route } from "./+types/pricing";
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Switch } from "~/components/ui/switch";
import { Check } from "lucide-react";
import {
  FadeIn,
  StaggerChildren,
  StaggerItem,
  TiltCard,
  MagneticButton,
  TextShimmer,
  DottedGrid,
} from "~/components/animations";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Pricing - JUDICA" },
    {
      name: "description",
      content:
        "Simple, transparent pricing for multi-agent deliberative AI. Start free, scale with your team.",
    },
  ];
}

const businessFeatures = [
  "Chat & Search UI",
  "Access to All Major LLMs",
  "Multi-Agent Deliberation",
  "5 Deliberation Modes",
  "Knowledge Bases & RAG",
  "Visual Workflow Builder",
  "14 Agent Archetypes",
  "Code Sandbox",
  "MCP Protocol",
  "Community Support",
];

const enterpriseFeatures = [
  "Everything in Business, plus:",
  "OIDC/SAML SSO",
  "SCIM Provisioning",
  "On-Premise Deployment",
  "Custom Agent Archetypes",
  "Advanced RBAC",
  "Audit Logs & Compliance",
  "Priority Support",
  "Custom Integrations",
  "SLA Guarantee",
  "Dedicated Account Manager",
];

export default function Pricing() {
  const [annual, setAnnual] = useState(false);
  const monthlyPrice = 25;
  const annualPrice = 20;
  const price = annual ? annualPrice : monthlyPrice;

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
            Simple, <TextShimmer>transparent pricing</TextShimmer>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
            Start with a free trial. No credit card required. Scale when you're
            ready.
          </p>

          {/* Billing toggle */}
          <div className="mt-8 flex items-center justify-center gap-3">
            <span
              className={`text-sm transition-colors duration-300 ${!annual ? "text-foreground" : "text-muted-foreground"}`}
            >
              Monthly
            </span>
            <Switch checked={annual} onCheckedChange={setAnnual} />
            <span
              className={`text-sm transition-colors duration-300 ${annual ? "text-foreground" : "text-muted-foreground"}`}
            >
              Annual
            </span>
            <div
              className={`ml-2 transition-all duration-300 ${annual ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2"}`}
            >
              <Badge variant="secondary">Save 20%</Badge>
            </div>
          </div>
        </FadeIn>
      </section>

      {/* Pricing cards */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <StaggerChildren className="grid gap-8 md:grid-cols-2" staggerDelay={0.15}>
          {/* Business */}
          <StaggerItem>
            <TiltCard className="rounded-xl" tiltAmount={5}>
              <Card className="relative flex flex-col backdrop-blur-md bg-card/80 border-white/10">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CardTitle className="font-display text-2xl">
                      Business
                    </CardTitle>
                    <style>
                      {`
                        @keyframes pulseGlow {
                          0%, 100% { box-shadow: 0 0 4px rgba(99,102,241,0.4); }
                          50% { box-shadow: 0 0 12px rgba(99,102,241,0.7); }
                        }
                      `}
                    </style>
                    <Badge
                      style={{ animation: "pulseGlow 2s ease-in-out infinite" }}
                    >
                      Popular
                    </Badge>
                  </div>
                  <CardDescription>
                    For teams that need multi-agent AI with full deliberation
                    capabilities.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1">
                  <div className="mb-6">
                    <span
                      className="font-display text-5xl font-bold inline-block transition-all duration-300"
                      key={price}
                    >
                      ${price}
                    </span>
                    <span className="text-muted-foreground">
                      /user/month
                    </span>
                    <div
                      className={`transition-all duration-300 overflow-hidden ${annual ? "max-h-8 opacity-100 mt-1" : "max-h-0 opacity-0"}`}
                    >
                      <p className="text-sm text-muted-foreground">
                        Billed annually
                      </p>
                    </div>
                  </div>
                  <StaggerChildren staggerDelay={0.05}>
                    <ul className="space-y-3">
                      {businessFeatures.map((feature) => (
                        <StaggerItem key={feature}>
                          <li className="flex items-start gap-3">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                            <span className="text-sm">{feature}</span>
                          </li>
                        </StaggerItem>
                      ))}
                    </ul>
                  </StaggerChildren>
                </CardContent>
                <CardFooter>
                  <MagneticButton className="w-full">
                    <Button className="w-full" size="lg" asChild>
                      <Link to="/register">Start Free Trial</Link>
                    </Button>
                  </MagneticButton>
                </CardFooter>
              </Card>
            </TiltCard>
          </StaggerItem>

          {/* Enterprise */}
          <StaggerItem>
            <TiltCard className="rounded-xl" tiltAmount={5}>
              <Card className="relative flex flex-col border-primary/30 backdrop-blur-md bg-card/80">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CardTitle className="font-display text-2xl">
                      Enterprise
                    </CardTitle>
                  </div>
                  <CardDescription>
                    For organizations that need advanced security, compliance, and
                    dedicated support.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1">
                  <div className="mb-6">
                    <span className="font-display text-4xl font-bold">
                      Contact us
                    </span>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Custom pricing for your organization
                    </p>
                  </div>
                  <StaggerChildren staggerDelay={0.05}>
                    <ul className="space-y-3">
                      {enterpriseFeatures.map((feature) => (
                        <StaggerItem key={feature}>
                          <li className="flex items-start gap-3">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                            <span className="text-sm">{feature}</span>
                          </li>
                        </StaggerItem>
                      ))}
                    </ul>
                  </StaggerChildren>
                </CardContent>
                <CardFooter>
                  <MagneticButton className="w-full">
                    <Button variant="outline" className="w-full" size="lg" asChild>
                      <Link to="/contact">Talk to Sales</Link>
                    </Button>
                  </MagneticButton>
                </CardFooter>
              </Card>
            </TiltCard>
          </StaggerItem>
        </StaggerChildren>
      </section>

      {/* FAQ-style bottom section */}
      <section className="border-t border-border/40 bg-muted/10 px-6 py-16 text-center">
        <FadeIn>
          <h2 className="font-display text-2xl font-bold">
            Need help choosing?
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-muted-foreground">
            Every plan includes a 14-day free trial. No credit card required. Talk
            to our team if you need a custom plan.
          </p>
          <MagneticButton className="mt-6">
            <Button variant="outline" asChild>
              <Link to="/contact">Contact Sales</Link>
            </Button>
          </MagneticButton>
        </FadeIn>
      </section>
    </div>
  );
}
