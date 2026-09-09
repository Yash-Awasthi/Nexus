// SPDX-License-Identifier: Apache-2.0
/**
 * MissionRunner — long-horizon autonomous missions, built on the
 * @nexus/agent-runtime harness loop.
 *
 * A mission is a goal the agent pursues across MULTIPLE harness iterations:
 *
 *   think → act → (spawn) → review → improve → … → done
 *
 *   think      — optional one-shot reasoning pass over the goal (the thinker).
 *   act        — a bounded ToolAgentRuntime run toward the goal (the agent loop,
 *                with whatever tools the toolset provides — including the
 *                self-loop spawn/review/best_of_n tools).
 *   spawn      — optional explicit subagent fan-out (the self-spawn phase); the
 *                model can also spawn inline during `act` via the toolset tool.
 *   review     — a reviewer pass scores the work; accept (score ≥ acceptScore)
 *                ends the mission.
 *   improve    — reviewer issues/suggestions are fed back as the next acting
 *                instruction; the loop continues up to maxIterations.
 *
 * Every phase transition is persisted through an injectable MissionStore (the
 * record, not the live callbacks, is the source of truth — restart-safe), and
 * usage is accumulated across acting runs, reviewer/thinker calls, and spawned
 * children so the cost log stays honest.
 */

import {
  buildReviewPrompt,
  parseReviewResult,
  RuntimeToolSet,
  ToolAgentRuntime,
  type LlmToolFn,
  type RuntimeMessage,
  type RuntimeUsage,
} from "@nexus/agent-runtime";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MissionStatus = "running" | "completed" | "failed" | "aborted";

export type MissionPhase =
  | "started"
  | "thinking"
  | "acting"
  | "spawning"
  | "reviewing"
  | "improving"
  | "completed"
  | "failed"
  | "aborted";

/** One persisted phase transition. */
export interface MissionProgress {
  phase: MissionPhase;
  iteration: number;
  /** Short human-readable note (thinker output, spawn summary, …). */
  note?: string;
  timestamp: string;
}

/** Reviewer verdict over the latest acting output. */
export interface MissionReview {
  score: number;
  verdict: "accept" | "reject" | "unknown";
  issues: string[];
  suggestions: string[];
  /** True when the reviewer produced no parseable structured verdict — a
   *  harness signal, NOT an actual rejection (never chase it as 0/100). */
  unparsed?: boolean;
  /** True when the reviewer returned `accept` but the iteration produced no
   *  output text and no tool activity — the harness blocks that acceptance
   *  deterministically (an empty result can never pass, regardless of model). */
  noWork?: boolean;
}

/** Reference to a skill attached to a mission (id + name; the record carries
 *  the refs so any surface can show which skills actually executed). */
export interface MissionSkillRef {
  id: string;
  name: string;
}

