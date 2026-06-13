// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/voice — Speech-to-Text transcription, Text-to-Speech synthesis,
 * and turn-based voice session management.
 *
 * Architecture
 * ─────────────
 *   AudioBuffer        — raw audio data with format + sample-rate metadata
 *   TranscribeProvider — STT: AudioBuffer → transcript string
 *   SynthesizeProvider — TTS: text → AudioBuffer (optional — omit for text-only sessions)
 *   VoiceHandler       — text in → text out (wire in any agent or LLM call)
 *   VoiceSession       — orchestrates one voice turn:
 *                          audio in → transcribe → handler → synthesize → audio out
 *
 * Included providers
 * ───────────────────
 *   GroqTranscribeProvider — Whisper via Groq API (whisper-large-v3-turbo, injectable fetch)
 *   ElevenLabsSynthesizeProvider — TTS via ElevenLabs API (injectable fetch)
 *   NullTranscribeProvider  — returns a fixed transcript string (dev / tests)
 *   NullSynthesizeProvider  — returns a zero-byte mp3 buffer (dev / tests)
 *
 * Hook integration
 * ─────────────────
 *   VoiceSession emits:
 *     task.before  — before transcription starts (with audioBytes, format)
 *     task.after   — after synthesis completes (with transcript, latencyMs)
 *   Hook errors are collected but never propagated.
 *
 * Usage
 * ─────
 * ```ts
 * import { VoiceSession, GroqTranscribeProvider, NullSynthesizeProvider } from "@nexus/voice";
 *
 * const session = new VoiceSession({
 *   transcribe: new GroqTranscribeProvider({ apiKey: process.env.GROQ_API_KEY }),
 *   synthesize: new NullSynthesizeProvider(),
 *   handler: async (text) => `You said: ${text}`,
 * });
 *
 * const result = await session.process({ data: wavBytes, format: "wav", sampleRate: 16000 });
 * console.log(result.transcript, result.response);
 * ```
 *
 * Zero hard inter-package dependencies.
 */

// ── Error ─────────────────────────────────────────────────────────────────────

export type VoiceErrorCode =
  | "TRANSCRIBE_FAILED"
  | "SYNTHESIZE_FAILED"
  | "HANDLER_FAILED"
  | "INVALID_AUDIO"
  | "PROVIDER_AUTH_FAILED";

export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: VoiceErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
    this.context = context;
  }
}

// ── Audio types ───────────────────────────────────────────────────────────────

export type AudioFormat = "wav" | "mp3" | "ogg" | "flac" | "webm" | "m4a";

export interface AudioBuffer {
  /** Raw audio bytes */
  data: Uint8Array;
  format: AudioFormat;
  /** Sample rate in Hz (e.g. 16000, 22050, 44100) */
  sampleRate: number;
  /** Duration in seconds — optional; used for logging/metrics */
  durationSeconds?: number;
}

// ── Provider interfaces ───────────────────────────────────────────────────────

/**
 * Speech-to-Text provider.  Implementations must be injectable for testing.
 */
export interface TranscribeProvider {
  readonly name: string;
  transcribe(audio: AudioBuffer, opts?: TranscribeOptions): Promise<TranscribeResult>;
}

export interface TranscribeOptions {
  /** BCP-47 language code hint (e.g. "en", "es", "fr"). Leave undefined for auto-detect. */
  language?: string;
  /** Prompt to guide the model's output style / vocabulary */
  prompt?: string;
  /** Temperature for transcript sampling (0 = deterministic, default: 0) */
  temperature?: number;
}

export interface TranscribeResult {
  /** The transcribed text */
  transcript: string;
  /** Detected or supplied language code */
  language?: string;
  /** Duration of the audio in seconds (from provider) */
  durationSeconds?: number;
  /** Latency of this transcription call in ms */
  latencyMs: number;
}

/**
 * Text-to-Speech provider.  Omit when only transcription is needed.
 */
export interface SynthesizeProvider {
  readonly name: string;
  synthesize(text: string, opts?: SynthesizeOptions): Promise<AudioBuffer>;
}

export interface SynthesizeOptions {
  /** Voice ID or name (provider-specific) */
  voice?: string;
  /** Speaking rate / speed (1.0 = normal) */
  speed?: number;
  /** Output audio format (default: "mp3") */
  format?: AudioFormat;
}

