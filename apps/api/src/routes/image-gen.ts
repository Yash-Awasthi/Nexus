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
  FluxProvider,
  StabilityProvider,
  RecraftProvider,
  FalProvider,
  ComfyUIProvider,
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
  "flux-1-dev": "black-forest-labs/flux-dev",
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
        apiToken: process.env.REPLICATE_API_KEY,
        model: replicateModel,
      }),
      maxAttempts: 2,
    });
  }
  if (model === "flux-pro" && process.env.FLUX_API_KEY) {
    return new ImageGenerator({
      provider: new FluxProvider({ apiKey: process.env.FLUX_API_KEY }),
      maxAttempts: 2,
    });
  }
  if (
    (model === "stability-core" || model === "stability-ultra") &&
    process.env.STABILITY_API_KEY
  ) {
    return new ImageGenerator({
      provider: new StabilityProvider({
        apiKey: process.env.STABILITY_API_KEY,
        engine: model === "stability-ultra" ? "ultra" : "core",
      }),
      maxAttempts: 2,
    });
  }
  if (model === "recraft-v3" && process.env.RECRAFT_API_KEY) {
    return new ImageGenerator({
      provider: new RecraftProvider({ apiKey: process.env.RECRAFT_API_KEY }),
      maxAttempts: 2,
    });
  }
  if (model === "fal-flux-dev" && process.env.FAL_KEY) {
    return new ImageGenerator({
      provider: new FalProvider({ apiKey: process.env.FAL_KEY }),
      maxAttempts: 2,
    });
  }
  if (model === "comfyui" && process.env.COMFYUI_URL) {
    return new ImageGenerator({
      provider: new ComfyUIProvider({
        workflow: JSON.parse(process.env.COMFYUI_WORKFLOW ?? "{}"),
        promptNode: process.env.COMFYUI_PROMPT_NODE ?? "6",
      }),
      maxAttempts: 1, // workflow errors are deterministic — retrying wastes cycles
    });
  }
  // Fallback: deterministic placeholder (always works)
  return new ImageGenerator({ provider: new NullImageProvider() });
}

const SUPPORTED_MODELS = [
  { id: "dall-e-3", label: "DALL·E 3", provider: "openai", requires: "OPENAI_API_KEY" },
  { id: "dall-e-2", label: "DALL·E 2", provider: "openai", requires: "OPENAI_API_KEY" },
  { id: "flux-1-dev", label: "FLUX.1 Dev", provider: "replicate", requires: "REPLICATE_API_KEY" },
  {
    id: "stable-diffusion-xl",
    label: "Stable Diffusion XL",
    provider: "replicate",
    requires: "REPLICATE_API_KEY",
  },
  { id: "flux-pro", label: "FLUX 1.1 Pro (BFL)", provider: "flux", requires: "FLUX_API_KEY" },
  {
    id: "stability-core",
    label: "Stable Image Core",
    provider: "stability",
    requires: "STABILITY_API_KEY",
  },
  {
    id: "stability-ultra",
    label: "Stable Image Ultra",
    provider: "stability",
    requires: "STABILITY_API_KEY",
  },
  { id: "recraft-v3", label: "Recraft V3", provider: "recraft", requires: "RECRAFT_API_KEY" },
  { id: "fal-flux-dev", label: "FLUX.1 [dev] via fal", provider: "fal", requires: "FAL_KEY" },
  { id: "comfyui", label: "ComfyUI (self-hosted)", provider: "comfyui", requires: "COMFYUI_URL" },
  { id: "null", label: "Placeholder (dev)", provider: "null", requires: "" },
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
        id: randomUUID(),
        url:
          img.url ??
          (img.data
            ? `data:image/${img.format};base64,${Buffer.from(img.data).toString("base64")}`
            : ""),
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
  app.get(
    "/image-gen/models",
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
      const models = SUPPORTED_MODELS.map((m) => ({
        ...m,
        available: !m.requires || !!process.env[m.requires],
      }));
      return reply.send({ models });
    },
  );

  /** GET /image-gen/history?limit= */
  app.get<{ Querystring: { limit?: string } }>(
    "/image-gen/history",
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
      const limit = Math.min(parseInt(request.query.limit ?? "20"), 50);
      return reply.send({ images: history.slice(0, limit), total: history.length });
    },
  );
}