/** Durable mission record — the store's unit of persistence. */
export interface MissionRecord {
  id: string;
  goal: string;
  /** Skills attached to this run (what the acting agent was told to execute). */
  skills?: MissionSkillRef[];
  status: MissionStatus;
  /** True when the reviewer accepted the work; false when the loop ended on budget. */
  accepted: boolean;
  /** True when maxIterations was reached before the reviewer accepted. */
  maxIterationsReached?: boolean;
  iteration: number;
  maxIterations: number;
  acceptScore: number;
  phases: MissionProgress[];
  /** Total harness steps across all acting runs. */
  actingSteps: number;
  /** Number of spawned children (explicit spawn phase only). */
  spawnCount: number;
  lastReview?: MissionReview;
  /** Provenance: this run continues a prior mission's execution memory. */
  memoryFrom?: { missionId: string; outcome: string };
  /** §15.8 — ≤3 carry-forward insights from the cheap local extractor
   * (lib/memory-extractor.ts), written once after this record went terminal.
   * Absent when the extractor is disabled or the local model was unavailable —
   * the deterministic distillation never depends on it. */
  memoryInsights?: { text: string; model: string };
  finalContent: string;
  usage: RuntimeUsage;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Minimal persistence seam — the API layer provides a KV-backed store. */
export interface MissionStore {
  save(record: MissionRecord): Promise<void>;
}

/** One explicit spawn task for the spawn phase. */
export interface MissionSpawnTask {
  instruction: string;
  /** Template id (defaults to the acting template — a self-spawn). */
  agentId?: string;
  maxSteps?: number;
}

export interface MissionRunnerOptions {
  /** Tool-aware LLM (from llmDriverToToolFn / llmDriverToStreamFn adapters). */
  llm: LlmToolFn;
  /** Toolset the acting agent (and spawned children) may use. */
  toolSet?: RuntimeToolSet;
  /** System prompt for the acting agent (the "worker"). */
  actingSystemPrompt?: string;
  /** Workspace root passed to tools via ToolContext. */
  workingDir?: string;
  /** Session id passed to tools + permission requests. */
  sessionId?: string;
  /** Optional one-shot thinking phase prompt. Omit to skip the think phase. */
  thinkPrompt?: string;
  /** System prompt for the reviewer agent. */
  reviewerSystemPrompt?: string;
  /** Max mission iterations (default 3). Each iteration = act + review. */
  maxIterations?: number;
  /** Reviewer score ≥ this accepts the mission (default 70). */
  acceptScore?: number;
  /** Harness steps per acting iteration (default 5). */
  stepsPerIteration?: number;
  /** Optional explicit spawn phase: return sub-agent tasks for this iteration. */
  spawnTasks?: (ctx: {
    goal: string;
    iteration: number;
    actingOutput: string;
  }) => MissionSpawnTask[] | Promise<MissionSpawnTask[]>;
  /** Durable store; every phase transition is saved through it. */
  store?: MissionStore;
  /** Called after every phase transition (SSE/UI progress). */
  onProgress?: (record: MissionRecord) => void;
  signal?: AbortSignal;
  /** Mission id (default: generated). */
  id?: string;
  /** Skills attached to the run — recorded on the record for provenance. */
  skills?: MissionSkillRef[];
  /** Prior-run execution memory this mission continues — recorded on the
   *  record for provenance (the runner owns the stored record, so this must
   *  flow through the options like skills). */
  memoryFrom?: { missionId: string; outcome: string };
  /**
   * Actionable directive distilled from a prior run, seeded onto the acting
   * USER turn (the channel the improve loop uses) on iteration 0 — the model
   * demonstrably attends to the user turn, not the system prompt. It tells
   * the agent what to fix / verify / resume from; the goal is appended after
   * it as the concrete task.
   */
  memoryDirective?: string;
}

// ── MissionRunner ─────────────────────────────────────────────────────────────

export class MissionRunner {
  private readonly llm: LlmToolFn;
  private readonly toolSet: RuntimeToolSet;
  private readonly missionId: string;
  private readonly workingDir?: string;
  private readonly sessionId?: string;
  private readonly actingSystemPrompt: string;
  private readonly thinkPrompt?: string;
  private readonly reviewerSystemPrompt: string;
  private readonly maxIterations: number;
  private readonly acceptScore: number;
  private readonly stepsPerIteration: number;
  private readonly spawnTasks?: MissionRunnerOptions["spawnTasks"];
  private readonly store?: MissionStore;
  private readonly onProgress?: (record: MissionRecord) => void;
  private readonly signal?: AbortSignal;
  private readonly skills?: MissionSkillRef[];
  private readonly memoryFrom?: { missionId: string; outcome: string };
  private readonly memoryDirective?: string;

  constructor(opts: MissionRunnerOptions) {
    this.llm = opts.llm;
    this.toolSet = opts.toolSet ?? new RuntimeToolSet();
    this.missionId = opts.id ?? this.generateId();
    this.workingDir = opts.workingDir;
    this.sessionId = opts.sessionId;
    this.actingSystemPrompt =
      opts.actingSystemPrompt ??
      "You are a mission agent. Work toward the goal using your tools, building on any prior work shown in the conversation.";
    this.thinkPrompt = opts.thinkPrompt;
    this.reviewerSystemPrompt =
      opts.reviewerSystemPrompt ??
      "You are a rigorous reviewer. Score the work 0-100 against the goal; >= 70 accepts. Be specific: name concrete problems, not generalities. If the work under review is empty or contains no concrete result, score it 0 and reject it — never accept empty work. The user message ends with the exact JSON schema — return ONLY that JSON object, nothing else.";
    this.maxIterations = opts.maxIterations ?? 3;
    this.acceptScore = opts.acceptScore ?? 70;
    this.stepsPerIteration = opts.stepsPerIteration ?? 5;
    this.spawnTasks = opts.spawnTasks;
    this.store = opts.store;
    this.onProgress = opts.onProgress;
    this.signal = opts.signal;
    this.skills = opts.skills;
    this.memoryFrom = opts.memoryFrom;
    this.memoryDirective = opts.memoryDirective;
  }

