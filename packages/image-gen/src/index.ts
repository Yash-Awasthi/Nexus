// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/image-gen — Text-to-image generation with injectable providers.
 *
 * Architecture
 * ─────────────
 *   ImageProvider    — core interface: prompt → GeneratedImage[]
 *   ImageGenerator   — wraps any provider with hook lifecycle, retry with
 *                      exponential backoff, and structured error surfacing
 *
 * Included providers
 * ───────────────────
 *   OpenAIImageProvider    — DALL-E 3 via OpenAI images/generations API
 *                            returns URL or base64 depending on response_format
 *   ReplicateProvider      — Flux / SDXL via Replicate Predictions API
 *                            two-phase: POST → poll until succeeded/failed
 *   NullImageProvider      — returns deterministic placeholder images (dev/tests)
 *
 * Hook integration
 * ─────────────────
 *   ImageGenerator emits via injectable VoiceHooks-compatible emitter:
 *     task.before  — with prompt, provider, n, width, height
 *     task.after   — with latencyMs, imageCount, provider
 *     task.error   — on terminal failure after all retries
 *
 * Retry policy
 * ─────────────
 *   ImageGenerator supports configurable maxAttempts (default: 1) with
 *   exponential backoff via an injectable sleep function.  Retry only
 *   applies to ImageGenError with code PROVIDER_ERROR (transient failures).
 *   AUTH_FAILED and INVALID_PROMPT are non-retryable.
 *
 * Usage
 * ─────
 * ```ts
 * import { ImageGenerator, OpenAIImageProvider } from "@nexus/image-gen";
 *
 * const gen = new ImageGenerator({
 *   provider: new OpenAIImageProvider({ apiKey: process.env.OPENAI_API_KEY }),
 *   hooks: globalHooks,
 *   maxAttempts: 2,
 * });
 *
 * const result = await gen.generate("A futuristic city at sunset", { n: 1 });
 * console.log(result.images[0].url);
 * ```
 */

// ── Error ─────────────────────────────────────────────────────────────────────

export type ImageGenErrorCode =
  | "PROVIDER_ERROR"
  | "AUTH_FAILED"
  | "INVALID_PROMPT"
  | "CONTENT_POLICY"
  | "POLL_TIMEOUT"
  | "PREDICTION_FAILED";

export class ImageGenError extends Error {
  readonly code: ImageGenErrorCode;
  readonly context?: Record<string, unknown>;
  /** Whether this error is safe to retry */
  readonly retryable: boolean;

  constructor(
    code: ImageGenErrorCode,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ImageGenError";
    this.code = code;
    this.context = context;
    this.retryable = code === "PROVIDER_ERROR";
  }
}

// ── Core types ────────────────────────────────────────────────────────────────

export type ImageFormat = "png" | "jpg" | "webp" | "gif";

/**
 * Standard size tokens (width × height).
 * Providers map these to their native resolutions.
 */
export type ImageSize =
  | "256x256"
  | "512x512"
  | "1024x1024"
  | "1792x1024"
  | "1024x1792";

export type ImageQuality = "standard" | "hd";
export type ImageStyle = "vivid" | "natural";

export interface GenerateOptions {
  /** Number of images to generate (default: 1) */
  n?: number;
  /** Output dimensions — provider interprets this (default: "1024x1024") */
  size?: ImageSize;
  /** Quality level (providers that support it) */
  quality?: ImageQuality;
  /** Visual style (OpenAI DALL-E 3 specific) */
  style?: ImageStyle;
  /** Output format (default: "png") */
  format?: ImageFormat;
  /**
   * Negative prompt — what to exclude.
   * Supported by Replicate / Stable Diffusion; ignored by DALL-E.
   */
  negativePrompt?: string;
  /** Seed for reproducibility (provider-specific) */
  seed?: number;
  /**
   * Inference steps — higher = more detail, slower.
   * Replicate: default 28. Ignored by DALL-E.
   */
  numInferenceSteps?: number;
  /**
   * Guidance scale — how closely to follow the prompt.
   * Replicate: default 3.5. Ignored by DALL-E.
   */
  guidanceScale?: number;
}

