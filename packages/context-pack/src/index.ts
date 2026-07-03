// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/context-pack — Cross-session memory context-pack assembly.
 *
 * On each session start (or before an agent begins a complex task), call
 * `assembleContextPack()` to build a structured snapshot of:
 *
 *   • Recent runtime tasks and their outcomes
 *   • Active high/critical signals awaiting action
 *   • Relevant stored memories (semantic recall if query provided)
 *   • Agent role definition and behavioural guidelines
 *
 * The assembled pack is formatted as a structured Markdown system prompt
 * prefix, ready to prepend to any LLM conversation.
 *
 * Design principles
 * ─────────────────
 *  • Zero DB dependency — callers inject fetcher functions.
 *    This keeps the package purely functional and fully testable.
 *  • Token budget — every section estimates its token cost (chars/4) and
 *    the assembler trims lower-priority sections to fit within the budget.
 *  • Deterministic — given the same fetcher output the same pack is produced.
 */

// ── Domain types (input) ──────────────────────────────────────────────────────

export interface RecentTask {
  id: string;
  type: string;
  status: string;
  priority: string;
  /** ISO 8601 */
  createdAt: string;
  error?: string | null;
}

/** Signal priority type alias. */
export type SignalPriority = "low" | "medium" | "high" | "critical";

/** Active signal interface definition. */
export interface ActiveSignal {
  id: string;
  signalType: string;
  summary: string;
  priority: SignalPriority;
  /** ISO 8601 */
  createdAt: string;
}

/** Memory fact interface definition. */
export interface MemoryFact {
  id: string;
  text: string;
  /** Cosine similarity [0,1] — higher means more relevant */
  score?: number;
  /** Unix epoch seconds */
  createdAt: number;
}

// ── Fetcher interface (injected by caller) ────────────────────────────────────

