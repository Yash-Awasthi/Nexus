// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";

import { getSharedKV } from "../../src/lib/shared-kv.js";
import {
  createResearchJob,
  getResearchJob,
  listResearchJobs,
  recordResearchMilestone,
  updateResearchJob,
} from "../../src/lib/research-jobs.js";

// No REDIS_URL / UPSTASH env in tests → getSharedKV() falls back to the
// in-process MemoryKVStore. Clear it before every test so cases are isolated.
beforeEach(async () => {
  await getSharedKV().clear();
});

describe("research-jobs", () => {
  it("creates a job in running state with timestamps", async () => {
    const j = await createResearchJob("user-1", "What is RAG?");
    expect(j.id).toBeTruthy();
    expect(j.query).toBe("What is RAG?");
    expect(j.status).toBe("running");
    expect(new Date(j.createdAt).getTime()).not.toBeNaN();
    expect(new Date(j.updatedAt).getTime()).not.toBeNaN();
  });

  it("updateResearchJob writes through state transitions and preserves fields", async () => {
    const j = await createResearchJob("user-1", "q");
    const done = await updateResearchJob("user-1", j.id, {
      status: "done",
      report: "synthesis text",
      citations: [{ id: "c-0", title: "t", url: "https://x.io", excerpt: "e" }],
      cycles: 1,
      durationMs: 1234,
      stats: { requests: 1, tokens: 99 },
    });
    expect(done?.status).toBe("done");
    expect(done?.report).toBe("synthesis text");
    expect(done?.query).toBe("q"); // untouched
    expect(done?.createdAt).toBe(j.createdAt); // createdAt preserved
    expect(done?.citations).toHaveLength(1);
    expect(done?.stats?.tokens).toBe(99);

    const err = await updateResearchJob("user-1", j.id, { status: "error", error: "boom" });
    expect(err?.status).toBe("error");
    expect(err?.report).toBe("synthesis text"); // prior fields survive
  });

  it("updateResearchJob on a missing job returns undefined", async () => {
    expect(await updateResearchJob("user-1", "nope", { status: "done" })).toBeUndefined();
  });

  it("lists newest first and respects limit", async () => {
    const a = await createResearchJob("user-1", "first");
    await new Promise((r) => setTimeout(r, 5));
    const b = await createResearchJob("user-1", "second");
    const c = await createResearchJob("user-1", "third");

    expect((await listResearchJobs("user-1", 10)).map((j) => j.id)).toEqual([c.id, b.id, a.id]);
    expect(await listResearchJobs("user-1", 2)).toHaveLength(2);
  });

  it("getResearchJob round-trips a completed record (the deep-link contract)", async () => {
    const j = await createResearchJob("user-1", "persist me");
    await updateResearchJob("user-1", j.id, {
      status: "done",
      report: "the report",
      sources: [{ url: "https://src.io" }],
      relatedQuestions: ["follow-up?"],
    });
    const got = await getResearchJob("user-1", j.id);
    expect(got?.status).toBe("done");
    expect(got?.report).toBe("the report");
    expect(got?.relatedQuestions).toEqual(["follow-up?"]);
  });

  it("concurrent transitions never lose fields (same race class as threads-store)", async () => {
    const j = await createResearchJob("user-1", "race");
    await Promise.all([
      updateResearchJob("user-1", j.id, { status: "done", report: "report" }),
      updateResearchJob("user-1", j.id, { relatedQuestions: ["q1"] }),
    ]);
    const got = await getResearchJob("user-1", j.id);
    expect(got?.status).toBe("done");
    expect(got?.report).toBe("report");
    expect(got?.relatedQuestions).toEqual(["q1"]);
  });

  it("scopes everything per user — no cross-user leakage", async () => {
    await createResearchJob("alice", "alice-q");
    const bob = await createResearchJob("bob", "bob-q");

    expect((await listResearchJobs("alice", 10)).map((j) => j.query)).toEqual(["alice-q"]);
    expect(await getResearchJob("alice", bob.id)).toBeUndefined();
    expect(await listResearchJobs("carol", 10)).toHaveLength(0);
  });

  it("list and get on an empty store are safe", async () => {
    expect(await listResearchJobs("user-1", 10)).toHaveLength(0);
    expect(await getResearchJob("user-1", "missing")).toBeUndefined();
  });

  it("recovers a stale running job to error on read (zombie reaper)", async () => {
    // A run is engine-bounded (≤2 min); a `running` record left untouched past
    // the stale bound is an orphan (server died mid-run / stream never opened)
    // and must not show as running forever after a restart.
    const j = await createResearchJob("user-1", "orphaned run");
    // Backdate the record past the stale bound (white-box: documented key layout).
    await getSharedKV().set(
      `research:item:user-1:${j.id}`,
      { ...j, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
      86_400_000,
    );

    const got = await getResearchJob("user-1", j.id);
    expect(got?.status).toBe("error");
    expect(got?.error).toContain("Interrupted");
    expect(got?.query).toBe("orphaned run");

    // Recovery is write-through — the next read already sees the terminal state
    // and the dashboard/history lists exclude it from `running`.
    const listed = await listResearchJobs("user-1", 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("error");
    expect(listed.filter((x) => x.status === "running")).toHaveLength(0);
  });

  it("never recovers a fresh running job or a terminal job", async () => {
    const running = await createResearchJob("user-1", "live run");
    const done = await createResearchJob("user-1", "finished");
    await updateResearchJob("user-1", done.id, { status: "done", report: "r" });

    expect((await getResearchJob("user-1", running.id))?.status).toBe("running");
    expect((await getResearchJob("user-1", done.id))?.status).toBe("done");
    expect(
      (await listResearchJobs("user-1", 10)).filter((j) => j.status === "running"),
    ).toHaveLength(1);
  });

  it("recovers stale running jobs per user without cross-user writes", async () => {
    const a = await createResearchJob("alice", "orphan");
    await getSharedKV().set(
      `research:item:alice:${a.id}`,
      { ...a, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
      86_400_000,
    );

    expect((await getResearchJob("alice", a.id))?.status).toBe("error");
    // bob never sees alice's job, recovered or not
    expect(await listResearchJobs("bob", 10)).toHaveLength(0);
  });

  it("recordResearchMilestone merges start + finish into one phase entry", async () => {
    const j = await createResearchJob("user-1", "milestones");
    await recordResearchMilestone("user-1", j.id, "planning", {
      startedAt: "2026-09-06T10:00:00.000Z",
      detail: "Planning research scope",
    });
    await recordResearchMilestone("user-1", j.id, "planning", {
      finishedAt: "2026-09-06T10:00:01.000Z",
    });
    await recordResearchMilestone("user-1", j.id, "synthesis", {
      startedAt: "2026-09-06T10:00:02.000Z",
      detail: "Synthesising findings with LLM",
    });

    const got = await getResearchJob("user-1", j.id);
    expect(got?.milestones?.planning).toEqual({
      startedAt: "2026-09-06T10:00:00.000Z",
      finishedAt: "2026-09-06T10:00:01.000Z",
      detail: "Planning research scope",
    });
    expect(got?.milestones?.synthesis?.startedAt).toBe("2026-09-06T10:00:02.000Z");
  });

  it("milestone writes race the done transition without dropping either", async () => {
    const j = await createResearchJob("user-1", "race milestones");
    await Promise.all([
      // Real stream order: phase completes while the terminal write-through lands.
      recordResearchMilestone("user-1", j.id, "synthesis", {
        finishedAt: "2026-09-06T10:00:03.000Z",
      }),
      updateResearchJob("user-1", j.id, { status: "done", report: "the report" }),
      recordResearchMilestone("user-1", j.id, "complete", {
        startedAt: "2026-09-06T10:00:03.500Z",
      }),
    ]);
    const got = await getResearchJob("user-1", j.id);
    expect(got?.status).toBe("done");
    expect(got?.report).toBe("the report");
    expect(got?.milestones?.synthesis?.finishedAt).toBe("2026-09-06T10:00:03.000Z");
    expect(got?.milestones?.complete?.startedAt).toBe("2026-09-06T10:00:03.500Z");
  });

  it("zombie recovery preserves the phase history a crash left behind", async () => {
    const j = await createResearchJob("user-1", "crashed mid-synthesis");
    await recordResearchMilestone("user-1", j.id, "planning", {
      finishedAt: "2026-09-06T09:59:00.000Z",
    });
    await recordResearchMilestone("user-1", j.id, "researching", {
      finishedAt: "2026-09-06T09:59:30.000Z",
    });
    await recordResearchMilestone("user-1", j.id, "synthesis", {
      startedAt: "2026-09-06T09:59:31.000Z",
    });
    // Backdate past the stale bound — the process died during synthesis.
    await getSharedKV().set(
      `research:item:user-1:${j.id}`,
      {
        ...(await getResearchJob("user-1", j.id)),
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
      86_400_000,
    );

    const recovered = await getResearchJob("user-1", j.id);
    expect(recovered?.status).toBe("error");
    // The record now shows exactly how far the run got before the crash.
    expect(recovered?.milestones?.synthesis?.startedAt).toBe("2026-09-06T09:59:31.000Z");
    expect(recovered?.milestones?.synthesis?.finishedAt).toBeUndefined();
    expect(recovered?.milestones?.planning?.finishedAt).toBeDefined();
  });

  it("recordResearchMilestone on a missing job returns undefined", async () => {
    expect(
      await recordResearchMilestone("user-1", "missing", "planning", {
        startedAt: new Date().toISOString(),
      }),
    ).toBeUndefined();
  });
});
