import type { Route } from "./+types/product.council";
import { ProductPage } from "~/components/product-page";
import {
  Zap,
  AlertTriangle,
  MessageSquare,
  BarChart3,
  Merge,
  Gauge,
} from "lucide-react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Multi-Agent Deliberation Engine | JUDICA" },
    {
      name: "description",
      content:
        "Run multiple AI agents simultaneously. Each with a distinct thinking style. They debate, critique, and produce a scored consensus.",
    },
  ];
}

export default function ProductCouncil() {
  return (
    <ProductPage
      badge="Core Feature"
      title="Multi-Agent Deliberation"
      titleHighlight="Engine"
      subtitle="Run 4-7 AI agents simultaneously. Each with a distinct thinking style. They debate, critique, and produce a scored consensus — not a single model's best guess."
      features={[
        {
          icon: Zap,
          title: "Parallel Agent Dispatch",
          description:
            "Send your question to multiple AI agents at once. Each agent processes independently with its own archetype and reasoning style.",
        },
        {
          icon: AlertTriangle,
          title: "Conflict Detection",
          description:
            "Keyword overlap pre-filtering identifies disagreements early. Conflicts are scored on a severity scale from 1 to 5.",
        },
        {
          icon: MessageSquare,
          title: "Debate Rounds",
          description:
            "Agents exchange critiques and rebuttals in structured rounds. Concession detection identifies when agents update their positions.",
        },
        {
          icon: BarChart3,
          title: "Reliability Scoring",
          description:
            "Each model is scored based on its debate performance. Scores adjust dynamically across rounds to reflect reasoning quality.",
        },
        {
          icon: Merge,
          title: "Consensus Synthesis",
          description:
            "Final answers are reliability-weighted, combining the strongest reasoning from every agent into a single coherent response.",
        },
        {
          icon: Gauge,
          title: "Confidence Scoring",
          description:
            "A 0-1 confidence score based on agent agreement, viewpoint diversity, and conflict resolution. Know exactly how certain the council is.",
        },
      ]}
      howItWorks={[
        {
          step: "1",
          title: "Ask",
          description:
            "Submit your question with any relevant context. Choose your agent council size and archetypes.",
        },
        {
          step: "2",
          title: "Debate",
          description:
            "Agents argue, critique each other's reasoning, and refine their positions through structured debate rounds.",
        },
        {
          step: "3",
          title: "Consensus",
          description:
            "A reliability-weighted verdict is produced with a confidence score so you know how much to trust the answer.",
        },
      ]}
    />
  );
}
