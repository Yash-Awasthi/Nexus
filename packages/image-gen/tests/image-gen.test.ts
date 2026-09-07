// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ImageGenError,
  ImageGenerator,
  NullImageProvider,
  OpenAIImageProvider,
  ReplicateProvider,
  FluxProvider,
  StabilityProvider,
  RecraftProvider,
  FalProvider,
  ComfyUIProvider,
  type ImageProvider,
  type ImageHooks,
  type FetchFn,
  type GenerateOptions,
  type GeneratedImage,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown }>): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: true, status: 200, body: {} };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body ?? {},
    } as Response;
  });
}

function makeHooks(): ImageHooks {
  return { emit: vi.fn().mockResolvedValue({ handled: 1, aborted: false, errors: [] }) };
}

const noSleep = async (_ms: number) => {};

// OpenAI success response
function openAIResponse(n = 1, format: "url" | "b64" = "url") {
  return {
    ok: true,
    body: {
      data: Array.from({ length: n }, (_, i) => ({
        url: format === "url" ? `https://cdn.openai.com/img${i}.png` : undefined,
        b64_json: format === "b64" ? Buffer.from("PNG_DATA").toString("base64") : undefined,
        revised_prompt: `Enhanced: prompt${i}`,
      })),
    },
  };
}

// Replicate responses: create + immediate success
function replicateResponses(status: "succeeded" | "failed" | "canceled" = "succeeded") {
  const creating = {
    ok: true,
    body: {
      id: "pred-001",
      status: "processing",
      urls: { get: "https://api.replicate.com/v1/predictions/pred-001" },
    },
  };
  const done = {
    ok: true,
    body: {
      id: "pred-001",
      status,
      output: status === "succeeded" ? ["https://replicate.delivery/img.png"] : null,
      error: status !== "succeeded" ? "model error" : null,
    },
  };
  return [creating, done];
}

// ─────────────────────────────────────────────────────────────────────────────
// ImageGenError
// ─────────────────────────────────────────────────────────────────────────────

