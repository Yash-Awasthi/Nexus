// SPDX-License-Identifier: Apache-2.0
/**
 * agent-runtime — Step execution loop for multi-step LLM agents.
 *
 * Provides:
 *   • StepInput / StepOutput    — typed step I/O
 *   • ToolStreamParser          — parse tool calls from streamed LLM output
 *   • StrReplaceProcessor       — apply str_replace tool calls to a file map
 *   • CacheControl              — per-step cache control headers/policies
 *   • AgentStepExecutor         — run a single step (prompt → tool calls → results)
 *   • AgentRuntime              — multi-step loop with abort handling
 *   • RuntimeToolSet            — assemble a typed tool set for a run
 *   • MockLlmStream             — injectable streaming LLM test double
 *   • LlmStreamDriver           — structural interface for @nexus/llm-drivers drivers
 *   • llmDriverToStreamFn       — bridge: LlmDriver.stream() → AsyncIterable<string>
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type RuntimeModel = string;

/** Tool call raw interface definition. */
export interface ToolCallRaw {
  name: string;
  arguments: Record<string, unknown>;
  callId?: string;
}

/** Tool result interface definition. */
export interface ToolResult {
  callId?: string;
  name: string;
  output: unknown;
  error?: string;
}

/** Step input interface definition. */
export interface StepInput {
  stepIndex: number;
  instruction: string;
  toolResults?: ToolResult[];
  cacheControl?: CacheControlPolicy;
  abortSignal?: AbortSignal;
}

/** Step output interface definition. */
export interface StepOutput {
  stepIndex: number;
  content: string;
  toolCalls: ToolCallRaw[];
  toolResults: ToolResult[];
  tokensUsed?: number;
  durationMs: number;
  stopped: boolean;
}

// ── CacheControl ──────────────────────────────────────────────────────────────

export type CacheControlPolicy = "no-cache" | "ephemeral" | "persistent";

/** Cache control header interface definition. */
export interface CacheControlHeader {
  policy: CacheControlPolicy;
  maxAgeMs?: number;
  staleWhileRevalidateMs?: number;
}

/** Cache policies. */
export const CACHE_POLICIES: Record<CacheControlPolicy, CacheControlHeader> = {
  "no-cache": { policy: "no-cache" },
  ephemeral: { policy: "ephemeral", maxAgeMs: 60_000 },
  persistent: { policy: "persistent", maxAgeMs: 3_600_000, staleWhileRevalidateMs: 60_000 },
};

/** Cache control. */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class CacheControl {
  static headerFor(policy: CacheControlPolicy): CacheControlHeader {
    return CACHE_POLICIES[policy];
  }

  static shouldBypassCache(policy: CacheControlPolicy): boolean {
    return policy === "no-cache";
  }

  static maxAgeMs(policy: CacheControlPolicy): number {
    return CACHE_POLICIES[policy].maxAgeMs ?? 0;
  }
}

// ── ToolStreamParser ──────────────────────────────────────────────────────────

/**
 * Parses tool calls from streamed LLM output.
 * Format: [TOOL:name]{"arg":"val"}[/TOOL]
 */
export class ToolStreamParser {
  private buffer = "";

  feed(chunk: string): ToolCallRaw[] {
    this.buffer += chunk;
    return this.flush();
  }

  flush(): ToolCallRaw[] {
    if (this.buffer.length > 100_000) {
      this.buffer = "";
      return [];
    }
    const calls: ToolCallRaw[] = [];
    const regex = /\[TOOL:(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
    let match: RegExpExecArray | null;
    const consumed: string[] = [];

    while ((match = regex.exec(this.buffer)) !== null) {
      const name = match[1]!;
      const argStr = match[2]!.trim();
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const args = JSON.parse(argStr);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        calls.push({ name, arguments: args });
      } catch {
        calls.push({ name, arguments: { raw: argStr } });
      }
      consumed.push(match[0]);
    }

    // Remove consumed patterns from buffer
    for (const c of consumed) {
      this.buffer = this.buffer.replace(c, "");
    }

    return calls;
  }

  /** Strip all TOOL tags and return clean text. */
  static stripTools(text: string): string {
    if (text.length > 100_000) return text;
    return text.replace(/\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g, "").trim();
  }

  reset(): void {
    this.buffer = "";
  }
  getBuffer(): string {
    return this.buffer;
  }
}

// ── StrReplaceProcessor ───────────────────────────────────────────────────────

export interface StrReplaceCall {
  path: string;
  oldStr: string;
  newStr: string;
}

/** Str replace result interface definition. */
export interface StrReplaceResult {
  path: string;
  success: boolean;
  replaced: boolean;
  error?: string;
}

/** Str replace processor. */
export class StrReplaceProcessor {
  private files: Map<string, string>;

  constructor(files = new Map<string, string>()) {
    this.files = files;
  }

  process(call: StrReplaceCall): StrReplaceResult {
    const content = this.files.get(call.path);
    if (content === undefined) {
      return {
        path: call.path,
        success: false,
        replaced: false,
        error: `File not found: ${call.path}`,
      };
    }
    if (!content.includes(call.oldStr)) {
      return {
        path: call.path,
        success: false,
        replaced: false,
        error: "String not found in file",
      };
    }
    this.files.set(call.path, content.replace(call.oldStr, call.newStr));
    return { path: call.path, success: true, replaced: true };
  }

  processAll(calls: StrReplaceCall[]): StrReplaceResult[] {
    return calls.map((c) => this.process(c));
  }

  getFile(path: string): string | undefined {
    return this.files.get(path);
  }
  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}

// ── RuntimeToolSet ────────────────────────────────────────────────────────────

/**
 * Per-invocation context passed to a tool handler (modeled on jcode's ToolContext).
 * All fields optional so existing handlers ignoring it keep working.
 */
export interface ToolContext {
  sessionId?: string;
  toolCallId?: string;
  /** Cooperative cancellation for long-running tools. */
  signal?: AbortSignal;
  /** Workspace root, if the run is workspace-scoped. */
  workingDir?: string;
}

export interface RuntimeTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
  /** JSON Schema for the tool's arguments — advertised to native tool-calling. */
  parameters?: Record<string, unknown>;
  /**
   * Override the default permission tier. When unset, the tier is derived from
   * the tool name via `classifyTool` (read-only names auto-allow; others gate).
   */
  tier?: ActionTier;
}

// ── Permission model (two-tier; modeled on jcode safety.rs) ─────────────────────

export type ActionTier = "auto_allowed" | "requires_permission";

/**
 * Read-only tool names that never require approval. Mirrors jcode's AUTO_ALLOWED.
 * Anything not listed defaults to `requires_permission` (mutating / side-effecting).
 */
export const AUTO_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "read_file",
  "glob",
  "grep",
  "ls",
  "list",
  "list_files",
  "memory",
  "todo",
  "todoread",
  "todowrite",
  "conversation_search",
  "session_search",
  "codesearch",
]);

/** Classify a tool by name into a permission tier (case-insensitive). */
export function classifyTool(name: string): ActionTier {
  return AUTO_ALLOWED_TOOLS.has(name.toLowerCase()) ? "auto_allowed" : "requires_permission";
}

/** A request to run a tool that requires approval. */
export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  tier: ActionTier;
  sessionId?: string;
  toolCallId?: string;
}

/** Approve/deny verdict for a PermissionRequest. */
export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decides whether a `requires_permission` tool may run. Injected into
 * ToolAgentRuntime; when absent, all tools run (back-compatible default).
 */
