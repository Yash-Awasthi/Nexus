// SPDX-License-Identifier: Apache-2.0
/**
 * skill-runner — the skills → runtime execution bridge (mission pillar 1:
 * "skills must actually execute work end-to-end").
 *
 * A skill stops being decorative text here: when a mission is started with
 * `skillIds`, the acting agent's system prompt is composed from the skill
 * records (name/description/procedure + deduped merged code) and the toolset
 * gains a `run_skill_code` tool that actually EXECUTES the skill's code in the
 * local sandbox (@nexus/sandbox: node / tsx / python3 / bash via child_process).
 *
 * The loop is the harness's own: plan → run_skill_code → inspect output →
 * on failure the error is fed back and the model recovers (fixes the code via
 * edit_file and re-runs) → verify → reviewer accepts. Nothing here injects a
 * canned prompt; the skill is a real executable unit.
 */

import type { RuntimeTool, ToolContext } from "@nexus/agent-runtime";
import {
  compressForTool,
  injectSystemPrompt,
  type InjectorName,
} from "@nexus/llm-compress";
import { executeCode, type Runner, type SandboxLanguage } from "@nexus/sandbox";

import type { ExecutionStatus } from "./session-graph.js";
import { splitSkillCodeImports } from "./skill-imports.js";

/** Structural shape of a stored skill (matches StoredSkill in routes/skills.ts). */
/** Output styles for mission agents — opt-in system-prompt injectors that cut
 *  output tokens (caveman-ponytail parity with OmniRoute output styles). */
export type MissionOutputStyle = "normal" | "terse" | "ponytail" | "caveman";

const STYLE_INJECTORS: Record<Exclude<MissionOutputStyle, "normal">, InjectorName[]> = {
  terse: ["terse-output"],
  ponytail: ["ponytail", "terse-output"],
  caveman: ["caveman-output", "ponytail"],
};

/** Apply an output style to a system prompt (no-op for "normal"; idempotent). */
export function withOutputStyle(base: string, style: MissionOutputStyle): string {
  if (style === "normal") return base;
  return injectSystemPrompt(base, STYLE_INJECTORS[style]);
}

export interface SkillRecord {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  code?: string;
  language?: string;
  parameters?: Record<string, unknown>;
}

const SANDBOX_LANGUAGES: Record<string, SandboxLanguage> = {
  python: "python",
  typescript: "typescript",
  javascript: "javascript",
  js: "javascript",
  ts: "typescript",
  bash: "bash",
  shell: "bash",
  sh: "bash",
};

/** Map a skill's language label to a sandbox runtime; undefined = unsupported. */
export function skillLanguageToSandbox(language?: string): SandboxLanguage | undefined {
  if (!language) return undefined;
  return SANDBOX_LANGUAGES[language.trim().toLowerCase()];
}

/** Substitute `{{name}}` placeholders in skill code from runtime params. */
export function substituteParams(code: string, params?: Record<string, unknown>): string {
  if (!params || typeof params !== "object") return code;
  return code.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (match, key: string) =>
    params[key] !== undefined ? String(params[key]) : match,
  );
}

const SKILL_EXEC_TIMEOUT_MS = 30_000;

/**
 * Structured execution-event seam into the mission/session graph. The runner
 * calls `recordSkillExecution` around every real sandbox run — start, then a
 * terminal completed/failed event — so skill executions become graph nodes
 * WITHOUT the model writing anything (see lib/mission-graph.ts, which
 * implements this shape via its sink). Returns the recorded node id so the
 * terminal event can chain deterministically to its started node.
 */
export interface SkillExecutionRecorder {
  recordSkillExecution(opts: {
    skillId: string;
    skillName: string;
    status: ExecutionStatus;
    detail?: string;
    from?: string;
  }): string;
}

const OUTCOME_DETAIL_CHARS = 200;

/** Short one-line outcome for a sandbox run (used for the graph event). */
function outcomeDetail(r: {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
  output?: string;
}): string {
  const ms = Number.isFinite(r.durationMs) ? Math.round(r.durationMs) : 0;
  if (r.timedOut) return `timed out after ${ms}ms`;
  if (!r.ok) {
    const err = (r.error ?? "").trim();
    if (err) return `failed: ${err.slice(0, OUTCOME_DETAIL_CHARS)}`;
    const out = (r.output ?? "").trim().split("\n").filter(Boolean).pop();
    const tail = out ? ` — ${out.slice(0, OUTCOME_DETAIL_CHARS)}` : "";
    return `failed (exit ${r.exitCode})${tail}`;
  }
  return `completed in ${ms}ms (exit ${r.exitCode})`;
}