describe("ImageGenError", () => {
  it("is an Error with name ImageGenError", () => {
    const e = new ImageGenError("PROVIDER_ERROR", "err");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ImageGenError");
  });

  it("exposes code and message", () => {
    const e = new ImageGenError("AUTH_FAILED", "bad key");
    expect(e.code).toBe("AUTH_FAILED");
    expect(e.message).toBe("bad key");
  });

  it("PROVIDER_ERROR is retryable", () => {
    expect(new ImageGenError("PROVIDER_ERROR", "x").retryable).toBe(true);
  });

  it("AUTH_FAILED is not retryable", () => {
    expect(new ImageGenError("AUTH_FAILED", "x").retryable).toBe(false);
  });

  it("CONTENT_POLICY is not retryable", () => {
    expect(new ImageGenError("CONTENT_POLICY", "x").retryable).toBe(false);
  });

  it("INVALID_PROMPT is not retryable", () => {
    expect(new ImageGenError("INVALID_PROMPT", "x").retryable).toBe(false);
  });

  it("stores optional context", () => {
    const e = new ImageGenError("POLL_TIMEOUT", "timed out", { predictionId: "p1" });
    expect(e.context).toEqual({ predictionId: "p1" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NullImageProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("NullImageProvider", () => {
  it("has name 'null'", () => {
    expect(new NullImageProvider().name).toBe("null");
  });

  it("returns n images", async () => {
    const p = new NullImageProvider();
    const imgs = await p.generate("test", { n: 3 });
    expect(imgs).toHaveLength(3);
  });

  it("defaults to 1 image", async () => {
    const imgs = await new NullImageProvider().generate("x");
    expect(imgs).toHaveLength(1);
  });

  it("returns correct dimensions from size", async () => {
    const imgs = await new NullImageProvider().generate("x", { size: "1792x1024" });
    expect(imgs[0]).toMatchObject({ width: 1792, height: 1024 });
  });

  it("returns zero-byte data", async () => {
    const imgs = await new NullImageProvider().generate("x");
    expect(imgs[0]!.data!.length).toBe(0);
  });

  it("respects format opt", async () => {
    const imgs = await new NullImageProvider().generate("x", { format: "webp" });
    expect(imgs[0]!.format).toBe("webp");
  });

  it("defaults format to png", async () => {
    const imgs = await new NullImageProvider().generate("x");
    expect(imgs[0]!.format).toBe("png");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIImageProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenAIImageProvider", () => {
  it("has name 'openai-dalle'", () => {
    expect(new OpenAIImageProvider({ apiKey: "k" }).name).toBe("openai-dalle");
  });

  it("throws INVALID_PROMPT for empty prompt", async () => {
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: makeFetch([]) });
    await expect(p.generate("   ")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("POSTs to OpenAI images/generations endpoint", async () => {
    const fetchFn = makeFetch([openAIResponse()]);
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: fetchFn });
    await p.generate("a cat");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      "openai.com/v1/images/generations",
    );
  });

  it("sends Authorization Bearer header", async () => {
    const fetchFn = makeFetch([openAIResponse()]);
    const p = new OpenAIImageProvider({ apiKey: "sk-test", fetch: fetchFn });
    await p.generate("a cat");
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
  });

  it("sends n, size, model in body", async () => {
    const fetchFn = makeFetch([openAIResponse(2)]);
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: fetchFn });
    await p.generate("x", { n: 2, size: "512x512" });
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body).toMatchObject({ n: 2, size: "512x512", model: "dall-e-3" });
  });

  it("sends quality and style when provided", async () => {
    const fetchFn = makeFetch([openAIResponse()]);
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: fetchFn });
    await p.generate("x", { quality: "hd", style: "vivid" });
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body).toMatchObject({ quality: "hd", style: "vivid" });
  });

  it("returns url and revisedPrompt from API", async () => {
    const fetchFn = makeFetch([openAIResponse()]);
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: fetchFn });
    const imgs = await p.generate("a cat");
    expect(imgs[0]!.url).toContain("openai.com");
    expect(imgs[0]!.revisedPrompt).toContain("Enhanced:");
  });

  it("returns correct width and height for size", async () => {
    const fetchFn = makeFetch([openAIResponse()]);
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: fetchFn });
    const imgs = await p.generate("x", { size: "1792x1024" });
    expect(imgs[0]).toMatchObject({ width: 1792, height: 1024 });
  });

  it("decodes b64_json into data Uint8Array", async () => {
    const fetchFn = makeFetch([openAIResponse(1, "b64")]);
    const p = new OpenAIImageProvider({
      apiKey: "k",
      responseFormat: "b64_json",
      fetch: fetchFn,
    });
    const imgs = await p.generate("x");
    expect(imgs[0]!.data).toBeInstanceOf(Uint8Array);
  });

  it("throws AUTH_FAILED on 401", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 401 }]);
    const p = new OpenAIImageProvider({ apiKey: "bad", fetch: fetchFn });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("throws CONTENT_POLICY on 400 with content policy message", async () => {
    const fetchFn = makeFetch([
      {
        ok: false,
        status: 400,
        body: {
          error: { message: "Your request was rejected as a result of our content policy." },
        },
      },
    ]);
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: fetchFn });
    await expect(p.generate("violent content")).rejects.toMatchObject({ code: "CONTENT_POLICY" });
  });

  it("throws INVALID_PROMPT on 400 without content policy message", async () => {
    const fetchFn = makeFetch([
      {
        ok: false,
        status: 400,
        body: { error: { message: "prompt too long" } },
      },
    ]);
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: fetchFn });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("throws PROVIDER_ERROR on 5xx", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 500 }]);
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: fetchFn });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("throws PROVIDER_ERROR on network failure", async () => {
    const badFetch: FetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const p = new OpenAIImageProvider({ apiKey: "k", fetch: badFetch });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("uses custom model from config", async () => {
    const fetchFn = makeFetch([openAIResponse()]);
    const p = new OpenAIImageProvider({ apiKey: "k", model: "dall-e-2", fetch: fetchFn });
    await p.generate("x");
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.model).toBe("dall-e-2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReplicateProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("ReplicateProvider", () => {
  it("has name 'replicate'", () => {
    expect(new ReplicateProvider({ apiToken: "t" }).name).toBe("replicate");
  });

  it("throws INVALID_PROMPT for empty prompt", async () => {
    const p = new ReplicateProvider({ apiToken: "t", fetch: makeFetch([]) });
    await expect(p.generate("  ")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("POSTs to Replicate models predictions endpoint", async () => {
    const fetchFn = makeFetch(replicateResponses());
    const p = new ReplicateProvider({ apiToken: "tok", fetch: fetchFn, sleep: noSleep });
    await p.generate("a landscape");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      "replicate.com/v1/models",
    );
  });

  it("sends Authorization Token header", async () => {
    const fetchFn = makeFetch(replicateResponses());
    const p = new ReplicateProvider({ apiToken: "r8_secret", fetch: fetchFn, sleep: noSleep });
    await p.generate("x");
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Token r8_secret");
  });

  it("sends prompt, width, height, num_outputs in input", async () => {
    const fetchFn = makeFetch(replicateResponses());
    const p = new ReplicateProvider({ apiToken: "t", fetch: fetchFn, sleep: noSleep });
    await p.generate("space whale", { n: 2, size: "512x512" });
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.input).toMatchObject({
      prompt: "space whale",
      width: 512,
      height: 512,
      num_outputs: 2,
    });
  });

  it("polls until succeeded and returns image URLs", async () => {
    const fetchFn = makeFetch(replicateResponses("succeeded"));
    const p = new ReplicateProvider({ apiToken: "t", fetch: fetchFn, sleep: noSleep });
    const imgs = await p.generate("x");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.url).toContain("replicate.delivery");
  });

  it("polls multiple times before succeeded", async () => {
    const processing = {
      ok: true,
      body: {
        id: "p1",
        status: "processing",
        urls: { get: "https://api.replicate.com/v1/predictions/p1" },
      },
    };
    const done = {
      ok: true,
      body: { id: "p1", status: "succeeded", output: ["https://img.example.com/out.png"] },
    };
    const fetchFn = makeFetch([processing, processing, processing, done]);
    const p = new ReplicateProvider({
      apiToken: "t",
      fetch: fetchFn,
      sleep: noSleep,
      pollIntervalMs: 0,
    });
    const imgs = await p.generate("x");
    expect(imgs[0]!.url).toContain("example.com");
    // 1 create + 3 poll = 4 fetches
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it("throws PREDICTION_FAILED on failed status", async () => {
    const fetchFn = makeFetch(replicateResponses("failed"));
    const p = new ReplicateProvider({ apiToken: "t", fetch: fetchFn, sleep: noSleep });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PREDICTION_FAILED" });
  });

  it("throws PREDICTION_FAILED on canceled status", async () => {
    const fetchFn = makeFetch(replicateResponses("canceled"));
    const p = new ReplicateProvider({ apiToken: "t", fetch: fetchFn, sleep: noSleep });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PREDICTION_FAILED" });
  });

  it("throws AUTH_FAILED on 401", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 401 }]);
    const p = new ReplicateProvider({ apiToken: "bad", fetch: fetchFn });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("throws PROVIDER_ERROR on create 5xx", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 500 }]);
    const p = new ReplicateProvider({ apiToken: "t", fetch: fetchFn });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("throws PROVIDER_ERROR on poll network failure", async () => {
    const creating = {
      ok: true,
      body: {
        id: "p1",
        status: "processing",
        urls: { get: "https://api.replicate.com/v1/predictions/p1" },
      },
    };
    let calls = 0;
    const badFetch: FetchFn = vi.fn(async () => {
      calls++;
      if (calls === 1)
        return { ok: true, status: 200, json: async () => creating.body } as Response;
      throw new Error("poll network down");
    });
    const p = new ReplicateProvider({ apiToken: "t", fetch: badFetch, sleep: noSleep });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("throws POLL_TIMEOUT when deadline exceeded", async () => {
    const processing = {
      ok: true,
      body: {
        id: "p1",
        status: "processing",
        urls: { get: "https://api.replicate.com/v1/predictions/p1" },
      },
    };
    const fetchFn = makeFetch(Array(20).fill(processing));
    // timeoutMs=0 forces immediate timeout after first poll
    const p = new ReplicateProvider({
      apiToken: "t",
      fetch: fetchFn,
      sleep: noSleep,
      timeoutMs: 0,
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "POLL_TIMEOUT" });
  });

  it("uses versioned model URL when model contains ':'", async () => {
    const fetchFn = makeFetch(replicateResponses());
    const p = new ReplicateProvider({
      apiToken: "t",
      model: "stability-ai/sdxl:abc123",
      fetch: fetchFn,
      sleep: noSleep,
    });
    await p.generate("x");
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain("/predictions");
    expect(url).not.toContain("/models/");
  });

  it("sends negative_prompt when provided", async () => {
    const fetchFn = makeFetch(replicateResponses());
    const p = new ReplicateProvider({ apiToken: "t", fetch: fetchFn, sleep: noSleep });
    await p.generate("x", { negativePrompt: "blurry, ugly" });
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.input.negative_prompt).toBe("blurry, ugly");
  });

  it("sends seed and numInferenceSteps when provided", async () => {
    const fetchFn = makeFetch(replicateResponses());
    const p = new ReplicateProvider({ apiToken: "t", fetch: fetchFn, sleep: noSleep });
    await p.generate("x", { seed: 42, numInferenceSteps: 50 });
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.input).toMatchObject({ seed: 42, num_inference_steps: 50 });
  });

  it("returns empty array when output is null", async () => {
    const fetchFn = makeFetch([
      {
        ok: true,
        body: {
          id: "p1",
          status: "starting",
          urls: { get: "https://api.replicate.com/v1/predictions/p1" },
        },
      },
      { ok: true, body: { id: "p1", status: "succeeded", output: null } },
    ]);
    const p = new ReplicateProvider({ apiToken: "t", fetch: fetchFn, sleep: noSleep });
    const imgs = await p.generate("x");
    expect(imgs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// FluxProvider (§1.3 — Black Forest Labs direct API)
// ─────────────────────────────────────────────────────────────────────

describe("FluxProvider", () => {
  it("has name 'flux'", () => {
    expect(new FluxProvider({ apiKey: "k" }).name).toBe("flux");
  });

  it("throws INVALID_PROMPT for empty prompt", async () => {
    const p = new FluxProvider({ apiKey: "k", fetch: makeFetch([]) });
    await expect(p.generate(" ")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("POSTs to the model endpoint with x-key auth and prompt/size", async () => {
    const fetchFn = makeFetch([
      { ok: true, body: { id: "t1", polling_url: "https://api.bfl.ai/v1/get_result?id=t1" } },
      { ok: true, body: { status: "Ready", result: { sample: "https://bfl.ai/img.png" } } },
    ]);
    const p = new FluxProvider({ apiKey: "bfl-key", fetch: fetchFn, sleep: noSleep });
    await p.generate("a cat", { size: "1024x1024" });
    const f = fetchFn as ReturnType<typeof vi.fn>;
    expect(f.mock.calls[0]![0]).toBe("https://api.bfl.ai/v1/flux-pro-1.1");
    const headers = f.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["x-key"]).toBe("bfl-key");
    const body = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ prompt: "a cat", width: 1024, height: 1024 });
  });

  it("polls polling_url until Ready and returns the sample URL", async () => {
    const fetchFn = makeFetch([
      { ok: true, body: { id: "t1", polling_url: "https://api.bfl.ai/v1/get_result?id=t1" } },
      { ok: true, body: { status: "Pending" } },
      { ok: true, body: { status: "Ready", result: { sample: "https://bfl.ai/img.png" } } },
    ]);
    const p = new FluxProvider({ apiKey: "k", fetch: fetchFn, sleep: noSleep, pollIntervalMs: 0 });
    const imgs = await p.generate("x");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.url).toBe("https://bfl.ai/img.png");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it("throws PREDICTION_FAILED on Error status", async () => {
    const fetchFn = makeFetch([
      { ok: true, body: { id: "t1", polling_url: "https://api.bfl.ai/v1/get_result?id=t1" } },
      { ok: true, body: { status: "Error" } },
    ]);
    const p = new FluxProvider({ apiKey: "k", fetch: fetchFn, sleep: noSleep, pollIntervalMs: 0 });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PREDICTION_FAILED" });
  });

  it("throws AUTH_FAILED on 401", async () => {
    const p = new FluxProvider({ apiKey: "bad", fetch: makeFetch([{ ok: false, status: 401 }]) });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("throws POLL_TIMEOUT when deadline exceeded", async () => {
    const pending = {
      ok: true,
      body: { id: "t1", polling_url: "https://api.bfl.ai/v1/get_result?id=t1" },
    };
    const p = new FluxProvider({
      apiKey: "k",
      fetch: makeFetch(Array(20).fill(pending)),
      sleep: noSleep,
      timeoutMs: 0,
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "POLL_TIMEOUT" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// StabilityProvider (§1.3)
// ─────────────────────────────────────────────────────────────────────

describe("StabilityProvider", () => {
  it("has name 'stability'", () => {
    expect(new StabilityProvider({ apiKey: "k" }).name).toBe("stability");
  });

  it("throws INVALID_PROMPT for empty prompt", async () => {
    const p = new StabilityProvider({ apiKey: "k", fetch: makeFetch([]) });
    await expect(p.generate(" ")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("POSTs multipart to the engine endpoint with Bearer auth and JSON accept", async () => {
    const fetchFn = makeFetch([
      {
        ok: true,
        body: { image: Buffer.from("PNG").toString("base64"), finish_reason: "SUCCESS" },
      },
    ]);
    const p = new StabilityProvider({ apiKey: "sk-key", engine: "core", fetch: fetchFn });
    await p.generate("a cat", { size: "1792x1024" });
    const f = fetchFn as ReturnType<typeof vi.fn>;
    expect(f.mock.calls[0]![0]).toBe(
      "https://api.stability.ai/v2beta/stable-image/generate/core",
    );
    const headers = f.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-key");
    expect(headers["Accept"]).toBe("application/json");
    const form = f.mock.calls[0]![1]!.body as FormData;
    expect(form.get("prompt")).toBe("a cat");
    expect(form.get("aspect_ratio")).toBe("16:9"); // closest to 1792/1024
    expect(form.get("output_format")).toBe("png");
  });

  it("decodes base64 image into data", async () => {
    const b64 = Buffer.from("PNGDATA").toString("base64");
    const p = new StabilityProvider({
      apiKey: "k",
      fetch: makeFetch([{ ok: true, body: { image: b64 } }]),
    });
    const imgs = await p.generate("x");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(imgs[0]!.data!).toString()).toBe("PNGDATA");
  });

  it("throws AUTH_FAILED on 401", async () => {
    const p = new StabilityProvider({
      apiKey: "bad",
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("throws INVALID_PROMPT on 400", async () => {
    const p = new StabilityProvider({
      apiKey: "k",
      fetch: makeFetch([{ ok: false, status: 400, body: { errors: ["prompt too weird"] } }]),
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("throws PROVIDER_ERROR on 5xx", async () => {
    const p = new StabilityProvider({
      apiKey: "k",
      fetch: makeFetch([{ ok: false, status: 500 }]),
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// RecraftProvider (§1.3)
// ─────────────────────────────────────────────────────────────────────

describe("RecraftProvider", () => {
  it("has name 'recraft'", () => {
    expect(new RecraftProvider({ apiKey: "k" }).name).toBe("recraft");
  });

  it("throws INVALID_PROMPT for empty prompt", async () => {
    const p = new RecraftProvider({ apiKey: "k", fetch: makeFetch([]) });
    await expect(p.generate(" ")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("POSTs to the generations endpoint with Bearer auth and model/size/n", async () => {
    const fetchFn = makeFetch([
      { ok: true, body: { data: [{ url: "https://recraft.ai/a.png" }] } },
    ]);
    const p = new RecraftProvider({ apiKey: "rk-key", fetch: fetchFn });
    const imgs = await p.generate("logo", { n: 2, size: "512x512" });
    const f = fetchFn as ReturnType<typeof vi.fn>;
    expect(f.mock.calls[0]![0]).toBe("https://external.api.recraft.ai/v1/images/generations");
    const headers = f.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer rk-key");
    const body = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ prompt: "logo", model: "recraftv3", size: "512x512", n: 2 });
    expect(imgs[0]!.url).toBe("https://recraft.ai/a.png");
  });

  it("decodes b64 data when the response carries it", async () => {
    const p = new RecraftProvider({
      apiKey: "k",
      fetch: makeFetch([
        { ok: true, body: { data: [{ b64: Buffer.from("IMG").toString("base64") }] } },
      ]),
    });
    const imgs = await p.generate("x");
    expect(imgs[0]!.data).toBeInstanceOf(Uint8Array);
  });

  it("throws AUTH_FAILED on 401 and PROVIDER_ERROR on 5xx", async () => {
    const p1 = new RecraftProvider({
      apiKey: "bad",
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    await expect(p1.generate("x")).rejects.toMatchObject({ code: "AUTH_FAILED" });
    const p2 = new RecraftProvider({
      apiKey: "k",
      fetch: makeFetch([{ ok: false, status: 500 }]),
    });
    await expect(p2.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// FalProvider (§1.3)
// ─────────────────────────────────────────────────────────────────────

describe("FalProvider", () => {
  it("has name 'fal'", () => {
    expect(new FalProvider({ apiKey: "k" }).name).toBe("fal");
  });

  it("throws INVALID_PROMPT for empty prompt", async () => {
    const p = new FalProvider({ apiKey: "k", fetch: makeFetch([]) });
    await expect(p.generate(" ")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("queues, polls status, fetches result, returns images", async () => {
    const fetchFn = makeFetch([
      {
        ok: true,
        body: {
          request_id: "rq1",
          status_url: "https://queue.fal.run/fal-ai/flux/dev/requests/rq1/status",
          response_url: "https://queue.fal.run/fal-ai/flux/dev/requests/rq1",
        },
      },
      { ok: true, body: { status: "IN_QUEUE" } },
      { ok: true, body: { status: "IN_PROGRESS" } },
      { ok: true, body: { status: "COMPLETED" } },
      {
        ok: true,
        body: { images: [{ url: "https://fal.media/out.png", width: 1024, height: 1024 }] },
      },
    ]);
    const p = new FalProvider({
      apiKey: "id:secret",
      fetch: fetchFn,
      sleep: noSleep,
      pollIntervalMs: 0,
    });
    const imgs = await p.generate("x");
    const f = fetchFn as ReturnType<typeof vi.fn>;
    expect(f.mock.calls[0]![0]).toBe("https://queue.fal.run/fal-ai/flux/dev");
    const headers = f.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Key id:secret");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.url).toBe("https://fal.media/out.png");
    expect(imgs[0]!.width).toBe(1024);
  });

  it("throws PREDICTION_FAILED when the status poll reports an error", async () => {
    const fetchFn = makeFetch([
      {
        ok: true,
        body: { request_id: "rq1", status_url: "https://q/status", response_url: "https://q/result" },
      },
      { ok: true, body: { status: "FAILED", error: "NSFW filter" } },
    ]);
    const p = new FalProvider({
      apiKey: "k",
      fetch: fetchFn,
      sleep: noSleep,
      pollIntervalMs: 0,
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PREDICTION_FAILED" });
  });

  it("throws AUTH_FAILED on 401 and POLL_TIMEOUT on deadline", async () => {
    const p1 = new FalProvider({
      apiKey: "bad",
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    await expect(p1.generate("x")).rejects.toMatchObject({ code: "AUTH_FAILED" });
    const p2 = new FalProvider({
      apiKey: "k",
      fetch: makeFetch([
        { ok: true, body: { request_id: "rq1", status_url: "https://q/status" } },
      ]),
      sleep: noSleep,
      timeoutMs: 0,
    });
    await expect(p2.generate("x")).rejects.toMatchObject({ code: "POLL_TIMEOUT" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// ComfyUIProvider (§1.3 — self-hosted)
// ─────────────────────────────────────────────────────────────────────

/** ComfyUI needs raw-bytes responses for /view — dedicated mock. */
function comfyFetch(sequence: unknown[]): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = sequence[idx++] as { raw?: Uint8Array; body?: unknown };
    if (r && "raw" in r && r.raw) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          r.raw!.buffer.slice(
            r.raw!.byteOffset,
            r.raw!.byteOffset + r.raw!.byteLength,
          ),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => (r as { body?: unknown }).body ?? {},
    } as Response;
  });
}

const COMFY_WORKFLOW: Record<string, unknown> = {
  "3": { class_type: "KSampler", inputs: { seed: 1 } },
  "9": { class_type: "SaveImage", inputs: {} },
};

describe("ComfyUIProvider", () => {
  it("has name 'comfyui'", () => {
    expect(new ComfyUIProvider({ workflow: COMFY_WORKFLOW, promptNode: "9" }).name).toBe(
      "comfyui",
    );
  });

  it("throws INVALID_PROMPT for empty prompt", async () => {
    const p = new ComfyUIProvider({
      workflow: COMFY_WORKFLOW,
      promptNode: "9",
      fetch: comfyFetch([]),
    });
    await expect(p.generate(" ")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("throws PROVIDER_ERROR when the promptNode is missing from the workflow", async () => {
    const p = new ComfyUIProvider({
      workflow: COMFY_WORKFLOW,
      promptNode: "nope",
      fetch: comfyFetch([]),
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("queues the workflow with the prompt injected, polls history, fetches image bytes", async () => {
    const fetchFn = comfyFetch([
      { body: { prompt_id: "job-1" } },
      { body: {} }, // history not ready yet
      {
        body: {
          "job-1": {
            status: { completed: true },
            outputs: {
              "9": { images: [{ filename: "c.png", subfolder: "", type: "output" }] },
            },
          },
        },
      },
      { raw: new Uint8Array([1, 2, 3]) },
    ]);
    const p = new ComfyUIProvider({
      workflow: COMFY_WORKFLOW,
      promptNode: "9",
      baseUrl: "http://127.0.0.1:8188",
      fetch: fetchFn,
      sleep: noSleep,
      pollIntervalMs: 0,
    });
    const imgs = await p.generate("a cat");
    const f = fetchFn as ReturnType<typeof vi.fn>;
    expect(f.mock.calls[0]![0]).toBe("http://127.0.0.1:8188/prompt");
    const body = JSON.parse(f.mock.calls[0]![1]!.body as string) as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(body.prompt["9"]!.inputs.text).toBe("a cat");
    expect(f.mock.calls[2]![0]).toContain("/history/job-1");
    expect(f.mock.calls[3]![0]).toContain("/view?filename=c.png");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.data).toBeInstanceOf(Uint8Array);
    expect(imgs[0]!.data!.length).toBe(3);
  });

  it("throws POLL_TIMEOUT when the history never completes", async () => {
    const p = new ComfyUIProvider({
      workflow: COMFY_WORKFLOW,
      promptNode: "9",
      fetch: comfyFetch([
        { body: { prompt_id: "job-1" } },
        { body: {} },
        { body: {} },
      ]),
      sleep: noSleep,
      pollIntervalMs: 0,
      timeoutMs: 0,
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "POLL_TIMEOUT" });
  });

  it("throws PROVIDER_ERROR when /prompt is rejected", async () => {
    const fetchFn: FetchFn = vi.fn(async () => {
      return { ok: false, status: 400, json: async () => ({}) } as Response;
    });
    const p = new ComfyUIProvider({
      workflow: COMFY_WORKFLOW,
      promptNode: "9",
      fetch: fetchFn,
      sleep: noSleep,
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

// ImageGenerator
// ─────────────────────────────────────────────────────────────────────────────

describe("ImageGenerator — basic flow", () => {
  let provider: ImageProvider;
  let hooks: ImageHooks;

  beforeEach(() => {
    provider = new NullImageProvider();
    hooks = makeHooks();
  });

  it("returns ImageResult with prompt, images, provider, latencyMs", async () => {
    const gen = new ImageGenerator({ provider, sleep: noSleep });
    const result = await gen.generate("a cat");
    expect(result.prompt).toBe("a cat");
    expect(result.images).toHaveLength(1);
    expect(result.provider).toBe("null");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("passes opts through to provider", async () => {
    provider = {
      name: "mock",
      generate: vi.fn().mockResolvedValue([{ format: "png", width: 512, height: 512 }]),
    };
    const gen = new ImageGenerator({ provider, sleep: noSleep });
    await gen.generate("x", { n: 2, size: "512x512" });
    expect(provider.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "x",
      expect.objectContaining({ n: 2, size: "512x512" }),
    );
  });

  it("result.attempts is 1 on first-attempt success", async () => {
    const gen = new ImageGenerator({ provider, sleep: noSleep });
    const result = await gen.generate("x");
    expect(result.attempts).toBe(1);
  });

  it("emits task.before and task.after on success", async () => {
    const gen = new ImageGenerator({ provider, hooks, sleep: noSleep });
    await gen.generate("a cat");
    const events = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("task.before");
    expect(events).toContain("task.after");
  });

  it("task.before includes prompt and provider", async () => {
    const gen = new ImageGenerator({ provider, hooks, sleep: noSleep });
    await gen.generate("a cat");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      prompt: "a cat",
      provider: "null",
    });
  });

  it("task.after includes imageCount and latencyMs", async () => {
    const gen = new ImageGenerator({ provider, hooks, sleep: noSleep });
    await gen.generate("x");
    const afterPayload = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls[1]![1];
    expect(afterPayload).toMatchObject({ imageCount: 1, provider: "null" });
    expect(typeof afterPayload["latencyMs"]).toBe("number");
  });

  it("hook errors are non-fatal", async () => {
    hooks = { emit: vi.fn().mockRejectedValue(new Error("hook crash")) };
    const gen = new ImageGenerator({ provider, hooks, sleep: noSleep });
    await expect(gen.generate("x")).resolves.toBeDefined();
  });

  it("uses custom name in hook payloads", async () => {
    const gen = new ImageGenerator({ provider, hooks, name: "my-gen", sleep: noSleep });
    await gen.generate("x");
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      gen: "my-gen",
    });
  });
});

describe("ImageGenerator — retry", () => {
  it("retries on PROVIDER_ERROR up to maxAttempts", async () => {
    let calls = 0;
    const flaky: ImageProvider = {
      name: "flaky",
      generate: vi.fn(async () => {
        calls++;
        if (calls < 3) throw new ImageGenError("PROVIDER_ERROR", "transient");
        return [{ format: "png" as const, width: 1024, height: 1024 }];
      }),
    };
    const gen = new ImageGenerator({ provider: flaky, maxAttempts: 3, sleep: noSleep });
    const result = await gen.generate("x");
    expect(result.attempts).toBe(3);
    expect(result.images).toHaveLength(1);
  });

  it("throws after exhausting all attempts", async () => {
    const failing: ImageProvider = {
      name: "fail",
      generate: vi.fn().mockRejectedValue(new ImageGenError("PROVIDER_ERROR", "always fails")),
    };
    const gen = new ImageGenerator({ provider: failing, maxAttempts: 3, sleep: noSleep });
    await expect(gen.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(failing.generate).toHaveBeenCalledTimes(3);
  });

  it("does not retry AUTH_FAILED (non-retryable)", async () => {
    const failing: ImageProvider = {
      name: "fail",
      generate: vi.fn().mockRejectedValue(new ImageGenError("AUTH_FAILED", "bad key")),
    };
    const gen = new ImageGenerator({ provider: failing, maxAttempts: 5, sleep: noSleep });
    await expect(gen.generate("x")).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(failing.generate).toHaveBeenCalledTimes(1);
  });

  it("does not retry CONTENT_POLICY", async () => {
    const failing: ImageProvider = {
      name: "fail",
      generate: vi.fn().mockRejectedValue(new ImageGenError("CONTENT_POLICY", "blocked")),
    };
    const gen = new ImageGenerator({ provider: failing, maxAttempts: 5, sleep: noSleep });
    await expect(gen.generate("x")).rejects.toMatchObject({ code: "CONTENT_POLICY" });
    expect(failing.generate).toHaveBeenCalledTimes(1);
  });

  it("emits task.error hook on terminal failure", async () => {
    const failing: ImageProvider = {
      name: "fail",
      generate: vi.fn().mockRejectedValue(new ImageGenError("PROVIDER_ERROR", "dead")),
    };
    const hooks = makeHooks();
    const gen = new ImageGenerator({ provider: failing, hooks, maxAttempts: 2, sleep: noSleep });
    await expect(gen.generate("x")).rejects.toBeDefined();
    const events = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("task.error");
  });

  it("task.error payload includes code and attempts", async () => {
    const failing: ImageProvider = {
      name: "fail",
      generate: vi.fn().mockRejectedValue(new ImageGenError("PROVIDER_ERROR", "dead")),
    };
    const hooks = makeHooks();
    const gen = new ImageGenerator({ provider: failing, hooks, maxAttempts: 2, sleep: noSleep });
    await expect(gen.generate("x")).rejects.toBeDefined();
    const errorPayload = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "task.error",
    )![1];
    expect(errorPayload).toMatchObject({ code: "PROVIDER_ERROR", attempts: 2 });
  });

  it("wraps unexpected non-ImageGenError into PROVIDER_ERROR", async () => {
    const failing: ImageProvider = {
      name: "fail",
      generate: vi.fn().mockRejectedValue(new Error("unexpected crash")),
    };
    const gen = new ImageGenerator({ provider: failing, sleep: noSleep });
    await expect(gen.generate("x")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("calls sleep between retries", async () => {
    const sleepFn = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const flaky: ImageProvider = {
      name: "flaky",
      generate: vi.fn(async () => {
        if (++calls < 3) throw new ImageGenError("PROVIDER_ERROR", "transient");
        return [{ format: "png" as const, width: 1024, height: 1024 }];
      }),
    };
    const gen = new ImageGenerator({
      provider: flaky,
      maxAttempts: 3,
      baseDelayMs: 100,
      sleep: sleepFn,
    });
    await gen.generate("x");
    expect(sleepFn).toHaveBeenCalledTimes(2);
    // Exponential: 100, 200
    expect(sleepFn.mock.calls[0]![0]).toBe(100);
    expect(sleepFn.mock.calls[1]![0]).toBe(200);
  });
});