export interface GeneratedImage {
  /** Public URL to the image (may expire — download promptly) */
  url?: string;
  /** Raw image bytes (when provider returns base64 or binary) */
  data?: Uint8Array;
  format: ImageFormat;
  width: number;
  height: number;
  /**
   * The prompt actually used — OpenAI DALL-E 3 may revise the original prompt
   * for safety / quality reasons. `undefined` when provider does not disclose.
   */
  revisedPrompt?: string;
}

export interface ImageResult {
  /** The original prompt passed by the caller */
  prompt: string;
  images: GeneratedImage[];
  provider: string;
  /** Total wall-clock latency including all poll cycles */
  latencyMs: number;
  /** Number of retry attempts made (0 = first attempt succeeded) */
  attempts: number;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface ImageProvider {
  readonly name: string;
  generate(prompt: string, opts?: GenerateOptions): Promise<GeneratedImage[]>;
}

// ── Null provider ─────────────────────────────────────────────────────────────

/**
 * No-op provider — returns placeholder images without any network calls.
 * Each image has zero-byte data and configurable dimensions.
 */
export class NullImageProvider implements ImageProvider {
  readonly name = "null";

  constructor(
    private readonly defaults: {
      width?: number;
      height?: number;
      format?: ImageFormat;
    } = {},
  ) {}

  async generate(
    _prompt: string,
    opts?: GenerateOptions,
  ): Promise<GeneratedImage[]> {
    const [w, h] = parseSize(opts?.size ?? "1024x1024");
    const count = opts?.n ?? 1;
    return Array.from({ length: count }, () => ({
      data: new Uint8Array(0),
      format: opts?.format ?? this.defaults.format ?? "png",
      width: this.defaults.width ?? w,
      height: this.defaults.height ?? h,
    }));
  }
}

// ── Shared utilities ──────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

function parseSize(size: ImageSize): [number, number] {
  const [w, h] = size.split("x").map(Number);
  return [w ?? 1024, h ?? 1024];
}

// ── OpenAI DALL-E 3 provider ──────────────────────────────────────────────────

export interface OpenAIImageConfig {
  /** OpenAI API key — defaults to process.env.OPENAI_API_KEY */
  apiKey?: string;
  /** Model to use. Default: "dall-e-3" */
  model?: string;
  /**
   * Response format from OpenAI.
   * "url"    — returns a time-limited CDN URL (default)
   * "b64_json" — returns base64-encoded image bytes
   */
  responseFormat?: "url" | "b64_json";
  /** Injectable fetch */
  fetch?: FetchFn;
}

interface OpenAIImageResponse {
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai-dalle";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly responseFormat: "url" | "b64_json";
  private readonly fetchFn: FetchFn;

  private static readonly ENDPOINT = "https://api.openai.com/v1/images/generations";

  constructor(config: OpenAIImageConfig = {}) {
    this.apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    this.model = config.model ?? "dall-e-3";
    this.responseFormat = config.responseFormat ?? "url";
    this.fetchFn = config.fetch ?? fetch;
  }

