// SPDX-License-Identifier: Apache-2.0

// ── MLX model configuration ───────────────────────────────────────────────────

export interface MLXModelConfig {
  /** Hugging Face model ID or local path (e.g. "mlx-community/Llama-3.2-3B-Instruct-4bit"). */
  modelPath: string;
  /** Max context window size (default: 4096). */
  contextSize?: number;
  /** Quantisation level (default: "none" — use whatever the model ships with). */
  quantize?: "4bit" | "8bit" | "none";
  /** Random seed for reproducibility. */
  seed?: number;
  /** Additional model metadata. */
  metadata?: Record<string, unknown>;
}

// ── Generate types ────────────────────────────────────────────────────────────

export interface MLXGenerateOpts {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
  seed?: number;
  stopSequences?: string[];
}

export interface MLXGenerateResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  stopReason?: "eos" | "max_tokens" | "stop_sequence";
}

// ── IMLXBridge ────────────────────────────────────────────────────────────────

export interface IMLXBridge {
  readonly loaded: boolean;
  readonly modelPath: string | undefined;
  /** Load (or download) a model. Idempotent if same model is already loaded. */
  load(config: MLXModelConfig): Promise<void>;
  /** Generate a completion for the given prompt. Requires load() to have been called. */
  generate(prompt: string, opts?: MLXGenerateOpts): Promise<MLXGenerateResult>;
  /** Release the loaded model from memory. */
  unload(): Promise<void>;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class MLXError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "MLXError";
    this.code = code;
  }
}

// ── NullMLXBridge ─────────────────────────────────────────────────────────────

/** Deterministic in-memory bridge for unit testing. */
export class NullMLXBridge implements IMLXBridge {
  private _loaded = false;
  private _modelPath: string | undefined;
  private _config: MLXModelConfig | undefined;

  readonly loadCalls: MLXModelConfig[] = [];
  readonly generateCalls: Array<{ prompt: string; opts?: MLXGenerateOpts }> = [];
  readonly unloadCalls: number[] = [];

  /** Override the response returned by generate(). */
  setResponse(response: Partial<MLXGenerateResult>): void {
    this._response = response;
  }
  private _response: Partial<MLXGenerateResult> = {};

  get loaded(): boolean { return this._loaded; }
  get modelPath(): string | undefined { return this._modelPath; }
  get config(): MLXModelConfig | undefined { return this._config; }

  async load(config: MLXModelConfig): Promise<void> {
    this.loadCalls.push(config);
    this._config = config;
    this._modelPath = config.modelPath;
    this._loaded = true;
  }

  async generate(prompt: string, opts?: MLXGenerateOpts): Promise<MLXGenerateResult> {
    if (!this._loaded) {
      throw new MLXError("No model loaded. Call load() first.", "NOT_LOADED");
    }
    this.generateCalls.push({ prompt, opts });

    const words = prompt.split(/\s+/).length;
    return {
      text: this._response.text ?? `[MLX response to: ${prompt.slice(0, 40)}]`,
      promptTokens: this._response.promptTokens ?? Math.ceil(prompt.length / 4),
      completionTokens: this._response.completionTokens ?? words,
      latencyMs: this._response.latencyMs ?? 10,
      stopReason: this._response.stopReason ?? "eos",
    };
  }

  async unload(): Promise<void> {
    this.unloadCalls.push(Date.now());
    this._loaded = false;
    this._modelPath = undefined;
    this._config = undefined;
  }
}

// ── LLM provider types (minimal inline) ──────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface LLMResponse {
  id: string;
  model: string;
  content: string;
  provider: string;
  latencyMs?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface LLMProvider {
  name: string;
  models: string[];
  complete(req: LLMRequest): Promise<LLMResponse>;
}

// ── Chat prompt formatter ─────────────────────────────────────────────────────

/** Convert chat messages into a single prompt string using a simple Llama-style template. */
export function formatChatPrompt(messages: LLMMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        parts.push(`<|system|>\n${m.content}<|end|>`);
        break;
      case "user":
        parts.push(`<|user|>\n${m.content}<|end|>`);
        break;
      case "assistant":
        parts.push(`<|assistant|>\n${m.content}<|end|>`);
        break;
      case "tool":
        parts.push(`<|tool|>\n${m.content}<|end|>`);
        break;
    }
  }
  parts.push("<|assistant|>");
  return parts.join("\n");
}

// ── MLXLLMProvider ────────────────────────────────────────────────────────────

let _idSeq = 0;
function genId(): string {
  return `mlx_${Date.now()}_${_idSeq++}`;
}

/**
 * LLMProvider backed by an IMLXBridge.
 * Loads the model on first call to complete() if not already loaded.
 */
export class MLXLLMProvider implements LLMProvider {
  private _loadPromise: Promise<void> | undefined;

  constructor(
    private readonly bridge: IMLXBridge,
    private readonly config: MLXModelConfig,
    private readonly formatPrompt: (messages: LLMMessage[]) => string = formatChatPrompt,
  ) {}

  get name(): string {
    return `mlx(${this.config.modelPath})`;
  }

  get models(): string[] {
    return [this.config.modelPath];
  }

  private async ensureLoaded(): Promise<void> {
    if (this.bridge.loaded) return;
    if (!this._loadPromise) {
      this._loadPromise = this.bridge.load(this.config).finally(() => {
        this._loadPromise = undefined;
      });
    }
    return this._loadPromise;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    await this.ensureLoaded();

    const prompt = this.formatPrompt(req.messages);
    const result = await this.bridge.generate(prompt, {
      maxTokens: req.maxTokens,
      temperature: req.temperature as number | undefined,
    });

    return {
      id: genId(),
      model: this.config.modelPath,
      content: result.text,
      provider: "mlx",
      latencyMs: result.latencyMs,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.promptTokens + result.completionTokens,
      },
    };
  }

  async unload(): Promise<void> {
    await this.bridge.unload();
  }
}

// ── MLX filesystem types (injectable) ────────────────────────────────────────

export interface MLXFsLike {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
}

// ── MLXModelPersister ─────────────────────────────────────────────────────────

export interface PersistedMLXState {
  config: MLXModelConfig;
  savedAt: number;
  metadata?: Record<string, unknown>;
}

/** Persists MLX model configurations to a filesystem (injectable). */
export class MLXModelPersister {
  private static readonly _ext = ".mlx.json";

  async save(key: string, config: MLXModelConfig, fs: MLXFsLike, dir = "."): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const state: PersistedMLXState = { config, savedAt: Date.now() };
    await fs.writeFile(`${dir}/${key}${this._ext()}`, JSON.stringify(state, null, 2));
  }

  async load(key: string, fs: MLXFsLike, dir = "."): Promise<PersistedMLXState | undefined> {
    const path = `${dir}/${key}${this._ext()}`;
    if (!(await fs.exists(path))) return undefined;
    const json = await fs.readFile(path);
    return JSON.parse(json) as PersistedMLXState;
  }

  async list(dir: string, fs: MLXFsLike): Promise<string[]> {
    const entries = await fs.readdir(dir);
    const ext = this._ext();
    return entries
      .filter((e) => e.endsWith(ext))
      .map((e) => e.slice(0, -ext.length));
  }

  private _ext(): string {
    return MLXModelPersister._ext;
  }
}

// ── NullMLXFs ─────────────────────────────────────────────────────────────────

export class NullMLXFs implements MLXFsLike {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  async mkdir(path: string): Promise<void> { this.dirs.add(path); }
  async writeFile(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return Array.from(this.files.keys())
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length).split("/")[0]!)
      .filter((k, i, a) => a.indexOf(k) === i);
  }
}
