// SPDX-License-Identifier: Apache-2.0
/**
 * Speech surface OWNER — extracted from api-bridge.ts.
 *
 * OpenAI TTS-1 on the caller's key; without one the client speaks locally.
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { FastifyInstance } from "fastify";

import type { serviceKey } from "../lib/provider-keys.ts";

export interface TtsRoutesDeps {
  serviceKey: typeof serviceKey;
}

/** Register POST /tts. */
export async function ttsRoutes(app: FastifyInstance, deps: TtsRoutesDeps): Promise<void> {
  app.post<{ Body: { text: string; voice?: string } }>("/tts", async (req, reply) => {
    const apiKey =
      (req.headers["x-openai-key"] as string | undefined) ||
      (await deps.serviceKey(req.nexusUserId, "openai", "OPENAI_API_KEY"));
    if (!apiKey)
      return reply.send({
        audio: null,
        message: "Add an OpenAI key under Settings → Provider keys for model voices.",
      });
    const text = (req.body.text ?? "").slice(0, 4096);
    const voice = req.body.voice ?? "alloy";
    try {
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "tts-1", input: text, voice, response_format: "mp3" }),
      });
      if (!r.ok) return reply.send({ audio: null, message: `TTS error: ${r.status}` });
      const buf = await r.arrayBuffer();
      const b64 = Buffer.from(buf).toString("base64");
      return reply.send({ audio: `data:audio/mpeg;base64,${b64}`, voice, chars: text.length });
    } catch (e) {
      return reply.send({
        audio: null,
        message: `TTS failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
}
