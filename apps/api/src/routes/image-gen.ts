// SPDX-License-Identifier: Apache-2.0
/**
 * Image generation routes — backed by @nexus/image-gen.
 *
 * POST /api/v1/image-gen/generate  — generate images from prompt
 * GET  /api/v1/image-gen/models    — list supported models/providers
 * GET  /api/v1/image-gen/history   — recent generation results (in-memory)
 */

import { randomUUID } from "crypto";

import {
  ImageGenerator,
  NullImageProvider,
  OpenAIImageProvider,
  ReplicateProvider,
  type ImageSize,
  type ImageStyle,
} from "@nexus/image-gen";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── In-memory history ─────────────────────────────────────────────────────────

interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  model: string;
  size: string;
  createdAt: string;
}

const history: GeneratedImage[] = [];

// ── Provider factory ──────────────────────────────────────────────────────────

const REPLICATE_MODELS: Record<string, string> = {
  "flux-1-dev":          "black-forest-labs/flux-dev",
  "stable-diffusion-xl": "stability-ai/sdxl:39ed52f2319f9259f897e5c2042de5a6a4b06b97",
};

function buildGenerator(model: string): ImageGenerator {
  if ((model === "dall-e-3" || model === "dall-e-2") && process.env.OPENAI_API_KEY) {
    return new ImageGenerator({
      provider: new OpenAIImageProvider({ apiKey: process.env.OPENAI_API_KEY, model }),
      maxAttempts: 2,
    });
  }
  const replicateModel = REPLICATE_MODELS[model];
  if (replicateModel && process.env.REPLICATE_API_KEY) {
    return new ImageGenerator({
      provider: new ReplicateProvider({
        apiKey: process.env.REPLICATE_API_KEY,
        model: replicateModel,
      }),
      maxAttempts: 2,
    });
  }
  // Fallback: deterministic placeholder (always works)
  return new ImageGenerator({ provider: new NullImageProvider() });
}

const SUPPORTED_MODELS = [
  { id: "dall-e-3",          label: "DALL·E 3",           provider: "openai",    requires: "OPENAI_API_KEY" },
  { id: "dall-e-2",          label: "DALL·E 2",           provider: "openai",    requires: "OPENAI_API_KEY" },
  { id: "flux-1-dev",        label: "FLUX.1 Dev",         provider: "replicate", requires: "REPLICATE_API_KEY" },
  { id: "stable-diffusion-xl", label: "Stable Diffusion XL", provider: "replicate", requires: "REPLICATE_API_KEY" },
  { id: "null",              label: "Placeholder (dev)",   provider: "null",      requires: "" },
];

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function imageGenRoutes(app: FastifyInstance): Promise<void> {
  /** POST /image-gen/generate */
  app.post<{
    Body: {
      prompt: string;
      negativePrompt?: string;
      model?: string;
      size?: string;
      n?: number;
      style?: "vivid" | "natural";
    };
  }>("/image-gen/generate", { preHandler: requireAuth }, async (request, reply) => {
    const {
      prompt,
      negativePrompt,
      model = "dall-e-3",
      size = "1024x1024",
      n = 1,
      style,
    } = request.body;

    if (!prompt?.trim()) return reply.code(400).send({ error: "prompt is required" });

    try {
      const gen = buildGenerator(model);
      const result = await gen.generate(prompt, {
        n: Math.min(n, 4),
        size: size as ImageSize,
        negativePrompt,
        style: style as ImageStyle | undefined,
      });

      const images: GeneratedImage[] = result.images.map((img) => ({
        id: img.id ?? randomUUID(),
        url: img.url ?? img.base64DataUrl ?? "",
        prompt,
        model,
        size,
        createdAt: new Date().toISOString(),
      }));

      // Keep last 50 in history
      history.unshift(...images);
      if (history.length > 50) history.splice(50);

      return reply.code(200).send({ images, model, latencyMs: result.latencyMs });
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      return reply.code(422).send({ error: e.code ?? "GENERATE_FAILED", message: e.message });
    }
  });

  /** GET /image-gen/models */
  app.get("/image-gen/models", { preHandler: requireAuth }, async (_req, reply) => {
    const models = SUPPORTED_MODELS.map((m) => ({
      ...m,
      available: !m.requires || !!process.env[m.requires],
    }));
    return reply.send({ models });
  });

  /** GET /image-gen/history?limit= */
  app.get<{ Querystring: { limit?: string } }>(
    "/image-gen/history",
    { preHandler: requireAuth },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "20"), 50);
      return reply.send({ images: history.slice(0, limit), total: history.length });
    },
  );
}
