// SPDX-License-Identifier: Apache-2.0
/**
 * Multi-agent code loop — model-per-role routing.
 *
 * Five specialist agents collaborate in a structured loop to produce, review,
 * and refine code from a plain-English specification.  Each agent runs on a
 * different Groq model tuned for its workload:
 *
 *   Planner      (70b) — structured implementation plan from spec
 *   Implementer  (8b)  — code from plan (fast, cheap drafts)
 *   Reviewer     (70b) — quality gate: accept or give precise feedback
 *   Debugger     (8b)  — targeted fix from reviewer feedback
 *   Synthesizer  (70b) — final summary written for humans
 *
 * Loop shape
 * ----------
 *   plan → implement → review ─── (accepted) ──→ synthesize → done
 *                         └───── (rejected) ──→ debug → review → …
 *
 * On reaching maxIterations without acceptance the last code and feedback
 * are returned with `accepted: false`.
 */

// ── Groq API base URL (OpenAI-compatible) ────────────────────────────────────

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";

// ── Role definition ──────────────────────────────────────────────────────────

export interface CodeLoopRole {
  /** Display name shown in iteration records */
  name: string;
  /** Groq model ID for this role */
  model: string;
  /** System prompt for this role */
  systemPrompt: string;
  /** Sampling temperature (default: role-specific) */
  temperature?: number;
  /** Max tokens to generate (default: 2048) */
  maxTokens?: number;
}

/**
 * Default role configurations.
 * Fast 8b models for generative roles; 70b for planning and review gating.
 * All models are Groq-hosted llama variants.
 */
export const DEFAULT_ROLES: Record<string, CodeLoopRole> = {
  planner: {
    name: "Planner",
    model: "llama-3.3-70b-versatile",
    temperature: 0.3,
    maxTokens: 1024,
    systemPrompt: [
      "You are a senior software architect.",
      "Given a code specification, produce a concise numbered implementation plan.",
      "Each step should be one actionable task (e.g. 'Define function X', 'Add validation for Y').",
      "Do NOT write any code — only the plan.",
      "Format: numbered list, one step per line.",
    ].join(" "),
  },
  implementer: {
    name: "Implementer",
    model: "llama-3.1-8b-instant",
    temperature: 0.2,
    maxTokens: 2048,
    systemPrompt: [
      "You are an expert software engineer.",
      "Given a numbered implementation plan and optionally a previous attempt with feedback,",
      "write clean, working code that fulfils every step in the plan.",
      "Return ONLY the code — no explanations, no markdown fences.",
    ].join(" "),
  },
  reviewer: {
    name: "Reviewer",
    model: "llama-3.3-70b-versatile",
    temperature: 0.1,
    maxTokens: 512,
    systemPrompt: [
      "You are a strict code reviewer.",
      "Evaluate the code against the original specification.",
      "Respond in exactly this format (no other text):",
      "ACCEPTED: yes\nFEEDBACK: <one sentence>",
      "OR",
      "ACCEPTED: no\nFEEDBACK: <specific issues to fix, one per line>",
      "Do not output anything outside this format.",
    ].join(" "),
  },
  debugger: {
    name: "Debugger",
    model: "llama-3.1-8b-instant",
    temperature: 0.2,
    maxTokens: 2048,
    systemPrompt: [
      "You are a debugging specialist.",
      "Given code and a list of specific reviewer issues, fix exactly those issues.",
      "Return ONLY the corrected code — no explanations, no markdown fences.",
    ].join(" "),
  },
  synthesizer: {
    name: "Synthesizer",
    model: "llama-3.3-70b-versatile",
    temperature: 0.5,
    maxTokens: 512,
    systemPrompt: [
      "You are a technical writer.",
      "Given a spec and the final code, write a 2-4 sentence summary describing",
      "what was implemented, key design decisions, and any caveats.",
      "Be concise and precise — this goes into a code review report.",
    ].join(" "),
  },
};

// ── Task and result types ────────────────────────────────────────────────────

export interface CodeLoopTask {
  taskType: "council.code_loop";
  /** Plain-English description of what to build */
  spec: string;
  /** Max review-debug-review cycles (default: 3) */
  maxIterations?: number;
  /**
   * Override individual role configurations.
   * Keys: "planner" | "implementer" | "reviewer" | "debugger" | "synthesizer"
   * Merged shallowly with DEFAULT_ROLES so you only need to specify deltas.
   */
  roleOverrides?: Partial<Record<string, Partial<CodeLoopRole>>>;
}

export interface CodeLoopIteration {
  iteration: number;
  /** Plan text (only present in iteration 1) */
  plan?: string;
  /** Code produced by implementer or debugger this iteration */
  code: string;
  /** Whether the reviewer accepted this code */
  reviewAccepted: boolean;
  /** Reviewer feedback text */
  reviewFeedback: string;
  /** Debug notes produced by the debugger (absent in iteration 1) */
  debugNotes?: string;
  latencyMs: number;
}

export interface CodeLoopResult {
  ok: boolean;
  /** Final code (last accepted version, or last attempt if never accepted) */
  finalCode: string;
  /** Final reviewer feedback */
  finalReview: string;
  /** True if the reviewer accepted the code before maxIterations was reached */
  accepted: boolean;
  /** Per-iteration record for observability */
  iterations: CodeLoopIteration[];
  /** Synthesizer summary (empty string if loop failed without acceptance) */
  synthesis: string;
  totalIterations: number;
  tokenUsage: { promptTokens: number; completionTokens: number };
  totalLatencyMs: number;
  error?: string;
}

// ── Internal LLM call ────────────────────────────────────────────────────────