export type PermissionGate = (
  req: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

/** Runtime tool set. */
export class RuntimeToolSet {
  private tools = new Map<string, RuntimeTool>();

  add(tool: RuntimeTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): RuntimeTool | undefined {
    return this.tools.get(name);
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  list(): RuntimeTool[] {
    return [...this.tools.values()];
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { name, output: null, error: `Tool not found: ${name}` };
    }
    try {
      const output = await tool.handler(args, ctx);
      return { name, output };
    } catch (err) {
      return { name, output: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  toLlmDescription(): string {
    return this.list()
      .map((t) => `${t.name}: ${t.description}`)
      .join("\n");
  }
}

// ── MockLlmStream ─────────────────────────────────────────────────────────────

export type LlmStreamFn = (
  systemPrompt: string,
  userPrompt: string,
  opts?: { signal?: AbortSignal },
) => AsyncIterable<string>;

/** Mock llm stream. */
export class MockLlmStream {
  private chunks: string[];
  private delayMs: number;
  readonly calls: string[] = [];

  constructor(chunks: string[] = ["Response text"], delayMs = 0) {
    this.chunks = chunks;
    this.delayMs = delayMs;
  }

  asStream(): LlmStreamFn {
    return async function* (
      this: MockLlmStream,
      _sys: string,
      user: string,
      opts?: { signal?: AbortSignal },
    ) {
      this.calls.push(user);
      for (const chunk of this.chunks) {
        if (opts?.signal?.aborted) return;
        if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
        yield chunk;
      }
    }.bind(this);
  }
}

// ── LlmStreamDriver adapter ───────────────────────────────────────────────────

/**
 * Structural interface matching the stream() signature of @nexus/llm-drivers drivers.
 * Defined here (not imported) to avoid circular workspace dependencies.
 * Any LlmDriver from @nexus/llm-drivers satisfies this interface structurally.
 */
export interface LlmStreamDriver {
  readonly model: string;
  stream(
    opts: {
      model?: string;
      messages: { role: string; content: string }[];
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
    },
    handler: (delta: { delta: string; done: boolean }) => void | Promise<void>,
  ): Promise<unknown>;
}

/**
 * Adapts a callback-based LlmDriver.stream() to an AsyncIterable<string>.
 *
 * The driver emits deltas via a handler callback; this function bridges that
 * to an async generator using a queue + Promise resolver pattern.
 *
 * Usage:
 *   import { GroqDriver } from "@nexus/llm-drivers";
 *   const driver = new GroqDriver({ apiKey: "..." });
 *   const streamFn = llmDriverToStreamFn(driver);
 *   const runtime = new AgentRuntime({ llm: streamFn, ... });
 */
export function llmDriverToStreamFn(driver: LlmStreamDriver, modelOverride?: string): LlmStreamFn {
  return async function* (
    systemPrompt: string,
    userPrompt: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    // Queue-based bridge: driver pushes chunks here, generator pulls them
    const queue: string[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let streamError: unknown = null;

    const push = (chunk: string): void => {
      queue.push(chunk);
      const r = resolve;
      resolve = null;
      r?.();
    };

    const streamPromise = driver
      .stream(
        {
          model: modelOverride ?? driver.model,
          messages: [{ role: "user", content: userPrompt }],
          systemPrompt,
        },
        (delta) => {
          if (!delta.done && delta.delta) push(delta.delta);
        },
      )
      .then(() => {
        done = true;
        const r = resolve;
        resolve = null;
        // eslint-disable-next-line promise/always-return
        r?.();
      })
      .catch((err: unknown) => {
        streamError = err;
        done = true;
        const r = resolve;
        resolve = null;
        r?.();
      });

    // Detach — we drive consumption via the generator below
    void streamPromise;

    while (!done || queue.length > 0) {
      if (opts?.signal?.aborted) return;

      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        // Wait for next push or done signal
        await new Promise<void>((res) => {
          resolve = res;
        });
      }
    }

    if (streamError) throw streamError;
  };
}

// ── AgentStepExecutor ─────────────────────────────────────────────────────────

export interface StepExecutorOptions {
  llm: LlmStreamFn;
  toolSet: RuntimeToolSet;
  systemPrompt: string;
}

/** Agent step executor. */
export class AgentStepExecutor {
  private llm: LlmStreamFn;
  private toolSet: RuntimeToolSet;
  private systemPrompt: string;

  constructor(opts: StepExecutorOptions) {
    this.llm = opts.llm;
    this.toolSet = opts.toolSet;
    this.systemPrompt = opts.systemPrompt;
  }

  async execute(input: StepInput): Promise<StepOutput> {
    const t0 = Date.now();
    const parser = new ToolStreamParser();
    let fullContent = "";

    const toolResultContext = input.toolResults?.length
      ? `\n\nPrevious tool results:\n${JSON.stringify(input.toolResults, null, 2)}`
      : "";

    const userPrompt = input.instruction + toolResultContext;

    // Stream and collect
    try {
      for await (const chunk of this.llm(this.systemPrompt, userPrompt, {
        signal: input.abortSignal,
      })) {
        if (input.abortSignal?.aborted) {
          return {
            stepIndex: input.stepIndex,
            content: fullContent,
            toolCalls: [],
            toolResults: [],
            durationMs: Date.now() - t0,
            stopped: true,
          };
        }
        fullContent += chunk;
        parser.feed(chunk);
      }
    } catch (err) {
      if (input.abortSignal?.aborted) {
        return {
          stepIndex: input.stepIndex,
          content: fullContent,
          toolCalls: [],
          toolResults: [],
          durationMs: Date.now() - t0,
          stopped: true,
        };
      }
      throw err;
    }

    // Extract tool calls from accumulated content
    const allCalls = new ToolStreamParser();
    const toolCalls = allCalls.feed(fullContent);
    const cleanContent = ToolStreamParser.stripTools(fullContent);

    // Execute tool calls
    const toolResults: ToolResult[] = [];
    for (const call of toolCalls) {
      const result = await this.toolSet.invoke(call.name, call.arguments);
      toolResults.push(result);
    }

    return {
      stepIndex: input.stepIndex,
      content: cleanContent,
      toolCalls,
      toolResults,
      durationMs: Date.now() - t0,
      stopped: false,
    };
  }
}

// ── AgentRuntime ──────────────────────────────────────────────────────────────

export interface RuntimeOptions {
  llm: LlmStreamFn;
  toolSet?: RuntimeToolSet;
  systemPrompt?: string;
  maxSteps?: number;
  cacheControl?: CacheControlPolicy;
}

/** Runtime result interface definition. */
export interface RuntimeResult {
  steps: StepOutput[];
  finalContent: string;
  totalTokens: number;
  aborted: boolean;
  totalDurationMs: number;
}

/** Agent runtime. */
export class AgentRuntime {
  private executor: AgentStepExecutor;
  private maxSteps: number;
  private cacheControl: CacheControlPolicy;

  constructor(opts: RuntimeOptions) {
    this.maxSteps = opts.maxSteps ?? 5;
    this.cacheControl = opts.cacheControl ?? "ephemeral";
    this.executor = new AgentStepExecutor({
      llm: opts.llm,
      toolSet: opts.toolSet ?? new RuntimeToolSet(),
      systemPrompt: opts.systemPrompt ?? "You are a helpful agent. Complete the task step by step.",
    });
  }

  async run(instruction: string, signal?: AbortSignal): Promise<RuntimeResult> {
    const t0 = Date.now();
    const steps: StepOutput[] = [];
    let currentInstruction = instruction;
    let previousResults: ToolResult[] = [];

    for (let i = 0; i < this.maxSteps; i++) {
      if (signal?.aborted) {
        return {
          steps,
          finalContent: steps[steps.length - 1]?.content ?? "",
          totalTokens: 0,
          aborted: true,
          totalDurationMs: Date.now() - t0,
        };
      }

      const step = await this.executor.execute({
        stepIndex: i,
        instruction: currentInstruction,
        toolResults: previousResults,
        cacheControl: this.cacheControl,
        abortSignal: signal,
      });

      steps.push(step);

      if (step.stopped) {
        return {
          steps,
          finalContent: step.content,
          totalTokens: 0,
          aborted: true,
          totalDurationMs: Date.now() - t0,
        };
      }

      // If no tool calls, we're done
      if (step.toolCalls.length === 0) break;

      // Continue with tool results
      previousResults = step.toolResults;
      currentInstruction = `Continue based on tool results. Original task: ${instruction}`;
    }

    const finalContent = steps[steps.length - 1]?.content ?? "";
    return {
      steps,
      finalContent,
      totalTokens: 0,
      aborted: false,
      totalDurationMs: Date.now() - t0,
    };
  }

  getExecutor(): AgentStepExecutor {
    return this.executor;
  }
}

// ── Native tool-calling runtime (ToolAgentRuntime) ──────────────────────────────
//
// The canonical harness loop. Unlike AgentRuntime above (which parses a custom
// [TOOL:...] bracket protocol from streamed TEXT and rebuilds a synthetic prompt
// each step), this loop uses the provider's NATIVE tool-calling and keeps a real
// growing message history, so multi-step coding sessions retain full context.
//
// It is decoupled from @nexus/llm-drivers via the structural LlmToolDriver
// interface + llmDriverToToolFn bridge (no cross-package import).

/** Token usage accumulated across a run. */
export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Provider-agnostic conversation message held in the loop's history. */
export interface RuntimeMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** On assistant messages that requested tool calls. */
  toolCalls?: ToolCallRaw[];
  /** On `role: "tool"` messages — links the result back to its call. */
  toolCallId?: string;
}

/** A tool advertised to the model (name + description + JSON-Schema params). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One model turn: assistant text + any tool calls + usage. */
export interface LlmTurnResult {
  content: string;
  toolCalls: ToolCallRaw[];
  usage?: RuntimeUsage;
}

/** Tool-aware LLM function consumed by ToolAgentRuntime. */
export type LlmToolFn = (
  messages: RuntimeMessage[],
  opts: {
    systemPrompt?: string;
    tools?: ToolSpec[];
    signal?: AbortSignal;
    /** Streamed text deltas (for SSE pass-through). */
    onText?: (delta: string) => void;
  },
) => Promise<LlmTurnResult>;

/**
 * Structural interface matching @nexus/llm-drivers' LlmDriver (native tool-calling
 * variant). Defined here to avoid a workspace import cycle; any real driver whose
 * stream() sends `tools` and returns `toolCalls` satisfies it structurally.
 */
export interface LlmToolDriver {
  readonly model: string;
  stream(
    opts: {
      model: string;
      messages: {
        role: "user" | "assistant" | "system" | "tool";
        content: string;
        toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
        toolCallId?: string;
      }[];
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
    },
    handler: (delta: { delta: string; done: boolean }) => void | Promise<void>,
  ): Promise<{
    content: string;
    toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
    usage?: RuntimeUsage;
  }>;
}

/** Bridge a native-tool-calling LlmDriver to the LlmToolFn the loop expects. */
export function llmDriverToToolFn(driver: LlmToolDriver, modelOverride?: string): LlmToolFn {
  return async (messages, opts): Promise<LlmTurnResult> => {
    const resp = await driver.stream(
      {
        model: modelOverride ?? driver.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls?.length
            ? {
                toolCalls: m.toolCalls.map((tc) => ({
                  id: tc.callId ?? "",
                  name: tc.name,
                  arguments: tc.arguments,
                })),
              }
            : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        })),
        systemPrompt: opts.systemPrompt,
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
      },
      (delta) => {
        if (!delta.done && delta.delta) opts.onText?.(delta.delta);
      },
    );
    return {
      content: resp.content,
      toolCalls: (resp.toolCalls ?? []).map((tc) => ({
        name: tc.name,
        arguments: tc.arguments,
        callId: tc.id,
      })),
      usage: resp.usage,
    };
  };
}

