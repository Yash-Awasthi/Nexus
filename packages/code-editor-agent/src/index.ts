// SPDX-License-Identifier: Apache-2.0
/**
 * code-editor-agent — Multi-model code editor with structured tool execution.
 *
 * Provides:
 *   • EditorModel          — supported model identifiers
 *   • EditorTool           — write_file | str_replace tool types
 *   • ThinkScaffold        — wraps prompt in <think> tags for reasoning models
 *   • WriteFileTool        — writes file content to a path
 *   • StrReplaceTool       — replaces exact string in a file
 *   • EditorToolExecutor   — dispatches tool calls to injected handlers
 *   • StructuredEditOutput — parsed structured response from model
 *   • CodeEditorAgent      — multi-model editor with spawn + execute lifecycle
 *   • MockModelBackend     — injectable test double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type EditorModel = "claude-opus-4" | "gpt-5" | "deepseek-coder" | "kimi-k2" | "minimax-code";

/** Editor tool name type alias. */
export type EditorToolName = "write_file" | "str_replace";

/** Write file params interface definition. */
export interface WriteFileParams {
  path: string;
  content: string;
}

/** Str replace params interface definition. */
export interface StrReplaceParams {
  path: string;
  oldStr: string;
  newStr: string;
}

/** Editor tool params type alias. */
export type EditorToolParams = WriteFileParams | StrReplaceParams;

/** Editor tool call interface definition. */
export interface EditorToolCall {
  tool: EditorToolName;
  params: EditorToolParams;
}

/** Structured edit output interface definition. */
export interface StructuredEditOutput {
  model: EditorModel;
  thinking?: string; // content extracted from <think> tags
  explanation: string;
  toolCalls: EditorToolCall[];
  tokensUsed?: number;
}

// ── ThinkScaffold ─────────────────────────────────────────────────────────────

/** Reasoning models (e.g. deepseek, kimi) use <think>…</think> scaffolding. */
const REASONING_MODELS = new Set<EditorModel>(["deepseek-coder", "kimi-k2"]);

/** Think scaffold. */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ThinkScaffold {
  static isReasoningModel(model: EditorModel): boolean {
    return REASONING_MODELS.has(model);
  }

  static wrapPrompt(prompt: string, model: EditorModel): string {
    if (!this.isReasoningModel(model)) return prompt;
    return `<think>\nAnalyze the task carefully before making edits.\n</think>\n\n${prompt}`;
  }

  static extractThinking(text: string): { thinking: string | undefined; rest: string } {
    if (text.length > 100_000) return { thinking: undefined, rest: text };
    const match = /<think>([\s\S]*?)<\/think>/i.exec(text);
    if (!match) return { thinking: undefined, rest: text };
    const thinking = match[1]!.trim();
    const rest = text.replace(match[0], "").trim();
    return { thinking, rest };
  }
}

// ── WriteFileTool ─────────────────────────────────────────────────────────────

export type FileSystem = {
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
};

