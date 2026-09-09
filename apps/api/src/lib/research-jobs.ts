// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user research job store — the single owner of research job persistence.
 * Backs the deep-research endpoints (create / list / get / stream write-through),
 * the dashboard research rows, and `/deep-research?id=…` deep links (dashboard
 * rows + notification links). Jobs survive API restarts, so a notification
 * emitted at completion still resolves after a redeploy — previously
 * `_researchJobs` was in-memory and every restart wiped history and 404'd every
 * deep link.
 *
 * Persistence: shared KV (Redis / Upstash / in-memory fallback via getSharedKV),
 * cross-pod safe, expires after RESEARCH_JOB_TTL_MS.
 *
 * Storage layout:
 *   research:list:{userId}      → string[] of job ids, newest first
 *   research:item:{userId}:{id} → serialized ResearchJob
 */

import { getSharedKV } from "./shared-kv.js";
import { withKeyLock } from "./with-key-lock.js";

export interface ResearchSource {
  url: string;
  title?: string;
  snippet?: string;
  score?: number;
  source?: string;
}

export interface ResearchCitation {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  cycleIndex?: number;
}

export interface ResearchJobStats {
  requests?: number;
  tokens?: number;
}

export interface ResearchPhaseState {
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
  cycleIndex?: number;
}

/**
 * Phase progress of a run (planning / researching / synthesis / complete),
 * persisted at each phaseStart/phaseDone so a running job's stage survives
 * reloads and restarts — the record, not the live SSE, is the source of truth.
 */
export type ResearchMilestones = Record<string, ResearchPhaseState>;

export interface ResearchJob {
  id: string;
  query: string;
  status: "running" | "done" | "error";
  /** Synthesis text — kept as an alias of `report` for callers that read either. */
  result?: string;
  report?: string;
  sources?: ResearchSource[];
  citations?: ResearchCitation[];
  relatedQuestions?: string[];
  cycles?: number;
  durationMs?: number;
  stats?: ResearchJobStats;
  milestones?: ResearchMilestones;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const RESEARCH_JOB_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — outlives the 30-day notification that links to it
const MAX_JOBS = 200;

// A run is engine-bounded (one search ≤15 s + one synthesis ≤90 s), so a job
// still `running` past this bound can only be an orphan: the process died
// mid-run, or the stream never opened after POST. Recovery flips it to a
// terminal error on read so no surface (dashboard running count, history,
// deep links) shows a phantom run forever.
const RESEARCH_JOB_STALE_RUNNING_MS = 5 * 60 * 1000;
const INTERRUPTED_ERROR =
  "Interrupted before completion — the server restarted or the connection was lost.";

/**
 * Lazy liveness recovery: a stale `running` record is written through to a
 * terminal `error` and returned. Idempotent (same terminal state every time),
 * so no key lock is needed; it can never false-positive a live run because a
 * real run updates `updatedAt` on start and finishes well inside the bound.
 */
async function recoverIfStale(
  kv: ReturnType<typeof getSharedKV>,
  uid: string,
  job: ResearchJob,
): Promise<ResearchJob> {
  if (job.status !== "running") return job;
  const ageMs = Date.now() - new Date(job.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < RESEARCH_JOB_STALE_RUNNING_MS) return job;
  const recovered: ResearchJob = {
    ...job,
    status: "error",
    error: INTERRUPTED_ERROR,
    updatedAt: new Date().toISOString(),
  };
  try {
    await kv.set(itemKey(uid, job.id), recovered, RESEARCH_JOB_TTL_MS);
  } catch {
    /* best-effort — the in-memory copy below is still terminal for this read */
  }
  return recovered;
}

const listKey = (userId: string) => `research:list:${userId}`;
const itemKey = (userId: string, id: string) => `research:item:${userId}:${id}`;

/** Same normalization as notifications-store / threads-store. */
export function userIdFor(uid: string | undefined): string {
  return uid?.trim() ? uid : "anonymous";
}

/** Create a job in `running` state (POST /api/research → stream follows). */
export async function createResearchJob(
  userId: string | undefined,
  query: string,
): Promise<ResearchJob> {
  const uid = userIdFor(userId);
  const id = crypto.randomUUID();
  const job: ResearchJob = {
    id,
    query: query.slice(0, 2000),
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return withKeyLock(itemKey(uid, id), async () => {
    const kv = getSharedKV();
    try {
      const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
      const next = [id, ...ids.filter((x) => x !== id)].slice(0, MAX_JOBS);
      await kv.set(listKey(uid), next, RESEARCH_JOB_TTL_MS);
      await kv.set(itemKey(uid, id), job, RESEARCH_JOB_TTL_MS);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "research-jobs.create-failed",
          error: (err as Error).message,
        }),
      );
    }
    return job;
  });
}