// ── Context compaction (constants + estimator + compactor; from jcode) ──────────
//
// Long agent sessions grow message history until the provider 4xx-es on context
// length. Compaction summarizes older turns into a single system message while
// keeping the most recent turns verbatim. Constants mirror jcode-compaction-core.

/** Default context budget in tokens (matches Claude's ~200k window). */
export const DEFAULT_TOKEN_BUDGET = 200_000;
/** Compact when the estimate reaches this fraction of the budget. */
export const COMPACTION_THRESHOLD = 0.8;
/** Keep this many most-recent turns verbatim (never summarized). */
export const RECENT_TURNS_TO_KEEP = 10;
/** Approximate chars per token for estimation. */
export const CHARS_PER_TOKEN = 4;
/**
 * Flat token cost charged per inline image. Counting raw base64 length as text
 * massively overestimates real cost and triggers spurious compaction loops, so
 * images are charged a flat estimate instead (jcode lesson).
 */
export const IMAGE_TOKEN_COST = 1_600;
/** Fixed overhead for system prompt + tool definitions (≈8k sys + ≈10k tools). */
export const SYSTEM_OVERHEAD_TOKENS = 18_000;

/** Summary prompt — produces a compact, resumable natural-language digest. */
export const COMPACTION_SUMMARY_PROMPT = `Summarize the conversation so far so the work can continue later.

Write natural language with these sections:
- Context: what we're working on and why (1-2 sentences)
- What we did: key actions taken, files changed, problems solved
- Current state: what works, what's broken, what's next
- User preferences: specific requirements or decisions made

Be concise but preserve important details (file paths, identifiers, decisions).`;

/** Heuristic per-message token estimate (text length + flat image cost). */
export function estimateMessageTokens(m: RuntimeMessage): number {
  let tokens = Math.ceil((m.content?.length ?? 0) / CHARS_PER_TOKEN);
  if (m.toolCalls?.length) {
    for (const tc of m.toolCalls) {
      tokens += Math.ceil(JSON.stringify(tc.arguments).length / CHARS_PER_TOKEN) + 4;
    }
  }
  // Inline base64 image markers are charged a flat cost, not their raw length.
  const images = m.content ? m.content.match(/data:image\/[a-zA-Z]+;base64,/g) : null;
  if (images) tokens += images.length * IMAGE_TOKEN_COST;
  return tokens;
}

/** Estimate total context tokens for a message list, incl. fixed overhead. */
export function estimateContextTokens(
  messages: RuntimeMessage[],
  systemOverhead = SYSTEM_OVERHEAD_TOKENS,
): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), systemOverhead);
}

export interface CompactionOptions {
  /** Token budget; compaction triggers at threshold × budget. */
  tokenBudget?: number;
  threshold?: number;
  recentTurnsToKeep?: number;
  systemOverhead?: number;
  /**
   * Summarizer LLM. Receives the messages to summarize; returns the digest text.
   * Typically the same LlmToolFn the loop uses, with no tools.
   */
  summarize: (messages: RuntimeMessage[]) => Promise<string>;
}

export interface CompactionResult {
  messages: RuntimeMessage[];
  compacted: boolean;
  preTokens: number;
  postTokens: number;
  summarizedCount: number;
}

/**
 * Compact a message history if it exceeds threshold × budget: summarize all but
 * the last `recentTurnsToKeep` messages into one system message, preserving the
 * recent tail verbatim. A leading system message (index 0) is always preserved.
 * Returns the original list unchanged when under threshold.
 */
export async function compactMessages(
  messages: RuntimeMessage[],
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const threshold = opts.threshold ?? COMPACTION_THRESHOLD;
  const keep = opts.recentTurnsToKeep ?? RECENT_TURNS_TO_KEEP;
  const overhead = opts.systemOverhead ?? SYSTEM_OVERHEAD_TOKENS;

  const preTokens = estimateContextTokens(messages, overhead);
  if (preTokens < budget * threshold) {
    return { messages, compacted: false, preTokens, postTokens: preTokens, summarizedCount: 0 };
  }

  // Preserve a leading system message; summarize the middle; keep recent tail.
  const hasLeadingSystem = messages[0]?.role === "system";
  const head = hasLeadingSystem ? messages.slice(0, 1) : [];
  const body = hasLeadingSystem ? messages.slice(1) : messages;

  if (body.length <= keep) {
    // Nothing old enough to summarize — leave as-is (avoids a no-op summary call).
    return { messages, compacted: false, preTokens, postTokens: preTokens, summarizedCount: 0 };
  }

  const toSummarize = body.slice(0, body.length - keep);
  const recent = body.slice(body.length - keep);
  const summary = await opts.summarize(toSummarize);

  const compactedMessages: RuntimeMessage[] = [
    ...head,
    { role: "system", content: `[Earlier conversation summary]\n${summary}` },
    ...recent,
  ];
  const postTokens = estimateContextTokens(compactedMessages, overhead);
  return {
    messages: compactedMessages,
    compacted: true,
    preTokens,
    postTokens,
    summarizedCount: toSummarize.length,
  };
}

