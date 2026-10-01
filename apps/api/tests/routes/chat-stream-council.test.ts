// SPDX-License-Identifier: Apache-2.0
/**
 * Stage D2 — the page users actually click runs the council.
 *
 * `POST /api/chat/stream` is what the Deliberations page calls. Before D2 its
 * members were bare provider/model pairs with no persona, and its verdict
 * counted identical completion strings, so the majority line read "1/N" no
 * matter how much the members agreed. These tests drive the real route with a
 * scripted driver and assert on the SSE frames it writes.
 */
import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** Per-model reply scripts, one entry per turn. Set by each test. */
const script: Record<string, string[]> = {};
const turns: Record<string, LlmRequestOptions[]> = {};
/** What the agreement judge answers; unreadable by default, so the verdict falls back to overlap. */
let judgeReply = "I cannot tell.";
const judgePrompts: string[] = [];

/** One scripted turn: records the request, emits the next reply for its model. */
async function streamScript(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
  const last = String(opts.messages.at(-1)?.content ?? "");
  if (last.includes("Group the members by the position they take")) {
    judgePrompts.push(last);
    return { id: "judge", content: judgeReply, model: opts.model, usage: {} } as LlmResponse;
  }
  const seen = (turns[opts.model] ??= []);
  seen.push(opts);
  if (opts.model.startsWith("broken")) throw new Error("provider down");
  const replies = script[opts.model] ?? [""];
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

vi.mock("../../src/routes/kb.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/routes/kb.js")>()),
  searchKb: async () => [
    {
      kbId: "ops",
      docName: "Ops runbook",
      text: "Nightly backups run at 02:00 and keep 30 days.",
      score: 0.9,
    },
  ],
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

interface SseEvent {
  type: string;
  label?: string;
  text?: string;
  archetype?: string;
}

// The council wraps every member driver in the response cache, keyed on the
// prompt. Two tests asking the same question would replay the first one's
// answers, so each test asks its own.
async function deliberate(
  question: string,
  members: { label: string; provider: string; model: string; archetypeId?: string }[],
  mentions?: { type: string; value: string }[],
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat/stream",
    payload: { message: question, members, round: 0, rounds: 2, threadId: "t1", mentions },
  });
  return res.payload
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as SseEvent);
}

const MEMBERS = [
  { label: "Alpha", provider: "openai", model: "model-a" },
  { label: "Beta", provider: "openai", model: "model-b" },
];

function reset() {
  for (const k of Object.keys(script)) delete script[k];
  for (const k of Object.keys(turns)) delete turns[k];
  judgeReply = "I cannot tell.";
  judgePrompts.length = 0;
}

describe("POST /api/chat/stream council membership", () => {
  it("gives every member an archetype persona from the registry", async () => {
    reset();
    script["model-a"] = ["a1", "FINAL: Ship it."];
    script["model-b"] = ["b1", "FINAL: Ship it."];

    const events = await deliberate("Should we ship the personas?", MEMBERS);

    const opinions = events.filter((e) => e.type === "opinion");
    expect(opinions.length).toBeGreaterThan(0);
    expect(opinions.every((o) => typeof o.archetype === "string" && o.archetype.length > 0)).toBe(
      true,
    );

    // The persona reaches the model as a system message, not just the event.
    const firstSystem = turns["model-a"]?.[0]?.messages?.[0];
    expect(firstSystem?.role).toBe("system");
    expect(firstSystem?.content).toContain("You are");

    // Two members, two different personas.
    const names = new Set(opinions.map((o) => o.archetype));
    expect(names.size).toBe(2);
  });
});

