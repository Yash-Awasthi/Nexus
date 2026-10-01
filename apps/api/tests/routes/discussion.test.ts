// SPDX-License-Identifier: Apache-2.0
/**
 * Stage D3 — the discussion route, driven with a scripted driver.
 *
 * The engine's own behaviour is covered in `packages/council`; these assert the
 * wiring the route owns: personas from the archetype registry, the ledger
 * arriving as SSE frames, the caps a caller may set, and the errors a caller
 * gets before any stream is opened.
 */
import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** Per-model reply scripts, one entry per turn; the last entry repeats. */
const script: Record<string, string[]> = {};
const turns: Record<string, LlmRequestOptions[]> = {};

/** One scripted turn: records the request, emits the next reply for its model. */
async function streamScript(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
  const seen = (turns[opts.model] ??= []);
  seen.push(opts);
  const replies = script[opts.model] ?? [`${opts.model} contributes.`];
  const text = replies[Math.min(seen.length - 1, replies.length - 1)] ?? "";
  await handler({ delta: text, done: true });
  return {
    id: "scripted",
    content: text,
    model: opts.model,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: "stop",
    durationMs: 1,
  } as LlmResponse;
}

/** A driver that answers from `script`, keyed by the model it is asked for. */
function scriptedDriver(provider: string): LlmDriver {
  return {
    provider,
    model: "scripted",
    complete: (opts: LlmRequestOptions) => streamScript(opts, () => {}),
    stream: streamScript,
  } as unknown as LlmDriver;
}

vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_userId: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    for (const p of new Set(providers)) registry.register(scriptedDriver(p), p);
    return { registry, missing: [] as string[] };
  },
}));

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

const PARTICIPANTS = [
  { label: "Alpha", provider: "openai", model: "alpha-model" },
  { label: "Beta", provider: "openai", model: "beta-model" },
];

async function discuss(
  body: Record<string, unknown>,
): Promise<{ status: number; frames: Frame[] }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/discussion/stream",
    payload: {
      topic: "Should the cache be invalidated on write?",
      participants: PARTICIPANTS,
      supervisorModel: "openai/recorder-model",
      settlePauseMs: 1,
      maxContributions: 4,
      ...body,
    },
  });
  const frames: Frame[] = [];
  for (const block of res.payload.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event && data) frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return { status: res.statusCode, frames };
}

function reset(): void {
  for (const k of Object.keys(script)) delete script[k];
  for (const k of Object.keys(turns)) delete turns[k];
}

describe("POST /api/v1/discussion/stream", () => {
  it("streams the ledger and gives every participant a persona from the registry", async () => {
    reset();
    script["recorder-model"] = ["Positions: two.\n\nSTATUS: CONTINUE"];

    const { frames } = await discuss({});

    const entries = frames.filter((f) => f.event === "entry").map((f) => f.data);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.line)).toEqual(entries.map((_e, i) => i + 1));
    expect(entries.some((e) => e.author === "Alpha")).toBe(true);
    expect(entries.some((e) => e.kind === "digest")).toBe(true);

    const persona = turns["alpha-model"]?.[0]?.messages?.[0];
    expect(persona?.role).toBe("system");
    expect(persona?.content).toContain("You are");
  });

  it("ends on the supervisor's verdict and returns a readable ledger", async () => {
    reset();
    script["alpha-model"] = ["Invalidate on write."];
    script["beta-model"] = ["Invalidate on read."];
    script["recorder-model"] = ["Positions: invalidate on write.\n\nSTATUS: SETTLED"];

    const done = (await discuss({ maxContributions: 20 })).frames.find((f) => f.event === "done");

    expect(done?.data.settled).toBe(true);
    expect(done?.data.reason).toBe("settled");
    expect(done?.data.digest).toBe("Positions: invalidate on write.");
    expect(String(done?.data.markdown)).toContain("Invalidate on write.");
    expect(Number(done?.data.contributions)).toBeLessThan(20);
  });

  it("stops at the caller's contribution cap when nothing settles", async () => {
    reset();
    script["recorder-model"] = ["Positions: unresolved.\n\nSTATUS: CONTINUE"];

    const done = (await discuss({ maxContributions: 3 })).frames.find((f) => f.event === "done");

    expect(done?.data.reason).toBe("contribution-cap");
    expect(done?.data.contributions).toBe(3);
  });

  it("rejects an unknown supervisor model before opening a stream", async () => {
    reset();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discussion/stream",
      payload: {
        topic: "Anything",
        participants: PARTICIPANTS,
        supervisorModel: "not-a-model-anyone-knows",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe("unknown_supervisor_model");
  });
});