/** Default step budget for a coding session (bounded to limit runaway cost). */
export const TOOL_RUNTIME_MAX_STEPS_DEFAULT = 50;

/** One executed step in a ToolAgentRuntime run. */
export interface ToolStepRecord {
  stepIndex: number;
  content: string;
  toolCalls: ToolCallRaw[];
  toolResults: ToolResult[];
  usage?: RuntimeUsage;
  durationMs: number;
}

/** Result of a ToolAgentRuntime run. */
export interface ToolRuntimeResult {
  /** Full conversation history (user → assistant/tool_calls → tool results → …). */
  messages: RuntimeMessage[];
  steps: ToolStepRecord[];
  finalContent: string;
  totalUsage: RuntimeUsage;
  aborted: boolean;
  totalDurationMs: number;
}

export interface ToolRuntimeOptions {
  llm: LlmToolFn;
  toolSet?: RuntimeToolSet;
  systemPrompt?: string;
  maxSteps?: number;
  /** Tools advertised to the model; derived from toolSet when omitted. */
  tools?: ToolSpec[];
  /** Streamed text deltas (SSE). */
  onText?: (delta: string) => void;
  /** Per-step lifecycle callback (SSE progress). */
  onStep?: (step: ToolStepRecord) => void;
  /**
   * Permission gate consulted before each `requires_permission` tool runs. When
   * omitted, all tools run (back-compatible). A denial is fed back to the model
   * as a tool error so it can adapt rather than crashing the run.
   */
  permissionGate?: PermissionGate;
  /** Workspace root passed to tools via ToolContext. */
  workingDir?: string;
  /** Session id passed to tools + permission requests. */
  sessionId?: string;
  /**
   * Context compaction. When set, the loop compacts the message history before
   * each model call once it exceeds threshold × budget. Off by default.
   */
  compaction?: CompactionOptions;
  /** Called when a compaction pass runs (SSE/telemetry). */
  onCompaction?: (info: CompactionResult) => void;
  /**
   * Prior conversation to resume from. When provided, the new instruction is
   * appended after these messages instead of starting a fresh history.
   */
  initialMessages?: RuntimeMessage[];
}

function deriveToolSpecs(toolSet: RuntimeToolSet): ToolSpec[] {
  return toolSet.list().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters ?? { type: "object", properties: {}, additionalProperties: true },
  }));
}

function stringifyToolOutput(r: ToolResult): string {
  if (r.error) return `Error: ${r.error}`;
  if (typeof r.output === "string") return r.output;
  try {
    return JSON.stringify(r.output);
  } catch {
    return String(r.output);
  }
}

/**
 * Multi-step agent loop over native tool-calling with a growing message history.
 *
 * Each step: call the model with the full history + advertised tools → append the
 * assistant message (incl. tool calls) → execute each tool → append a tool-result
 * message → repeat until the model emits no tool calls (done) or maxSteps / abort.
 */
export class ToolAgentRuntime {
  private llm: LlmToolFn;
  private toolSet: RuntimeToolSet;
  private systemPrompt: string;
  private maxSteps: number;
  private tools?: ToolSpec[];
  private onText?: (delta: string) => void;
  private onStep?: (step: ToolStepRecord) => void;
  private permissionGate?: PermissionGate;
  private workingDir?: string;
  private sessionId?: string;
  private compaction?: CompactionOptions;
  private onCompaction?: (info: CompactionResult) => void;
  private initialMessages?: RuntimeMessage[];

  constructor(opts: ToolRuntimeOptions) {
    this.llm = opts.llm;
    this.toolSet = opts.toolSet ?? new RuntimeToolSet();
    this.systemPrompt =
      opts.systemPrompt ?? "You are a coding agent. Use the provided tools to complete the task.";
    this.maxSteps = opts.maxSteps ?? TOOL_RUNTIME_MAX_STEPS_DEFAULT;
    this.tools = opts.tools;
    this.onText = opts.onText;
    this.onStep = opts.onStep;
    this.permissionGate = opts.permissionGate;
    this.workingDir = opts.workingDir;
    this.sessionId = opts.sessionId;
    this.compaction = opts.compaction;
    this.onCompaction = opts.onCompaction;
    this.initialMessages = opts.initialMessages;
  }

  /** Resolve a tool's effective permission tier (explicit override, else by name). */
  private tierFor(toolName: string): ActionTier {
    return this.toolSet.get(toolName)?.tier ?? classifyTool(toolName);
  }

  async run(instruction: string, signal?: AbortSignal): Promise<ToolRuntimeResult> {
    const t0 = Date.now();
    let messages: RuntimeMessage[] = [
      ...(this.initialMessages ?? []),
      { role: "user", content: instruction },
    ];
    const steps: ToolStepRecord[] = [];
    const totalUsage: RuntimeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const tools = this.tools ?? deriveToolSpecs(this.toolSet);
    let finalContent = "";

    for (let i = 0; i < this.maxSteps; i++) {
      if (signal?.aborted) {
        return { messages, steps, finalContent, totalUsage, aborted: true, totalDurationMs: Date.now() - t0 };
      }

      // Compact the history before the model call once it exceeds the budget.
      if (this.compaction) {
        const result = await compactMessages(messages, this.compaction);
        if (result.compacted) {
          messages = result.messages;
          this.onCompaction?.(result);
        }
      }

      const s0 = Date.now();
      const turn = await this.llm(messages, {
        systemPrompt: this.systemPrompt,
        tools,
        signal,
        onText: this.onText,
      });

      if (turn.usage) {
        totalUsage.inputTokens += turn.usage.inputTokens;
        totalUsage.outputTokens += turn.usage.outputTokens;
        totalUsage.totalTokens += turn.usage.totalTokens;
      }
      if (turn.content) finalContent = turn.content;

      // Record the assistant turn in history (with any tool calls).
      messages.push({
        role: "assistant",
        content: turn.content,
        ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
      });

      // Execute each tool call and append its result to history.
      const toolResults: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        const tier = this.tierFor(call.name);
        let result: ToolResult;

        // Gate mutating tools through the permission gate (when one is set).
        if (tier === "requires_permission" && this.permissionGate) {
          const decision = await this.permissionGate({
            toolName: call.name,
            args: call.arguments,
            tier,
            sessionId: this.sessionId,
            toolCallId: call.callId,
          });
          if (!decision.allowed) {
            result = {
              name: call.name,
              output: null,
              error: `permission_denied: ${decision.reason ?? "tool call was not approved"}`,
            };
          } else {
            result = await this.toolSet.invoke(call.name, call.arguments, {
              sessionId: this.sessionId,
              toolCallId: call.callId,
              signal,
              workingDir: this.workingDir,
            });
          }
        } else {
          result = await this.toolSet.invoke(call.name, call.arguments, {
            sessionId: this.sessionId,
            toolCallId: call.callId,
            signal,
            workingDir: this.workingDir,
          });
        }

        result.callId = call.callId;
        result.name = call.name;
        toolResults.push(result);
        messages.push({
          role: "tool",
          content: stringifyToolOutput(result),
          toolCallId: call.callId,
        });
      }

      const step: ToolStepRecord = {
        stepIndex: i,
        content: turn.content,
        toolCalls: turn.toolCalls,
        toolResults,
        usage: turn.usage,
        durationMs: Date.now() - s0,
      };
      steps.push(step);
      this.onStep?.(step);

      // No tool calls → the model is done.
      if (turn.toolCalls.length === 0) break;
    }

    return { messages, steps, finalContent, totalUsage, aborted: false, totalDurationMs: Date.now() - t0 };
  }
}

