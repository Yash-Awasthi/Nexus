// SPDX-License-Identifier: Apache-2.0
/**
 * Voice routes — STT/TTS + turn-based chat, backed by @nexus/voice.
 *
 * POST /api/v1/voice/chat         — text in → assistant text out (no audio needed)
 * POST /api/v1/voice/transcribe   — audio bytes → transcript string
 * POST /api/v1/voice/synthesize   — text → audio bytes (mp3)
 * GET  /api/v1/voice/voices       — list available TTS voices
 * GET  /api/v1/voice/providers    — list configured STT/TTS providers
 */

import { OllamaDriver } from "@nexus/llm-drivers";
import {
  VoiceSession,
  NullTranscribeProvider,
  NullSynthesizeProvider,
  NullVadProvider,
  GroqTranscribeProvider,
  ElevenLabsSynthesizeProvider,
  DeepgramTranscribeProvider,
  DeepgramSynthesizeProvider,
  CartesiaSynthesizeProvider,
  AssemblyAiTranscribeProvider,
  type TranscribeProvider,
  type SynthesizeProvider,
} from "@nexus/voice";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Available TTS voices (ElevenLabs defaults + generic labels) ───────────────

const VOICES = [
  { id: "alloy", label: "Alloy", provider: "elevenlabs" },
  { id: "echo", label: "Echo", provider: "elevenlabs" },
  { id: "fable", label: "Fable", provider: "elevenlabs" },
  { id: "onyx", label: "Onyx", provider: "elevenlabs" },
  { id: "nova", label: "Nova", provider: "elevenlabs" },
  { id: "shimmer", label: "Shimmer", provider: "elevenlabs" },
];