type RunCodeResult = Awaited<ReturnType<typeof executeCode>>;

/**
 * One shared skill-run choreography (used by BOTH the harness pre-execution
 * path and the run_skill_code tool, so a change to the event shape lands in
 * one place): emit a `started` event, run the code, emit the terminal
 * `completed`/`failed` event chained to the start, and — if the sandbox
 * itself throws — emit `failed` and rethrow so the caller (and the harness
 * loop / tool wrapper) sees the failure exactly as before.
 */
async function runSkillWithExecution(
  skill: SkillRecord,
  language: SandboxLanguage,
  budgetMs: number,
  recorder: SkillExecutionRecorder | undefined,
  run: () => Promise<RunCodeResult>,
): Promise<RunCodeResult> {
  const started = recorder?.recordSkillExecution({
    skillId: skill.id,
    skillName: skill.name,
    status: "started",
    detail: `${language} · ${budgetMs}ms budget`,
  });
  try {
    const result = await run();
    const ok = result.ok && result.exitCode === 0 && !result.timedOut;
    recorder?.recordSkillExecution({
      skillId: skill.id,
      skillName: skill.name,
      status: ok ? "completed" : "failed",
      detail: outcomeDetail({
        ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        error: result.error,
        output: `${result.stdout}\n${result.stderr}`,
      }),
      from: started,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recorder?.recordSkillExecution({
      skillId: skill.id,
      skillName: skill.name,
      status: "failed",
      detail: `sandbox threw: ${message.slice(0, OUTCOME_DETAIL_CHARS)}`,
      from: started,
    });
    throw err;
  }
}

/** Result of one deterministic harness-side skill execution. */
export interface SkillExecutionResult {
  skillId: string;
  skillName: string;
  language: SandboxLanguage | "unsupported";
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Compressed stdout+stderr (lossless cleanup + bounded tail truncation). */
  output: string;
  error?: string;
}

/**
 * Execute every attached skill's code ONCE, up front, in the harness — so a
 * skill's work happens even if the model never emits a tool call. This is the
 * anti-fake-agentic guarantee: execution is deterministic, not a suggestion.
 * Failures are returned (not thrown) so the acting agent gets a real recovery
 * task: inspect → fix → re-run via run_skill_code.
 */
export async function executeSkillsOnce(
  skills: SkillRecord[],
  opts: { runner?: Runner; onExecution?: SkillExecutionRecorder } = {},
): Promise<SkillExecutionResult[]> {
  const results: SkillExecutionResult[] = [];
  for (const skill of skills) {
    const language = skillLanguageToSandbox(skill.language);
    if (!language) {
      results.push({
        skillId: skill.id,
        skillName: skill.name,
        language: "unsupported",
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        output: "",
        error: `unsupported language "${skill.language ?? "none"}"`,
      });
      continue;
    }
    const code = substituteParams(skill.code ?? "", skill.parameters ?? {});
    if (!code.trim()) {
      results.push({
        skillId: skill.id,
        skillName: skill.name,
        language,
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        output: "",
        error: "skill has no code to execute",
      });
      continue;
    }
    try {
      // One shared choreography: started → run → completed/failed, emitted by
      // the runtime — the graph gets the skill run without the model writing a
      // single token.
      const r = await runSkillWithExecution(
        skill,
        language,
        SKILL_EXEC_TIMEOUT_MS,
        opts.onExecution,
        () =>
          executeCode(
            { taskType: "sandbox.execute", language, code, timeoutMs: SKILL_EXEC_TIMEOUT_MS },
            opts.runner,
          ),
      );
      const compressed = compressForTool(
        "run_skill_code",
        `=== stdout ===\n${r.stdout}\n=== stderr ===\n${r.stderr}`,
        { allowLossy: true },
      );
      const ok = r.ok && r.exitCode === 0 && !r.timedOut;
      results.push({
        skillId: skill.id,
        skillName: skill.name,
        language,
        ok,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        output: compressed.text,
        error: !r.ok ? r.error : undefined,
      });
    } catch (err) {
      // runSkillWithExecution already recorded the `failed` event + rethrew.
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        skillId: skill.id,
        skillName: skill.name,
        language,
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        output: "",
        error: message,
      });
    }
  }
  return results;
}