// ── spawn_agents tool ─────────────────────────────────────────────────────────
//
// Registers a "spawn_agents" tool on any RuntimeToolSet, enabling an agent to
// fork N child agents that run concurrently and merge their results.
//
// Usage:
//   const toolSet = new RuntimeToolSet();
//   toolSet.add(makeSpawnAgentsTool(llmFn, { maxConcurrency: 4 }));
//
// LLM prompt pattern:
//   spawn_agents({ tasks: [
//     { instruction: "Summarise the Q1 earnings report" },
//     { instruction: "Find the top 3 risks from the risk register" },
//   ]})
//
// Each child is an independent AgentRuntime with its own step budget.
// Promise.allSettled ensures one failed child never cancels the others.

export interface SpawnAgentTask {
  /** Instruction passed to the child agent. */
  instruction: string;
  /** Optional system-prompt override for this child. */
  systemPrompt?: string;
  /** Max steps for this child (overrides the factory default). */
  maxSteps?: number;
}

/** Spawn agent result interface definition. */
export interface SpawnAgentResult {
  taskIndex: number;
  instruction: string;
  finalContent: string;
  steps: number;
  /** Set when the child agent threw — other results are still returned. */
  error?: string;
}

/** Spawn agents options interface definition. */
export interface SpawnAgentsOptions {
  /** Hard cap on concurrent children (default: 5). */
  maxConcurrency?: number;
  /** Default step budget per child (default: 3). */
  maxStepsPerAgent?: number;
  /** Default system-prompt for child agents. */
  defaultSystemPrompt?: string;
}

/**
 * Factory: returns a RuntimeTool that forks child AgentRuntime instances.
 *
 * @param llm     The same LlmStreamFn used by the parent agent.
 * @param opts    Concurrency / step limits.
 */
export function makeSpawnAgentsTool(llm: LlmStreamFn, opts: SpawnAgentsOptions = {}): RuntimeTool {
  const maxConcurrency = opts.maxConcurrency ?? 5;
  const maxStepsPerAgent = opts.maxStepsPerAgent ?? 3;
  const defaultSystemPrompt = opts.defaultSystemPrompt;

  return {
    name: "spawn_agents",
    description:
      "Fork N child agents to execute sub-tasks concurrently and collect results. " +
      "Each child runs an independent AgentRuntime.  " +
      "Pass an array of tasks; receives an array of results in the same order. " +
      `Max concurrent children: ${maxConcurrency}.`,
    handler: async (args): Promise<SpawnAgentResult[]> => {
      const rawTasks = (args.tasks as SpawnAgentTask[] | undefined) ?? [];
      const tasks = rawTasks.slice(0, maxConcurrency);

      const settled = await Promise.allSettled(
        tasks.map(async (task, i): Promise<SpawnAgentResult> => {
          const child = new AgentRuntime({
            llm,
            maxSteps: task.maxSteps ?? maxStepsPerAgent,
            systemPrompt: task.systemPrompt ?? defaultSystemPrompt,
          });
          const result = await child.run(task.instruction);
          return {
            taskIndex: i,
            instruction: task.instruction,
            finalContent: result.finalContent,
            steps: result.steps.length,
          };
        }),
      );

      return settled.map((s, i): SpawnAgentResult => {
        if (s.status === "fulfilled") return s.value;
        return {
          taskIndex: i,
          instruction: tasks[i]?.instruction ?? "",
          finalContent: "",
          steps: 0,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        };
      });
    },
  };
}

// ── Swarm primitives (from jcode / 1jehuang/jcode) ───────────────────────────
//
// Extracted from jcode-swarm-core, jcode-plan, jcode-tool-types, and
// jcode-session-types. Fills the multi-agent coordination layer missing
// from AgentRuntime above (which handles single-agent step loops only).
//
// SwarmRole             — role within a swarm (Agent | Coordinator | WorktreeManager)
// SwarmLifecycleStatus  — 13-state lifecycle (Spawned → Done / Failed / Crashed …)
// SwarmMemberRecord     — durable serializable agent state
// ChannelIndex          — bidirectional pub/sub subscription index
// SessionStatus         — agent session lifecycle (Active | Closed | Crashed …)
// ResumeTarget          — typed session-resume discriminated union
// PlanItem              — swarm-level shared plan item (not session-local todos)
// SwarmTaskProgress     — 13 optional timestamp/counter fields for durable task tracking
// SwarmPlanDefinition   — versioned serializable plan snapshot
// SwarmExecutionState   — per-task runtime status snapshot
// VersionedPlan         — live plan with participant set + progress map + snapshot methods
// ToolOutput            — rich tool result with builder API (title, metadata, images)
// resolve_tool_name     — canonical alias normaliser (task→subagent, shell→bash …)

// ── SwarmRole ─────────────────────────────────────────────────────────────────

export type SwarmRole = "agent" | "coordinator" | "worktree_manager" | string;

export const SwarmRole = {
  Agent: "agent" as SwarmRole,
  Coordinator: "coordinator" as SwarmRole,
  WorktreeManager: "worktree_manager" as SwarmRole,
} as const;

// ── SwarmLifecycleStatus ──────────────────────────────────────────────────────

export type SwarmLifecycleStatus =
  | "spawned"
  | "ready"
  | "running"
  | "running_stale"
  | "completed"
  | "done"
  | "failed"
  | "stopped"
  | "crashed"
  | "queued"
  | "blocked"
  | "pending"
  | "todo"
  | string;

export const SwarmLifecycleStatus = {
  Spawned: "spawned" as SwarmLifecycleStatus,
  Ready: "ready" as SwarmLifecycleStatus,
  Running: "running" as SwarmLifecycleStatus,
  RunningStale: "running_stale" as SwarmLifecycleStatus,
  Completed: "completed" as SwarmLifecycleStatus,
  Done: "done" as SwarmLifecycleStatus,
  Failed: "failed" as SwarmLifecycleStatus,
  Stopped: "stopped" as SwarmLifecycleStatus,
  Crashed: "crashed" as SwarmLifecycleStatus,
  Queued: "queued" as SwarmLifecycleStatus,
  Blocked: "blocked" as SwarmLifecycleStatus,
  Pending: "pending" as SwarmLifecycleStatus,
  Todo: "todo" as SwarmLifecycleStatus,
} as const;

// ── SwarmMemberRecord ─────────────────────────────────────────────────────────

/**
 * Durable, serialisable state for a single swarm member.
 * Persisted at the server/swarm level; independent of session-local state.
 */
export interface SwarmMemberRecord {
  sessionId: string;
  workingDir?: string;
  swarmId?: string;
  swarmEnabled: boolean;
  status: SwarmLifecycleStatus;
  detail?: string;
  friendlyName?: string;
  /** Session that should receive completion reports from this member. */
  reportBackToSessionId?: string;
  latestCompletionReport?: string;
  role: SwarmRole;
  isHeadless: boolean;
}

// ── ChannelIndex ──────────────────────────────────────────────────────────────

/**
 * Bidirectional pub/sub subscription index for swarm channel routing.
 *
 * Maintains two parallel lookup trees:
 *   - by_swarm_channel: swarmId → channel → Set<sessionId>
 *   - by_session:       sessionId → swarmId → Set<channel>
 *
 * Both are kept in sync on subscribe/unsubscribe so lookups are O(1)
 * in either direction without a full table scan.
 */
export class ChannelIndex {
  readonly bySwarmChannel = new Map<string, Map<string, Set<string>>>();
  readonly bySession = new Map<string, Map<string, Set<string>>>();

  subscribe(sessionId: string, swarmId: string, channel: string): void {
    // by_swarm_channel
    if (!this.bySwarmChannel.has(swarmId)) this.bySwarmChannel.set(swarmId, new Map());
    const swarmSubs = this.bySwarmChannel.get(swarmId)!;
    if (!swarmSubs.has(channel)) swarmSubs.set(channel, new Set());
    swarmSubs.get(channel)!.add(sessionId);

    // by_session
    if (!this.bySession.has(sessionId)) this.bySession.set(sessionId, new Map());
    const sessionSubs = this.bySession.get(sessionId)!;
    if (!sessionSubs.has(swarmId)) sessionSubs.set(swarmId, new Set());
    sessionSubs.get(swarmId)!.add(channel);
  }

