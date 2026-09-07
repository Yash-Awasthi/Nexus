// SPDX-License-Identifier: Apache-2.0
/**
 * mission-memory — the READ side of zero-write-cost execution memory.
 *
 * The spider-graph captures every run automatically (see mission-graph.ts),
 * but capture is only half of the mission's pillar 3: "store the agent's
 * useful execution state as structured memory/graphs RATHER THAN repeatedly
 * replaying the entire history." This module distills a prior mission's
 * record + graph into ONE bounded prompt block — what happened, why the
 * reviewer rejected it, which tool calls failed, which skills ran and how
 * they went, where the output ended — so a follow-up mission continues from
 * the diff instead of restarting.
 *
 * The distilled block is an ACTIONABLE directive, not a passive summary: it
 * points at the prior run and tells the model what to fix, what to verify,
 * and where to resume from — the channel the model attends to is the acting
 * user turn (the improve loop), so this text is delivered there, not buried
 * in a system prompt the local model ignores.
 *
 * Zero write cost is preserved: nothing here writes memory; it only reads
 * the record and graph that the runtime already captured, and turns them
 * into a few hundred tokens of context.
 */

import type { MissionRecord } from "@nexus/agent-engine";

import { getMission } from "./mission-store.js";
import { getSessionGraph, type GraphNode, type SessionGraph } from "./session-graph.js";

const MAX_GOAL_CHARS = 120;
const MAX_ISSUE_CHARS = 140;
const MAX_EXCERPT_CHARS = 320;
const MAX_TRACE_CHARS = 240;
const MAX_TOTAL_CHARS = 1600;

export interface MissionMemory {
  /** The prior run's mission id. */
  missionId: string;
  /** One-line outcome for provenance badges ("REJECTED — score 0/100"). */
  summary: string;
  /** Prompt block injected into the next run's acting system prompt. */
  text: string;
}

/** Compact one-line summary of a terminal mission for the memory header. */
export function outcomeSummary(record: MissionRecord): string {
  if (record.status === "failed") return `FAILED${record.error ? ` — ${record.error.slice(0, 80)}` : ""}`;
  if (record.status === "aborted") return "ABORTED";
  // A reviewer that produced no parseable verdict is a harness signal, not an
  // actual rejection — must never read as "reject 0/100" in distilled memory.
  if (record.lastReview?.unparsed) return "UNKNOWN — reviewer produced no structured verdict";
  const verdict = record.lastReview?.verdict ?? (record.accepted ? "accept" : "reject");
  const score = record.lastReview?.score ?? "?";
  return `${record.accepted ? "ACCEPTED" : "REJECTED"} — review ${verdict} ${score}/100`;
}

/**
 * True when a review issue is a harness artifact rather than a real defect.
 * The reviewer parse-failure path in @nexus/agent-runtime records the raw
 * unparseable prose as the "issue" — that is a harness error, not something
 * the continuing agent can fix, so it must never be presented as work to do.
 */
export function isReviewNoise(issue: string): boolean {
  return /reviewer returned unparseable output/i.test(issue);
}

/** Keep only genuine review issues — drop harness parse-failure artifacts. */
export function filterReviewIssues(issues: string[] | undefined): string[] {
  return (issues ?? []).filter((i) => !isReviewNoise(i));
}

/**
 * Distill one terminal mission's record (+ optional graph tool trace) into a
 * bounded prompt block. Deterministic and honest: every fact comes from the
 * captured record/graph — the model never writes this memory.
 */