interface GroqChatResponse {
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

interface LLMResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

async function llmCall(
  systemPrompt: string,
  userContent: string,
  role: CodeLoopRole,
  apiKey: string,
): Promise<LLMResult> {
  const start = Date.now();

  const res = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: role.model,
      temperature: role.temperature ?? 0.3,
      max_tokens: role.maxTokens ?? 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as GroqChatResponse;
  const content = data.choices[0]?.message?.content ?? "";

  return {
    content,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}

// ── Reviewer response parser ──────────────────────────────────────────────────

function parseReview(raw: string): { accepted: boolean; feedback: string } {
  const upper = raw.toUpperCase();
  const acceptedMatch = /ACCEPTED:\s*(yes|no)/i.exec(raw);
  const feedbackMatch = /FEEDBACK:\s*(.+)/is.exec(raw);

  const accepted =
    acceptedMatch != null
      ? (acceptedMatch[1] ?? "no").toLowerCase() === "yes"
      : upper.includes("ACCEPTED: YES") || upper.includes("LGTM");
  const feedback = feedbackMatch != null ? (feedbackMatch[1] ?? raw).trim() : raw.trim();

  return { accepted, feedback };
}

// ── Role resolver ─────────────────────────────────────────────────────────────

interface ResolvedRoles {
  planner: CodeLoopRole;
  implementer: CodeLoopRole;
  reviewer: CodeLoopRole;
  debugger: CodeLoopRole;
  synthesizer: CodeLoopRole;
}

function resolveRoles(
  overrides: Partial<Record<string, Partial<CodeLoopRole>>> | undefined,
): ResolvedRoles {
  function merge(key: string): CodeLoopRole {
    const def = DEFAULT_ROLES[key]!;
    const override = overrides?.[key] ?? {};
    return { ...def, ...override };
  }
  return {
    planner: merge("planner"),
    implementer: merge("implementer"),
    reviewer: merge("reviewer"),
    debugger: merge("debugger"),
    synthesizer: merge("synthesizer"),
  };
}

// ── Main loop ────────────────────────────────────────────────────────────────

export async function runCodeLoop(task: CodeLoopTask, apiKey: string): Promise<CodeLoopResult> {
  const start = Date.now();
  const maxIter = task.maxIterations ?? 3;
  const roles = resolveRoles(task.roleOverrides);
  const spec = task.spec;

  const totalUsage = { promptTokens: 0, completionTokens: 0 };
  const iterations: CodeLoopIteration[] = [];

  function addUsage(r: LLMResult): void {
    totalUsage.promptTokens += r.promptTokens;
    totalUsage.completionTokens += r.completionTokens;
  }

  // ── Step 1: Plan ────────────────────────────────────────────────────────────

  let plan: string;
  {
    const r = await llmCall(
      roles.planner.systemPrompt,
      `Specification:\n${spec}`,
      roles.planner,
      apiKey,
    );
    addUsage(r);
    plan = r.content.trim();
  }

  // ── Steps 2-N: Implement → Review → (Debug → Review)* ──────────────────────

  let currentCode = "";
  let lastReview = { accepted: false, feedback: "" };
  let debugNotes: string | undefined;

  for (let iter = 1; iter <= maxIter; iter++) {
    const iterStart = Date.now();

    // Implement or debug
    let newCode: string;
    if (iter === 1) {
      // First pass — implementer works from plan
      const r = await llmCall(
        roles.implementer.systemPrompt,
        `Specification:\n${spec}\n\nImplementation plan:\n${plan}`,
        roles.implementer,
        apiKey,
      );
      addUsage(r);
      newCode = r.content.trim();
      debugNotes = undefined;
    } else {
      // Subsequent passes — debugger fixes issues from reviewer feedback
      const r = await llmCall(
        roles.debugger.systemPrompt,
        [
          `Specification:\n${spec}`,
          `\nCurrent code:\n${currentCode}`,
          `\nReviewer issues:\n${lastReview.feedback}`,
        ].join("\n"),
        roles.debugger,
        apiKey,
      );
      addUsage(r);
      newCode = r.content.trim();
      debugNotes = `Fixed: ${lastReview.feedback.slice(0, 200)}`;
    }

    currentCode = newCode;

    // Review
    const reviewRaw = await llmCall(
      roles.reviewer.systemPrompt,
      `Specification:\n${spec}\n\nCode to review:\n${currentCode}`,
      roles.reviewer,
      apiKey,
    );
    addUsage(reviewRaw);
    lastReview = parseReview(reviewRaw.content);

    const record: CodeLoopIteration = {
      iteration: iter,
      code: currentCode,
      reviewAccepted: lastReview.accepted,
      reviewFeedback: lastReview.feedback,
      latencyMs: Date.now() - iterStart,
      ...(iter === 1 ? { plan } : {}),
      ...(debugNotes != null ? { debugNotes } : {}),
    };
    iterations.push(record);

    if (lastReview.accepted) break;
  }

  // ── Synthesize ──────────────────────────────────────────────────────────────

  let synthesis = "";
  if (lastReview.accepted) {
    const r = await llmCall(
      roles.synthesizer.systemPrompt,
      `Specification:\n${spec}\n\nFinal code:\n${currentCode}`,
      roles.synthesizer,
      apiKey,
    );
    addUsage(r);
    synthesis = r.content.trim();
  }

  return {
    ok: true,
    finalCode: currentCode,
    finalReview: lastReview.feedback,
    accepted: lastReview.accepted,
    iterations,
    synthesis,
    totalIterations: iterations.length,
    tokenUsage: totalUsage,
    totalLatencyMs: Date.now() - start,
  };
}