/** Write file tool. */
export class WriteFileTool {
  private fs: FileSystem;

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  async execute(
    params: WriteFileParams,
  ): Promise<{ success: boolean; path: string; error?: string }> {
    try {
      await this.fs.write(params.path, params.content);
      return { success: true, path: params.path };
    } catch (err) {
      return {
        success: false,
        path: params.path,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── StrReplaceTool ────────────────────────────────────────────────────────────

export class StrReplaceTool {
  private fs: FileSystem;

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  async execute(
    params: StrReplaceParams,
  ): Promise<{ success: boolean; path: string; replaced: boolean; error?: string }> {
    try {
      const content = await this.fs.read(params.path);
      if (!content.includes(params.oldStr)) {
        return { success: false, path: params.path, replaced: false, error: "String not found" };
      }
      const updated = content.replace(params.oldStr, params.newStr);
      await this.fs.write(params.path, updated);
      return { success: true, path: params.path, replaced: true };
    } catch (err) {
      return {
        success: false,
        path: params.path,
        replaced: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── InMemoryFileSystem ────────────────────────────────────────────────────────

export class InMemoryFileSystem implements FileSystem {
  private files = new Map<string, string>();

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async read(path: string): Promise<string> {
    if (!this.files.has(path)) throw new Error(`File not found: ${path}`);
    return this.files.get(path)!;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files.entries());
  }
}

// ── EditorToolExecutor ────────────────────────────────────────────────────────

export interface ToolExecutionResult {
  tool: EditorToolName;
  success: boolean;
  path: string;
  error?: string;
}

/** Editor tool executor. */
export class EditorToolExecutor {
  private writeFile: WriteFileTool;
  private strReplace: StrReplaceTool;

  constructor(fs: FileSystem) {
    this.writeFile = new WriteFileTool(fs);
    this.strReplace = new StrReplaceTool(fs);
  }

  async execute(call: EditorToolCall): Promise<ToolExecutionResult> {
    if (call.tool === "write_file") {
      const result = await this.writeFile.execute(call.params as WriteFileParams);
      return { tool: "write_file", ...result };
    } else {
      const result = await this.strReplace.execute(call.params as StrReplaceParams);
      return {
        tool: "str_replace",
        success: result.success,
        path: result.path,
        error: result.error,
      };
    }
  }

  async executeAll(calls: EditorToolCall[]): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (const call of calls) {
      results.push(await this.execute(call));
    }
    return results;
  }
}

// ── MockModelBackend ──────────────────────────────────────────────────────────

export interface ModelResponse {
  text: string;
  tokensUsed?: number;
}

/** Model backend type alias. */
export type ModelBackend = (
  model: EditorModel,
  systemPrompt: string,
  userPrompt: string,
) => Promise<ModelResponse>;

/** Mock model backend. */
export class MockModelBackend {
  readonly calls: { model: EditorModel; prompt: string }[] = [];
  private response: ModelResponse | ((model: EditorModel, prompt: string) => ModelResponse);

  constructor(
    response: ModelResponse | ((m: EditorModel, p: string) => ModelResponse) = {
      text: "No changes needed.",
      tokensUsed: 10,
    },
  ) {
    this.response = response;
  }

  asBackend(): ModelBackend {
    return async (model, _sys, userPrompt) => {
      this.calls.push({ model, prompt: userPrompt });
      if (typeof this.response === "function") {
        return this.response(model, userPrompt);
      }
      return this.response;
    };
  }
}

// ── CodeEditorAgent ───────────────────────────────────────────────────────────

export interface EditorAgentOptions {
  model?: EditorModel;
  fs?: FileSystem;
  backend: ModelBackend;
  maxToolCalls?: number;
}

/** Edit request interface definition. */
export interface EditRequest {
  instruction: string;
  filePaths?: string[];
  context?: string;
}

/** Edit result interface definition. */
export interface EditResult {
  output: StructuredEditOutput;
  toolResults: ToolExecutionResult[];
  durationMs: number;
}

/** Code editor agent. */
export class CodeEditorAgent {
  private model: EditorModel;
  private executor: EditorToolExecutor;
  private backend: ModelBackend;
  private fs: FileSystem;
  private maxToolCalls: number;

  constructor(opts: EditorAgentOptions) {
    this.model = opts.model ?? "claude-opus-4";
    this.fs = opts.fs ?? new InMemoryFileSystem();
    this.backend = opts.backend;
    this.executor = new EditorToolExecutor(this.fs);
    this.maxToolCalls = opts.maxToolCalls ?? 10;
  }

  private buildSystemPrompt(): string {
    return [
      "You are a code editor agent. Your task is to modify code files as instructed.",
      "Use write_file to create or overwrite files.",
      "Use str_replace to make targeted replacements.",
      "Provide a brief explanation of your changes.",
      `Available tools: write_file, str_replace.`,
      `Model: ${this.model}.`,
    ].join(" ");
  }

  private parseToolCalls(text: string): EditorToolCall[] {
    const calls: EditorToolCall[] = [];
    // Parse [WRITE_FILE path]...content...[/WRITE_FILE] blocks
    const writeRegex = /\[WRITE_FILE\s+([^\]]+)\]([\s\S]*?)\[\/WRITE_FILE\]/g;
    let m: RegExpExecArray | null;
    while ((m = writeRegex.exec(text)) !== null) {
      calls.push({ tool: "write_file", params: { path: m[1]!.trim(), content: m[2]!.trim() } });
    }
    // Parse [STR_REPLACE path]OLD[SEP]NEW[/STR_REPLACE] blocks
    const replaceRegex = /\[STR_REPLACE\s+([^\]]+)\]([\s\S]*?)\[SEP\]([\s\S]*?)\[\/STR_REPLACE\]/g;
    while ((m = replaceRegex.exec(text)) !== null) {
      calls.push({
        tool: "str_replace",
        params: { path: m[1]!.trim(), oldStr: m[2]!.trim(), newStr: m[3]!.trim() },
      });
    }
    return calls.slice(0, this.maxToolCalls);
  }

  async edit(request: EditRequest): Promise<EditResult> {
    const t0 = Date.now();
    const wrappedPrompt = ThinkScaffold.wrapPrompt(
      [
        request.instruction,
        request.filePaths ? `Files: ${request.filePaths.join(", ")}` : "",
        request.context ? `Context: ${request.context}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      this.model,
    );

    const systemPrompt = this.buildSystemPrompt();
    const response = await this.backend(this.model, systemPrompt, wrappedPrompt);

    const { thinking, rest } = ThinkScaffold.extractThinking(response.text);
    const toolCalls = this.parseToolCalls(rest);
    const toolResults = await this.executor.executeAll(toolCalls);

    return {
      output: {
        model: this.model,
        thinking,
        explanation: rest,
        toolCalls,
        tokensUsed: response.tokensUsed,
      },
      toolResults,
      durationMs: Date.now() - t0,
    };
  }

  getModel(): EditorModel {
    return this.model;
  }
  getFileSystem(): FileSystem {
    return this.fs;
  }

  static spawnerPrompt(): string {
    return [
      "Spawn a code editor agent when you need to create or modify files.",
      "Supported models: claude-opus-4, gpt-5, deepseek-coder, kimi-k2, minimax-code.",
      "Provide clear instructions and file paths.",
    ].join(" ");
  }
}
