// SPDX-License-Identifier: Apache-2.0
/**
 * Agents discuss a task in its thread: rounds until they agree or hit the cap,
 * each turn billed to its agent, and a budget that would be crossed silences
 * that agent instead of spending.
 */
import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

useOrgDataDir();

const boot = () =>
  bootOrg(async () => ({
    budget: await import("../../src/lib/org-budget.js"),
    talk: await import("../../src/lib/org-discussion.js"),
  }));

const step = { provider: "x", model: "unpriced", latencyMs: 1, cached: false };

describe("agent discussion", () => {
  it("runs until the agents agree, posting each turn as that agent", async () => {
    const { org, work, budget, talk } = await boot();
    const c = org.createCompany("alice", { name: "Talk Co" });
    const dev = org.createAgent("alice", c.id, { name: "Dev", role: "engineer" });
    const qa = org.createAgent("alice", c.id, { name: "Qa", role: "tester" });
    const t = work.createTask("alice", c.id, { title: "Pick a database" });

    const heard: string[] = [];
    talk.setDiscussionSpeaker(async (agent, messages, steps) => {
      heard.push(agent.name);
      steps.push({ ...step, inputTokens: 1000, outputTokens: 500 });
      const round = messages.filter((m) => m.role === "user").length;
      return agent.name === "Qa" && round === 1
        ? "SQLite is enough.\nFINAL: use SQLite"
        : "Postgres, for concurrent writes.\nFINAL: use Postgres";
    });

    const started = talk.startDiscussion("alice", t.id, [dev.id, qa.id], { rounds: 4 });
    expect(() => talk.startDiscussion("alice", t.id, [dev.id, qa.id])).toThrow(/already running/);
    const result = await started.done;
    expect(result).toMatchObject({ rounds: 2, agreed: true });
    expect(heard).toHaveLength(4);

    const thread = work.listComments("alice", t.id);
    expect(thread.filter((x) => x.author.id === qa.id).map((x) => x.body)).toEqual([
      "SQLite is enough.\nFINAL: use SQLite",
      "Postgres, for concurrent writes.\nFINAL: use Postgres",
    ]);
    expect(thread.at(-1)!.body).toMatch(/settled after 2 rounds/);
    const spend = budget.budgetOverview("alice", c.id).spend.byAgent;
    expect(spend.find((x) => x.agentId === dev.id)?.monthMicros).toBe(5000);
  });

  it("refuses bad casts and lets a budget silence an agent", async () => {
    const { org, work, budget, talk } = await boot();
    const c = org.createCompany("alice", { name: "Tight Co" });
    const other = org.createCompany("alice", { name: "Other Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const b = org.createAgent("alice", c.id, { name: "B" });
    const outsider = org.createAgent("alice", other.id, { name: "Out" });
    const t = work.createTask("alice", c.id, { title: "Name it" });
    talk.setDiscussionSpeaker(async (_agent, _messages, _steps, _max, guard) => {
      const why = guard("unpriced");
      if (why) throw new Error(why);
      return "FINAL: call it Nova";
    });

    expect(() => talk.startDiscussion("alice", t.id, [a.id])).toThrow(/two to five/);
    expect(() => talk.startDiscussion("alice", t.id, [a.id, outsider.id])).toThrow(/not in this/);
    expect(() => talk.startDiscussion("bob", t.id, [a.id, b.id])).toThrow(/not found/);

    budget.upsertPolicy("alice", c.id, { scopeType: "agent", scopeId: b.id, amountUsd: 0.000001 });
    const result = await talk.startDiscussion("alice", t.id, [a.id, b.id], { rounds: 2 }).done;
    expect(result.agreed).toBe(false);
    const thread = work.listComments("alice", t.id);
    expect(thread.some((x) => x.author.id === b.id)).toBe(false);
    expect(thread.some((x) => /B could not answer: .*budget/.test(x.body))).toBe(true);
  });
});

describe("a paused scope", () => {
  it("never speaks in a discussion", async () => {
    const { org, work, talk } = await boot();
    const c = org.createCompany("alice", { name: "Pause Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const b = org.createAgent("alice", c.id, { name: "B" });
    const t = work.createTask("alice", c.id, { title: "Name it" });
    const spoke: string[] = [];
    talk.setDiscussionSpeaker(async (agent) => {
      spoke.push(agent.name);
      if (agent.name === "A") org.setAgentStatus("alice", b.id, "paused");
      return "FINAL: Nova";
    });
    org.setAgentStatus("alice", a.id, "paused");
    expect(() => talk.startDiscussion("alice", t.id, [a.id, b.id])).toThrow(/paused/);
    org.setAgentStatus("alice", a.id, "idle");
    org.setCompanyStatus("alice", c.id, "paused");
    expect(() => talk.startDiscussion("alice", t.id, [a.id, b.id])).toThrow(/paused/);
    org.setCompanyStatus("alice", c.id, "active");

    await talk.startDiscussion("alice", t.id, [a.id, b.id], { rounds: 2 }).done;
    expect(spoke.filter((n) => n === "B").length).toBeLessThanOrEqual(1);
    expect(spoke.at(-1)).toBe("A");
  });
});

describe("a restart", () => {
  it("closes a discussion it interrupted with a comment and frees the task", async () => {
    const { org, work, talk } = await boot();
    const c = org.createCompany("alice", { name: "Restart Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const b = org.createAgent("alice", c.id, { name: "B" });
    const t = work.createTask("alice", c.id, { title: "Name it" });
    talk.setDiscussionSpeaker(() => new Promise<string>(() => undefined));
    talk.startDiscussion("alice", t.id, [a.id, b.id]);

    const again = await boot();
    expect(again.work.listComments("alice", t.id).at(-1)!.body).toMatch(/interrupted by a restart/);
    again.talk.setDiscussionSpeaker(async () => "FINAL: Nova");
    expect(
      (await again.talk.startDiscussion("alice", t.id, [a.id, b.id], { rounds: 1 }).done).agreed,
    ).toBe(true);
  });
});

describe("a discussion in order", () => {
  it("lets each agent see the turns before it in the same round", async () => {
    const { org, work, talk } = await boot();
    const c = org.createCompany("alice", { name: "Order Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const b = org.createAgent("alice", c.id, { name: "B" });
    const t = work.createTask("alice", c.id, { title: "Name it" });
    const heard: Record<string, string> = {};
    talk.setDiscussionSpeaker(async (agent, messages) => {
      heard[agent.name] = messages.filter((m) => m.role === "user").at(-1)!.content;
      return agent.name === "A" ? "Call it Nova.\nFINAL: Nova" : "Agreed.\nFINAL: Nova";
    });
    const started = talk.startDiscussion("alice", t.id, [a.id, b.id], { rounds: 2, inOrder: true });
    expect(started.inOrder).toBe(true);
    expect((await started.done).agreed).toBe(true);
    expect(heard.B).toContain("Call it Nova.");
    expect(heard.A).not.toContain("Agreed.");
  });
});

describe("a settled discussion", () => {
  it("files the decision as a subtask for the top agent when asked", async () => {
    const { org, work, talk } = await boot();
    const c = org.createCompany("alice", { name: "Outcome Co" });
    const lead = org.createAgent("alice", c.id, {
      name: "Lead",
      heartbeat: { wakeOnAssign: false },
    });
    const dev = org.createAgent("alice", c.id, { name: "Dev", reportsTo: lead.id });
    const t = work.createTask("alice", c.id, { title: "Pick a database" });
    talk.setDiscussionSpeaker(async () => "SQLite is enough.\nFINAL: use SQLite");

    const result = await talk.startDiscussion("alice", t.id, [dev.id, lead.id], {
      rounds: 2,
      fileOutcome: true,
    }).done;
    expect(result.agreed).toBe(true);
    const filed = work.getTask("alice", result.filedTaskId!);
    expect(filed).toMatchObject({ parentId: t.id, assigneeAgentId: lead.id });
    expect(filed.title).toContain("use SQLite");
    expect(work.listComments("alice", t.id).at(-1)!.body).toContain(filed.identifier);
  });

  it("files nothing without agreement or when not asked", async () => {
    const { org, work, talk } = await boot();
    const c = org.createCompany("alice", { name: "No Outcome Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const b = org.createAgent("alice", c.id, { name: "B" });
    const t = work.createTask("alice", c.id, { title: "Pick a name" });
    talk.setDiscussionSpeaker(async (agent) => `FINAL: ${agent.name === "A" ? "Nova" : "Orion"}`);
    const split = await talk.startDiscussion("alice", t.id, [a.id, b.id], {
      rounds: 1,
      fileOutcome: true,
    }).done;
    expect(split.filedTaskId).toBeUndefined();
    talk.setDiscussionSpeaker(async () => "FINAL: Nova");
    const quiet = await talk.startDiscussion("alice", t.id, [a.id, b.id], { rounds: 1 }).done;
    expect(quiet.agreed).toBe(true);
    expect(quiet.filedTaskId).toBeUndefined();
    expect(work.listTasks("alice", c.id)).toHaveLength(1);
  });

  it("reports back in the discussion when the filed decision is finished or dropped", async () => {
    const { org, work, talk } = await boot();
    const c = org.createCompany("alice", { name: "Follow Co" });
    const lead = org.createAgent("alice", c.id, {
      name: "Lead",
      heartbeat: { wakeOnAssign: false },
    });
    const dev = org.createAgent("alice", c.id, { name: "Dev", reportsTo: lead.id });
    talk.setDiscussionSpeaker(async () => "FINAL: use SQLite");
    const decide = async (title: string) => {
      const t = work.createTask("alice", c.id, { title });
      const r = await talk.startDiscussion("alice", t.id, [dev.id, lead.id], {
        rounds: 1,
        fileOutcome: true,
      }).done;
      return { thread: t.id, filed: work.getTask("alice", r.filedTaskId!) };
    };
    const lastSaid = (taskId: string) => work.listComments("alice", taskId).at(-1)!.body;

    const done = await decide("Pick a database");
    work.addComment("alice", done.filed.id, "Moved storage to SQLite; schema in db/.", {
      type: "agent",
      id: lead.id,
    });
    work.setTaskStatus("alice", done.filed.id, "in_progress", { type: "agent", id: lead.id });
    work.setTaskStatus("alice", done.filed.id, "done", { type: "agent", id: lead.id });
    expect(lastSaid(done.thread)).toContain(`${done.filed.identifier} is done`);
    expect(lastSaid(done.thread)).toContain("Moved storage to SQLite");
    expect(work.listComments("alice", done.thread).at(-1)!.author).toEqual({
      type: "agent",
      id: lead.id,
    });

    const dropped = await decide("Pick a cache");
    work.setTaskStatus("alice", dropped.filed.id, "cancelled", { type: "user", id: "alice" });
    expect(lastSaid(dropped.thread)).toContain(`${dropped.filed.identifier} was cancelled`);

    // The link survives a restart.
    const waiting = await decide("Pick a queue");
    const after = await boot();
    after.work.setTaskStatus("alice", waiting.filed.id, "cancelled", { type: "user", id: "alice" });
    expect(after.work.listComments("alice", waiting.thread).at(-1)!.body).toContain(
      `${waiting.filed.identifier} was cancelled`,
    );

    // Only filed decisions report back.
    const other = work.createTask("alice", c.id, { title: "Unrelated", parentId: done.thread });
    work.setTaskStatus("alice", other.id, "cancelled", { type: "user", id: "alice" });
    expect(lastSaid(done.thread)).not.toContain(other.identifier);
  });

  it("remembers how a decision ended, so a later run on the question recalls it", async () => {
    const { org, work, talk } = await boot();
    const memory = await import("../../src/lib/org-memory.js");
    const c = org.createCompany("alice", { name: "Lesson Co" });
    const lead = org.createAgent("alice", c.id, {
      name: "Lead",
      heartbeat: { wakeOnAssign: false },
    });
    const dev = org.createAgent("alice", c.id, { name: "Dev", reportsTo: lead.id });
    talk.setDiscussionSpeaker(async () => "FINAL: use SQLite");
    const t = work.createTask("alice", c.id, { title: "Pick a database for billing" });
    const r = await talk.startDiscussion("alice", t.id, [dev.id, lead.id], {
      rounds: 1,
      fileOutcome: true,
    }).done;
    work.setTaskStatus("alice", r.filedTaskId!, "cancelled", { type: "user", id: "alice" });

    const found = memory.recall("alice", c.id, "which database for billing");
    const lesson = found.find((l) => l.kind === "decision");
    expect(lesson?.text).toContain("Pick a database for billing");
    expect(lesson?.text).toContain("use SQLite");
    expect(lesson?.text).toMatch(/dropped/);
  });
});