// ── Session factory ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildSession(voice = "alloy"): VoiceSession {
  const transcribe = process.env.GROQ_API_KEY
    ? new GroqTranscribeProvider({ apiKey: process.env.GROQ_API_KEY })
    : new NullTranscribeProvider("(groq not configured)");

  const synthesize = process.env.ELEVENLABS_API_KEY
    ? new ElevenLabsSynthesizeProvider({
        apiKey: process.env.ELEVENLABS_API_KEY,
        defaultVoice: voice,
      })
    : new NullSynthesizeProvider();

  return new VoiceSession({
    transcribe,
    synthesize,
    vad: new NullVadProvider(),
    // Handler: echo — swap for real LLM call in production
    handler: async (text: string) => `You said: "${text}". (Voice handler not yet wired to LLM)`,
  });
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /voice/chat
   *
   * Text-only voice turn — no audio required. Used by the web UI demo mode
   * until real WebRTC/audio upload is wired.
   * Body: { text: string, voice?: string }
   * Returns: { text: string, latencyMs: number }
   */
  app.post<{ Body: { text: string; voice?: string } }>(
    "/voice/chat",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { text, voice = "alloy" } = request.body;
      if (!text?.trim()) return reply.code(400).send({ error: "text is required" });

      const t0 = Date.now();
      let responseText: string;
      try {
        const driver = new OllamaDriver({
          baseUrl: process.env.OLLAMA_BASE_URL,
          model: process.env.NEXUS_DEFAULT_MODEL ?? "qwen2.5:7b",
        });
        const res = await driver.complete({
          model: process.env.NEXUS_DEFAULT_MODEL ?? "qwen2.5:7b",
          messages: [
            { role: "system", content: "You are a concise voice assistant. Reply in 1-3 sentences." },
            { role: "user", content: text },
          ],
          maxTokens: 256,
        });
        responseText = res.content.trim() || "(no response)";
      } catch (e) {
        responseText = `Voice LLM unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }

      return reply.send({ text: responseText, voice, latencyMs: Date.now() - t0 });
    },
  );

  /**
   * POST /voice/transcribe
   *
   * Accepts raw audio as base64 string.
   * Body: { audio: string (base64), format: "wav"|"mp3"|..., sampleRate?: number }
   * Returns: { transcript: string, latencyMs: number }
   */
  app.post<{
    Body: {
      audio: string;
      format?: string;
      sampleRate?: number;
      provider?: "groq" | "deepgram" | "assemblyai";
    };
  }>("/voice/transcribe", { preHandler: requireAuth }, async (request, reply) => {
    const { audio, format = "wav", sampleRate = 16000 } = request.body;
    if (!audio) return reply.code(400).send({ error: "audio (base64) is required" });

    const t0 = Date.now();
    const provider: TranscribeProvider =
      request.body.provider === "deepgram" && process.env.DEEPGRAM_API_KEY
        ? new DeepgramTranscribeProvider({ apiKey: process.env.DEEPGRAM_API_KEY })
        : request.body.provider === "assemblyai" && process.env.ASSEMBLYAI_API_KEY
          ? new AssemblyAiTranscribeProvider({ apiKey: process.env.ASSEMBLYAI_API_KEY })
          : process.env.GROQ_API_KEY
            ? new GroqTranscribeProvider({ apiKey: process.env.GROQ_API_KEY })
            : new NullTranscribeProvider("(no STT key)");

    const audioBuffer = {
      data: Buffer.from(audio, "base64"),
      format: format as "wav" | "mp3",
      sampleRate,
    };

    try {
      const transcript = await provider.transcribe(audioBuffer);
      return reply.send({ transcript, latencyMs: Date.now() - t0 });
    } catch (err: unknown) {
      const e = err as { message?: string };
      return reply.code(422).send({ error: "TRANSCRIBE_FAILED", message: e.message });
    }
  });

  /**
   * POST /voice/synthesize
   *
   * Body: { text: string, voice?: string, provider?: "elevenlabs" | "deepgram" | "cartesia" }
   * Returns audio/mpeg bytes (mp3).
   */
  app.post<{ Body: { text: string; voice?: string; provider?: "elevenlabs" | "deepgram" | "cartesia" } }>(
    "/voice/synthesize",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { text, voice = "alloy" } = request.body;
      if (!text?.trim()) return reply.code(400).send({ error: "text is required" });

      const provider: SynthesizeProvider =
        request.body.provider === "deepgram" && process.env.DEEPGRAM_API_KEY
          ? new DeepgramSynthesizeProvider({ apiKey: process.env.DEEPGRAM_API_KEY })
          : request.body.provider === "cartesia" && process.env.CARTESIA_API_KEY
            ? new CartesiaSynthesizeProvider({
                apiKey: process.env.CARTESIA_API_KEY,
                defaultVoice: process.env.CARTESIA_VOICE_ID,
              })
            : process.env.ELEVENLABS_API_KEY
              ? new ElevenLabsSynthesizeProvider({
                  apiKey: process.env.ELEVENLABS_API_KEY,
                  defaultVoice: voice,
                })
              : new NullSynthesizeProvider();

      try {
        const audioBuffer = await provider.synthesize(text);
        return reply
          .code(200)
          .header("Content-Type", "audio/mpeg")
          .send(Buffer.from(audioBuffer.data));
      } catch (err: unknown) {
        const e = err as { message?: string };
        return reply.code(422).send({ error: "SYNTHESIZE_FAILED", message: e.message });
      }
    },
  );

  /** GET /voice/voices */
  app.get(
    "/voice/voices",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      return reply.send({ voices: VOICES });
    },
  );

  /** GET /voice/providers */
  app.get(
    "/voice/providers",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      // `transcribe`/`synthesize` keep the historical single-active-provider
      // shape (the UI voice page reads .provider/.available as scalars); the
      // full selectable set rides transcribeOptions/synthesizeOptions.
      const transcribeOptions = [
        {
          provider: "groq",
          model: "whisper-large-v3-turbo",
          available: !!process.env.GROQ_API_KEY,
          requires: "GROQ_API_KEY",
        },
        {
          provider: "deepgram",
          model: "nova-2",
          available: !!process.env.DEEPGRAM_API_KEY,
          requires: "DEEPGRAM_API_KEY",
        },
        {
          provider: "assemblyai",
          model: "universal",
          available: !!process.env.ASSEMBLYAI_API_KEY,
          requires: "ASSEMBLYAI_API_KEY",
        },
      ];
      const synthesizeOptions = [
        {
          provider: "elevenlabs",
          model: "eleven_turbo_v2_5",
          available: !!process.env.ELEVENLABS_API_KEY,
          requires: "ELEVENLABS_API_KEY",
        },
        {
          provider: "deepgram",
          model: "aura-2-thalia-en",
          available: !!process.env.DEEPGRAM_API_KEY,
          requires: "DEEPGRAM_API_KEY",
        },
        {
          provider: "cartesia",
          model: "sonic-english",
          available: !!process.env.CARTESIA_API_KEY && !!process.env.CARTESIA_VOICE_ID,
          requires: "CARTESIA_API_KEY + CARTESIA_VOICE_ID",
        },
      ];
      const activeTranscribe =
        transcribeOptions.find((p) => p.available) ?? transcribeOptions[0]!;
      const activeSynthesize =
        synthesizeOptions.find((p) => p.available) ?? synthesizeOptions[0]!;
      return reply.send({
        transcribe: {
          provider: activeTranscribe.provider,
          model: activeTranscribe.model,
          available: activeTranscribe.available,
        },
        synthesize: {
          provider: activeSynthesize.provider,
          available: activeSynthesize.available,
        },
        transcribeOptions,
        synthesizeOptions,
      });
    },
  );
}
