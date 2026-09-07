// SPDX-License-Identifier: Apache-2.0
/**
 * Task-compression tests — dynamic composite skills.
 *
 * Covers: relevance scoring, capability-slimming (only task-relevant sections
 * kept), token accounting, the never-empty fallback, slug naming, and the
 * mission-prompt stub optimization (executed-OK skills collapse to a line).
 */

import { describe, it, expect } from "vitest";

import {
  compressSkillsForTask,
  compressSkillsForTaskSemantic,
  hybridScore,
  scoreSkillForTask,
  semanticSelection,
  slugify,
  tokenize,
  type SkillSource,
} from "../../src/lib/skill-compress.js";
import {
  composeSkillSystemPrompt,
  mergeSkillCodeBodies,
  type SkillRecord,
} from "../../src/lib/skill-runner.js";

const FRONTEND_SKILL: SkillRecord = {
  id: "f1",
  name: "Hero Section",
  description: "Responsive hero section with gradient background",
  language: "TypeScript",
  code: [
    "const hero = () => {",
    "  const styles = {",
    "    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',",
    "    padding: '96px 24px',",
    "    textAlign: 'center' as const,",
    "  };",
    "  return `",
    "    <section style={styles}>",
    "      <h1>Welcome</h1>",
    "      <p>Build something great today.</p>",
    "      <a href='/get-started'>Get Started</a>",
    "    </section>",
    "  `;",
    "};",
    "console.log(hero());",
  ].join("\n"),
};

const GRID_SKILL: SkillRecord = {
  id: "f2",
  name: "Responsive Grid",
  description: "CSS grid layout for product cards",
  language: "TypeScript",
  code: [
    "const grid = () => {",
    "  const styles = {",
    "    display: 'grid',",
    "    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',",
    "    gap: '24px',",
    "    padding: '48px 24px',",
    "  };",
    "  return `",
    "    <div style={styles}>",
    "      <!-- product cards -->",
    "    </div>",
    "  `;",
    "};",
    "console.log(grid());",
  ].join("\n"),
};

const PAYMENT_SKILL: SkillRecord = {
  id: "p1",
  name: "Stripe Checkout",
  description: "Stripe payment intent + checkout session",
  language: "TypeScript",
  code: [
    "import Stripe from 'stripe';",
    "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);",
    "export const createCheckoutSession = async (priceId: string) => {",
    "  const session = await stripe.checkout.sessions.create({",
    "    line_items: [{ price: priceId, quantity: 1 }],",
    "    mode: 'payment',",
    "    success_url: 'https://example.com/success',",
    "    cancel_url: 'https://example.com/cancel',",
    "  });",
    "  return session.url;",
    "};",
    "export const createPaymentIntent = async (amount: number) => {",
    "  return stripe.paymentIntents.create({ amount, currency: 'usd' });",
    "};",
    "console.log('checkout ready');",
  ].join("\n"),
};

const task = "build a frontend landing page with a hero section and responsive grid";

describe("tokenize / slugify", () => {
  it("drops stopwords and short tokens", () => {
    const t = tokenize("build a frontend landing page hero section grid");
    expect(t).toContain("frontend");
    expect(t).toContain("hero");
    expect(t).not.toContain("a");
    expect(t).not.toContain("skill");
  });

  it("slugifies tasks into composite names", () => {
    expect(slugify("Build a frontend landing page")).toBe("build-frontend-landing-page");
    expect(slugify("!!!")).toBe("composite");
  });
});

describe("scoreSkillForTask", () => {
  it("scores by task-word overlap, weighted by name", () => {
    const tokens = tokenize(task);
    expect(scoreSkillForTask(FRONTEND_SKILL, tokens)).toBeGreaterThan(0);
    expect(scoreSkillForTask(GRID_SKILL, tokens)).toBeGreaterThan(0);
    expect(scoreSkillForTask(PAYMENT_SKILL, tokens)).toBe(0);
  });

  it("never drops when the task has no signal", () => {
    expect(scoreSkillForTask(PAYMENT_SKILL, [])).toBe(1);
  });
});