export interface ContextFetchers {
  /** Return the N most-recently-updated tasks */
  fetchRecentTasks: (limit: number) => Promise<RecentTask[]>;
  /**
   * Return the N most-recent active signals.
   * Implementations should filter to priority >= "high" by default,
   * but the pack also accepts lower-priority signals if capacity allows.
   */
  fetchActiveSignals: (limit: number) => Promise<ActiveSignal[]>;
  /**
   * Return stored memory facts.
   * If a semantic query string is provided, implementations should rank by
   * relevance; otherwise return the N most-recently stored facts.
   */
  fetchMemories: (limit: number, query?: string) => Promise<MemoryFact[]>;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export interface ContextPackConfig {
  /**
   * Token budget for the entire context pack.
   * Sections are trimmed to fit. Default: 4000 tokens.
   * (1 token ≈ 4 chars — a conservative estimate.)
   */
  maxTokenBudget?: number;
  /** Max tasks to include. Default: 10. */
  maxTasks?: number;
  /** Max active signals to include. Default: 5. */
  maxSignals?: number;
  /** Max memory facts to include. Default: 8. */
  maxMemories?: number;
  /**
   * Agent role description injected into the preamble.
   * E.g. "You are the Nexus orchestration agent managing a multi-agent platform."
   */
  agentRole?: string;
  /**
   * Caller-supplied extra context appended verbatim after memories.
   * Useful for ad-hoc session context (e.g. current user identity, active project).
   */
  extraContext?: string;
  /**
   * Semantic query string forwarded to `fetchMemories` for relevance ranking.
   * If omitted, memories are returned in recency order.
   */
  memoryQuery?: string;
}

// ── Output types ──────────────────────────────────────────────────────────────

export interface ContextSection {
  /** Human-readable name, e.g. "Recent Tasks" */
  name: string;
  /** Rendered markdown content */
  content: string;
  /** Estimated token cost (content.length / 4, rounded up) */
  tokenEstimate: number;
  /** Was this section trimmed to fit the budget? */
  trimmed: boolean;
}

/** Context pack interface definition. */
export interface ContextPack {
  /** The full assembled system prompt — prepend to any LLM conversation */
  systemPrompt: string;
  /** Individual sections for introspection / debugging */
  sections: ContextSection[];
  /** Sum of all section token estimates */
  totalTokenEstimate: number;
  /** ISO 8601 assembly timestamp */
  assembledAt: string;
  /** Whether any section was truncated due to token budget */
  wasTrimmed: boolean;
}

// ── Token estimation ──────────────────────────────────────────────────────────

/** Conservative char/token ratio — errs on the side of underestimating tokens */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── Section renderers ─────────────────────────────────────────────────────────

const STATUS_EMOJI: Record<string, string> = {
  queued: "⏳",
  running: "▶",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
  awaiting_approval: "⏸",
};

const PRIORITY_LABEL: Record<string, string> = {
  low: "🔵",
  medium: "🟡",
  high: "🟠",
  critical: "🔴",
};

function renderTasks(tasks: RecentTask[]): string {
  if (tasks.length === 0) return "_No recent tasks._";
  return tasks
    .map((t) => {
      const icon = STATUS_EMOJI[t.status] ?? "·";
      const pri = PRIORITY_LABEL[t.priority] ?? "";
      const ts = new Date(t.createdAt).toISOString().slice(0, 16).replace("T", " ");
      const errLine = t.error ? `\n   ↳ Error: ${t.error.slice(0, 120)}` : "";
      return `- ${icon} \`${t.type}\` [${t.status}] ${pri} — ${ts}${errLine}`;
    })
    .join("\n");
}

function renderSignals(signals: ActiveSignal[]): string {
  if (signals.length === 0) return "_No active signals._";
  return signals
    .map((s) => {
      const pri = PRIORITY_LABEL[s.priority] ?? "";
      const ts = new Date(s.createdAt).toISOString().slice(0, 16).replace("T", " ");
      return `- ${pri} **${s.signalType}** — ${s.summary.slice(0, 200)}\n  _(${ts})_`;
    })
    .join("\n");
}

function renderMemories(memories: MemoryFact[]): string {
  if (memories.length === 0) return "_No stored memories._";
  return memories
    .map((m, i) => {
      const score = m.score !== undefined ? ` [relevance: ${(m.score * 100).toFixed(0)}%]` : "";
      return `${i + 1}. ${m.text.slice(0, 300)}${score}`;
    })
    .join("\n");
}

// ── Section builder ───────────────────────────────────────────────────────────

function buildSection(name: string, content: string, budgetLeft: number): ContextSection {
  const tokens = estimateTokens(content);
  if (tokens <= budgetLeft) {
    return { name, content, tokenEstimate: tokens, trimmed: false };
  }
  // Trim content to fit remaining budget
  const maxChars = budgetLeft * CHARS_PER_TOKEN;
  const trimmed = content.slice(0, maxChars - 60) + "\n\n_[truncated to fit token budget]_";
  return {
    name,
    content: trimmed,
    tokenEstimate: estimateTokens(trimmed),
    trimmed: true,
  };
}

// ── Default configuration ─────────────────────────────────────────────────────

const DEFAULTS: Required<Omit<ContextPackConfig, "agentRole" | "extraContext" | "memoryQuery">> = {
  maxTokenBudget: 4000,
  maxTasks: 10,
  maxSignals: 5,
  maxMemories: 8,
};

// ── Main assembler ────────────────────────────────────────────────────────────

/**
 * Assemble a context pack from the provided fetchers and configuration.
 *
 * Sections are built in priority order:
 *   1. Preamble   — agent role (always included, low token cost)
 *   2. Signals    — highest priority for situational awareness
 *   3. Tasks      — recent work history
 *   4. Memories   — long-term recall (semantically ranked if query provided)
 *   5. Extra      — caller-supplied context
 *
 * Each section is trimmed if it would exceed the remaining token budget.
 */
export async function assembleContextPack(
  fetchers: ContextFetchers,
  config: ContextPackConfig = {},
): Promise<ContextPack> {
  const cfg = { ...DEFAULTS, ...config };
  const budget = cfg.maxTokenBudget;
  let remaining = budget;

  // ── Fetch all data in parallel ──────────────────────────────────────────
  const [tasks, signals, memories] = await Promise.all([
    fetchers.fetchRecentTasks(cfg.maxTasks),
    fetchers.fetchActiveSignals(cfg.maxSignals),
    fetchers.fetchMemories(cfg.maxMemories, cfg.memoryQuery),
  ]);

  const sections: ContextSection[] = [];

  // ── 1. Preamble ─────────────────────────────────────────────────────────
  const role =
    cfg.agentRole ??
    "You are Nexus, an intelligent multi-agent orchestration platform. " +
      "You have access to real-time task state, active signals, and long-term memory. " +
      "Use this context to reason accurately and act appropriately.";

  const preamble = `## Agent Context Pack\n_Assembled at ${new Date().toISOString()}_\n\n**Role:** ${role}`;
  const preambleSection = buildSection("Preamble", preamble, remaining);
  sections.push(preambleSection);
  remaining -= preambleSection.tokenEstimate;

  // ── 2. Active Signals ───────────────────────────────────────────────────
  if (remaining > 50) {
    const signalContent = `## Active Signals (${signals.length})\n\n${renderSignals(signals)}`;
    const section = buildSection("Active Signals", signalContent, remaining);
    sections.push(section);
    remaining -= section.tokenEstimate;
  }

  // ── 3. Recent Tasks ─────────────────────────────────────────────────────
  if (remaining > 50) {
    const taskContent = `## Recent Tasks (${tasks.length})\n\n${renderTasks(tasks)}`;
    const section = buildSection("Recent Tasks", taskContent, remaining);
    sections.push(section);
    remaining -= section.tokenEstimate;
  }

  // ── 4. Stored Memories ──────────────────────────────────────────────────
  if (remaining > 50) {
    const memLabel = cfg.memoryQuery
      ? `Relevant Memories for "${cfg.memoryQuery}"`
      : "Stored Memories";
    const memContent = `## ${memLabel} (${memories.length})\n\n${renderMemories(memories)}`;
    const section = buildSection(memLabel, memContent, remaining);
    sections.push(section);
    remaining -= section.tokenEstimate;
  }

  // ── 5. Extra context ────────────────────────────────────────────────────
  if (cfg.extraContext && remaining > 50) {
    const extraContent = `## Additional Context\n\n${cfg.extraContext}`;
    const section = buildSection("Additional Context", extraContent, remaining);
    sections.push(section);
    remaining -= section.tokenEstimate;
  }

  // ── Assemble final prompt ───────────────────────────────────────────────
  const systemPrompt = sections.map((s) => s.content).join("\n\n---\n\n");
  const totalTokenEstimate = sections.reduce((sum, s) => sum + s.tokenEstimate, 0);
  const wasTrimmed = sections.some((s) => s.trimmed);

  return {
    systemPrompt,
    sections,
    totalTokenEstimate,
    assembledAt: new Date().toISOString(),
    wasTrimmed,
  };
}

// ── Null fetchers (dev / test fallback) ───────────────────────────────────────

/**
 * Fetchers that always return empty arrays.
 * Useful as a drop-in when no DB is available (local dev, tests).
 */
export const nullFetchers: ContextFetchers = {
  fetchRecentTasks: async () => [],
  fetchActiveSignals: async () => [],
  fetchMemories: async () => [],
};

// ── Token utility (re-exported for callers) ───────────────────────────────────

export { estimateTokens };