export function distillMissionMemory(record: MissionRecord, graph?: SessionGraph): MissionMemory {
  const summary = outcomeSummary(record);
  const issues = filterReviewIssues(record.lastReview?.issues);
  const suggestions = record.lastReview?.suggestions ?? [];
  const trace = graph ? summarizeToolTrace(graph) : undefined;
  const skills = graph ? summarizeSkillExecutions(graph) : undefined;
  const excerpt = record.finalContent.trim();

  // ACTIONABLE directive, not a passive narrative: tell the model concretely
  // what to fix, what to verify, and where to resume from.
  const lines: string[] = [
    `## CONTINUING from prior mission ${record.id} (${summary})`,
    "You are continuing prior work, not starting over. Do NOT redo what already",
    "succeeded — fix what failed, verify side effects before claiming success,",
    "and build on the output below. Address each item explicitly.",
    "",
    `Prior goal: ${record.goal.slice(0, MAX_GOAL_CHARS)}`,
  ];

  if (issues.length > 0) {
    lines.push("", "REVIEW REJECTED THIS. FIX THESE, then verify:");
    for (const issue of issues.slice(0, 3)) {
      lines.push(`- ${issue.slice(0, MAX_ISSUE_CHARS)}`);
    }
  }
  if (suggestions.length > 0) {
    lines.push("Reviewer suggestions:");
    for (const s of suggestions.slice(0, 2)) {
      lines.push(`- ${s.slice(0, MAX_ISSUE_CHARS)}`);
    }
  }

  // Tool trace from the spider-graph: failed calls are the concrete "verify X".
  if (trace) {
    lines.push("", `Tool trace (resume/verify from these outcomes): ${trace.slice(0, MAX_TRACE_CHARS)}`);
  }

  // Skill executions from the spider-graph (runtime-emitted skill nodes): the
  // continuation must know which skills already ran and how they went, so it
  // verifies instead of redoing them — and re-runs only the failed ones.
  if (skills) {
    lines.push("", `Skill executions (resume/verify from these outcomes): ${skills.slice(0, MAX_TRACE_CHARS)}`);
  }

  if (excerpt) {
    lines.push("", "Resume from where the previous output ended:", excerpt.slice(0, MAX_EXCERPT_CHARS));
  }

  // §15.8 — insights the cheap local extractor distilled AFTER the prior run
  // went terminal. Additive only: the deterministic facts above stay the source
  // of truth; absent insights change nothing.
  if (record.memoryInsights?.text) {
    lines.push(
      "", 
      `Extracted insights (${record.memoryInsights.model}):`,
      record.memoryInsights.text.slice(0, 600),
    );
  }

  lines.push("", "Act on the prior run now and complete the new goal on top of it.");

  const text = lines.join("\n").trim();
  return {
    missionId: record.id,
    summary,
    text: text.length > MAX_TOTAL_CHARS ? `${text.slice(0, MAX_TOTAL_CHARS)}…` : text,
  };
}

/** Last 4 tool calls with their outcomes ("read_file ok (12ms) | run_skill_code FAILED: …"). */
export function summarizeToolTrace(graph: SessionGraph): string {
  const nodes = graph.nodes;
  const calls: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n?.kind !== "tool") continue;
    // Outcome node is the tool node's own "<id>:out" child.
    const out = nodes.find((x) => x.id === `${n.id}:out`);
    const outcome = out?.detail ?? "no outcome recorded";
    const failed = out?.kind === "error" || /fail|error|exit [^0]|timed out/i.test(outcome);
    calls.push(`${n.label} ${failed ? "FAILED" : "ok"} — ${outcome.slice(0, 80)}`);
    if (calls.length >= 4) break;
  }
  return calls.join(" | ");
}

/**
 * Last 4 skill executions with their outcomes ("proof-echo ok — completed in
 * 20ms (exit 0) | report-writer FAILED — failed (exit 2) — Traceback…").
 * Consumes the runtime-emitted `skill` nodes' TERMINAL events (status
 * completed/failed — the graph-write side pairs each with a `started` node);
 * the newest executions win when more than 4 ran.
 */
export function summarizeSkillExecutions(graph: SessionGraph): string {
  const terminals = graph.nodes.filter(
    (n): n is GraphNode & { status: "completed" | "failed" } =>
      n.kind === "skill" && (n.status === "completed" || n.status === "failed"),
  );
  const lines = terminals.slice(-4).map((n) => {
    const name = n.label.replace(/ result$/, "");
    // The recorder's detail is "[skillId] <outcome>"; strip the id prefix so
    // the directive reads naturally while the id stays available in the label
    // of the started node / node id itself.
    const outcome = (n.detail ?? "").replace(/^\[[^\]]*\]\s*/, "");
    return `${name} ${n.status === "completed" ? "ok" : "FAILED"} — ${outcome || "no outcome recorded"}`;
  });
  return lines.join(" | ");
}

/**
 * Load + distill a prior mission for continuation. Returns null when the
 * mission is unknown (per-user isolation), still running, or has nothing to
 * continue from. Injection seams mirror the other libs for tests.
 */
export async function loadMissionMemory(
  uid: string | undefined,
  missionId: string,
  deps: {
    getRecord?: (u: string | undefined, id: string) => Promise<MissionRecord | undefined>;
    getGraph?: (u: string | undefined, id: string) => Promise<SessionGraph | undefined>;
  } = {},
): Promise<MissionMemory | null> {
  const getRecord = deps.getRecord ?? ((u, id) => getMission(u, id));
  const getGraph = deps.getGraph ?? ((u, id) => getSessionGraph(u, id));
  const record = await getRecord(uid, missionId);
  if (!record) return null;
  if (record.status === "running") return null;
  const graph = await getGraph(uid, missionId);
  return distillMissionMemory(record, graph);
}