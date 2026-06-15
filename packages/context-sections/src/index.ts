// SPDX-License-Identifier: Apache-2.0
/**
 * context-sections — Structured human/agent section renderers for LLM context.
 *
 * Provides:
 *   • SectionType       — typed section names
 *   • Section           — data model for a context section
 *   • SectionRenderer   — injectable interface for custom renderers
 *   • Built-in renderers — PreviouslySeenRenderer, AgentContextRenderer,
 *                          UserContextRenderer, FooterRenderer, TokenEconomicsRenderer
 *   • SectionAssembler  — pipeline that composes sections → final context string
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SectionType =
  | "previously-seen"
  | "agent-context"
  | "user-context"
  | "instructions"
  | "footer"
  | "token-economics"
  | "custom";

/** Section interface definition. */
export interface Section {
  type: SectionType;
  label?: string;
  content: string;
  priority: number;   // Lower = rendered first. Default: 50
  enabled: boolean;
  tokenEstimate?: number;
}

/** Section data interface definition. */
export interface SectionData {
  type: SectionType;
  label?: string;
  priority?: number;
  enabled?: boolean;
}

/** Section renderer interface definition. */
export interface SectionRenderer<TInput = unknown> {
  type: SectionType;
  render(input: TInput): Section;
}

// ── Token estimation ───────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Built-in renderers ────────────────────────────────────────────────────────

export interface PreviouslySeenInput {
  facts: string[];
  maxFacts?: number;
}

/** Previously seen renderer. */
export class PreviouslySeenRenderer implements SectionRenderer<PreviouslySeenInput> {
  readonly type = "previously-seen" as const;