  unsubscribe(sessionId: string, swarmId: string, channel: string): void {
    const swarmMap = this.bySwarmChannel.get(swarmId);
    if (swarmMap) {
      const members = swarmMap.get(channel);
      if (members) {
        members.delete(sessionId);
        if (members.size === 0) swarmMap.delete(channel);
      }
      if (swarmMap.size === 0) this.bySwarmChannel.delete(swarmId);
    }

    const sessionMap = this.bySession.get(sessionId);
    if (sessionMap) {
      const channels = sessionMap.get(swarmId);
      if (channels) {
        channels.delete(channel);
        if (channels.size === 0) sessionMap.delete(swarmId);
      }
      if (sessionMap.size === 0) this.bySession.delete(sessionId);
    }
  }

  /** All session IDs subscribed to a given channel within a swarm. */
  getSubscribers(swarmId: string, channel: string): ReadonlySet<string> {
    return this.bySwarmChannel.get(swarmId)?.get(channel) ?? new Set();
  }

  /** All channels a session has subscribed to within a swarm. */
  getSessionChannels(sessionId: string, swarmId: string): ReadonlySet<string> {
    return this.bySession.get(sessionId)?.get(swarmId) ?? new Set();
  }
}

// ── SessionStatus ─────────────────────────────────────────────────────────────

export type SessionStatus =
  | { kind: "active" }
  | { kind: "closed" }
  | { kind: "crashed"; message?: string }
  | { kind: "reloaded" }
  | { kind: "compacted" }
  | { kind: "rate_limited" }
  | { kind: "error"; message: string };

export const SessionStatus = {
  active(): SessionStatus {
    return { kind: "active" };
  },
  closed(): SessionStatus {
    return { kind: "closed" };
  },
  crashed(message?: string): SessionStatus {
    return { kind: "crashed", message };
  },
  reloaded(): SessionStatus {
    return { kind: "reloaded" };
  },
  compacted(): SessionStatus {
    return { kind: "compacted" };
  },
  rateLimited(): SessionStatus {
    return { kind: "rate_limited" };
  },
  error(message: string): SessionStatus {
    return { kind: "error", message };
  },
} as const;

// ── ResumeTarget ──────────────────────────────────────────────────────────────

/**
 * Typed discriminated union for resuming a session from any supported agent backend.
 * Allows coordinators to resume sub-agent sessions across different runtimes.
 */
export type ResumeTarget =
  | { kind: "jcode"; sessionId: string }
  | { kind: "claude_code"; sessionId: string; sessionPath: string }
  | { kind: "codex"; sessionId: string; sessionPath: string }
  | { kind: "pi"; sessionPath: string }
  | { kind: "open_code"; sessionId: string; sessionPath: string };

export function resumeTargetId(target: ResumeTarget): string {
  switch (target.kind) {
    case "jcode":
      return target.sessionId;
    case "claude_code":
      return target.sessionId;
    case "codex":
      return target.sessionId;
    case "pi":
      return target.sessionPath;
    case "open_code":
      return target.sessionId;
  }
}

// ── Swarm plan types ──────────────────────────────────────────────────────────

/**
 * A single plan item shared across the swarm (distinct from session-local todos).
 * File scope and blocked_by enable dependency-aware scheduling.
 */
export interface PlanItem {
  id: string;
  content: string;
  status: string;
  priority: string;
  subsystem?: string;
  /** Files this task touches — used for conflict detection. */
  fileScope: string[];
  /** IDs of tasks that must complete before this one can start. */
  blockedBy: string[];
  assignedTo?: string;
}

/**
 * Durable runtime progress for a single swarm task.
 * All fields optional — populated progressively as the task advances.
 */
export interface SwarmTaskProgress {
  assignedSessionId?: string;
  assignmentSummary?: string;
  assignedAtMs?: number;
  startedAtMs?: number;
  lastHeartbeatMs?: number;
  lastDetail?: string;
  lastCheckpointMs?: number;
  checkpointSummary?: string;
  completedAtMs?: number;
  staleAlertMs?: number;
  heartbeatCount?: number;
  checkpointCount?: number;
}

/** Serialisable versioned plan definition (snapshot for persistence / wire). */
export interface SwarmPlanDefinition {
  version: number;
  participants: string[];
  items: Omit<PlanItem, "status" | "assignedTo">[];
}

/** Per-task execution status snapshot. */
export interface SwarmExecutionItemState {
  taskId: string;
  status: string;
  assignedTo?: string;
  progress?: SwarmTaskProgress;
}

/** Full runtime execution state snapshot (all tasks). */
export interface SwarmExecutionState {
  items: SwarmExecutionItemState[];
}

/**
 * Live versioned swarm plan with participant set and per-task progress.
 *
 * Separates plan definition (what to do) from execution state (how it's going).
 * Both are derivable as serialisable snapshots for persistence or wire transport.
 */
export class VersionedPlan {
  items: PlanItem[] = [];
  version = 0;
  participants = new Set<string>();
  taskProgress = new Map<string, SwarmTaskProgress>();

  /** Serialisable definition snapshot (no runtime state). */
  planDefinition(): SwarmPlanDefinition {
    return {
      version: this.version,
      participants: [...this.participants].sort(),
      items: this.items.map(({ id, content, priority, subsystem, fileScope, blockedBy }) => ({
        id,
        content,
        priority,
        subsystem,
        fileScope,
        blockedBy,
      })),
    };
  }

  /** Serialisable execution state snapshot (status + progress per task). */
  executionState(): SwarmExecutionState {
    return {
      items: this.items.map((item) => ({
        taskId: item.id,
        status: item.status,
        assignedTo: item.assignedTo,
        progress: this.taskProgress.get(item.id),
      })),
    };
  }

  /** Bump version counter (call after any mutation). */
  bump(): void {
    this.version++;
  }
}

// ── ToolOutput ────────────────────────────────────────────────────────────────

export interface ToolImageAttachment {
  mediaType: string;
  /** Base64-encoded image data. */
  data: string;
  label?: string;
}

/**
 * Rich tool result with optional title, JSON metadata, and image attachments.
 * Builder API makes multi-field construction ergonomic.
 *
 * @example
 * ```ts
 * const out = new ToolOutput('Found 3 results')
 *   .withTitle('Search Results')
 *   .withMetadata({ count: 3 })
 *   .withImage('image/png', base64Png, 'screenshot');
 * ```
 */
export class ToolOutput {
  output: string;
  title?: string;
  metadata?: unknown;
  images: ToolImageAttachment[] = [];

  constructor(output: string) {
    this.output = output;
  }

  withTitle(title: string): this {
    this.title = title;
    return this;
  }

  withMetadata(metadata: unknown): this {
    this.metadata = metadata;
    return this;
  }

  withImage(mediaType: string, data: string, label?: string): this {
    this.images.push({ mediaType, data, label });
    return this;
  }
}

/**
 * Normalise tool name aliases to canonical internal names.
 *
 * Providers present tools under various names (e.g. OAuth APIs use Claude Code
 * names like `file_grep`, `shell_exec`). This mapper ensures both forms resolve
 * to the same internal registry entry.
 *
 * @example
 * ```ts
 * resolveToolName('shell_exec') // → 'bash'
 * resolveToolName('read_file')  // → 'read'
 * resolveToolName('task')       // → 'subagent'
 * ```
 */