// ── Null providers ────────────────────────────────────────────────────────────

/**
 * Null STT provider — always returns a fixed transcript.
 * Useful for tests and text-only pipelines.
 */
export class NullTranscribeProvider implements TranscribeProvider {
  readonly name = "null-transcribe";

  constructor(private readonly fixedTranscript = "") {}

  async transcribe(_audio: AudioBuffer, _opts?: TranscribeOptions): Promise<TranscribeResult> {
    return { transcript: this.fixedTranscript, latencyMs: 0 };
  }
}

/**
 * Null TTS provider — always returns a zero-byte mp3 buffer.
 * Useful for tests and server-side pipelines where audio output is not needed.
 */
export class NullSynthesizeProvider implements SynthesizeProvider {
  readonly name = "null-synthesize";

  async synthesize(_text: string, opts?: SynthesizeOptions): Promise<AudioBuffer> {
    return {
      data: new Uint8Array(0),
      format: opts?.format ?? "mp3",
      sampleRate: 24000,
    };
  }
}

// ── Groq Whisper STT provider ─────────────────────────────────────────────────

export type FetchFn = typeof fetch;

export interface GroqTranscribeConfig {
  /** Groq API key — defaults to process.env.GROQ_API_KEY */
  apiKey?: string;
  /**
   * Whisper model to use.
   * Default: "whisper-large-v3-turbo" (fast, accurate, free-tier)
   * Alternative: "whisper-large-v3" (higher accuracy, slower)
   */
  model?: string;
  /** Injectable fetch for testability */
  fetch?: FetchFn;
}

interface GroqTranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  x_groq?: { id: string };
}

/**
 * STT provider backed by Groq's Whisper API.
 * Submits audio as multipart/form-data to the OpenAI-compatible transcriptions endpoint.
 */
export class GroqTranscribeProvider implements TranscribeProvider {
  readonly name = "groq-whisper";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;

  private static readonly ENDPOINT =
    "https://api.groq.com/openai/v1/audio/transcriptions";

  constructor(config: GroqTranscribeConfig = {}) {
    this.apiKey = config.apiKey ?? process.env["GROQ_API_KEY"] ?? "";
    this.model = config.model ?? "whisper-large-v3-turbo";
    this.fetchFn = config.fetch ?? fetch;
  }

  async transcribe(audio: AudioBuffer, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    if (!audio.data || audio.data.length === 0) {
      throw new VoiceError("INVALID_AUDIO", "Audio buffer is empty");
    }

    const start = Date.now();

    const form = new FormData();
    const blob = new Blob([audio.data], { type: this._mimeType(audio.format) });
    form.append("file", blob, `audio.${audio.format}`);
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    if (opts.language) form.append("language", opts.language);
    if (opts.prompt) form.append("prompt", opts.prompt);
    if (opts.temperature !== undefined) {
      form.append("temperature", String(opts.temperature));
    }

    let res: Response;
    try {
      res = await this.fetchFn(GroqTranscribeProvider.ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (cause) {
      throw new VoiceError(
        "TRANSCRIBE_FAILED",
        `Groq Whisper network error: ${String(cause)}`,
        { model: this.model },
      );
    }

    if (res.status === 401) {
      throw new VoiceError("PROVIDER_AUTH_FAILED", "Groq API key is invalid or missing");
    }

    if (!res.ok) {
      throw new VoiceError(
        "TRANSCRIBE_FAILED",
        `Groq Whisper API returned ${res.status}`,
        { model: this.model, status: res.status },
      );
    }

    let json: GroqTranscriptionResponse;
    try {
      json = (await res.json()) as GroqTranscriptionResponse;
    } catch (cause) {
      throw new VoiceError("TRANSCRIBE_FAILED", `Invalid JSON from Groq: ${String(cause)}`);
    }

    const transcript = json.text?.trim() ?? "";

    return {
      transcript,
      language: json.language,
      durationSeconds: json.duration,
      latencyMs: Date.now() - start,
    };
  }

  private _mimeType(format: AudioFormat): string {
    const map: Record<AudioFormat, string> = {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      flac: "audio/flac",
      webm: "audio/webm",
      m4a: "audio/mp4",
    };
    return map[format];
  }
}

// ── ElevenLabs TTS provider ───────────────────────────────────────────────────

export interface ElevenLabsConfig {
  /** ElevenLabs API key — defaults to process.env.ELEVENLABS_API_KEY */
  apiKey?: string;
  /**
   * Default voice ID.
   * Default: "21m00Tcm4TlvDq8ikWAM" (Rachel — neutral, clear)
   */
  defaultVoice?: string;
  /**
   * TTS model ID.
   * Default: "eleven_turbo_v2_5" (low-latency, high quality)
   */
  model?: string;
  /** Injectable fetch */
  fetch?: FetchFn;
}

interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  speed?: number;
}

/**
 * TTS provider backed by ElevenLabs API.
 * Returns an MP3 AudioBuffer for any text input.
 */
export class ElevenLabsSynthesizeProvider implements SynthesizeProvider {
  readonly name = "elevenlabs";

