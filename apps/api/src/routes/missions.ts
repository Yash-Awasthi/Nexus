// SPDX-License-Identifier: Apache-2.0
/**
 * Missions — long-horizon autonomous agent runs, wired to the
 * @nexus/agent-engine MissionRunner over the
 * @nexus/agent-runtime self-loop harness.
 *
 * A mission is a goal the agent pursues across multiple harness iterations
 * (think → act → spawn → review → improve → … → done), with a reviewer agent
 * deciding when the work is accepted. Every phase transition is persisted to
 * the shared KV through lib/mission-store.ts, so missions survive restarts and
 * the record — not the live process — is the source of truth.
 *
 * The acting agent gets the self-loop toolset: filesystem tools (read/list/
 * glob/grep), edit_file, run_command (sandbox-bound), spawn_agent_inline
 * (self-spawn), think_deeply, review, and best_of_n.
 */

import { MissionRunner, type MissionRecord } from "@nexus/agent-engine";
import {
  AgentTemplateRegistry,
  createEditFileTool,
  createFilesystemTools,
  createRunCommandTool,
  llmDriverToToolFn,
  makeBestOfNTool,
  makeReviewTool,
  makeSpawnAgentInlineTool,
  makeThinkDeeplyTool,
  RuntimeToolSet,
  type CommandExecutor,
  type LlmToolFn,
} from "@nexus/agent-runtime";
import { EscalationBreaker, type BreakerAction } from "@nexus/escalation-breaker";
import { executeCode } from "@nexus/sandbox";
import type { FastifyInstance } from "fastify";

import { MissionGraphRecorder } from "../lib/mission-graph.js";
import { loadMissionMemory, type MissionMemory } from "../lib/mission-memory.js";
import {
  createMission,
  deleteMission,
  getMission,
  kvMissionStore,
  listMissions,
} from "../lib/mission-store.js";
import { compressSkillsForTaskSemantic, slugify } from "../lib/skill-compress.js";
import {
  composeSkillSystemPrompt,
  executeSkillsOnce,
  makeRunSkillCodeTool,
  withOutputStyle,
  type MissionOutputStyle,
  type SkillRecord,
} from "../lib/skill-runner.js";
import { requireAuthWithTier } from "../middleware/auth.js";

import { getDefaultDriver } from "./api-bridge.js";
import { getSkillsByIds } from "./skills.js";

const MISSION_ACTING_PROMPT = `You are a mission agent. Work toward the stated goal autonomously using your tools.
Build on prior work already present in the conversation. When the reviewer sends feedback, address it directly.
Keep responses concise but complete.`;

const MISSION_THINK_PROMPT =
  "Think step by step about the best approach to this mission before acting.";

