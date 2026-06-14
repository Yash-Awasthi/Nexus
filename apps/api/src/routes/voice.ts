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

import {
  VoiceSession,
  NullTranscribeProvider,
  NullSynthesizeProvider,
  NullVadProvider,
  GroqTranscribeProvider,
  ElevenLabsSynthesizeProvider,
} from "@nexus/voice";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Available TTS voices (ElevenLabs defaults + generic labels) ───────────────

const VOICES = [
  { id: "alloy",   label: "Alloy",   provider: "elevenlabs" },
  { id: "echo",    label: "Echo",    provider: "elevenlabs" },
  { id: "fable",   label: "Fable",   provider: "elevenlabs" },
  { id: "onyx",    label: "Onyx",    provider: "elevenlabs" },
  { id: "nova",    label: "Nova",    provider: "elevenlabs" },
  { id: "shimmer", label: "Shimmer", provider: "elevenlabs" },
];

// ── Session factory ───────────────────────────────────────────────────────────

function buildSession(voice = "alloy"): VoiceSession {
  const transcribe = process.env.GROQ_API_KEY
    ? new GroqTranscribeProvider({ apiKey: process.env.GROQ_API_KEY })
    : new NullTranscribeProvider("(groq not configured)");

  const synthesize = process.env.ELEVENLABS_API_KEY
    ? new ElevenLabsSynthesizeProvider({ apiKey: process.env.ELEVENLABS_API_KEY, voiceId: voice })
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
    { preHandler: requireAuth },
    async (request, reply) => {
      const { text, voice = "alloy" } = request.body;
      if (!text?.trim()) return reply.code(400).send({ error: "text is required" });

      const t0 = Date.now();
      // Use handler directly (no audio in / out for text-only mode)
      const session = buildSession(voice);
      const responseText = await session.textTurn(text);

      return reply.send({ text: responseText, latencyMs: Date.now() - t0 });
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
    Body: { audio: string; format?: string; sampleRate?: number };
  }>("/voice/transcribe", { preHandler: requireAuth }, async (request, reply) => {
    const { audio, format = "wav", sampleRate = 16000 } = request.body;
    if (!audio) return reply.code(400).send({ error: "audio (base64) is required" });

    const t0 = Date.now();
    const provider = process.env.GROQ_API_KEY
      ? new GroqTranscribeProvider({ apiKey: process.env.GROQ_API_KEY })
      : new NullTranscribeProvider("(no groq key)");

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
   * Body: { text: string, voice?: string }
   * Returns audio/mpeg bytes (mp3).
   */
  app.post<{ Body: { text: string; voice?: string } }>(
    "/voice/synthesize",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { text, voice = "alloy" } = request.body;
      if (!text?.trim()) return reply.code(400).send({ error: "text is required" });

      const provider = process.env.ELEVENLABS_API_KEY
        ? new ElevenLabsSynthesizeProvider({ apiKey: process.env.ELEVENLABS_API_KEY, voiceId: voice })
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
  app.get("/voice/voices", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send({ voices: VOICES });
  });

  /** GET /voice/providers */
  app.get("/voice/providers", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send({
      transcribe: {
        provider: process.env.GROQ_API_KEY ? "groq" : "null",
        model: "whisper-large-v3-turbo",
        available: !!process.env.GROQ_API_KEY,
      },
      synthesize: {
        provider: process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "null",
        available: !!process.env.ELEVENLABS_API_KEY,
      },
    });
  });
}
