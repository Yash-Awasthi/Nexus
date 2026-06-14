// SPDX-License-Identifier: Apache-2.0
/**
 * agent-runtime — Step execution loop for multi-step LLM agents.
 *
 * Provides:
 *   • StepInput / StepOutput  — typed step I/O
 *   • ToolStreamParser        — parse tool calls from streamed LLM output
 *   • StrReplaceProcessor     — apply str_replace tool calls to a file map
 *   • CacheControl            — per-step cache control headers/policies
 *   • AgentStepExecutor       — run a single step (prompt → tool calls → results)
 *   • AgentRuntime            — multi-step loop with abort handling
 *   • RuntimeToolSet          — assemble a typed tool set for a run
 *   • MockLlmStream           — injectable streaming LLM test double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type RuntimeModel = string;

export interface ToolCallRaw {
  name: string;
  arguments: Record<string, unknown>;
  callId?: string;
}

export interface ToolResult {
  callId?: string;
  name: string;
  output: unknown;
  error?: string;
}

export interface StepInput {
  stepIndex: number;
  instruction: string;
  toolResults?: ToolResult[];
  cacheControl?: CacheControlPolicy;
  abortSignal?: AbortSignal;
}

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

export interface CacheControlHeader {
  policy: CacheControlPolicy;
  maxAgeMs?: number;
  staleWhileRevalidateMs?: number;
}

export const CACHE_POLICIES: Record<CacheControlPolicy, CacheControlHeader> = {
  "no-cache":   { policy: "no-cache" },
  "ephemeral":  { policy: "ephemeral",  maxAgeMs: 60_000 },
  "persistent": { policy: "persistent", maxAgeMs: 3_600_000, staleWhileRevalidateMs: 60_000 },
};

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
    const calls: ToolCallRaw[] = [];
    const regex = /\[TOOL:(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
    let match: RegExpExecArray | null;
    const consumed: string[] = [];

    while ((match = regex.exec(this.buffer)) !== null) {
      const name = match[1]!;
      const argStr = match[2]!.trim();
      try {
        const args = JSON.parse(argStr);
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
    return text.replace(/\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g, "").trim();
  }

  reset(): void { this.buffer = ""; }
  getBuffer(): string { return this.buffer; }
}

// ── StrReplaceProcessor ───────────────────────────────────────────────────────

export interface StrReplaceCall {
  path: string;
  oldStr: string;
  newStr: string;
}

export interface StrReplaceResult {
  path: string;
  success: boolean;
  replaced: boolean;
  error?: string;
}

export class StrReplaceProcessor {
  private files: Map<string, string>;

  constructor(files: Map<string, string> = new Map()) {
    this.files = files;
  }

  process(call: StrReplaceCall): StrReplaceResult {
    const content = this.files.get(call.path);
    if (content === undefined) {
      return { path: call.path, success: false, replaced: false, error: `File not found: ${call.path}` };
    }
    if (!content.includes(call.oldStr)) {
      return { path: call.path, success: false, replaced: false, error: "String not found in file" };
    }
    this.files.set(call.path, content.replace(call.oldStr, call.newStr));
    return { path: call.path, success: true, replaced: true };
  }

  processAll(calls: StrReplaceCall[]): StrReplaceResult[] {
    return calls.map((c) => this.process(c));
  }

  getFile(path: string): string | undefined { return this.files.get(path); }
  setFile(path: string, content: string): void { this.files.set(path, content); }
  snapshot(): Record<string, string> { return Object.fromEntries(this.files); }
}

// ── RuntimeToolSet ────────────────────────────────────────────────────────────

export interface RuntimeTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export class RuntimeToolSet {
  private tools = new Map<string, RuntimeTool>();

  add(tool: RuntimeTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): RuntimeTool | undefined { return this.tools.get(name); }
  has(name: string): boolean { return this.tools.has(name); }
  names(): string[] { return [...this.tools.keys()]; }
  list(): RuntimeTool[] { return [...this.tools.values()]; }

  async invoke(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { name, output: null, error: `Tool not found: ${name}` };
    }
    try {
      const output = await tool.handler(args);
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

export class MockLlmStream {
  private chunks: string[];
  private delayMs: number;
  readonly calls: string[] = [];

  constructor(chunks: string[] = ["Response text"], delayMs = 0) {
    this.chunks = chunks;
    this.delayMs = delayMs;
  }

  asStream(): LlmStreamFn {
    return async function* (this: MockLlmStream, _sys: string, user: string, opts?: { signal?: AbortSignal }) {
      this.calls.push(user);
      for (const chunk of this.chunks) {
        if (opts?.signal?.aborted) return;
        if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
        yield chunk;
      }
    }.bind(this);
  }
}

// ── AgentStepExecutor ─────────────────────────────────────────────────────────

export interface StepExecutorOptions {
  llm: LlmStreamFn;
  toolSet: RuntimeToolSet;
  systemPrompt: string;
}

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
      for await (const chunk of this.llm(this.systemPrompt, userPrompt, { signal: input.abortSignal })) {
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

export interface RuntimeResult {
  steps: StepOutput[];
  finalContent: string;
  totalTokens: number;
  aborted: boolean;
  totalDurationMs: number;
}

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

  getExecutor(): AgentStepExecutor { return this.executor; }
}