  /** Run a mission to completion (or abort / budget). Returns the final record. */
  async run(goal: string): Promise<MissionRecord> {
    const t0 = new Date().toISOString();
    const record: MissionRecord = {
      // The caller's id wins (route-created records); the runner never mints a
      // phantom id — otherwise every phase save would land under a key nothing
      // reads and the route's record would stay a stuck-looking shell.
      id: this.missionId,
      goal,
      skills: this.skills?.map((s) => ({ id: s.id, name: s.name })),
      memoryFrom: this.memoryFrom,
      status: "running",
      accepted: false,
      iteration: 0,
      maxIterations: this.maxIterations,
      acceptScore: this.acceptScore,
      phases: [],
      actingSteps: 0,
      spawnCount: 0,
      finalContent: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: t0,
      updatedAt: t0,
    };

    await this.phase(record, "started", 0);

    // Carried conversation: each acting run resumes the previous history so the
    // agent builds on its own prior work across iterations.
    let carried: RuntimeMessage[] = [];
    // Iteration 0's acting USER turn: the memory directive (fix X, verify Y,
    // resume from Z) leads, the goal follows — both on the user-turn channel
    // the improve loop already uses, where the model demonstrably attends.
    let improveDirective = this.memoryDirective ? `${this.memoryDirective}\n\nGOAL: ${goal}` : goal;

    for (let iter = 0; iter < this.maxIterations; iter++) {
      record.iteration = iter;
      if (this.signal?.aborted) {
        record.status = "aborted";
        await this.phase(record, "aborted", iter, "aborted by caller");
        return record;
      }

      // 1. THINK — optional one-shot reasoning pass over the goal.
      if (this.thinkPrompt) {
        try {
          const thought = await this.llm(
            [{ role: "user", content: `${this.thinkPrompt}\n\nGoal: ${goal}` }],
            {},
          );
          this.addUsage(record, thought.usage);
          await this.phase(
            record,
            "thinking",
            iter,
            thought.content.trim().slice(0, 300) || "thought",
          );
        } catch (err) {
          record.status = "failed";
          record.error = err instanceof Error ? err.message : String(err);
          await this.phase(record, "failed", iter);
          return record;
        }
      }

      // 2. ACT — bounded harness run toward the goal (resuming prior work).
      let actingOutput = "";
      /** This iteration produced output text or ran a tool (blocks empty accepts). */
      let actingEvidence = false;
      try {
        const acting = new ToolAgentRuntime({
          llm: this.llm,
          toolSet: this.toolSet,
          systemPrompt: this.actingSystemPrompt,
          maxSteps: this.stepsPerIteration,
          initialMessages: carried,
          workingDir: this.workingDir,
          sessionId: this.sessionId,
        });
        const res = await acting.run(improveDirective, this.signal);
        this.addUsage(record, res.totalUsage);
        record.actingSteps += res.steps.length;
        actingOutput = res.finalContent;
        record.finalContent = actingOutput;
        carried = res.messages;
        actingEvidence =
          actingOutput.trim().length > 0 ||
          res.steps.some((s) => (s.content ?? "").trim().length > 0 || s.toolCalls.length > 0);
        await this.phase(
          record,
          "acting",
          iter,
          `steps: ${res.steps.length}${res.aborted ? " (aborted)" : ""}`,
        );
        if (res.aborted && this.signal?.aborted) {
          record.status = "aborted";
          await this.phase(record, "aborted", iter, "aborted mid-acting");
          return record;
        }
      } catch (err) {
        record.status = "failed";
        record.error = err instanceof Error ? err.message : String(err);
        await this.phase(record, "failed", iter);
        return record;
      }

      // 3. SPAWN — optional explicit subagent fan-out (self-spawn by default).
      if (this.spawnTasks) {
        try {
          const tasks = await this.spawnTasks({
            goal,
            iteration: iter,
            actingOutput,
          });
          const results: string[] = [];
          for (const task of tasks) {
            const child = new ToolAgentRuntime({
              llm: this.llm,
              toolSet: this.toolSet,
              systemPrompt: this.actingSystemPrompt,
              maxSteps: task.maxSteps ?? 3,
            });
            const childRes = await child.run(task.instruction, this.signal);
            this.addUsage(record, childRes.totalUsage);
            record.spawnCount += 1;
            results.push(`[${task.agentId ?? "self"}]: ${childRes.finalContent.slice(0, 1000)}`);
            carried.push({
              role: "user",
              content: `Subagent (${task.agentId ?? "self"}) reported:\n${childRes.finalContent.slice(0, 2000)}`,
            });
          }
          await this.phase(record, "spawning", iter, `spawned ${results.length} subagent(s)`);
        } catch (err) {
          record.status = "failed";
          record.error = err instanceof Error ? err.message : String(err);
          await this.phase(record, "failed", iter);
          return record;
        }
      }

      // 4. REVIEW — reviewer scores the latest output against the goal. The
      //     user turn ends with the fill-in JSON schema (the channel treatment
      //     that made memory work: short, concrete, last-instruction).
      let review: MissionReview;
      try {
        const reviewTurn = await this.llm(
          [{ role: "user", content: buildReviewPrompt(goal, actingOutput, "") }],
          { systemPrompt: this.reviewerSystemPrompt },
        );
        this.addUsage(record, reviewTurn.usage);
        review = parseReviewResult(reviewTurn.content);
        record.lastReview = review;
      } catch (err) {
        record.status = "failed";
        record.error = err instanceof Error ? err.message : String(err);
        await this.phase(record, "failed", iter);
        return record;
      }

      await this.phase(
        record,
        "reviewing",
        iter,
        review.unparsed
          ? "reviewer returned no structured verdict — retrying"
          : `score ${review.score}/100 — ${review.verdict}`,
      );

      // 5. Accept → done — but never on an empty iteration. Whatever the
      //     reviewer said, an accept with no output text AND no tool activity
      //     in this iteration is blocked deterministically (the model can
      //     self-gratify; the harness cannot). The reviewer's score is kept on
      //     the record with the noWork marker so the override is auditable.
      const noWork = !actingEvidence;
      if (noWork && review.verdict === "accept" && review.score >= this.acceptScore) {
        review.noWork = true;
        record.lastReview = review;
      }

      if (review.verdict === "accept" && review.score >= this.acceptScore && !review.noWork) {
        record.status = "completed";
        record.accepted = true;
        await this.phase(record, "completed", iter, `accepted at score ${review.score}`);
        return record;
      }

      // 5a. Reviewer accepted, but the run produced nothing this iteration —
      //     deterministic rejection: feed a concrete directive back, not the
      //     reviewer's (groundless) praise.
      if (review.noWork) {
        improveDirective =
          "The reviewer scored the work, but this iteration produced no output and no tool " +
          "activity, so acceptance was blocked. Actually perform the task now: run your tools " +
          "or write the concrete result, then return the deliverable — it will be re-reviewed.";
        await this.phase(
          record,
          "improving",
          iter,
          "accept blocked — no work produced in iteration",
        );
        continue;
      }

      // 5b. Unparsed review = harness failure, NOT a rejection. Never fabricate
      //     issues or a 0/100 score for it — continue as an explicit retry with
      //     a neutral directive so the loop re-reviews, not re-chases noise.
      if (review.unparsed) {
        improveDirective =
          "The reviewer could not produce a structured verdict this pass (its output was not parseable). " +
          "This is NOT a rejection of your work. Verify the work yourself against the goal, fix anything " +
          "actually wrong, and return the result — it will be re-reviewed.";
        await this.phase(record, "improving", iter, "review inconclusive — verify and retry");
        continue;
      }

      // 6. Reject → improve and loop.
      const suggestions = review.suggestions.length
        ? review.suggestions.map((s) => `- ${s}`).join("\n")
        : "- (no suggestions given; address the issues yourself)";
      improveDirective =
        `The reviewer did not accept the current work (score ${review.score}/100).\n` +
        `Issues: ${review.issues.join("; ") || "none listed"}\n` +
        `Suggested improvements:\n${suggestions}\n\n` +
        `Improve the existing work — the full conversation so far is above. Return the improved result.`;
      await this.phase(record, "improving", iter, `${review.issues.length} issue(s) to address`);
    }

    // Budget exhausted without acceptance — best-effort completion, marked honestly.
    record.status = "completed";
    record.accepted = false;
    record.maxIterationsReached = true;
    await this.phase(
      record,
      "completed",
      this.maxIterations - 1,
      "max iterations reached without acceptance — best-effort result",
    );
    return record;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private generateId(): string {
    return `mission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private addUsage(record: MissionRecord, usage?: RuntimeUsage): void {
    if (!usage) return;
    record.usage.inputTokens += usage.inputTokens ?? 0;
    record.usage.outputTokens += usage.outputTokens ?? 0;
    record.usage.totalTokens += usage.totalTokens ?? 0;
  }

  private async phase(
    record: MissionRecord,
    phase: MissionPhase,
    iteration: number,
    note?: string,
  ): Promise<void> {
    record.updatedAt = new Date().toISOString();
    record.phases.push({ phase, iteration, note, timestamp: record.updatedAt });
    if (this.store) {
      try {
        await this.store.save(record);
      } catch {
        /* persistence is best-effort — the runner keeps going */
      }
    }
    this.onProgress?.(record);
  }
}

export default MissionRunner;