  async generate(
    prompt: string,
    opts: GenerateOptions = {},
  ): Promise<GeneratedImage[]> {
    if (!prompt.trim()) {
      throw new ImageGenError("INVALID_PROMPT", "Prompt must not be empty");
    }

    const n = opts.n ?? 1;
    const size = opts.size ?? "1024x1024";
    const [width, height] = parseSize(size);

    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      n,
      size,
      response_format: this.responseFormat,
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(opts.style ? { style: opts.style } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchFn(OpenAIImageProvider.ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new ImageGenError(
        "PROVIDER_ERROR",
        `OpenAI network error: ${String(cause)}`,
        { model: this.model },
      );
    }

    if (res.status === 401) {
      throw new ImageGenError("AUTH_FAILED", "OpenAI API key is invalid or missing");
    }

    if (res.status === 400) {
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      const msg = json.error?.message ?? "Bad request";
      const isPolicy = msg.toLowerCase().includes("content policy") || msg.toLowerCase().includes("safety");
      throw new ImageGenError(
        isPolicy ? "CONTENT_POLICY" : "INVALID_PROMPT",
        `OpenAI rejected prompt: ${msg}`,
        { prompt },
      );
    }

    if (!res.ok) {
      throw new ImageGenError(
        "PROVIDER_ERROR",
        `OpenAI API returned ${res.status}`,
        { model: this.model, status: res.status },
      );
    }

    let json: OpenAIImageResponse;
    try {
      json = (await res.json()) as OpenAIImageResponse;
    } catch (cause) {
      throw new ImageGenError("PROVIDER_ERROR", `Invalid JSON from OpenAI: ${String(cause)}`);
    }

    const format = opts.format ?? "png";

    return json.data.map((item) => {
      const image: GeneratedImage = { format, width, height };
      if (item.url) image.url = item.url;
      if (item.b64_json) {
        image.data = Buffer.from(item.b64_json, "base64");
      }
      if (item.revised_prompt) image.revisedPrompt = item.revised_prompt;
      return image;
    });
  }
}

// ── Replicate provider ────────────────────────────────────────────────────────

export interface ReplicateConfig {
  /** Replicate API token — defaults to process.env.REPLICATE_API_TOKEN */
  apiToken?: string;
  /**
   * Model version in the format "owner/model" or "owner/model:version".
   * Default: "black-forest-labs/flux-1.1-pro" (latest tag)
   */
  model?: string;
  /**
   * Poll interval in ms while waiting for the prediction to complete.
   * Default: 1000ms. Inject 0 in tests.
   */
  pollIntervalMs?: number;
  /**
   * Max time in ms to wait for a prediction (default: 120_000).
   */
  timeoutMs?: number;
  /** Injectable fetch */
  fetch?: FetchFn;
  /** Injectable sleep for testing without real delays */
  sleep?: SleepFn;
}

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string };
}

export class ReplicateProvider implements ImageProvider {
  readonly name = "replicate";

  private readonly apiToken: string;
  private readonly model: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: SleepFn;

  private static readonly BASE = "https://api.replicate.com/v1";

