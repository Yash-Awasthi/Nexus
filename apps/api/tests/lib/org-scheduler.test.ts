// SPDX-License-Identifier: Apache-2.0
/**
 * What wakes agents on their own: assignment and comment events, timer and
 * cron heartbeats (only when there is work), routines with their concurrency
 * rule, and signed routine webhooks.
 */
import crypto from "node:crypto";

import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

useOrgDataDir({ NEXUS_SECRETS_KEY: crypto.randomBytes(32).toString("hex") });

async function boot() {
  const { org, work, rt, sched } = await bootOrg(async () => ({
    sched: await import("../../src/lib/org-scheduler.js"),
  }));
  const seen: { agent: string; source: string; task: string | null }[] = [];
  rt.registerAdapter("nexus", async (ctx) => {
    seen.push({ agent: ctx.agent.name, source: ctx.run.source, task: ctx.task?.title ?? null });
    return { ok: true, output: '```json\n{"status":"in_progress"}\n```' };
  });
  return { org, work, rt, sched, seen };
}

describe("org scheduler", () => {
  it("wakes the assignee on assignment and on the board's comments only", async () => {
    const { org, work, rt, seen } = await boot();
    const c = org.createCompany("alice", { name: "Events" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const quiet = org.createAgent("alice", c.id, {
      name: "Quiet",
      heartbeat: { wakeOnAssign: false },
    });
    const t = work.createTask("alice", c.id, { title: "T", assigneeAgentId: a.id });
    work.createTask("alice", c.id, { title: "Q", assigneeAgentId: quiet.id });
    await rt.idle();
    expect(seen).toEqual([{ agent: "A", source: "assignment", task: "T" }]);

    work.addComment("alice", t.id, "agent note", { type: "agent", id: a.id });
    await rt.idle();
    expect(seen).toHaveLength(1);
    work.addComment("alice", t.id, "please add tests", { type: "user", id: "alice" });
    await rt.idle();
    expect(seen.at(-1)).toEqual({ agent: "A", source: "comment", task: "T" });
  });

  it("pulls a mentioned agent in with an answer-only subtask", async () => {
    const { org, work, rt, seen } = await boot();
    const c = org.createCompany("alice", { name: "Mentions" });
    const owner = org.createAgent("alice", c.id, {
      name: "Owner",
      heartbeat: { wakeOnAssign: false },
    });
    org.createAgent("alice", c.id, { name: "Dev" });
    const t = work.createTask("alice", c.id, { title: "Pick a stack", assigneeAgentId: owner.id });
    work.addComment("alice", t.id, "@dev which database would you choose?", {
      type: "user",
      id: "alice",
    });
    work.addComment("alice", t.id, "@Dev again", { type: "agent", id: owner.id });
    await rt.idle();
    const subs = work.listTasks("alice", c.id, { parentId: t.id });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      workMode: "ask",
      description: "@dev which database would you choose?",
    });
    expect(seen.some((s) => s.agent === "Dev" && s.task?.startsWith("Reply to the board"))).toBe(
      true,
    );
  });

  it("ticks heartbeats only for agents with work, once per due minute", async () => {
    const { org, work, rt, sched, seen } = await boot();
    const c = org.createCompany("alice", { name: "Beats" });
    const busy = org.createAgent("alice", c.id, {
      name: "Busy",
      heartbeat: { enabled: true, intervalSec: 60, wakeOnAssign: false },
    });
    const idleAgent = org.createAgent("alice", c.id, {
      name: "Idle",
      heartbeat: { enabled: true, intervalSec: 60 },
    });
    const cronAgent = org.createAgent("alice", c.id, {
      name: "Cron",
      heartbeat: { enabled: true, cron: "30 9 * * *", wakeOnAssign: false },
    });
    work.createTask("alice", c.id, { title: "busy work", assigneeAgentId: busy.id });
    work.createTask("alice", c.id, { title: "cron work", assigneeAgentId: cronAgent.id });

    const later = new Date(Date.now() + 5 * 60_000);
    later.setHours(9, 30, 0, 0);
    if (later.getTime() < Date.now() + 120_000) later.setDate(later.getDate() + 1);
    const first = sched.tick(later);
    expect(first.woken.sort()).toEqual([busy.id, cronAgent.id].sort());
    expect(first.woken).not.toContain(idleAgent.id);
    expect(sched.tick(later).woken).toEqual([]);
    await rt.idle();
    expect(seen.map((s) => s.source)).toEqual(["timer", "timer"]);
    expect(sched.tick(new Date(later.getTime() + 60_000)).woken).not.toContain(cronAgent.id);
  });

  it("files a review for a manager only when its team has something waiting", async () => {
    const { org, work, rt, sched, seen } = await boot();
    const c = org.createCompany("alice", { name: "Review Co" });
    const ceo = org.createAgent("alice", c.id, {
      name: "Ceo",
      heartbeat: { enabled: true, intervalSec: 60, wakeOnAssign: false },
    });
    const dev = org.createAgent("alice", c.id, {
      name: "Dev",
      reportsTo: ceo.id,
      heartbeat: { wakeOnAssign: false },
    });
    let at = Date.now() + 5 * 60_000;
    const tickAt = (ms: number) => sched.tick(new Date((at += ms))).woken.includes(ceo.id);
    const reviews = () =>
      work
        .listTasks("alice", c.id, { assigneeAgentId: ceo.id })
        .filter((t) => t.createdBy.id === "review");

    expect(tickAt(0)).toBe(false);

    const pr = work.createTask("alice", c.id, { title: "Ship login", assigneeAgentId: dev.id });
    work.setTaskStatus("alice", pr.id, "in_progress");
    work.setTaskStatus("alice", pr.id, "in_review");
    expect(tickAt(2 * 60_000)).toBe(false);

    expect(tickAt(2 * 3600_000)).toBe(true);
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]!.description).toContain(pr.identifier);
    await rt.idle();
    expect(seen.at(-1)).toMatchObject({ agent: "Ceo", task: reviews()[0]!.title });

    tickAt(2 * 60_000);
    expect(reviews()).toHaveLength(1);
    work.setTaskStatus("alice", reviews()[0]!.id, "cancelled");
    expect(tickAt(2 * 60_000)).toBe(false);
    expect(reviews()).toHaveLength(1);

    const stuck = work.createTask("alice", c.id, { title: "Migrate db", assigneeAgentId: dev.id });
    work.setTaskStatus("alice", stuck.id, "blocked");
    expect(tickAt(2 * 60_000)).toBe(true);
    expect(reviews()).toHaveLength(2);
    expect(reviews()[0]!.description).toContain(stuck.identifier);
    await rt.idle();

    // The same findings after a restart still count as already reviewed.
    work.setTaskStatus("alice", reviews()[0]!.id, "cancelled");
    const again = await boot();
    expect(again.sched.tick(new Date((at += 2 * 60_000))).woken).not.toContain(ceo.id);
    const filed = again.work
      .listTasks("alice", c.id, { assigneeAgentId: ceo.id })
      .filter((t) => t.createdBy.id === "review");
    expect(filed).toHaveLength(2);
    await again.rt.idle();
  });

  it("files routine tasks on schedule and skips while the last one is open", async () => {
    const { org, work, rt, sched } = await boot();
    const c = org.createCompany("alice", { name: "Routine Co" });
    const a = org.createAgent("alice", c.id, {
      name: "Reporter",
      heartbeat: { wakeOnAssign: false },
    });
    const r = sched.createRoutine("alice", c.id, {
      title: "Daily report",
      assigneeAgentId: a.id,
      cron: "0 8 * * *",
    });
    expect(() =>
      sched.createRoutine("alice", c.id, { title: "x", assigneeAgentId: a.id, cron: "bad" }),
    ).toThrow(/five-field/);
    const at = new Date();
    at.setHours(8, 0, 0, 0);
    expect(sched.tick(at).fired).toEqual([r.id]);
    await rt.idle();
    const filed = work.listTasks("alice", c.id);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.title).toMatch(/^Daily report \(/);
    expect(rt.listRuns("alice", c.id)[0]).toMatchObject({ source: "routine" });

    expect(sched.fireRoutine("alice", r.id, "manual").result).toBe("skipped_active");
    work.setTaskStatus("alice", filed[0]!.id, "cancelled");
    expect(sched.fireRoutine("alice", r.id, "manual").result).toBe("filed");
    expect(sched.getRoutine("alice", r.id).history.map((h) => h.result)).toEqual([
      "filed",
      "skipped_active",
      "filed",
    ]);
    await rt.idle();
  });

  it("accepts a correctly signed webhook and refuses everything else", async () => {
    const { org, work, rt, sched } = await boot();
    const c = org.createCompany("alice", { name: "Hook Co" });
    const a = org.createAgent("alice", c.id, { name: "A", heartbeat: { wakeOnAssign: false } });
    const r = sched.createRoutine("alice", c.id, {
      title: "On deploy",
      assigneeAgentId: a.id,
      concurrency: "always",
    });
    const { routine, secret } = sched.setRoutineWebhook("alice", r.id, true);
    expect(secret).toBeTruthy();
    expect(JSON.stringify(sched.publicRoutine(routine))).not.toContain(routine.webhookSecretEnc!);

    const body = JSON.stringify({ version: "1.2.3" });
    const ts = String(Date.now());
    const sign = (t: string, b: string) =>
      `sha256=${crypto.createHmac("sha256", secret!).update(`${t}.${b}`).digest("hex")}`;

    const ok = sched.fireRoutineWebhook(routine.webhookId!, body, ts, sign(ts, body));
    expect(ok.result).toBe("filed");
    expect(work.getTask("alice", ok.taskId!).description).toContain('"version": "1.2.3"');
    // A captured request replayed inside the freshness window does not fire again.
    expect(() => sched.fireRoutineWebhook(routine.webhookId!, body, ts, sign(ts, body))).toThrow(
      /Signature/,
    );
    await rt.idle();
    // Nor after a restart.
    const again = await boot();
    expect(() =>
      again.sched.fireRoutineWebhook(routine.webhookId!, body, ts, sign(ts, body)),
    ).toThrow(/Signature/);

    expect(() => sched.fireRoutineWebhook(routine.webhookId!, body, ts, sign(ts, "{}"))).toThrow(
      /Signature/,
    );
    const stale = String(Date.now() - 10 * 60_000);
    expect(() =>
      sched.fireRoutineWebhook(routine.webhookId!, body, stale, sign(stale, body)),
    ).toThrow(/Signature/);
    expect(() => sched.fireRoutineWebhook("nope", body, ts, sign(ts, body))).toThrow(/Signature/);

    sched.setRoutineWebhook("alice", r.id, false);
    expect(() => sched.fireRoutineWebhook(routine.webhookId!, body, ts, sign(ts, body))).toThrow(
      /Signature/,
    );
    await rt.idle();
  });
});