  render({ facts, maxFacts = 20 }: PreviouslySeenInput): Section {
    const limited = facts.slice(0, maxFacts);
    const content = limited.length > 0
      ? `The following facts are known from prior conversations:\n${limited.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
      : "";
    return {
      type: this.type,
      label: "Previously Seen",
      content,
      priority: 10,
      enabled: limited.length > 0,
      tokenEstimate: estimateTokens(content),
    };
  }
}

/** Agent context input interface definition. */
export interface AgentContextInput {
  agentName: string;
  role: string;
  capabilities?: string[];
  constraints?: string[];
}

/** Agent context renderer. */
export class AgentContextRenderer implements SectionRenderer<AgentContextInput> {
  readonly type = "agent-context" as const;

  render({ agentName, role, capabilities = [], constraints = [] }: AgentContextInput): Section {
    const lines = [
      `You are ${agentName}, ${role}.`,
    ];
    if (capabilities.length > 0) {
      lines.push("", "Capabilities:", ...capabilities.map((c) => `• ${c}`));
    }
    if (constraints.length > 0) {
      lines.push("", "Constraints:", ...constraints.map((c) => `• ${c}`));
    }
    const content = lines.join("\n");
    return {
      type: this.type,
      label: "Agent Context",
      content,
      priority: 20,
      enabled: true,
      tokenEstimate: estimateTokens(content),
    };
  }
}

/** User context input interface definition. */
export interface UserContextInput {
  userId?: string;
  displayName?: string;
  preferences?: Record<string, string>;
  recentTopics?: string[];
}

/** User context renderer. */
export class UserContextRenderer implements SectionRenderer<UserContextInput> {
  readonly type = "user-context" as const;

  render({ userId, displayName, preferences = {}, recentTopics = [] }: UserContextInput): Section {
    const lines: string[] = [];
    if (displayName) lines.push(`User: ${displayName}${userId ? ` (${userId})` : ""}`);
    if (Object.keys(preferences).length > 0) {
      lines.push("Preferences:");
      for (const [k, v] of Object.entries(preferences)) {
        lines.push(`  ${k}: ${v}`);
      }
    }
    if (recentTopics.length > 0) {
      lines.push(`Recent topics: ${recentTopics.join(", ")}`);
    }
    const content = lines.join("\n");
    return {
      type: this.type,
      label: "User Context",
      content,
      priority: 30,
      enabled: content.length > 0,
      tokenEstimate: estimateTokens(content),
    };
  }
}

/** Instructions input interface definition. */
export interface InstructionsInput {
  instructions: string;
  header?: string;
}

/** Instructions renderer. */
export class InstructionsRenderer implements SectionRenderer<InstructionsInput> {
  readonly type = "instructions" as const;

  render({ instructions, header }: InstructionsInput): Section {
    const content = header ? `${header}\n\n${instructions}` : instructions;
    return {
      type: this.type,
      label: "Instructions",
      content,
      priority: 40,
      enabled: instructions.length > 0,
      tokenEstimate: estimateTokens(content),
    };
  }
}

/** Footer input interface definition. */
export interface FooterInput {
  reminder?: string;
  timestamp?: boolean;
  format?: string;
}

/** Footer renderer. */
export class FooterRenderer implements SectionRenderer<FooterInput> {
  readonly type = "footer" as const;

  render({ reminder, timestamp = false, format }: FooterInput): Section {
    const parts: string[] = [];
    if (reminder) parts.push(reminder);
    if (timestamp) parts.push(`Current time: ${new Date().toISOString()}`);
    if (format) parts.push(`Response format: ${format}`);
    const content = parts.join("\n");
    return {
      type: this.type,
      label: "Footer",
      content,
      priority: 90,
      enabled: content.length > 0,
      tokenEstimate: estimateTokens(content),
    };
  }
}

/** Token economics input interface definition. */
export interface TokenEconomicsInput {
  inputTokensUsed: number;
  inputTokenBudget: number;
  outputTokenBudget?: number;
  remainingConversationTurns?: number;
}

/** Token economics renderer. */
export class TokenEconomicsRenderer implements SectionRenderer<TokenEconomicsInput> {
  readonly type = "token-economics" as const;

  render({ inputTokensUsed, inputTokenBudget, outputTokenBudget, remainingConversationTurns }: TokenEconomicsInput): Section {
    const pct = Math.round((inputTokensUsed / inputTokenBudget) * 100);
    const remaining = inputTokenBudget - inputTokensUsed;
    const lines = [
      `Token budget: ${inputTokensUsed.toLocaleString()} / ${inputTokenBudget.toLocaleString()} (${pct}% used, ${remaining.toLocaleString()} remaining)`,
    ];
    if (outputTokenBudget !== undefined) {
      lines.push(`Output budget: ${outputTokenBudget.toLocaleString()} tokens`);
    }
    if (remainingConversationTurns !== undefined) {
      lines.push(`Estimated remaining turns: ~${remainingConversationTurns}`);
    }
    const content = lines.join("\n");
    return {
      type: this.type,
      label: "Token Economics",
      content,
      priority: 95,
      enabled: true,
      tokenEstimate: estimateTokens(content),
    };
  }
}

// ── SectionAssembler ───────────────────────────────────────────────────────────

export interface AssemblerOptions {
  /** Separator between sections. Default: "\n\n" */
  separator?: string;
  /** If set, trim total to this many characters. */
  maxChars?: number;
  /** Include section labels as headers. Default: false */
  showLabels?: boolean;
  /** Label prefix. Default: "## " */
  labelPrefix?: string;
}

/** Section assembler. */
export class SectionAssembler {
  private opts: Required<AssemblerOptions>;

  constructor(opts: AssemblerOptions = {}) {
    this.opts = {
      separator:   opts.separator   ?? "\n\n",
      maxChars:    opts.maxChars    ?? Infinity,
      showLabels:  opts.showLabels  ?? false,
      labelPrefix: opts.labelPrefix ?? "## ",
    };
  }

  assemble(sections: Section[]): string {
    const active = sections
      .filter((s) => s.enabled && s.content.length > 0)
      .sort((a, b) => a.priority - b.priority);

    const parts = active.map((s) => {
      if (this.opts.showLabels && s.label) {
        return `${this.opts.labelPrefix}${s.label}\n${s.content}`;
      }
      return s.content;
    });

    let result = parts.join(this.opts.separator);
    if (this.opts.maxChars < Infinity) {
      result = result.slice(0, this.opts.maxChars);
    }
    return result;
  }

  totalTokenEstimate(sections: Section[]): number {
    return sections
      .filter((s) => s.enabled)
      .reduce((sum, s) => sum + (s.tokenEstimate ?? estimateTokens(s.content)), 0);
  }
}
