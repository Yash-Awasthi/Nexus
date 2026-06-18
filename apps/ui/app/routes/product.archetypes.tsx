import type { Route } from "./+types/product.archetypes";
import { ProductPage } from "~/components/product-page";
import {
  Compass,
  ShieldAlert,
  FlaskConical,
  Combine,
  Scale,
  Flame,
  Sparkles,
} from "lucide-react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "14 Agent Archetypes | JUDICA" },
    {
      name: "description",
      content:
        "Each agent has a distinct thinking style — from the methodical Architect to the skeptical Contrarian. Customize or create your own.",
    },
  ];
}

export default function ProductArchetypes() {
  return (
    <ProductPage
      badge="Core Feature"
      title="14 Agent"
      titleHighlight="Archetypes"
      subtitle="Each agent has a distinct thinking style — from the methodical Architect to the skeptical Contrarian. Customize or create your own."
      features={[
        {
          icon: Compass,
          title: "The Architect",
          description:
            "Systematic, structured thinking. The Architect breaks down complex problems into organized frameworks and builds solutions methodically.",
        },
        {
          icon: ShieldAlert,
          title: "The Contrarian",
          description:
            "Challenges assumptions and consensus. The Contrarian stress-tests ideas by arguing against the majority, exposing blind spots.",
        },
        {
          icon: FlaskConical,
          title: "The Empiricist",
          description:
            "Data-driven, evidence-based reasoning. The Empiricist demands proof, cites sources, and grounds arguments in measurable facts.",
        },
        {
          icon: Combine,
          title: "The Futurist",
          description:
            "Explores long-term trends, emerging technologies, and second-order consequences. The Futurist ensures decisions account for where the world is heading.",
        },
        {
          icon: Scale,
          title: "The Ethicist",
          description:
            "Evaluates moral implications and societal impact. The Ethicist ensures decisions consider fairness, harm, and long-term consequences.",
        },
        {
          icon: Flame,
          title: "The Devil's Advocate",
          description:
            "Dedicated adversarial stress-testing. Finds the strongest possible objections to any proposal to expose hidden weaknesses before they matter.",
        },
        {
          icon: Sparkles,
          title: "Custom Archetypes",
          description:
            "Create and share your own agent personas. Define personality traits, expertise domains, and reasoning styles tailored to your needs.",
        },
      ]}
      howItWorks={[
        {
          step: "1",
          title: "Select",
          description:
            "Choose from 14 built-in archetypes, each with a distinct reasoning style and perspective.",
        },
        {
          step: "2",
          title: "Customize",
          description:
            "Adjust personality, expertise, and communication style. Fine-tune how each agent approaches problems.",
        },
        {
          step: "3",
          title: "Council",
          description:
            "Compose your ideal deliberation team. Mix archetypes for balanced, thorough analysis of any topic.",
        },
      ]}
    />
  );
}