  private readonly apiKey: string;
  private readonly defaultVoice: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;

  private static readonly BASE = "https://api.elevenlabs.io/v1";

  constructor(config: ElevenLabsConfig = {}) {
    this.apiKey = config.apiKey ?? process.env["ELEVENLABS_API_KEY"] ?? "";
    this.defaultVoice = config.defaultVoice ?? "21m00Tcm4TlvDq8ikWAM";
    this.model = config.model ?? "eleven_turbo_v2_5";
    this.fetchFn = config.fetch ?? fetch;
  }

  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<AudioBuffer> {
    const voiceId = opts.voice ?? this.defaultVoice;
    const url = `${ElevenLabsSynthesizeProvider.BASE}/text-to-speech/${voiceId}`;

    const voiceSettings: ElevenLabsVoiceSettings = {
      stability: 0.5,
      similarity_boost: 0.75,
      ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
          voice_settings: voiceSettings,
        }),
      });
    } catch (cause) {
      throw new VoiceError(
        "SYNTHESIZE_FAILED",
        `ElevenLabs network error: ${String(cause)}`,
      );
    }

    if (res.status === 401) {
      throw new VoiceError("PROVIDER_AUTH_FAILED", "ElevenLabs API key is invalid or missing");
    }

    if (!res.ok) {
      throw new VoiceError(
        "SYNTHESIZE_FAILED",
        `ElevenLabs API returned ${res.status}`,
        { voiceId, status: res.status },
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      data: new Uint8Array(arrayBuffer),
      format: opts.format ?? "mp3",
      sampleRate: 24000,
    };
  }
}

// ── VoiceSession ──────────────────────────────────────────────────────────────

/**
 * Turn-based voice handler — text in, text out.
 * Wire in LibrarianAgent.recall, ResearcherAgent.research, or any async text fn.
 */
export type VoiceHandler = (transcript: string) => Promise<string>;

/** Minimal hook emitter — structurally compatible with @nexus/hooks HookRegistry */
export interface VoiceHooks {
  emit(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ handled: number; aborted: boolean; errors: unknown[] }>;
}

export interface VoiceSessionConfig {
  transcribe: TranscribeProvider;
  /** If omitted, VoiceTurnResult.audio will be undefined */
  synthesize?: SynthesizeProvider;
  handler: VoiceHandler;
  hooks?: VoiceHooks;
  /** Session name used in hook payloads (default: "voice-session") */
  name?: string;
  /** Default transcribe options applied to every turn */
  transcribeOpts?: TranscribeOptions;
  /** Default synthesize options applied to every turn */
  synthesizeOpts?: SynthesizeOptions;
}

export interface VoiceTurnOptions {
  /** Per-turn language override */
  language?: string;
  /** Per-turn voice override */
  voice?: string;
  /** Skip synthesis for this turn (overrides config) */
  textOnly?: boolean;
}

export interface VoiceTurnResult {
  /** The transcribed text from the audio input */
  transcript: string;
  /** The handler's text response */
  response: string;
  /** Synthesized speech output (undefined when synthesize not wired or textOnly:true) */
  audio?: AudioBuffer;
  /** Wall-clock latency for the full turn in ms */
  latencyMs: number;
  /** Time spent in transcription in ms */
  transcribeMs: number;
  /** Time spent in handler in ms */
  handlerMs: number;
  /** Time spent in synthesis in ms (undefined when skipped) */
  synthesizeMs?: number;
  /** Language detected / used during transcription */
  language?: string;
}

