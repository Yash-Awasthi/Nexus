// SPDX-License-Identifier: Apache-2.0
/**
 * general-agent — Spawnable multi-model general-purpose agent.
 *
 * Provides:
 *   • AgentModel          — supported model identifiers
 *   • ReasoningEffort     — low | medium | high
 *   • SubAgentSpec        — spec for spawning a child agent
 *   • AgentResponse       — typed agent output
 *   • GeneralAgentOptions — configuration (model, no history, file injection)
 *   • GeneralAgent        — executes a single task (no conversation history)
 *   • SubAgentSpawner     — spawns child agents from a spec list
 *   • MockAgentBackend    — injectable test double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentModel = "gpt-5" | "claude-opus-4";
export type ReasoningEffort = "low" | "medium" | "high";

export interface SubAgentSpec {
  name: string;
  description: string;
  model?: AgentModel;
  effort?: ReasoningEffort;
  filePaths?: string[];
}

export interface AgentResponse {
  content: string;
  model: AgentModel;
  tokensUsed?: number;
  subAgentsSpawned?: string[];
  filePaths?: string[];
  durationMs: number;
}

export interface AgentTask {
  instruction: string;
  filePaths?: string[];
  context?: string;
  subAgentSpecs?: SubAgentSpec[];
}

// ── MockAgentBackend ──────────────────────────────────────────────────────────

export type AgentBackend = (
  model: AgentModel,
  systemPrompt: string,
  instruction: string,
) => Promise<{ content: string; tokensUsed?: number }>;

export class MockAgentBackend {
  readonly calls: Array<{ model: AgentModel; instruction: string }> = [];
  private content: string;

  constructor(content = "Task completed successfully.") {
    this.content = content;
  }

  asBackend(): AgentBackend {
    return async (model, _sys, instruction) => {
      this.calls.push({ model, instruction });
      return { content: this.content, tokensUsed: 20 };
    };
  }

  setContent(content: string): void { this.content = content; }
}

// ── GeneralAgent ──────────────────────────────────────────────────────────────

export interface GeneralAgentOptions {
  model?: AgentModel;
  effort?: ReasoningEffort;
  backend: AgentBackend;
  /** Inject file paths into system prompt context. */
  injectFilePaths?: boolean;
  systemPromptOverride?: string;
}

export class GeneralAgent {
  private model: AgentModel;
  private effort: ReasoningEffort;
  private backend: AgentBackend;
  private injectFilePaths: boolean;
  private systemPromptOverride?: string;

  constructor(opts: GeneralAgentOptions) {
    this.model           = opts.model    ?? "gpt-5";
    this.effort          = opts.effort   ?? "medium";
    this.backend         = opts.backend;
    this.injectFilePaths = opts.injectFilePaths ?? false;
    this.systemPromptOverride = opts.systemPromptOverride;
  }

  private buildSystemPrompt(filePaths?: string[]): string {
    if (this.systemPromptOverride) return this.systemPromptOverride;

    const lines = [
      "You are a general-purpose AI agent.",
      `Reasoning effort: ${this.effort}.`,
      "Complete the given task thoroughly and concisely.",
      "No conversation history is maintained — each task is independent.",
    ];

    if (this.injectFilePaths && filePaths && filePaths.length > 0) {
      lines.push(`Working files: ${filePaths.join(", ")}`);
    }

    return lines.join(" ");
  }

  /** Execute a single task. Note: no conversation history by design. */
  async run(task: AgentTask): Promise<AgentResponse> {
    const t0 = Date.now();
    const systemPrompt = this.buildSystemPrompt(task.filePaths);

    let instruction = task.instruction;
    if (task.context) {
      instruction += `\n\nContext:\n${task.context}`;
    }

    const result = await this.backend(this.model, systemPrompt, instruction);

    return {
      content: result.content,
      model: this.model,
      tokensUsed: result.tokensUsed,
      filePaths: task.filePaths,
      subAgentsSpawned: task.subAgentSpecs?.map((s) => s.name),
      durationMs: Date.now() - t0,
    };
  }

  getModel(): AgentModel { return this.model; }
  getEffort(): ReasoningEffort { return this.effort; }

  static spawnerPrompt(): string {
    return [
      "Spawn a general agent for broad task execution.",
      "Models: gpt-5 (default), claude-opus-4.",
      "Effort: low | medium | high. No conversation history maintained.",
      "Provide a single clear instruction per task.",
    ].join(" ");
  }
}

// ── SubAgentSpawner ───────────────────────────────────────────────────────────

export interface SpawnResult {
  name: string;
  response: AgentResponse;
  error?: string;
}

export class SubAgentSpawner {
  private backend: AgentBackend;

  constructor(backend: AgentBackend) {
    this.backend = backend;
  }

  async spawn(spec: SubAgentSpec, instruction: string): Promise<SpawnResult> {
    const agent = new GeneralAgent({
      model: spec.model ?? "gpt-5",
      effort: spec.effort ?? "medium",
      backend: this.backend,
      injectFilePaths: true,
    });

    try {
      const response = await agent.run({
        instruction,
        filePaths: spec.filePaths,
      });
      return { name: spec.name, response };
    } catch (err) {
      return {
        name: spec.name,
        response: {
          content: "",
          model: spec.model ?? "gpt-5",
          durationMs: 0,
        },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async spawnAll(specs: SubAgentSpec[], instruction: string): Promise<SpawnResult[]> {
    return Promise.all(specs.map((spec) => this.spawn(spec, instruction)));
  }
}

// ── AgentResponseFormatter ────────────────────────────────────────────────────

export class AgentResponseFormatter {
  format(response: AgentResponse): string {
    const lines = [
      `Model: ${response.model}`,
      `Effort-based duration: ${response.durationMs}ms`,
    ];
    if (response.tokensUsed) lines.push(`Tokens: ${response.tokensUsed}`);
    if (response.filePaths?.length) lines.push(`Files: ${response.filePaths.join(", ")}`);
    if (response.subAgentsSpawned?.length) lines.push(`Sub-agents: ${response.subAgentsSpawned.join(", ")}`);
    lines.push("", response.content);
    return lines.join("\n");
  }

  extractSubAgentNames(response: AgentResponse): string[] {
    return response.subAgentsSpawned ?? [];
  }
}