export function resolveToolName(name: string): string {
  switch (name) {
    case "communicate":
      return "swarm";
    case "task":
    case "task_runner":
      return "subagent";
    case "launch":
      return "open";
    case "shell":
    case "shell_exec":
      return "bash";
    case "read_file":
    case "file_read":
      return "read";
    case "write_file":
    case "file_write":
      return "write";
    case "edit_file":
    case "file_edit":
      return "edit";
    case "file_glob":
      return "glob";
    case "file_grep":
      return "grep";
    case "skill":
    case "Skill":
      return "skill_manage";
    case "todoread":
    case "todowrite":
    case "todo_read":
    case "todo_write":
    case "todos":
      return "todo";
    default:
      return name;
  }
}

// ── Enhanced message types (from jcode-message-types) ────────────────────────
//
// Extracted from jcode's message type layer. Adds provider-specific reasoning
// content blocks, cache control, ToolDefinition token estimation helpers, and
// a TokenUsageTotals struct with full cache telemetry breakdown.

/** Cache control metadata for prompt caching (ephemeral / persistent).
 *  Named PromptCacheControl to avoid colliding with the CacheControl class
 *  (HTTP cache policy helper) exported from this same module.
 */
export interface PromptCacheControl {
  type: "ephemeral" | "persistent";
  ttl?: string;
}

/** Factory helpers for PromptCacheControl — kept for backward compat. */
export const PromptCacheControlFactory = {
  ephemeral(ttl?: string): PromptCacheControl {
    return { type: "ephemeral", ttl };
  },
  persistent(): PromptCacheControl {
    return { type: "persistent" };
  },
} as const;

/**
 * Provider-aware content block union.
 *
 * Includes provider-specific reasoning variants:
 *   ReasoningTrace      — never replayed to provider (zero token cost on future turns).
 *   AnthropicThinking   — includes Anthropic signature required for multi-turn replay.
 *   OpenAIReasoning     — includes encrypted_content for OpenAI `store=false` stateless mode.
 */
export type ContentBlock =
  | { type: "text"; text: string; cache_control?: PromptCacheControl }
  | { type: "reasoning"; text: string }
  | { type: "reasoning_trace"; text: string } // captured for debugging, never replayed
  | { type: "anthropic_thinking"; thinking: string; signature: string }
  | {
      type: "open_ai_reasoning";
      id: string;
      summary: string[];
      encrypted_content?: string;
      status?: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      cache_control?: PromptCacheControl;
    }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/**
 * Tool definition advertised to model providers.
 * Includes token/char estimation helpers to audit tool bloat.
 */
export class ToolDefinition {
  readonly name: string;
  /**
   * Prompt-visible description sent to the model.
   * Approximate prompt cost: `description.length / 4` tokens.
   */
  readonly description: string;
  readonly inputSchema: unknown;

  constructor(name: string, description: string, inputSchema: unknown) {
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
  }

  /** Serialised byte length of the full tool payload sent to providers. */
  promptChars(): number {
    return JSON.stringify({
      name: this.name,
      description: this.description,
      input_schema: this.inputSchema,
    }).length;
  }

  /** Approximate token cost of the description only (chars / 4). */
  descriptionTokenEstimate(): number {
    return Math.ceil(this.description.length / 4);
  }

  /** Approximate token cost of the full tool payload (chars / 4). */
  promptTokenEstimate(): number {
    return Math.ceil(this.promptChars() / 4);
  }

  static aggregatePromptChars(defs: ToolDefinition[]): number {
    return defs.reduce((s, d) => s + d.promptChars(), 0);
  }

  static aggregatePromptTokenEstimate(defs: ToolDefinition[]): number {
    return defs.reduce((s, d) => s + d.promptTokenEstimate(), 0);
  }
}

/**
 * Cumulative token usage with full cache telemetry breakdown.
 * `cacheReportedInputTokens` may be lower than `inputTokens` for providers
 * that don't expose cache-read/write fields on every response.
 */
export interface TokenUsageTotals {
  messagesWithTokenUsage: number;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens from requests where provider reported cache telemetry. */
  cacheReportedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

// ── Codebuff Agent Runtime Schemas ────────────────────────────────────────────
// Extracted from: CodebuffAI/codebuff packages/agent-runtime/ + common/src/
// Covers: AgentDefinition, AgentState, AgentOutput, SkillDefinition, retry config, HttpError

/** Error with an HTTP statusCode attached — used by retry logic. */
export type HttpError = Error & { statusCode: number };

/** HTTP status codes that should trigger automatic retry. */
export const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/** Maximum retry attempts per agent message before permanent failure. */
export const AGENT_MAX_RETRIES_PER_MESSAGE = 3;
/** Base delay (ms) for exponential backoff. First retry: 1s, second: 2s, third: 4s. */
export const AGENT_RETRY_BACKOFF_BASE_MS = 1_000;
/** Maximum delay (ms) cap for exponential backoff. */
export const AGENT_RETRY_BACKOFF_MAX_MS = 8_000;
/** Duration (ms) to show the reconnection status banner before auto-hiding. */
export const AGENT_RECONNECTION_BANNER_MS = 2_000;
/** Delay (ms) before re-queuing messages after a successful reconnection. */
export const AGENT_RECONNECTION_RETRY_DELAY_MS = 500;
/** Default maximum steps an agent is allowed to take in a single run. */
export const AGENT_MAX_STEPS_DEFAULT = 200;

/** Create an HttpError with a specific status code. */
export function createHttpError(message: string, statusCode: number): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

/** Returns true if the error should trigger an automatic retry. */
export function isRetryableStatusCode(statusCode: number): boolean {
  return RETRYABLE_HTTP_STATUS_CODES.has(statusCode);
}

/** Extract an HTTP status code from an unknown error object. */
export function getErrorStatusCode(err: unknown): number | undefined {
  if (err && typeof (err as Record<string, unknown>)["statusCode"] === "number") {
    return (err as HttpError).statusCode;
  }
  return undefined;
}

/** Compute exponential backoff delay in ms for a given retry attempt (0-indexed). */
export function agentRetryBackoffMs(
  attempt: number,
  baseMs = AGENT_RETRY_BACKOFF_BASE_MS,
  maxMs = AGENT_RETRY_BACKOFF_MAX_MS,
): number {
  return Math.min(baseMs * Math.pow(2, attempt), maxMs);
}

/** Single tool call tracked in session state. */
export interface AgentToolCall {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** Sub-goal tracked within an agent context during a multi-step run. */
export interface AgentSubgoal {
  objective?: string;
  status?: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "ABORTED";
  plan?: string;
  logs: string[];
}

/** Full runtime state for an agent run. */
export interface AgentSessionState {
  agentId: string;
  agentType: string | null;
  agentContext: Record<string, AgentSubgoal>;
  ancestorRunIds: string[];
  runId?: string;
  childRunIds: string[];
  subagents: AgentSessionState[];
  stepsRemaining: number;
  creditsUsed: number;
  output?: Record<string, unknown>;
  parentId?: string;
  systemPrompt: string;
  toolDefinitions: Record<string, { description?: string; inputSchema: Record<string, unknown> }>;
  contextTokenCount: number;
}

/** Discriminated union for what an agent returns at the end of a run. */
export type AgentRunOutput =
  | { type: "structuredOutput"; value: Record<string, unknown> | null }
  | { type: "lastMessage"; value: unknown[] }
  | { type: "allMessages"; value: unknown[] }
  | { type: "error"; message: string; statusCode?: number; error?: string };

/** Metadata attached to a skill loaded from a SKILL.md file. */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  metadata?: Record<string, string>;
}

/** Full skill definition including content and file path. */
export interface SkillDefinition {
  name: string;
  description: string;
  license?: string;
  metadata?: Record<string, string>;
  /** Full SKILL.md content (includes frontmatter). */
  content: string;
  filePath: string;
}

/** Collection of skills keyed by skill name. */
export type SkillsMap = Record<string, SkillDefinition>;

/** Reasoning token options (OpenRouter pattern). */
export type AgentReasoningOptions =
  | { enabled?: boolean; exclude?: boolean; max_tokens: number }
  | {
      enabled?: boolean;
      exclude?: boolean;
      effort: "high" | "medium" | "low" | "minimal" | "none";
    };

/** Provider routing options for OpenRouter-compatible LLM backends. */
export interface AgentProviderOptions {
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  only?: string[];
  ignore?: string[];
  quantizations?: ("int4" | "int8" | "fp4" | "fp6" | "fp8" | "fp16" | "bf16" | "fp32")[];
  sort?: "price" | "throughput" | "latency";
  max_price?: { prompt?: number | string; completion?: number | string; request?: number | string };
}

/** MCP server config referenced by an agent definition. */
export interface AgentMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/**
 * Declarative agent definition — a portable blueprint for spawnable agents.
 * Compatible with Codebuff AgentDefinition and OpenRouter provider routing.
 */
export interface AgentDefinition {
  /** Unique lowercase-hyphenated identifier, e.g. "code-reviewer" */
  id: string;
  version?: string;
  publisher?: string;
  displayName: string;
  /** OpenRouter model slug, e.g. "anthropic/claude-fable-5" */
  model: string;
  reasoningOptions?: AgentReasoningOptions;
  providerOptions?: AgentProviderOptions;
  mcpServers?: Record<string, AgentMcpServerConfig>;
  toolNames?: string[];
  spawnableAgents?: string[];
  inputSchema?: {
    prompt?: { type: "string"; description?: string };
    params?: Record<string, unknown>;
  };
  outputMode?: "last_message" | "all_messages" | "structured_output";
  outputSchema?: Record<string, unknown>;
  spawnerPrompt?: string;
  systemPrompt?: string;
  instructionsPrompt?: string;
  stepPrompt?: string;
  includeMessageHistory?: boolean;
  inheritParentSystemPrompt?: boolean;
}

/** Context injected into an agent's step generator. */
export interface AgentStepContext {
  agentState: AgentSessionState;
  prompt?: string;
  params?: Record<string, unknown>;
  logger: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
    debug(msg: string, ctx?: Record<string, unknown>): void;
  };
}