export class VoiceSession {
  private readonly transcribe: TranscribeProvider;
  private readonly synthesize?: SynthesizeProvider;
  private readonly handler: VoiceHandler;
  private readonly hooks?: VoiceHooks;
  private readonly name: string;
  private readonly transcribeOpts: TranscribeOptions;
  private readonly synthesizeOpts: SynthesizeOptions;

  constructor(config: VoiceSessionConfig) {
    this.transcribe = config.transcribe;
    this.synthesize = config.synthesize;
    this.handler = config.handler;
    this.hooks = config.hooks;
    this.name = config.name ?? "voice-session";
    this.transcribeOpts = config.transcribeOpts ?? {};
    this.synthesizeOpts = config.synthesizeOpts ?? {};
  }

  /**
   * Process one voice turn: audio in → transcript → handler response → audio out.
   */
  async process(audio: AudioBuffer, opts: VoiceTurnOptions = {}): Promise<VoiceTurnResult> {
    const turnStart = Date.now();

    // ── Validate input ──────────────────────────────────────────────────────
    if (!audio.data || audio.data.length === 0) {
      throw new VoiceError("INVALID_AUDIO", "Cannot process an empty audio buffer");
    }

    // ── Hook: task.before ────────────────────────────────────────────────────
    await this._emit("task.before", {
      session: this.name,
      audioBytes: audio.data.length,
      format: audio.format,
      sampleRate: audio.sampleRate,
    });

    // ── 1. Transcribe ────────────────────────────────────────────────────────
    const transcribeStart = Date.now();
    let transcribeResult: TranscribeResult;
    try {
      transcribeResult = await this.transcribe.transcribe(audio, {
        ...this.transcribeOpts,
        ...(opts.language ? { language: opts.language } : {}),
      });
    } catch (cause) {
      if (cause instanceof VoiceError) throw cause;
      throw new VoiceError(
        "TRANSCRIBE_FAILED",
        `Transcription failed: ${String(cause)}`,
        { provider: this.transcribe.name },
      );
    }
    const transcribeMs = Date.now() - transcribeStart;

    const transcript = transcribeResult.transcript;

    // ── 2. Handler ───────────────────────────────────────────────────────────
    const handlerStart = Date.now();
    let response: string;
    try {
      response = await this.handler(transcript);
    } catch (cause) {
      throw new VoiceError(
        "HANDLER_FAILED",
        `Voice handler threw: ${String(cause)}`,
        { transcript },
      );
    }
    const handlerMs = Date.now() - handlerStart;

    // ── 3. Synthesize ────────────────────────────────────────────────────────
    let audio_out: AudioBuffer | undefined;
    let synthesizeMs: number | undefined;

    const shouldSynthesize = this.synthesize && !opts.textOnly;
    if (shouldSynthesize && response) {
      const synthStart = Date.now();
      try {
        audio_out = await this.synthesize!.synthesize(response, {
          ...this.synthesizeOpts,
          ...(opts.voice ? { voice: opts.voice } : {}),
        });
      } catch (cause) {
        if (cause instanceof VoiceError) throw cause;
        throw new VoiceError(
          "SYNTHESIZE_FAILED",
          `Synthesis failed: ${String(cause)}`,
          { provider: this.synthesize!.name, responseLength: response.length },
        );
      }
      synthesizeMs = Date.now() - synthStart;
    }

    const latencyMs = Date.now() - turnStart;

    // ── Hook: task.after ─────────────────────────────────────────────────────
    await this._emit("task.after", {
      session: this.name,
      transcript,
      responseLength: response.length,
      latencyMs,
      transcribeMs,
      handlerMs,
      synthesizeMs,
      language: transcribeResult.language,
    });

    return {
      transcript,
      response,
      audio: audio_out,
      latencyMs,
      transcribeMs,
      handlerMs,
      synthesizeMs,
      language: transcribeResult.language,
    };
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

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Create an AudioBuffer from a raw byte array with sensible defaults.
 */
export function createAudioBuffer(
  data: Uint8Array | ArrayBuffer | number[],
  format: AudioFormat,
  sampleRate = 16000,
  durationSeconds?: number,
): AudioBuffer {
  const bytes =
    data instanceof Uint8Array
      ? data
      : Array.isArray(data)
        ? new Uint8Array(data)
        : new Uint8Array(data);
  return { data: bytes, format, sampleRate, durationSeconds };
}
