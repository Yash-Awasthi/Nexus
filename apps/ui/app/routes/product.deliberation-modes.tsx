import type { Route } from "./+types/product.deliberation-modes";
import { ProductPage } from "~/components/product-page";
import {
  Users,
  HelpCircle,
  Swords,
  FlaskConical,
  Weight,
} from "lucide-react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "5 Deliberation Modes | JUDICA" },
    {
      name: "description",
      content:
        "Choose how your AI council approaches every problem. From structured debate to adversarial red-teaming.",
    },
  ];
}

export default function ProductDeliberationModes() {
  return (
    <ProductPage
      badge="Intelligence Modes"
      title="5 Ways to"
      titleHighlight="Think"
      subtitle="Choose how your AI council approaches every problem. From structured debate to adversarial red-teaming."
      features={[
        {
          icon: Users,
          title: "Standard",
          description:
            "Balanced multi-agent discussion. All agents share perspectives openly and build toward consensus through collaborative reasoning.",
        },
        {
          icon: HelpCircle,
          title: "Socratic",
          description:
            "A question-and-answer prelude before deliberation. Agents probe the problem space with targeted questions to surface hidden assumptions.",
        },
        {
          icon: Swords,
          title: "Red/Blue",
          description:
            "Adversarial teams argue opposing sides while an impartial judge evaluates. Stress-test any idea with structured opposition.",
        },
        {
          icon: FlaskConical,
          title: "Hypothesis",
          description:
            "Iterative refinement and testing. Agents propose hypotheses, design tests, and refine conclusions through systematic experimentation.",
        },
        {
          icon: Weight,
          title: "Confidence-Weighted",
          description:
            "Model reliability drives synthesis. Agents with stronger track records have more influence on the final consensus.",
        },
      ]}
      howItWorks={[
        {
          step: "1",
          title: "Choose",
          description:
            "Select the right deliberation mode for your task. Each mode shapes how agents interact and reason.",
        },
        {
          step: "2",
          title: "Deliberate",
          description:
            "Agents follow the mode-specific protocol — structured debate, adversarial challenge, or iterative refinement.",
        },
        {
          step: "3",
          title: "Verify",
          description:
            "Review the transparent reasoning chain, individual scores, and confidence metrics behind every conclusion.",
        },
      ]}
    />
  );
}
