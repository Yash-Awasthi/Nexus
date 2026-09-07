// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-engine — Pluggable agent engine abstraction.
 *
 * Inspired by containarium's engine interface.
 * Provides a harness-agnostic interface for running agents across
 * different providers (Claude, Codex, Gemini, etc.) with consistent
 * configuration and result handling.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface EngineConfig {
  /** Model identifier (engine-specific) */
  model: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /** MCP server command for tool access */
  agentBoxCommand?: string;
  /** Arguments for the MCP server */
  agentBoxArgs?: string[];
  /** Maximum agentic turns (tool-use round trips) */
  maxTurns: number;
  /** Maximum tokens per response */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
}

export interface EngineResult {
  /** Agent's final output */
  output: string;
  /** Parsed JSON output if applicable */
  outputJson?: unknown;
  /** Usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Cost in USD if available */
  cost?: number;
  /** Number of tool calls made */
  toolCallCount: number;
  /** Total turns taken */
  turns: number;
  /** Duration in milliseconds */
  durationMs: number;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

// ── Missions (long-horizon autonomous runs) ─────────────────────────────────

export {
  MissionRunner,
  type MissionPhase,
  type MissionProgress,
  type MissionRecord,
  type MissionReview,
  type MissionSpawnTask,
  type MissionStatus,
  type MissionStore,
} from "./mission.js";

/** Executes a tool call requested by the model; returns the result text fed back. */
export type ToolExecutor = (call: ToolCall) => string | Promise<string>;

// ── Engine Interface ─────────────────────────────────────────────────────────

export interface Engine {
  readonly name: string;
  run(task: string, config: EngineConfig): Promise<EngineResult>;
}

// ── Built-in Engines ─────────────────────────────────────────────────────────

/**
 * OpenAI-compatible engine (works with OpenAI, Groq, etc.)
 */
export class OpenAIEngine implements Engine {
  readonly name = "openai";

  constructor(
    private baseUrl: string = "https://api.openai.com/v1",
    private apiKey?: string,
    private executeTool: ToolExecutor = () => "No tool executor configured for this engine.",
  ) {}

  async run(task: string, config: EngineConfig): Promise<EngineResult> {
    const start = Date.now();
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: config.systemPrompt },
      { role: "user", content: task },
    ];

    let totalTurns = 0;
    let output = "";
    let toolCallCount = 0;

    for (let turn = 0; turn < config.maxTurns; turn++) {
      totalTurns++;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: config.maxTokens ?? 4096,
          temperature: config.temperature ?? 0.7,
        }),
      });

      const data = (await resp.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const message = data.choices[0]?.message;
      if (!message) break;

      // Execute any tool calls the model requested and feed results back
      // (OpenAI tool-calling protocol: assistant tool_calls + tool-role
      // messages carrying tool_call_id).
      if (message.tool_calls && message.tool_calls.length > 0) {
        toolCallCount += message.tool_calls.length;
        messages.push({
          role: "assistant",
          content: message.content ?? "",
          tool_calls: message.tool_calls.map((c) => ({
            id: c.id,
            type: "function",
            function: c.function,
          })),
        });
        for (const call of message.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          } catch {
            // Malformed arguments: feed the parse failure back so the model can retry.
          }
          let result: string;
          try {
            result = await this.executeTool({ name: call.function.name, arguments: args });
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        continue;
      }

      output = message.content ?? "";
      break;
    }

    return {
      output,
      toolCallCount,
      turns: totalTurns,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Anthropic Claude engine
 */
export class ClaudeEngine implements Engine {
  readonly name = "claude";

  constructor(private apiKey?: string) {}

  async run(task: string, config: EngineConfig): Promise<EngineResult> {
    const start = Date.now();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        system: config.systemPrompt,
        messages: [{ role: "user", content: task }],
        max_tokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
      }),
    });

    const data = (await resp.json()) as {
      content?: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const output = data.content?.[0]?.text ?? "";

    return {
      output,
      toolCallCount: 0,
      turns: 1,
      durationMs: Date.now() - start,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  }
}

// ── Engine Registry ──────────────────────────────────────────────────────────

export class EngineRegistry {
  private engines: Map<string, Engine> = new Map();

  register(engine: Engine): void {
    this.engines.set(engine.name, engine);
  }

  get(name: string): Engine | undefined {
    return this.engines.get(name);
  }

  list(): Engine[] {
    return Array.from(this.engines.values());
  }

  /**
   * Auto-detect engine from model name.
   */
  resolveEngine(model: string): Engine {
    if (model.startsWith("claude"))
      return this.engines.get("claude") ?? this.engines.values().next().value!;
    if (model.startsWith("gpt"))
      return this.engines.get("openai") ?? this.engines.values().next().value!;
    return this.engines.values().next().value!;
  }
}

export default EngineRegistry;
