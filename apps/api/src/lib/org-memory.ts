// SPDX-License-Identifier: Apache-2.0
/**
 * What a company learns: finished work and the board's feedback become lessons
 * that later runs recall.
 *
 * Capture costs no model call — a lesson is the run's own summary and the head
 * of its deliverable, or the board's comment verbatim — so learning is free and
 * works offline. Recall ranks lessons by term overlap weighted by rarity, with a
 * small preference for recent ones; no embedding model is needed, which keeps it
 * working on the desktop build with nothing else running. When the owner's
 * Nexus memory can embed, each lesson is mirrored there too.
 */

import crypto from "node:crypto";

import { UNTRUSTED_NOTE, screenUntrusted } from "@nexus/shared";

import { addPromptContributor } from "./org-protocol.js";
import { onRunFinished, type Run } from "./org-runtime.js";
import { OrgError, getCompany, nextSeq, onOrgLoad, registerCompanyScoped } from "./org-store.js";
import { getTask, orgEvents } from "./org-work.js";
import { PersistentStore } from "./persistent-store.js";

export type LessonKind = "outcome" | "feedback" | "note" | "decision";

export interface Lesson {
  id: string;
  ownerId: string;
  companyId: string;
  agentId: string | null;
  kind: LessonKind;
  text: string;
  /** The task it came from, e.g. ACME-12. */
  source: string | null;
  /** How often a run has been shown this lesson. */
  uses: number;
  createdAt: string;
  seq: number;
}

const lessons = new PersistentStore<Lesson>("org_memory");
registerCompanyScoped(lessons);
onOrgLoad(() => lessons.load());

const LESSONS_PER_COMPANY = 1000;

type Mirror = (ownerId: string, lesson: Lesson) => Promise<void>;
let mirror: Mirror | null = null;
/** Also write lessons into the owner's Nexus memory; injected by the route module. */
export function setMemoryMirror(m: Mirror): void {
  mirror = m;
}

export function addLesson(input: Omit<Lesson, "id" | "uses" | "createdAt" | "seq">): Lesson {
  const text = input.text.trim().slice(0, 2000);
  if (!text) throw new OrgError(400, "invalid", "A lesson needs text.");
  const lesson: Lesson = {
    ...input,
    text,
    id: crypto.randomUUID(),
    uses: 0,
    createdAt: new Date().toISOString(),
    seq: nextSeq(),
  };
  lessons.set(lesson.id, lesson);
  const mine = [...lessons.values()].filter((l) => l.companyId === input.companyId);
  if (mine.length > LESSONS_PER_COMPANY) {
    mine.sort((a, b) => a.uses - b.uses || a.seq - b.seq);
    for (const old of mine.slice(0, mine.length - LESSONS_PER_COMPANY)) lessons.delete(old.id);
  }
  if (mirror) void mirror(lesson.ownerId, lesson).catch(() => undefined);
  return lesson;
}

export function listLessons(ownerId: string, companyId: string): Lesson[] {
  getCompany(ownerId, companyId);
  return [...lessons.values()]
    .filter((l) => l.ownerId === ownerId && l.companyId === companyId)
    .sort((a, b) => b.seq - a.seq);
}

export function deleteLesson(ownerId: string, id: string): void {
  const l = lessons.get(id);
  if (!l || l.ownerId !== ownerId) throw new OrgError(404, "not_found", "Lesson not found.");
  lessons.delete(id);
}

// ── Recall ───────────────────────────────────────────────────────────────────

const STOP = new Set(
  "the and for with that this from into your you are was were have has had not but all any can will would should about over under then than them they their there these those what when where which while who why how our out its it's use using make made".split(
    " ",
  ),
);

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((t) => !STOP.has(t));
}

