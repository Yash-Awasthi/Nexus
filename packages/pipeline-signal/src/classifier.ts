// SPDX-License-Identifier: Apache-2.0
/**
 * SignalClassifier — heuristic rules that turn a raw IngestedEvent into a
 * typed Signal without calling an LLM.
 *
 * Rules are evaluated in priority order; first match wins.
 * Unmatched events fall back to the "general.event" signal type at medium priority.
 *
 * Rules are intentionally simple and fast — the council does the heavy lifting.
 * Add domain-specific rules via registerRule().
 */

export interface ClassificationInput {
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ClassificationResult {
  signalType: string;
  priority: "low" | "medium" | "high" | "critical";
  summary: string;
  tags: string[];
}

export type ClassifierRule = {
  name: string;
  /** Return true when this rule applies */
  matches: (input: ClassificationInput) => boolean;
  classify: (input: ClassificationInput) => ClassificationResult;
};

// ── Built-in rules ────────────────────────────────────────────────────────────

const BUILT_IN_RULES: ClassifierRule[] = [
  // GitHub: PR opened / review requested
  {
    name: "github.pr",
    matches: (i) => i.source === "github" && i.eventType.startsWith("pr."),
    classify: (i) => ({
      signalType: "code.review-required",
      priority: i.eventType === "pr.review_requested" ? "high" : "medium",
      summary: `GitHub PR event: ${i.eventType} — ${String((i.payload as Record<string, unknown>)["title"] ?? "untitled")}`,
      tags: ["github", "pull-request"],
    }),
  },
  // GitHub: security alert
  {
    name: "github.security",
    matches: (i) =>
      i.source === "github" &&
      (i.eventType.includes("vulnerability") || i.eventType.includes("secret_scanning")),
    classify: (i) => ({
      signalType: "security.vulnerability-detected",
      priority: "critical",
      summary: `Security alert from GitHub: ${i.eventType}`,
      tags: ["github", "security", "critical"],
    }),
  },
  // Gmail: action-required subject heuristic
  {
    name: "gmail.action-required",
    matches: (i) => {
      if (i.source !== "gmail") return false;
      const subject = String((i.payload as Record<string, unknown>)["subject"] ?? "").toLowerCase();
      return (
        subject.includes("action required") ||
        subject.includes("urgent") ||
        subject.includes("invoice") ||
        subject.includes("approval needed")
      );
    },
    classify: (i) => ({
      signalType: "email.action-required",
      priority: "high",
      summary: `Action-required email: ${String((i.payload as Record<string, unknown>)["subject"] ?? "")}`,
      tags: ["gmail", "action-required"],
    }),
  },
  // Gmail: regular email
  {
    name: "gmail.received",
    matches: (i) => i.source === "gmail" && i.eventType === "email.received",
    classify: (i) => ({
      signalType: "email.received",
      priority: "low",
      summary: `Email from ${String((i.payload as Record<string, unknown>)["from"] ?? "unknown")}`,
      tags: ["gmail"],
    }),
  },
  // Slack: mention
  {
    name: "slack.mention",
    matches: (i) => i.source === "slack" && i.eventType === "message.mention",
    classify: (_i) => ({
      signalType: "chat.mention",
      priority: "medium",
      summary: "You were mentioned in Slack",
      tags: ["slack", "mention"],
    }),
  },
  // Linear: issue assigned
  {
    name: "linear.issue",
    matches: (i) => i.source === "linear",
    classify: (i) => ({
      signalType: "task.assigned",
      priority: "medium",
      summary: `Linear issue: ${String((i.payload as Record<string, unknown>)["title"] ?? i.eventType)}`,
      tags: ["linear", "issue"],
    }),
  },
  // Scrape: data extracted
  {
    name: "ingest.scrape",
    matches: (i) => i.source === "ingest" && i.eventType.startsWith("scrape."),
    classify: (i) => ({
      signalType: "data.scraped",
      priority: "low",
      summary: `Scrape result: ${String((i.payload as Record<string, unknown>)["url"] ?? i.eventType)}`,
      tags: ["scrape", "data"],
    }),
  },
];

// ── SignalClassifier ──────────────────────────────────────────────────────────

export class SignalClassifier {
  private readonly rules: ClassifierRule[] = [...BUILT_IN_RULES];

  /** Prepend a custom rule (runs before built-ins) */
  registerRule(rule: ClassifierRule): void {
    this.rules.unshift(rule);
  }

  classify(input: ClassificationInput): ClassificationResult {
    for (const rule of this.rules) {
      if (rule.matches(input)) return rule.classify(input);
    }
    // Fallback
    return {
      signalType: "general.event",
      priority: "medium",
      summary: `Event from ${input.source}: ${input.eventType}`,
      tags: [input.source],
    };
  }
}