/** Persona descriptor for a named built-in agent type. */
export interface AgentPersona {
  displayName: string;
  purpose: string;
  hidden?: boolean;
}

// ── Programmatic Tool Calling (PTC) ─────────────────────────────────────────────
//
// Round-trip tool calling pushes every intermediate tool result back into the
// model's context — expensive when a task needs many calls (read 30 files, grep
// them, return the 3 that matched). PTC gives the model ONE tool that runs a
// script it authors; the script calls other tools locally via `call()` and only
// its printed/returned output re-enters context. Intermediate results never cost
// context tokens. (Clean-room from hermes-agent's PTC idea.)
//
// SECURITY: the script runs in-process via the AsyncFunction constructor with the
// worker's privileges — the same trust model as the shell tool. Every `call()`
// is routed through the permission gate (no bypass), and execution is bounded by
// max calls, output size, and a cooperative async timeout. A synchronous infinite
// loop cannot be force-killed in-process (worker_thread isolation is a future
// hardening, mirroring run_command's sandbox follow-up).

// The AsyncFunction constructor isn't a global; derive it from an async fn's
// `.constructor` (typed `Function`, so no unsafe-any from getPrototypeOf).
const AsyncFunctionCtor = (async () => {
  /* probe */
}).constructor as new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;

function ptcSafeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function ptcClip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

function ptcWithTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Invoke a tool through the same two-tier permission check the runtime applies,
 * so callers (e.g. PTC scripts) cannot bypass the gate. Throws on denial or tool
 * error; otherwise returns the tool's raw output.
 */
export async function gatedInvoke(
  toolSet: RuntimeToolSet,
  permissionGate: PermissionGate | undefined,
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<unknown> {
  const tier = toolSet.get(name)?.tier ?? classifyTool(name);
  if (tier === "requires_permission" && permissionGate) {
    const decision = await permissionGate({
      toolName: name,
      args,
      tier,
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    });
    if (!decision.allowed) {
      throw new Error(`permission_denied: ${decision.reason ?? "tool call was not approved"}`);
    }
  }
  const result = await toolSet.invoke(name, args, ctx);
  if (result.error) throw new Error(result.error);
  return result.output;
}

export interface ProgrammaticToolOptions {
  /** The tool set the script may call into. */
  toolSet: RuntimeToolSet;
  /** Permission gate applied to every `call()` (same one the runtime uses). */
  permissionGate?: PermissionGate;
  /** Tool name (default "run_tool_script"). */
  name?: string;
  /** Max tool calls a single script may make (default 100). */
  maxCalls?: number;
  /** Cooperative timeout for the script in ms (default 60s). */
  timeoutMs?: number;
  /** Max chars of captured output returned to the model (default 16000). */
  maxOutputChars?: number;
  /** Tool names the script may not call (the PTC tool always excludes itself). */
  exclude?: readonly string[];
}

const PTC_DEFAULT_NAME = "run_tool_script";

/**
 * Build the PTC meta-tool. The model passes a JavaScript body that may
 * `await call(name, args)` other tools and `print(...)` results; only printed
 * output (plus any returned value) is handed back to the model.
 */
export function createProgrammaticToolTool(opts: ProgrammaticToolOptions): RuntimeTool {
  const name = opts.name ?? PTC_DEFAULT_NAME;
  const maxCalls = opts.maxCalls ?? 100;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOutput = opts.maxOutputChars ?? 16_000;
  const excluded = new Set<string>([name, ...(opts.exclude ?? [])]);

  const callableTools = (): { name: string; description: string }[] =>
    opts.toolSet
      .list()
      .filter((t) => !excluded.has(t.name))
      .map((t) => ({ name: t.name, description: t.description }));

  return {
    name,
    description:
      "Run a JavaScript snippet that orchestrates other tools WITHOUT returning each " +
      "intermediate result to the conversation — saving context tokens. Inside the script: " +
      "`await call(toolName, argsObject)` runs a tool and returns its output; `print(...values)` " +
      "appends to the output you get back; the script may also `return` a value. Best for " +
      "batching many calls (read/grep/filter many files, then surface only what matters). " +
      "Callable tools: " +
      callableTools()
        .map((t) => t.name)
        .join(", "),
    tier: "requires_permission",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "Async JavaScript body. In scope: `call(name, args)`, `print(...)`, and `tools` " +
            "(array of {name, description}). Example: `const out = await call('list_files', " +
            "{path:'src'}); for (const f of out.split('\\n')) if (f.endsWith('.ts')) print(f);`",
        },
      },
      required: ["code"],
    },
    handler: async (args, ctx) => {
      const code = String(args.code ?? "");
      if (!code.trim()) return "Error: empty script";

      const outputs: string[] = [];
      let calls = 0;
      const print = (...vals: unknown[]): void => {
        outputs.push(vals.map((v) => (typeof v === "string" ? v : ptcSafeJson(v))).join(" "));
      };
      const call = async (toolName: unknown, toolArgs?: unknown): Promise<unknown> => {
        if (ctx?.signal?.aborted) throw new Error("aborted");
        const tn = String(toolName);
        if (excluded.has(tn)) throw new Error(`tool '${tn}' is not callable from a script`);
        if (++calls > maxCalls) throw new Error(`script exceeded ${maxCalls} tool calls`);
        return gatedInvoke(
          opts.toolSet,
          opts.permissionGate,
          tn,
          (toolArgs ?? {}) as Record<string, unknown>,
          ctx,
        );
      };

      const fn = new AsyncFunctionCtor("call", "print", "tools", code);
      let returnLine = "";
      try {
        const ret = await ptcWithTimeout(
          fn(call, print, callableTools()),
          timeoutMs,
          `script timed out after ${timeoutMs}ms`,
        );
        if (ret !== undefined) {
          returnLine = `\n[return] ${typeof ret === "string" ? ret : ptcSafeJson(ret)}`;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const partial = outputs.join("\n");
        return ptcClip(`${partial}${partial ? "\n" : ""}[error] ${msg}`, maxOutput);
      }

      const combined = (outputs.join("\n") + returnLine).trim();
      return `${ptcClip(combined || "(script produced no output)", maxOutput)}\n[${calls} tool call(s)]`;
    },
  };
}
