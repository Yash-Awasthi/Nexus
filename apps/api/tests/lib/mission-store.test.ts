// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import type { MissionRecord } from "@nexus/agent-engine";

import {
  createMission,
  deleteMission,
  getMission,
  listMissions,
  saveMission,
} from "../../src/lib/mission-store.js";
import { getSharedKV } from "../../src/lib/shared-kv.js";

function terminal(record: MissionRecord): MissionRecord {
  return { ...record, status: "completed", accepted: true, updatedAt: new Date().toISOString() };
}

beforeEach(async () => {
  await getSharedKV().clear();
});

describe("mission-store", () => {
  it("creates a mission and reads it back (newest-first index)", async () => {
    const a = await createMission("u1", "Ship the feature");
    await saveMission("u1", terminal(a));
    const b = await createMission("u1", "Fix the bug");
    await saveMission("u1", terminal(b));

    const got = await getMission("u1", a.id);
    expect(got?.goal).toBe("Ship the feature");
    expect(got?.status).toBe("completed");

    const list = await listMissions("u1");
    expect(list.map((m) => m.id)).toEqual([b.id, a.id]); // newest first
  });

  it("isolates missions per user — u2 never sees u1's missions", async () => {
    const a = await createMission("u1", "u1 goal");
    await saveMission("u1", terminal(a));

    expect(await getMission("u2", a.id)).toBeUndefined();
    expect(await listMissions("u2")).toEqual([]);
  });

  it("caps the index at MAX_MISSIONS (oldest dropped from the list, records kept)", async () => {
    let first: MissionRecord | undefined;
    for (let i = 0; i < 105; i++) {
      const r = await createMission("u1", `goal ${i}`);
      if (i === 0) first = r;
      await saveMission("u1", terminal(r));
    }
    const list = await listMissions("u1");
    expect(list).toHaveLength(100);
    expect(list.some((m) => m.id === first?.id)).toBe(false); // oldest evicted from index
  });

  it("recovers a stale running mission to a terminal failed state on read", async () => {
    const a = await createMission("u1", "long mission");
    // Age the record beyond the stale bound without touching updatedAt.
    const kv = getSharedKV();
    const aged = { ...a, updatedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString() };
    await kv.set(`mission:item:u1:${a.id}`, aged, 30 * 24 * 60 * 60 * 1000);

    const got = await getMission("u1", a.id);
    expect(got?.status).toBe("failed");
    expect(got?.error).toContain("Interrupted");
    // Recovery is write-through: a second read is stable.
    const again = await getMission("u1", a.id);
    expect(again?.status).toBe("failed");
  });

  it("keeps a live running mission running (updatedAt fresh)", async () => {
    const a = await createMission("u1", "fresh mission");
    await saveMission("u1", a); // phase transition touches updatedAt
    const got = await getMission("u1", a.id);
    expect(got?.status).toBe("running");
  });

  it("deletes a mission from index + store", async () => {
    const a = await createMission("u1", "to delete");
    await saveMission("u1", terminal(a));
    await deleteMission("u1", a.id);

    expect(await getMission("u1", a.id)).toBeUndefined();
    expect(await listMissions("u1")).toEqual([]);
  });
});