describe("compressSkillsForTask", () => {
  it("keeps only task-relevant capabilities and reports token savings", () => {
    const skills = [FRONTEND_SKILL, GRID_SKILL, PAYMENT_SKILL].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      language: s.language,
      code: s.code,
    }));
    const result = compressSkillsForTask(skills, task);

    expect(result.report.keptSkills.map((s) => s.id).sort()).toEqual(["f1", "f2"]);
    expect(result.report.droppedSkills.map((s) => s.id)).toEqual(["p1"]);
    expect(result.code).toContain("Hero Section");
    expect(result.code).toContain("Responsive Grid");
    expect(result.code).not.toContain("Stripe");
    expect(result.report.inputTokens).toBeGreaterThan(result.report.outputTokens);
    expect(result.report.estimatedTokensSaved).toBeGreaterThan(0);
    expect(result.report.savedRatio).toBeGreaterThan(0);
    expect(result.name).toContain("Composite");
  });

  it("never produces an empty composite when nothing is relevant", () => {
    const skills = [PAYMENT_SKILL].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      language: s.language,
      code: s.code,
    }));
    const result = compressSkillsForTask(skills, "write a haiku about koi fish");
    expect(result.report.keptSkills).toHaveLength(1);
    expect(result.report.droppedSkills).toHaveLength(0);
    expect(result.code).toContain("Stripe");
  });
});

const toSource = (s: SkillRecord): SkillSource => ({
  id: s.id,
  name: s.name,
  description: s.description,
  language: s.language,
  code: s.code,
});

/** Fake embed daemon: Stripe-text embeds onto the task vector, others orthogonal.
 *  Lets the semantic path select by MEANING where keywords find nothing. */