/**
 * Locked read-modify-write core for a single job record. Every mutator runs
 * through here so concurrent transitions / milestone writes serialize per key
 * (same race the threads-store lock closes) and merge, never clobber, each
 * other's fields. Best-effort — never throws into the research path; a failed
 * persistence log is preferable to a failed research run.
 */
async function mutateJob(
  uid: string,
  id: string,
  mutate: (job: ResearchJob) => ResearchJob,
): Promise<ResearchJob | undefined> {
  return withKeyLock(itemKey(uid, id), async () => {
    const kv = getSharedKV();
    let existing: ResearchJob | undefined;
    try {
      existing = await kv.get<ResearchJob>(itemKey(uid, id));
      if (!existing) return undefined;
      const job: ResearchJob = { ...mutate(existing), updatedAt: new Date().toISOString() };
      await kv.set(itemKey(uid, id), job, RESEARCH_JOB_TTL_MS);
      return job;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "research-jobs.update-failed",
          jobId: id,
          error: (err as Error).message,
        }),
      );
      return existing ?? undefined;
    }
  });
}

/**
 * Write-through on state transitions (start / done / failed / metadata like
 * related questions). Patch fields merge over the existing record.
 */
export async function updateResearchJob(
  userId: string | undefined,
  id: string,
  patch: Partial<Omit<ResearchJob, "id" | "query" | "createdAt">>,
): Promise<ResearchJob | undefined> {
  return mutateJob(userIdFor(userId), id, (job) => ({ ...job, ...patch }));
}

/**
 * Record a phase milestone (phaseStart → startedAt/detail, phaseDone →
 * finishedAt/detail) by merging into the job's milestones map under the key
 * lock, so concurrent phase writes and the terminal done/failed transition can
 * never drop each other's progress.
 */
export async function recordResearchMilestone(
  userId: string | undefined,
  id: string,
  phase: string,
  patch: Partial<ResearchPhaseState>,
): Promise<ResearchJob | undefined> {
  return mutateJob(userIdFor(userId), id, (job) => ({
    ...job,
    milestones: {
      ...job.milestones,
      [phase]: { ...job.milestones?.[phase], ...patch },
    },
  }));
}

/** Fetch one job (deep links, re-stream lookups, loadJob). */
export async function getResearchJob(
  userId: string | undefined,
  id: string,
): Promise<ResearchJob | undefined> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    const job = await kv.get<ResearchJob>(itemKey(uid, id));
    if (!job) return undefined;
    return await recoverIfStale(kv, uid, job);
  } catch {
    return undefined;
  }
}

/** List jobs, newest first (history sidebar, dashboard recent rows). */
export async function listResearchJobs(
  userId: string | undefined,
  limit = 50,
): Promise<ResearchJob[]> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    // The id list is write-order authoritative (newest first) — same rationale
    // as threads-store: timestamps have ms resolution and can tie.
    const ids = (await kv.get<string[]>(listKey(uid))) ?? [];
    const found = (
      await Promise.all(ids.map((id) => kv.get<ResearchJob>(itemKey(uid, id))))
    ).filter((j): j is ResearchJob => Boolean(j));
    const jobs: ResearchJob[] = [];
    for (const j of found) jobs.push(await recoverIfStale(kv, uid, j));
    return jobs.slice(0, limit);
  } catch {
    return [];
  }
}