/**
 * `run_skill_code` RuntimeTool — executes a skill's code in the local sandbox.
 *
 * Returns a compressed execution result (lossless cleanup + bounded tail
 * truncation so a noisy run can't flood the model's context). Failures are
 * returned as structured `error` output — never thrown — so the harness loop
 * sees them, reports them, and the model can recover (fix + re-run).
 */
export function makeRunSkillCodeTool(
  skills: SkillRecord[],
  opts: { runner?: Runner; onExecution?: SkillExecutionRecorder } = {},
): RuntimeTool {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const names = skills.map((s) => `${s.id} — ${s.name}`).join("; ");

  return {
    name: "run_skill_code",
    description:
      "Execute the code of a skill in the local sandbox and return its stdout/stderr. " +
      "Use this to actually RUN the work a skill specifies — do not merely restate the skill's " +
      "instructions. Inspect the output; if the run failed, fix the code (edit_file) and re-run. " +
      `Available skills: ${names || "(none registered)"}`,
    parameters: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "id of the skill to execute" },
        params: {
          type: "object",
          description: "optional {{name}} substitutions applied to the skill code",
        },
        timeout_ms: { type: "number", description: "execution timeout in ms (max 30000)" },
      },
      required: ["skill_id"],
    },
    handler: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<unknown> => {
      const skill = byId.get(String(args.skill_id ?? ""));
      if (!skill) {
        return { ok: false, error: `Unknown skill id "${String(args.skill_id)}"` };
      }
      const language = skillLanguageToSandbox(skill.language);
      if (!language) {
        return {
          ok: false,
          error: `Skill "${skill.name}" has unsupported language "${skill.language ?? "none"}" ` +
            `(supported: python, typescript, javascript, bash)`,
        };
      }
      const code = substituteParams(skill.code ?? "", (args.params as Record<string, unknown>) ?? {});
      if (!code.trim()) {
        return { ok: false, error: `Skill "${skill.name}" has no code to execute` };
      }

      const timeoutMs = Math.min(
        Math.max(1_000, Number(args.timeout_ms) || SKILL_EXEC_TIMEOUT_MS),
        SKILL_EXEC_TIMEOUT_MS,
      );
      const signal = ctx?.signal;

      // Model-driven runs carry the same structured nodes as harness
      // pre-execution (started → completed/failed) via the shared helper; a
      // thrown sandbox error records `failed` and propagates so the harness
      // loop (and tool wrapper) still sees the failure.
      const result = await runSkillWithExecution(
        skill,
        language,
        timeoutMs,
        opts.onExecution,
        () => executeCode({ taskType: "sandbox.execute", language, code, timeoutMs }, opts.runner),
      );
      const compressed = compressForTool(
        "run_skill_code",
        `=== stdout ===\n${result.stdout}\n=== stderr ===\n${result.stderr}`,
        { allowLossy: true },
      );

      const payload: Record<string, unknown> = {
        ok: result.ok,
        language,
        skill: skill.name,
        skill_id: skill.id,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        output: compressed.text,
        outputChars: compressed.compressedChars,
        outputTokens: compressed.compressedTokens,
      };
      if (!result.ok && result.error) payload.error = result.error;
      // Non-zero exit / timeout / spawn failure = a failed run the model must
      // recover from — surfaced as an error so the harness can react.
      if (!result.ok || result.exitCode !== 0 || result.timedOut) {
        payload.recoverable = true;
        payload.recoveryHint =
          "The skill run failed. Inspect the output, fix the skill's code with edit_file " +
          "(or your own logic), then call run_skill_code again. Do not declare success.";
      }
      void signal; // cooperative cancellation is enforced by the sandbox timeout
      return payload;
    },
  };
}

/**
 * Compose the acting agent's system prompt for a skills-backed mission.
 *
 * The skill records become the operating procedure: the agent's job is to
 * execute them end-to-end with the runtime tools, not to paraphrase them.
 * Code sections are merged with the same deterministic dedupe as the merge UI
 * (shared imports once), and the prompt is explicit about plan → run → inspect
 * → recover → verify so the loop behaves like a real executor.
 *
 * When `execResults` is given (the harness already ran the skills once), the
 * real outcomes are embedded and the agent's job becomes verify-and-report,
 * or inspect → fix → re-run for any failed skill.
 */