describe("POST /api/chat/stream chosen archetypes", () => {
  it("seats the archetype each member names and auto-fills the rest", async () => {
    reset();
    script["model-a"] = ["a1", "FINAL: Wait."];
    script["model-b"] = ["b1", "FINAL: Wait."];
    script["model-c"] = ["c1", "FINAL: Wait."];

    const events = await deliberate("Should we pick our own council personas?", [
      { ...MEMBERS[0], archetypeId: "contrarian" },
      { ...MEMBERS[1], archetypeId: "empiricist" },
      { label: "Gamma", provider: "openai", model: "model-c" },
    ]);

    const byLabel = new Map(
      events.filter((e) => e.type === "opinion").map((o) => [o.label, o.archetype]),
    );
    expect(byLabel.get("Alpha")).toBe("The Contrarian");
    expect(byLabel.get("Beta")).toBe("The Empiricist");
    const auto = byLabel.get("Gamma");
    expect(auto).toBeTruthy();
    expect(["The Contrarian", "The Empiricist"]).not.toContain(auto);
    expect(turns["model-a"]?.[0]?.messages?.[0]?.content).toContain("You are The Contrarian");
  });

  it("ignores an archetype id the caller cannot see", async () => {
    reset();
    script["model-a"] = ["a1", "FINAL: Fine."];
    script["model-b"] = ["b1", "FINAL: Fine."];

    const events = await deliberate("Does an unknown persona id break the council?", [
      { ...MEMBERS[0], archetypeId: "no-such-archetype" },
      MEMBERS[1],
    ]);
    const alpha = events.find((e) => e.type === "opinion" && e.label === "Alpha");
    expect(alpha?.archetype).toBeTruthy();
  });
});

describe("POST /api/chat/stream verdict", () => {
  it("counts members who reached the same position in different words", async () => {
    reset();
    const QUESTION = "Should we ship the flagged rollout?";
    script["model-a"] = ["a1", "Reasoning.\n\nFINAL: Ship it behind a feature flag."];
    script["model-b"] = ["b1", "Other reasoning.\n\nFINAL: Ship behind a feature flag."];

    const verdict = (await deliberate(QUESTION, MEMBERS)).find((e) => e.type === "verdict");
    expect(verdict?.text).toContain("2/2 members converged");
    expect(verdict?.text).toContain("feature flag");
  });

  it("lets a model judge agreement: same answer in different words agrees", async () => {
    reset();
    const QUESTION = "What database should a small shop start with?";
    script["model-a"] = ["a1", "FINAL: Postgres, it is a safe default."];
    script["model-b"] = ["b1", "FINAL: Go with PostgreSQL."];
    judgeReply = '{"groups":[{"members":["Alpha","Beta"],"position":"use PostgreSQL"}]}';

    const verdict = (await deliberate(QUESTION, MEMBERS)).find((e) => e.type === "verdict");
    expect(judgePrompts[0]).toContain("Alpha: Postgres, it is a safe default.");
    expect(verdict?.text).toContain("2/2 members converged (agree: Alpha, Beta) — use PostgreSQL");
    expect(verdict?.text).not.toContain("word overlap");
  });

  it("lets a model judge agreement: yes and no disagree however alike they read", async () => {
    reset();
    const QUESTION = "Should we adopt the framework?";
    script["model-a"] = ["a1", "FINAL: Yes, adopt the new framework now."];
    script["model-b"] = ["b1", "FINAL: No, do not adopt the new framework now."];
    judgeReply =
      '{"groups":[{"members":["Alpha"],"position":"adopt"},{"members":["Beta"],"position":"do not adopt"}]}';

    const verdict = (await deliberate(QUESTION, MEMBERS)).find((e) => e.type === "verdict");
    expect(verdict?.text).toContain("no majority position (Alpha: adopt; Beta: do not adopt)");
  });

  it("names the members on each side when the council splits unevenly", async () => {
    reset();
    const QUESTION = "Ship on Friday?";
    const THREE = [...MEMBERS, { label: "Gamma", provider: "openai", model: "model-c" }];
    script["model-a"] = ["a1", "FINAL: Ship Friday."];
    script["model-b"] = ["b1", "FINAL: Friday is fine to ship."];
    script["model-c"] = ["c1", "FINAL: Wait until Monday."];
    judgeReply =
      '{"groups":[{"members":["Alpha","Beta"],"position":"ship Friday"},{"members":["Gamma"],"position":"wait for Monday"}]}';

    const verdict = (await deliberate(QUESTION, THREE)).find((e) => e.type === "verdict");
    expect(verdict?.text).toContain(
      "2/3 members converged (agree: Alpha, Beta; disagree: Gamma says wait for Monday) — ship Friday",
    );
  });

  it("says when agreement fell back to word overlap", async () => {
    reset();
    script["model-a"] = ["a1", "FINAL: Ship behind a feature flag."];
    script["model-b"] = ["b1", "FINAL: Ship behind a feature flag."];
    const verdict = (await deliberate("Ship how?", MEMBERS)).find((e) => e.type === "verdict");
    expect(verdict?.text).toContain("by word overlap");
  });

  it("claims no majority when the members do not converge", async () => {
    reset();
    const QUESTION = "Should we cancel or continue?";
    script["model-a"] = ["a1", "FINAL: Ship it today."];
    script["model-b"] = ["b1", "FINAL: Cancel the project and refund every customer."];

    const verdict = (await deliberate(QUESTION, MEMBERS)).find((e) => e.type === "verdict");
    expect(verdict?.text).toContain("no majority position");
    expect(verdict?.text).not.toContain("converged");
  });

  it("adds a chair synthesis written from every member's final answer", async () => {
    reset();
    const QUESTION = "Should we hire or contract the first designer?";
    script["model-a"] = ["a1", "FINAL: Hire full time.", "**Answer:** Contract first, then hire."];
    script["model-b"] = ["b1", "FINAL: Contract for six months."];

    const events = await deliberate(QUESTION, MEMBERS);
    const verdict = events
      .filter((e) => e.type === "verdict")
      .map((e) => e.text)
      .join("");
    expect(verdict).toContain("no majority position");
    expect(verdict).toContain("**Answer:** Contract first, then hire.");

    const chair = turns["model-a"]?.[2]?.messages?.map((m) => m.content).join(" ") ?? "";
    expect(chair).toContain(QUESTION);
    expect(chair).toContain("Hire full time.");
    expect(chair).toContain("Contract for six months.");
  });

  it("skips the debate round when the members already agree", async () => {
    reset();
    const QUESTION = "Should we keep the nightly backup?";
    script["model-a"] = ["FINAL: Keep the nightly backup.", "**Answer:** Keep it."];
    script["model-b"] = ["FINAL: Keep the nightly backup."];

    const events = await deliberate(QUESTION, MEMBERS);
    // One answer each, then the chair's synthesis on model-a.
    expect(turns["model-b"]).toHaveLength(1);
    expect(turns["model-a"]).toHaveLength(2);
    const verdict = events.find((e) => e.type === "verdict");
    expect(verdict?.text).toContain("stopped after 1 of 2 rounds");
    expect(verdict?.text).toContain("2/2 members converged");
  });

  it("reports the failure when a member never answers", async () => {
    reset();
    const QUESTION = "Should we proceed with one silent member?";
    script["model-a"] = ["a1", "FINAL: Ship it."];
    script["model-b"] = [""];

    const verdict = (await deliberate(QUESTION, MEMBERS)).find((e) => e.type === "verdict");
    expect(verdict?.text).toContain("no majority position");
    expect(verdict?.text).toContain("1 member(s) failed");
  });
});

