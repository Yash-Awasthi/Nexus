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

export interface RuntimeTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

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