  constructor(config: ReplicateConfig = {}) {
    this.apiToken = config.apiToken ?? process.env["REPLICATE_API_TOKEN"] ?? "";
    this.model = config.model ?? "black-forest-labs/flux-1.1-pro";
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.fetchFn = config.fetch ?? fetch;
    this.sleepFn = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async generate(
    prompt: string,
    opts: GenerateOptions = {},
  ): Promise<GeneratedImage[]> {
    if (!prompt.trim()) {
      throw new ImageGenError("INVALID_PROMPT", "Prompt must not be empty");
    }

    const [width, height] = parseSize(opts.size ?? "1024x1024");
    const input: Record<string, unknown> = {
      prompt,
      width,
      height,
      ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.numInferenceSteps !== undefined ? { num_inference_steps: opts.numInferenceSteps } : {}),
      ...(opts.guidanceScale !== undefined ? { guidance_scale: opts.guidanceScale } : {}),
      num_outputs: opts.n ?? 1,
    };

    // ── Create prediction ────────────────────────────────────────────────────
    const createUrl = this.model.includes(":")
      ? `${ReplicateProvider.BASE}/predictions`
      : `${ReplicateProvider.BASE}/models/${this.model}/predictions`;

    let createRes: Response;
    try {
      createRes = await this.fetchFn(createUrl, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiToken}`,
          "Content-Type": "application/json",
          Prefer: "respond-async",
        },
        body: JSON.stringify(
          this.model.includes(":")
            ? { version: this.model.split(":")[1], input }
            : { input },
        ),
      });
    } catch (cause) {
      throw new ImageGenError(
        "PROVIDER_ERROR",
        `Replicate network error: ${String(cause)}`,
      );
    }

    if (createRes.status === 401) {
      throw new ImageGenError("AUTH_FAILED", "Replicate API token is invalid or missing");
    }
    if (!createRes.ok) {
      throw new ImageGenError(
        "PROVIDER_ERROR",
        `Replicate create returned ${createRes.status}`,
        { model: this.model, status: createRes.status },
      );
    }

    let prediction = (await createRes.json()) as ReplicatePrediction;

    // ── Poll until done ──────────────────────────────────────────────────────
    const deadline = Date.now() + this.timeoutMs;
    while (prediction.status === "starting" || prediction.status === "processing") {
      if (Date.now() >= deadline) {
        throw new ImageGenError(
          "POLL_TIMEOUT",
          `Replicate prediction ${prediction.id} timed out after ${this.timeoutMs}ms`,
          { predictionId: prediction.id },
        );
      }

      if (this.pollIntervalMs > 0) {
        await this.sleepFn(this.pollIntervalMs);
      }

      const pollUrl =
        prediction.urls?.get ??
        `${ReplicateProvider.BASE}/predictions/${prediction.id}`;

      let pollRes: Response;
      try {
        pollRes = await this.fetchFn(pollUrl, {
          headers: { Authorization: `Token ${this.apiToken}` },
        });
      } catch (cause) {
        throw new ImageGenError(
          "PROVIDER_ERROR",
          `Replicate poll network error: ${String(cause)}`,
        );
      }

      if (!pollRes.ok) {
        throw new ImageGenError(
          "PROVIDER_ERROR",
          `Replicate poll returned ${pollRes.status}`,
        );
      }

      prediction = (await pollRes.json()) as ReplicatePrediction;
    }

    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new ImageGenError(
        "PREDICTION_FAILED",
        `Replicate prediction ${prediction.status}: ${prediction.error ?? "unknown error"}`,
        { predictionId: prediction.id, status: prediction.status },
      );
    }

    // ── Parse output ─────────────────────────────────────────────────────────
    const format = opts.format ?? "png";
    const rawOutput = prediction.output;
    const urls: string[] = Array.isArray(rawOutput)
      ? rawOutput.filter(Boolean)
      : rawOutput
        ? [rawOutput]
        : [];

    return urls.map((url) => ({ url, format, width, height }));
  }
}

// ── Hook emitter (local re-declaration) ──────────────────────────────────────

export interface ImageHooks {
  emit(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ handled: number; aborted: boolean; errors: unknown[] }>;
}

// ── ImageGenerator ────────────────────────────────────────────────────────────

export interface ImageGeneratorConfig {
  provider: ImageProvider;
  hooks?: ImageHooks;
  /** Max total attempts including the first (default: 1 — no retry) */
  maxAttempts?: number;
  /**
   * Base delay in ms for exponential backoff between retries (default: 500).
   * Actual delay = baseDelayMs * 2^(attempt - 1).
   */
  baseDelayMs?: number;
  /** Injectable sleep for tests */
  sleep?: SleepFn;
  /** Name for hook payloads (default: "image-gen") */
  name?: string;
}

export class ImageGenerator {
  private readonly provider: ImageProvider;
  private readonly hooks?: ImageHooks;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleepFn: SleepFn;
  private readonly name: string;

  constructor(config: ImageGeneratorConfig) {
    this.provider = config.provider;
    this.hooks = config.hooks;
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 1);
    this.baseDelayMs = config.baseDelayMs ?? 500;
    this.sleepFn = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.name = config.name ?? "image-gen";
  }

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<ImageResult> {
    const start = Date.now();
    const n = opts.n ?? 1;

    // ── Hook: task.before ────────────────────────────────────────────────────
    await this._emit("task.before", {
      gen: this.name,
      provider: this.provider.name,
      prompt,
      n,
      size: opts.size ?? "1024x1024",
    });

    let lastError: ImageGenError | undefined;
    let attempts = 0;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      attempts = attempt;
      try {
        const images = await this.provider.generate(prompt, opts);
        const latencyMs = Date.now() - start;

        await this._emit("task.after", {
          gen: this.name,
          provider: this.provider.name,
          latencyMs,
          imageCount: images.length,
          attempts,
        });

        return { prompt, images, provider: this.provider.name, latencyMs, attempts };
      } catch (cause) {
        const err =
          cause instanceof ImageGenError
            ? cause
            : new ImageGenError(
                "PROVIDER_ERROR",
                `Unexpected error: ${String(cause)}`,
              );

        lastError = err;

        // Non-retryable errors — bail immediately
        if (!err.retryable || attempt === this.maxAttempts) break;

        // Exponential backoff before next attempt
        const delay = this.baseDelayMs * Math.pow(2, attempt - 1);
        await this.sleepFn(delay);
      }
    }

    await this._emit("task.error", {
      gen: this.name,
      provider: this.provider.name,
      prompt,
      attempts,
      error: lastError?.message,
      code: lastError?.code,
    });

    throw lastError!;
  }

  private async _emit(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.hooks) return;
    try {
      await this.hooks.emit(event, payload);
    } catch {
      // Hook errors are non-fatal
    }
  }
}