/** Sandbox-bound command executor (safe env, bounded timeout) for run_command. */
const sandboxExec: CommandExecutor = async (command, opts) => {
  const r = await executeCode({
    taskType: "sandbox.execute",
    language: "bash",
    code: command,
    timeoutMs: opts.timeoutMs,
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut };
};

/** Abort controllers for running missions (per-process; persistence marks them). */
const _aborters = new Map<string, AbortController>();

function buildMissionToolset(llm: LlmToolFn): RuntimeToolSet {
  const toolSet = new RuntimeToolSet();
  for (const t of createFilesystemTools()) toolSet.add(t);
  toolSet.add(createEditFileTool());
  toolSet.add(createRunCommandTool(sandboxExec));

  // Self-loop tools: the registry carries the mission agent's own template, so
  // spawn_agent_inline defaults to a SELF-spawn.
  const registry = new AgentTemplateRegistry();
  registry.register({
    id: "mission-agent",
    name: "Mission Agent",
    description: "an autonomous mission worker (self)",
    systemPrompt: MISSION_ACTING_PROMPT,
    maxSteps: 5,
  });
  toolSet.add(
    makeSpawnAgentInlineTool(llm, { registry, parentTemplateId: "mission-agent", toolSet }),
  );
  toolSet.add(makeThinkDeeplyTool());
  toolSet.add(makeReviewTool(llm));
  toolSet.add(makeBestOfNTool(llm, { n: 3 }));
  return toolSet;
}

async function startMission(
  uid: string | undefined,
  record: MissionRecord,
  opts: {
    think?: boolean;
    stepsPerIteration?: number;
    skills?: SkillRecord[];
    outputStyle?: MissionOutputStyle;
    /** Prior-run execution memory distilled into the acting prompt. */
    memory?: MissionMemory | null;
  },
): Promise<void> {
  const driver = getDefaultDriver();
  if (!driver) {
    await saveFailedNoDriver(uid, record);
    return;
  }
  const llm: LlmToolFn = llmDriverToToolFn(driver);
  const controller = new AbortController();
  _aborters.set(record.id, controller);

  const skills = opts.skills ?? [];

  // Runaway/cost guardrail (@nexus/escalation-breaker): a
  // steer → constrain → stop ladder fed by tool-call/error signals and per-
  // iteration usage. `steer`/`constrain` land as visible phase notes; `stop`
  // aborts the run through the same controller the route's DELETE uses. The
  // ladder caps at `constrained` unless MISSION_BREAKER_HARD_STOP is set.
  const breaker = new EscalationBreaker(() => ({
    enabled: process.env.MISSION_BREAKER_ENABLED !== "false",
    hardStop: process.env.MISSION_BREAKER_HARD_STOP === "true",
    repeatedToolLimit: parseInt(process.env.MISSION_BREAKER_REPEATED_TOOL_LIMIT ?? "8", 10) || 8,
    errorStormLimit: parseInt(process.env.MISSION_BREAKER_ERROR_STORM_LIMIT ?? "5", 10) || 5,
    tokenVelocityPerMin:
      parseInt(process.env.MISSION_BREAKER_TOKEN_VELOCITY_PER_MIN ?? "60000", 10) || 60000,
    costCapUsd: process.env.MISSION_BREAKER_COST_CAP_USD
      ? parseFloat(process.env.MISSION_BREAKER_COST_CAP_USD)
      : undefined,
    costCapTokens: process.env.MISSION_BREAKER_COST_CAP_TOKENS
      ? parseInt(process.env.MISSION_BREAKER_COST_CAP_TOKENS, 10)
      : undefined,
  }));
  // Per-tick breaker state, updated from the runner's onProgress below.
  let breakerLevel: "steering" | "constrained" | "stopped" | undefined = undefined;
  let breakerReason = "";

  // Zero-write-cost execution memory: every phase transition, every tool call,
  // and every skill-code execution becomes a node in the session spider-graph
  // (see lib/mission-graph.ts). The recorder is created before the toolset so
  // skill runs — harness pre-execution AND model-driven run_skill_code calls —
  // emit their structured started/completed/failed events into the same graph.
  const graph = new MissionGraphRecorder(uid, record.id);
  // Feed the breaker from the graph's tool observation — the recorder is the
  // single owner of tool plumbing; the breaker only reads its signals.
  graph.onToolCall = (toolName, args) => breaker.recordToolUse(record.id, toolName, args);
  graph.onToolError = (toolName) => {
    breaker.recordError(record.id);
    console.log(`[breaker] mission ${record.id}: tool error on ${toolName}`);
  };
  const toolSet = buildMissionToolset(llm);
  if (skills.length > 0) {
    // Skills execute end-to-end: the acting agent gets run_skill_code so the
    // skill's code can be (re-)RUN in the sandbox, not just quoted.
    toolSet.add(makeRunSkillCodeTool(skills, { onExecution: graph }));
  }
  for (const tool of toolSet.list()) {
    toolSet.add(graph.wrapTool(tool)); // wrapped copy replaces the original by name
  }

  // Deterministic harness-side execution: each attached skill's code is run
  // ONCE before the acting loop, so the work happens even if the model never
  // emits a tool call. The real outcomes (or failures to recover from) are
  // embedded in the acting prompt.
  const execResults =
    skills.length > 0 ? await executeSkillsOnce(skills, { onExecution: graph }) : undefined;
  if (execResults) {
    console.log(
      `[skill-runner] mission ${record.id}: pre-executed ${execResults.length} skill(s): ` +
        execResults
          .map((r) => {
            const head = `${r.skillName}=${r.ok ? "ok" : "failed"}${r.error ? ` (${r.error.slice(0, 200)})` : ""}`;
            const out = r.ok ? "" : ` output: ${r.output.slice(0, 400)}`.replace(/\n/g, " ");
            return head + out;
          })
          .join(" | ") +
        ` (cwd=${process.cwd()})`,
    );
  }

  // 4-part dispatch contract: when present, it becomes the leading block of
  // the acting SYSTEM prompt — the worker sees OBJECTIVE / OUTPUT / TOOLS /
  // BOUNDARIES as its standing constraints, with the goal appended as the
  // concrete task.
  const dispatchBlock = record.dispatch
    ? [
        "DISPATCH CONTRACT (follow exactly):",
        `OBJECTIVE — ${record.dispatch.objective}`,
        record.dispatch.output ? `OUTPUT — ${record.dispatch.output}` : null,
        record.dispatch.tools ? `TOOLS — ${record.dispatch.tools}` : null,
        record.dispatch.boundaries ? `BOUNDARIES — ${record.dispatch.boundaries}` : null,
      ]
        .filter((l): l is string => l !== null)
        .join("\n")
    : undefined;
  const basePrompt =
    skills.length > 0
      ? composeSkillSystemPrompt(skills, record.goal, execResults)
      : MISSION_ACTING_PROMPT;
  const actingPrompt = dispatchBlock ? `${dispatchBlock}\n\n${basePrompt}` : basePrompt;

  const runner = new MissionRunner({
    llm,
    toolSet,
    actingSystemPrompt: withOutputStyle(actingPrompt, opts.outputStyle ?? "normal"),
    // The distilled memory is an ACTIONABLE directive that must land on the
    // acting USER turn (the improve-loop channel) — not the system prompt,
    // which the local model ignores. The runner seeds it ahead of the goal on
    // iteration 0; see @nexus/agent-engine memoryDirective.
    memoryDirective: opts.memory?.text,
    thinkPrompt: opts.think === false ? undefined : MISSION_THINK_PROMPT,
    maxIterations: record.maxIterations,
    acceptScore: record.acceptScore,
    stepsPerIteration: opts.stepsPerIteration ?? 5,
    store: kvMissionStore(uid),
    signal: controller.signal,
    workingDir: process.cwd(),
    sessionId: record.id,
    id: record.id,
    skills: skills.map((s) => ({ id: s.id, name: s.name })),
    memoryFrom: record.memoryFrom,
    onProgress: (r) => {
      const last = r.phases[r.phases.length - 1];
      if (last) graph.recordPhase(last.phase, last.iteration, last.note);
      // Tick the breaker once per phase transition. Usage is cumulative, so
      // the velocity arm diffs consecutive samples — never double counts.
      const decisions = breaker.tick(
        [
          {
            runId: record.id,
            progressing: true, // a phase transition is forward progress
            sample: {
              input: r.usage.inputTokens,
              output: r.usage.outputTokens,
              cacheRead: 0,
              cacheCreation: 0,
              ts: Date.now(),
            },
          },
        ],
        Date.now(),
      );
      const decision = decisions[0];
      if (decision) {
        // Only annotate the record when the breaker actually acted — a
        // healthy/recovering level is the default state and adds noise.
        breakerLevel = decision.state.level === "healthy" ? undefined : decision.state.level;
        breakerReason = decision.state.reason;
        const action: BreakerAction = decision.action;
        if (action !== "none") {
          console.log(`[breaker] mission ${record.id}: ${action} — ${decision.state.reason}`);
          graph.recordPhase(action, r.iteration, decision.state.reason);
          if (action === "stop") controller.abort();
        }
      }
    },
  });

  void runner
    .run(record.goal)
    .catch(async (err) => {
      // Honest terminal state on an unexpected runner failure.
      const current = await getMission(uid, record.id);
      if (current && current.status === "running") {
        await kvMissionStore(uid).save({
          ...current,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          updatedAt: new Date().toISOString(),
        });
      }
    })
    .finally(() => {
      _aborters.delete(record.id);
      breaker.forget(record.id);
      // Surface the final breaker state on the record so any consumer can see
      // the run was steered/constrained without parsing the phase list.
      if (breakerLevel !== undefined) {
        void kvMissionStore(uid)
          .save({
            ...record,
            breaker: { level: breakerLevel, reason: breakerReason },
            updatedAt: new Date().toISOString(),
          })
          .catch(() => {});
      }
    });
}

async function saveFailedNoDriver(uid: string | undefined, record: MissionRecord): Promise<void> {
  await kvMissionStore(uid).save({
    ...record,
    status: "failed",
    error: "No LLM driver configured — set at least one provider API key.",
    updatedAt: new Date().toISOString(),
  });
}

export async function missionRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/missions — start a mission ────────────────────────────────────
  app.post<{
    Body: {
      goal: string;
      skillIds?: string[];
      /** Task-compress the given skills into ONE composite unit for this run
       *  (semantic selection, keyword fallback) — the mission's "temporary
       *  frontend composite" that never needs to be saved. */
      compress?: { ids?: unknown; task?: unknown };
      /** Continue a prior mission's execution memory: its record + graph are
       *  distilled into the acting prompt (verdict, review issues, tool trace,
       *  final excerpt) so this run starts from the diff, not from blank. */
      continueFrom?: string;
      maxIterations?: number;
      acceptScore?: number;
      stepsPerIteration?: number;
      think?: boolean;
      outputStyle?: string;
      /** Structured 4-part dispatch contract (OBJECTIVE / OUTPUT / TOOLS /
       *  BOUNDARIES) folded into the acting prompt so the worker runs
       *  autonomously against concrete constraints. */
      dispatch?: {
        objective?: string;
        output?: string;
        tools?: string;
        boundaries?: string;
      };
    };
  }>("/missions", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const goal = (request.body.goal ?? "").trim();
    if (!goal) return reply.code(400).send({ error: "goal_required", message: "goal is required" });
    if (goal.length > 4000) return reply.code(400).send({ error: "goal_too_long" });

    // 4-part dispatch contract — validated once, stored on the record, folded
    // into the acting prompt. The objective is required when dispatch is given
    // (it IS the goal's structured form); the other three are optional.
    let dispatch: MissionRecord["dispatch"] = undefined;
    if (request.body.dispatch !== undefined) {
      const d = request.body.dispatch;
      if (typeof d !== "object" || d === null || Array.isArray(d)) {
        return reply.code(400).send({ error: "dispatch_object_required" });
      }
      const objective = (d.objective ?? "").trim();
      if (!objective) {
        return reply.code(400).send({
          error: "dispatch_objective_required",
          message: "dispatch.objective is required",
        });
      }
      const clean = (s: string | undefined, cap: number): string | undefined => {
        const t = (s ?? "").trim();
        if (!t) return undefined;
        return t.slice(0, cap);
      };
      dispatch = {
        objective: objective.slice(0, 4000),
        output: clean(d.output, 2000),
        tools: clean(d.tools, 2000),
        boundaries: clean(d.boundaries, 2000),
      };
    }

    const maxIterations = Math.min(10, Math.max(1, Math.round(request.body.maxIterations ?? 3)));
    const acceptScore = Math.min(100, Math.max(1, Math.round(request.body.acceptScore ?? 70)));
    const rawStyle = (request.body.outputStyle ?? "normal").toLowerCase();
    const outputStyle: MissionOutputStyle =
      rawStyle === "terse" || rawStyle === "ponytail" || rawStyle === "caveman"
        ? rawStyle
        : "normal";

    // Skills attached to the mission become executable units in the run: the
    // acting agent's prompt is composed from them and run_skill_code executes
    // their code in the sandbox. Unknown ids are skipped honestly (400 if none
    // resolve so the caller sees the mistake).
    let skills: SkillRecord[] = [];
    if (request.body.skillIds !== undefined) {
      if (!Array.isArray(request.body.skillIds)) {
        return reply.code(400).send({ error: "skillIds_array_required" });
      }
      const ids = [...new Set(request.body.skillIds.map((x) => x.slice(0, 200)).filter(Boolean))];
      if (ids.length > 20) return reply.code(400).send({ error: "too_many_skills" });
      skills = getSkillsByIds(ids);
      if (skills.length === 0) {
        return reply.code(400).send({
          error: "unknown_skills",
          message: "None of the provided skillIds resolve to a stored skill",
        });
      }
    }

    // Task-compression: skillIds + a task become ONE temporary composite skill
    // (semantic selection, keyword fallback) that pre-executes as a unit like
    // any other attached skill — the composite never has to be saved.
    if (request.body.compress !== undefined) {
      const rawIds = request.body.compress.ids;
      const task = String(request.body.compress.task ?? "").trim();
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        return reply.code(400).send({ error: "compress_ids_required" });
      }
      if (!task) return reply.code(400).send({ error: "compress_task_required" });
      if (task.length > 2000) return reply.code(400).send({ error: "compress_task_too_long" });
      const ids = [...new Set(rawIds.map((x) => String(x).slice(0, 200)).filter(Boolean))];
      if (ids.length > 20) return reply.code(400).send({ error: "too_many_skills" });
      const stored = getSkillsByIds(ids);
      if (stored.length === 0) {
        return reply.code(400).send({
          error: "unknown_skills",
          message: "None of the provided compress ids resolve to a stored skill",
        });
      }
      const sources = stored.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        language: s.language,
        code: s.code ?? "",
      }));
      try {
        const composite = await compressSkillsForTaskSemantic(sources, task, {
          embedBaseUrl: process.env.OLLAMA_BASE_URL,
        });
        skills.push({
          id: `composite:${slugify(task)}`,
          name: composite.name,
          description: composite.description,
          language: composite.language,
          code: composite.code,
        });
      } catch (err) {
        return reply.code(400).send({
          error: "compress_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Prior-run memory: distill the referenced mission's record + graph so the
    // acting agent continues from where it left off (see lib/mission-memory.ts).
    let memory: MissionMemory | null = null;
    if (request.body.continueFrom !== undefined) {
      const prevId = request.body.continueFrom.slice(0, 200);
      memory = await loadMissionMemory(request.nexusUserId, prevId);
      if (!memory) {
        return reply.code(400).send({
          error: "unknown_or_running_mission",
          message: "continueFrom must reference your own terminal mission",
        });
      }
    }

    const record = await createMission(request.nexusUserId, goal, {
      maxIterations,
      acceptScore,
      dispatch,
    });
    if (memory) {
      // The runner owns the stored record (its first phase save overwrites the
      // shell), so memoryFrom must flow through the runner options — the same
      // path as skills — not be patched onto the store record afterwards.
      record.memoryFrom = { missionId: memory.missionId, outcome: memory.summary };
      console.log(
        `[mission-memory] mission ${record.id} continuing from ${memory.missionId} ` +
          `(${memory.summary}, ${memory.text.length} chars)`,
      );
    }
    void startMission(request.nexusUserId, record, {
      think: request.body.think,
      stepsPerIteration: request.body.stepsPerIteration,
      skills,
      outputStyle,
      memory,
    });
    return reply.code(202).send(record);
  });

  // ── GET /api/missions — list own missions, newest first ─────────────────────
  app.get("/missions", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const missions = await listMissions(request.nexusUserId);
    return reply.send({
      missions,
      total: missions.length,
    });
  });

  // ── GET /api/missions/:id — one mission (per-user isolation) ────────────────
  app.get<{ Params: { id: string } }>(
    "/missions/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const mission = await getMission(request.nexusUserId, request.params.id);
      if (!mission) return reply.code(404).send({ error: "not_found" });
      return reply.send(mission);
    },
  );

  // ── POST /api/missions/:id/abort — stop a running mission ───────────────────
  app.post<{ Params: { id: string } }>(
    "/missions/:id/abort",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const mission = await getMission(request.nexusUserId, request.params.id);
      if (!mission) return reply.code(404).send({ error: "not_found" });
      if (mission.status !== "running") {
        return reply.send({ ok: true, status: mission.status }); // already terminal
      }
      const controller = _aborters.get(request.params.id);
      if (controller) controller.abort();
      else {
        // Orphaned (restart) — mark terminal right away.
        await kvMissionStore(request.nexusUserId).save({
          ...mission,
          status: "aborted",
          updatedAt: new Date().toISOString(),
        });
      }
      return reply.send({ ok: true, status: "aborting" });
    },
  );

  // ── DELETE /api/missions/:id — remove a mission ─────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/missions/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const controller = _aborters.get(request.params.id);
      controller?.abort();
      await deleteMission(request.nexusUserId, request.params.id);
      return reply.send({ ok: true });
    },
  );
}