const semanticFetch: typeof fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  const embeddings = body.input.map((t) =>
    t.includes("Stripe") || t === body.input[0] ? [1, 0, 0] : [0, 1, 0],
  );
  return new Response(JSON.stringify({ embeddings }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const failingFetch: typeof fetch = (() => {
  throw new Error("embed daemon down");
}) as unknown as typeof fetch;

describe("hybridScore / semanticSelection", () => {
  it("mixes cosine with normalized keyword hits", () => {
    expect(hybridScore(1, 0, 2)).toBeCloseTo(0.65);
    expect(hybridScore(0, 2, 2)).toBeCloseTo(0.35);
    expect(hybridScore(0, 0, 0)).toBe(0);
  });

  it("keeps scores above the bar, else the top 2 (never empty)", () => {
    const scored = [
      { skill: toSource(PAYMENT_SKILL), score: 0.7 },
      { skill: toSource(FRONTEND_SKILL), score: 0.1 },
      { skill: toSource(GRID_SKILL), score: 0.2 },
    ];
    const kept = semanticSelection(scored);
    expect(kept.map((k) => k.skill.id)).toEqual(["p1"]);
    const none = semanticSelection(scored.map((s) => ({ ...s, score: 0.1 })));
    expect(none.map((k) => k.skill.id)).toEqual(["p1", "f1"]); // top 2 by score (stable)
  });
});

describe("compressSkillsForTaskSemantic", () => {
  const skills = [FRONTEND_SKILL, GRID_SKILL, PAYMENT_SKILL].map(toSource);

  it("selects by meaning where keywords find nothing (matchSource semantic)", async () => {
    // "collect card details from shoppers" shares zero words with Stripe's
    // metadata — the keyword path would keep EVERYTHING. Embeddings pick Stripe.
    const result = await compressSkillsForTaskSemantic(skills, "collect card details from shoppers", {
      embedBaseUrl: "http://fake",
      embedFetch: semanticFetch,
    });
    expect(result.report.matchSource).toBe("semantic");
    expect(result.report.keptSkills.map((s) => s.id)).toEqual(["p1"]);
    expect(result.report.droppedSkills.map((s) => s.id).sort()).toEqual(["f1", "f2"]);
    expect(result.code).toContain("Stripe");
    expect(result.code).not.toContain("Hero Section");
  });

  it("falls back to keywords with honest matchSource when the daemon is down", async () => {
    const result = await compressSkillsForTaskSemantic(
      skills,
      "build a frontend landing page with a hero section and responsive grid",
      { embedBaseUrl: "http://fake", embedFetch: failingFetch },
    );
    expect(result.report.matchSource).toBe("keyword");
    expect(result.report.keptSkills.map((s) => s.id).sort()).toEqual(["f1", "f2"]);
    expect(result.report.droppedSkills.map((s) => s.id)).toEqual(["p1"]);
  });

  it("keeps a keyword-hit skill even when its cosine is the batch minimum", async () => {
    // Live-found regression: for task "parse a CSV file and write normalized
    // JSON", JSON Writer has real "json" keyword hits but its cosine ranked
    // last — min-max normalization zeroed it to 0.175 and it was dropped.
    const batchMin: typeof fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      // Task and CSV (name contains "csv") embed onto [1,0,0]; JSON Writer
      // (contains "JSON") is the batch MINIMUM on [0,1,0].
      const embeddings = body.input.map((t) =>
        t.includes("csv") || t === body.input[0] ? [1, 0, 0] : [0, 1, 0],
      );
      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const csvJson = [
      { ...toSource(FRONTEND_SKILL), id: "csv", name: "CSV Reader", description: "Parse CSV", code: "import csv" },
      { ...toSource(FRONTEND_SKILL), id: "json", name: "JSON Writer", description: "Pretty-print JSON", code: "import json" },
    ];
    const result = await compressSkillsForTaskSemantic(csvJson, "parse a CSV file and write normalized JSON", {
      embedBaseUrl: "http://fake",
      embedFetch: batchMin,
    });
    expect(result.report.matchSource).toBe("semantic");
    // CSV top, JSON Writer kept via keyword anchor despite min cosine.
    expect(result.report.keptSkills.map((k) => k.id).sort()).toEqual(["csv", "json"]);
    expect(result.report.droppedSkills).toHaveLength(0);
  });

  it("emits language-valid comment markers (# for python, // for TS)", async () => {
    const py = [
      { ...toSource(PAYMENT_SKILL), id: "a", language: "Python", name: "Py A", code: "import csv" },
      { ...toSource(PAYMENT_SKILL), id: "b", language: "Python", name: "Py B", code: "import json" },
    ];
    const pyResult = compressSkillsForTask(py, "data parsing");
    expect(pyResult.language).toBe("Python");
    expect(pyResult.code.startsWith("# Composite skill")).toBe(true);
    expect(pyResult.code).toContain("# ── Py A");
    expect(pyResult.code).not.toContain("//");

    const ts = [
      { ...toSource(FRONTEND_SKILL), id: "c", language: "TypeScript", name: "TS A", code: "const a = 1;" },
      { ...toSource(FRONTEND_SKILL), id: "d", language: "TypeScript", name: "TS B", code: "const b = 2;" },
    ];
    const tsResult = compressSkillsForTask(ts, "frontend");
    expect(tsResult.language).toBe("TypeScript");
    expect(tsResult.code.startsWith("// Composite skill")).toBe(true);
  });

  it("keeps everything when the embed cannot discriminate (all-equal cosines)", async () => {
    // Every skill embeds identically to the task → zero spread → no slimming.
    const degenerate: typeof fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      const embeddings = body.input.map(() => [1, 0, 0]);
      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const result = await compressSkillsForTaskSemantic(skills, "anything at all", {
      embedBaseUrl: "http://fake",
      embedFetch: degenerate,
    });
    expect(result.report.matchSource).toBe("semantic");
    expect(result.report.keptSkills).toHaveLength(3);
    expect(result.report.droppedSkills).toHaveLength(0);
  });
});

describe("mission prompt token optimization", () => {
  it("stubs executed-OK skill bodies to one line; keeps failed bodies in full", () => {
    const okResult = {
      skillId: "f1",
      skillName: "Hero Section",
      language: "typescript" as const,
      ok: true,
      exitCode: 0,
      timedOut: false,
      durationMs: 42,
      output: "hero section markup",
    };
    const failResult = {
      skillId: "p1",
      skillName: "Stripe Checkout",
      language: "typescript" as const,
      ok: false,
      exitCode: 1,
      timedOut: false,
      durationMs: 9,
      output: "=== stderr ===\nboom",
      error: "exit 1",
    };

    const merged = mergeSkillCodeBodies(
      [FRONTEND_SKILL, PAYMENT_SKILL],
      [okResult, failResult],
    );
    // Executed-OK skill collapses to a stub referencing run_skill_code.
    expect(merged).toContain("EXECUTED OK");
    expect(merged).not.toContain("const hero");
    // Failed skill keeps its full body for recovery.
    expect(merged).toContain("export const createCheckoutSession");

    const prompt = composeSkillSystemPrompt([FRONTEND_SKILL, PAYMENT_SKILL], "go", [
      okResult,
      failResult,
    ]);
    expect(prompt).toContain("EXECUTED OK");
    expect(prompt).toContain("export const createCheckoutSession");
  });

  it("keeps full bodies when there are no pre-execution results", () => {
    const merged = mergeSkillCodeBodies([FRONTEND_SKILL]);
    expect(merged).toContain("const hero");
  });
});