export function composeSkillSystemPrompt(
  skills: SkillRecord[],
  goal: string,
  execResults?: SkillExecutionResult[],
): string {
  const sections = skills.map((s) => {
    const lang = s.language ? ` (${s.language})` : "";
    return [
      `## Skill: ${s.name}${lang}`,
      s.description ? `Description: ${s.description}` : "",
      `id: ${s.id}`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    "You are a mission agent executing skills end-to-end. The skills below are EXECUTABLE units:",
    "each has a runnable `code` body you must actually run in the sandbox — never just",
    "restate instructions or pretend the work is done.",
    "",
    sections.join("\n\n"),
    "",
    "## How to execute",
    "1. PLAN: read each skill's procedure and the goal below; decide what to run.",
    "2. ACT: call run_skill_code with the skill_id (and any {{param}} substitutions) to",
    "   execute the skill's code. Use the other tools (read/list/glob/edit_file/run_command)",
    "   to prepare inputs and verify side effects.",
    "3. INSPECT: read the returned stdout/stderr and exit code.",
    "4. RECOVER: if a run failed (non-zero exit, timeout, error), fix the code or your",
    "   approach and re-run. Never report success on a failed run.",
    "5. VERIFY: confirm the skill's intended output actually exists (file written,",
    "   transformation applied) before finishing.",
    "",
    `## Goal\n${goal}`,
    "",
    ...(execResults && execResults.length > 0
      ? [
          "## Pre-execution results (the harness already ran each skill's code)",
          "These are REAL run results, captured before this agent turn. Do not re-run skills",
          "that already succeeded unless you changed their inputs — your job is to inspect,",
          "verify side effects, and report. For FAILED runs, recover: inspect the output,",
          "fix the code (edit_file / run_command), then re-run via run_skill_code until it",
          "passes. Never report success on a failed run.",
          "",
          execResults
            .map((r) => {
              const status = r.ok ? "OK" : r.timedOut ? "TIMEOUT" : "FAILED";
              const head = `- ${r.skillName} (${r.language}): ${status} — exit ${r.exitCode ?? "n/a"}, ${r.durationMs}ms`;
              const body = r.output.trim() ? `\n  output: ${r.output.trim().slice(0, 2000)}` : "";
              const err = r.error ? `\n  error: ${r.error.slice(0, 500)}` : "";
              return `${head}${body}${err}`;
            })
            .join("\n"),
          "",
        ]
      : []),
    "## Skill code bodies (deduped merge; each section = one skill's runnable code)",
    "Run these bodies via run_skill_code when you need to (re-)execute — they are what",
    "the skill actually does:",
    "",
    mergeSkillCodeBodies(skills, execResults),
  ].join("\n");
}

/**
 * Merge skill code bodies with the same deterministic dedupe as the merge UI.
 *
 * Token optimization: when pre-execution results are available, skills that
 * already ran OK are reduced to a one-line capability stub (their full source
 * stays available to the model through run_skill_code by id) — only FAILED
 * skills keep their full body, because recovery needs it. This keeps the
 * acting context slim without losing any executable capability.
 */
export function mergeSkillCodeBodies(
  skills: SkillRecord[],
  execResults?: SkillExecutionResult[],
): string {
  const seenImports = new Set<string>();
  const imports: string[] = [];
  const sections: string[] = [];
  const byId = new Map((execResults ?? []).map((r) => [r.skillId, r]));

  for (const skill of skills) {
    const code = (skill.code ?? "").trim();
    const exec = byId.get(skill.id);
    if (code && exec?.ok) {
      // Executed OK: stub the body — the code is one run_skill_code call away.
      sections.push(
        `// ── ${skill.name} (${skill.id}) — EXECUTED OK (exit ${exec.exitCode}, ${exec.durationMs}ms) — re-run via run_skill_code if inputs change`,
      );
      continue;
    }
    if (!code) {
      sections.push(`// ── ${skill.name} — (no code)`);
      continue;
    }
    const body = splitSkillCodeImports(code, imports, seenImports);
    sections.push([`// ── ${skill.name} (${skill.id}) ──`, ...body].join("\n"));
  }
  return [imports.join("\n"), sections.join("\n\n")].filter(Boolean).join("\n\n").trimEnd();
}