describe("POST /api/chat/stream chair", () => {
  it("has a member that answered write the synthesis when the first member failed", async () => {
    reset();
    script["model-a"] = ["a1", "FINAL: Ship it."];
    script["model-b"] = ["b1", "FINAL: Hold it."];

    const events = await deliberate("Who chairs when the first seat is down?", [
      { label: "Down", provider: "openai", model: "broken-1" },
      ...MEMBERS,
    ]);

    const notices = events.filter((e) => e.type === "notice").map((e) => JSON.stringify(e));
    expect(notices.join(" ")).not.toMatch(/synthesis could not be written/);
    expect(turns["broken-1"]?.some((t) => t.maxTokens === 900)).toBeFalsy();
  });
});

describe("POST /api/chat/stream sources", () => {
  it("numbers @kb sources for the members and lists the cited ones under the verdict", async () => {
    reset();
    const QUESTION = "How long do we keep backups?";
    script["model-a"] = ["a1", "FINAL: Thirty days [1].", "**Answer:** Thirty days [1]."];
    script["model-b"] = ["b1", "FINAL: A month."];

    const events = await deliberate(QUESTION, MEMBERS, [{ type: "kb", value: "ops" }]);

    const system = (turns["model-b"]?.[0]?.messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join(" ");
    expect(system).toContain("[1] Ops runbook");
    expect(system).toContain("cite it inline as [n]");
    const verdict = events
      .filter((e) => e.type === "verdict")
      .map((e) => e.text)
      .join("");
    expect(verdict).toMatch(/\*\*Sources\*\*\s+- \[1\] Ops runbook$/);
  });
});