/** Lessons most relevant to `query`, best first; none when nothing overlaps. */
export function recall(ownerId: string, companyId: string, query: string, k = 4): Lesson[] {
  const pool = [...lessons.values()].filter(
    (l) => l.ownerId === ownerId && l.companyId === companyId,
  );
  const q = new Set(terms(query));
  if (q.size === 0 || pool.length === 0) return [];
  const docs = pool.map((l) => new Set(terms(l.text)));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const newest = Math.max(...pool.map((l) => l.seq));
  const oldest = Math.min(...pool.map((l) => l.seq));
  const scored = pool.map((l, i) => {
    let s = 0;
    for (const t of q) if (docs[i]!.has(t)) s += Math.log(1 + pool.length / (df.get(t) ?? 1));
    const recency = newest === oldest ? 1 : (l.seq - oldest) / (newest - oldest);
    return { l, s: s > 0 ? s * (0.85 + 0.15 * recency) + (l.kind === "feedback" ? 0.5 : 0) : 0 };
  });
  return scored
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.l);
}

// ── Capture ──────────────────────────────────────────────────────────────────

/** A finished run that closed or handed in its task teaches the company what was done. */
export function learnFromRun(run: Run): Lesson | null {
  if (run.status !== "succeeded" || !run.taskId || !run.outcome) return null;
  if (run.outcome.status !== "done" && run.outcome.status !== "in_review") return null;
  let task;
  try {
    task = getTask(run.ownerId, run.taskId);
  } catch {
    return null;
  }
  const deliverable = run.output.replace(/```(?:json)?[\s\S]*?```/g, "").trim();
  const text = [
    `${task.title}: ${run.outcome.summary || "completed"}.`,
    deliverable ? `Result: ${deliverable.slice(0, 500)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return addLesson({
    ownerId: run.ownerId,
    companyId: run.companyId,
    agentId: run.agentId,
    kind: "outcome",
    text,
    source: task.identifier,
  });
}

onRunFinished((run) => {
  learnFromRun(run);
});

// The board's words on a task are the most valuable lessons there are.
orgEvents.on("comment.created", (comment, task) => {
  if (comment.author.type !== "user" || comment.body.length < 12) return;
  addLesson({
    ownerId: task.ownerId,
    companyId: task.companyId,
    agentId: task.assigneeAgentId,
    kind: "feedback",
    text: `Board on "${task.title}": ${comment.body}`,
    source: task.identifier,
  });
});

addPromptContributor(async ({ agent, company, task }) => {
  const query = task ? `${task.title} ${task.description}` : `${agent.role} ${agent.capabilities}`;
  const found = recall(agent.ownerId, company.id, query).filter(
    (l) => !task || l.source !== task.identifier || l.kind === "feedback",
  );
  if (found.length === 0) return null;
  for (const l of found) lessons.set(l.id, { ...l, uses: l.uses + 1 });
  return `What this company learned before (most relevant first; use it, do not repeat it):\n${found
    .map((l) => `- [${l.kind}${l.source ? ` ${l.source}` : ""}] ${l.text}`)
    .join("\n")}`;
});

/** Passages from the owner's wider Nexus knowledge: the agent's knowledge bases, then personal memory. */
export type KnowledgeRecall = (
  ownerId: string,
  query: string,
  knowledgeBaseIds: string[],
) => Promise<{ source: string; text: string }[]>;

let knowledgeRecall: KnowledgeRecall | null = null;
/** The route module injects this; Nexus memory needs an embedder the org layer does not own. */
export function setKnowledgeRecall(fn: KnowledgeRecall | null): void {
  knowledgeRecall = fn;
}

addPromptContributor(async ({ agent, company, task }) => {
  if (!knowledgeRecall) return null;
  const query = task ? `${task.title}\n${task.description}` : company.mission;
  if (!query.trim()) return null;
  const hits = await knowledgeRecall(agent.ownerId, query, agent.knowledgeBaseIds ?? []);
  if (hits.length === 0) return null;
  return `From the owner's knowledge bases and memory (cite what you use). ${UNTRUSTED_NOTE}\n${hits
    .map(
      (h) => `- [${h.source}] ${screenUntrusted(h.text.replace(/\s+/g, " ").slice(0, 800)).text}`,
    )
    .join("\n")}`;
});
