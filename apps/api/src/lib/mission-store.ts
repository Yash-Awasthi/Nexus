// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user mission store — the single owner of mission persistence.
 * Backs the /api/missions endpoints (start / list / get / abort) and the
 * dashboard mission rows. Missions survive API restarts: every phase
 * transition of a running MissionRunner is saved through here, so a restart
 * mid-mission leaves a durable, honestly-marked record instead of a phantom
 * `running` entry.
 *
 * Persistence: shared KV (Redis / Upstash / in-memory fallback via
 * getSharedKV), cross-pod safe, expires after MISSION_TTL_MS.
 *
 * Storage layout:
 *   mission:list:{userId}      → string[] of mission ids, newest first
 *   mission:item:{userId}:{id} → serialized MissionRecord
 */

import type { MissionRecord, MissionStore } from "@nexus/agent-engine";

import { getSharedKV } from "./shared-kv.js";
import { withKeyLock } from "./with-key-lock.js";

const MISSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_MISSIONS = 100;

/** Same normalization as notifications-store / threads-store / research-jobs. */
export function missionUserIdFor(uid: string | undefined): string {
  return uid ?? "anon";
}

const listKey = (userId: string) => `mission:list:${userId}`;
const itemKey = (userId: string, id: string) => `mission:item:${userId}:${id}`;

/**
 * A running mission whose `updatedAt` is older than the bound can only be an
 * orphan (process died mid-run): recovery flips it to `failed` on read so no
 * surface shows a phantom running mission forever. Missions update their
 * record at every phase transition, so a live run can never false-positive.
 */
const MISSION_STALE_RUNNING_MS = 30 * 60 * 1000;
const INTERRUPTED_ERROR =
  "Interrupted before completion — the server restarted or the connection was lost.";

async function recoverIfStale(
  kv: ReturnType<typeof getSharedKV>,
  uid: string,
  record: MissionRecord,
): Promise<MissionRecord> {
  if (record.status !== "running") return record;
  const ageMs = Date.now() - new Date(record.updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < MISSION_STALE_RUNNING_MS) return record;
  const recovered: MissionRecord = {
    ...record,
    status: "failed",
    error: INTERRUPTED_ERROR,
    updatedAt: new Date().toISOString(),
  };
  try {
    await kv.set(itemKey(uid, record.id), recovered, MISSION_TTL_MS);
  } catch {
    /* best-effort — the in-memory copy below is still terminal for this read */
  }
  return recovered;
}

/** Create a mission record and register it in the user's newest-first index. */
export async function createMission(
  uid: string | undefined,
  goal: string,
  overrides: Partial<Pick<MissionRecord, "id" | "maxIterations" | "acceptScore">> = {},
): Promise<MissionRecord> {
  const userId = missionUserIdFor(uid);
  const now = new Date().toISOString();
  const record: MissionRecord = {
    id:
      overrides.id ??
      `mission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    goal,
    status: "running",
    accepted: false,
    iteration: 0,
    maxIterations: overrides.maxIterations ?? 3,
    acceptScore: overrides.acceptScore ?? 70,
    // Phase history is owned by MissionRunner (it saves the record at every
    // phase transition, starting with `started`); the store record is a shell.
    phases: [],
    actingSteps: 0,
    spawnCount: 0,
    finalContent: "",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt: now,
    updatedAt: now,
  };

  await withKeyLock(`mission:list:${userId}`, async () => {
    const kv = getSharedKV();
    const ids = (await kv.get<string[]>(listKey(userId))) ?? [];
    ids.unshift(record.id);
    await kv.set(listKey(userId), ids.slice(0, MAX_MISSIONS), MISSION_TTL_MS);
    await kv.set(itemKey(userId, record.id), record, MISSION_TTL_MS);
  });
  return record;
}

/** Persist a phase transition (MissionStore seam for MissionRunner). */
export async function saveMission(uid: string | undefined, record: MissionRecord): Promise<void> {
  const userId = missionUserIdFor(uid);
  const kv = getSharedKV();
  await kv.set(itemKey(userId, record.id), record, MISSION_TTL_MS);
}

/** KV-backed MissionStore implementation for MissionRunner. */
export function kvMissionStore(uid: string | undefined): MissionStore {
  return { save: (record) => saveMission(uid, record) };
}

/** Read one mission (with orphan recovery). Returns undefined when absent. */
export async function getMission(
  uid: string | undefined,
  id: string,
): Promise<MissionRecord | undefined> {
  const userId = missionUserIdFor(uid);
  const kv = getSharedKV();
  const record = await kv.get<MissionRecord>(itemKey(userId, id));
  return record ? recoverIfStale(kv, userId, record) : undefined;
}

/** List the user's missions, newest first (with orphan recovery). */
export async function listMissions(uid: string | undefined): Promise<MissionRecord[]> {
  const userId = missionUserIdFor(uid);
  const kv = getSharedKV();
  const ids = (await kv.get<string[]>(listKey(userId))) ?? [];
  const records = await Promise.all(ids.map((id) => kv.get<MissionRecord>(itemKey(userId, id))));
  const recovered = await Promise.all(
    records.filter((r): r is MissionRecord => Boolean(r)).map((r) => recoverIfStale(kv, userId, r)),
  );
  return recovered.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Remove a mission from the user's index + store. */
export async function deleteMission(uid: string | undefined, id: string): Promise<void> {
  const userId = missionUserIdFor(uid);
  const kv = getSharedKV();
  await withKeyLock(`mission:list:${userId}`, async () => {
    const ids = (await kv.get<string[]>(listKey(userId))) ?? [];
    await kv.set(
      listKey(userId),
      ids.filter((i) => i !== id),
      MISSION_TTL_MS,
    );
    await kv.delete(itemKey(userId, id));
  });
}
