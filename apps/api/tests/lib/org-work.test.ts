// SPDX-License-Identifier: Apache-2.0
/**
 * Goals and tasks: the status machine, single-holder checkout, blockers, and
 * the "why" chain every run prompt starts from.
 */

import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

const boot = () => bootOrg();

useOrgDataDir();

describe("org work", () => {
  it("numbers tasks and walks the why chain up to the mission", async () => {
    const { org, work } = await boot();
    const c = org.createCompany("alice", { name: "Notes Inc", mission: "Reach $1M MRR" });
    const top = work.createGoal("alice", c.id, { title: "Grow signups" });
    const team = work.createGoal("alice", c.id, { title: "Run ads", parentId: top.id });
    const parent = work.createTask("alice", c.id, { title: "Launch ads", goalId: team.id });
    const child = work.createTask("alice", c.id, {
      title: "Research competitor ads",
      parentId: parent.id,
    });

    expect([parent.identifier, child.identifier]).toEqual(["NI-1", "NI-2"]);
    expect(child.goalId).toBe(team.id);
    expect(work.taskContext("alice", child)).toBe(
      [
        "Current task NI-2: Research competitor ads",
        "  because of NI-1: Launch ads",
        "  serving the team goal: Run ads",
        "  serving the company goal: Grow signups",
        "  and the company mission: Reach $1M MRR",
      ].join("\n"),
    );
    expect(() => work.updateGoal("alice", top.id, { parentId: team.id })).toThrow(/cycle/);
    expect(() => work.updateTask("alice", parent.id, { parentId: child.id })).toThrow(/cycle/);
    expect(work.findTask("alice", c.id, "ni-2")?.id).toBe(child.id);
    expect(() => work.getTask("bob", child.id)).toThrow(/not found/);
  });

  it("lets exactly one run hold a task, and respects blockers", async () => {
    const { org, work } = await boot();
    const c = org.createCompany("alice", { name: "Lock Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const b = org.createAgent("alice", c.id, { name: "B" });
    const first = work.createTask("alice", c.id, { title: "First" });
    const second = work.createTask("alice", c.id, { title: "Second", blockedBy: [first.id] });

    const held = work.checkoutTask("alice", first.id, a.id, "run-1");
    expect(held).toMatchObject({
      status: "in_progress",
      assigneeAgentId: a.id,
      checkoutRunId: "run-1",
    });
    expect(() => work.checkoutTask("alice", first.id, a.id, "run-2")).toThrow(/run-1/);
    expect(() => work.checkoutTask("alice", first.id, b.id, "run-3")).toThrow(/another agent/);
    expect(() => work.checkoutTask("alice", second.id, b.id, "run-4")).toThrow(/blockers/);

    work.setTaskStatus("alice", first.id, "done", { type: "agent", id: a.id });
    expect(work.getTask("alice", first.id).checkoutRunId).toBeNull();
    expect(work.checkoutTask("alice", second.id, b.id, "run-4").status).toBe("in_progress");
  });

  it("follows the status machine; only the board reopens finished work", async () => {
    const { org, work } = await boot();
    const c = org.createCompany("alice", { name: "Flow Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const t = work.createTask("alice", c.id, { title: "T", status: "backlog" });
    expect(() => work.setTaskStatus("alice", t.id, "done")).toThrow(/backlog to done/);
    work.setTaskStatus("alice", t.id, "todo");
    expect(() => work.setTaskStatus("alice", t.id, "in_progress")).toThrow(/Assign/);
    work.updateTask("alice", t.id, { assigneeAgentId: a.id });
    work.setTaskStatus("alice", t.id, "in_progress");
    const done = work.setTaskStatus("alice", t.id, "done");
    expect(done.completedAt).not.toBeNull();
    expect(() => work.setTaskStatus("alice", t.id, "todo", { type: "agent", id: a.id })).toThrow();
    expect(work.setTaskStatus("alice", t.id, "todo").completedAt).toBeNull();
  });

  it("picks the next task by priority, then age, and emits assignment events", async () => {
    const { org, work } = await boot();
    const c = org.createCompany("alice", { name: "Queue Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    const seen: string[] = [];
    work.orgEvents.on("task.assigned", (t) => seen.push(t.title));
    work.createTask("alice", c.id, { title: "low", priority: "low", assigneeAgentId: a.id });
    const high = work.createTask("alice", c.id, {
      title: "high",
      priority: "high",
      assigneeAgentId: a.id,
    });
    work.createTask("alice", c.id, {
      title: "high later",
      priority: "high",
      assigneeAgentId: a.id,
    });
    expect(work.nextTaskFor("alice", a.id)?.id).toBe(high.id);
    expect(seen).toEqual(["low", "high", "high later"]);
    work.addComment("alice", high.id, "looks good", { type: "user", id: "alice" });
    expect(work.listComments("alice", high.id).map((x) => x.body)).toEqual(["looks good"]);
  });

  it("turns a council verdict into a high-priority task for the top agent", async () => {
    const { org, work } = await boot();
    const c = org.createCompany("alice", { name: "Verdict Co" });
    const ceo = org.createAgent("alice", c.id, { name: "Ceo", heartbeat: { wakeOnAssign: false } });
    org.createAgent("alice", c.id, { name: "Dev", reportsTo: ceo.id });
    const filed = await work.fileVerdict("alice", c.id, {
      question: "Should we ship a mobile app?",
      verdict: "Yes, start with iOS.",
    });
    const t = work.getTask("alice", filed.taskId);
    expect(t).toMatchObject({ assigneeAgentId: ceo.id, priority: "high" });
    expect(t.title).toContain("Should we ship a mobile app?");
    expect(t.description).toContain("Yes, start with iOS.");
    await expect(work.fileVerdict("alice", c.id, { verdict: " " })).rejects.toThrow(/verdict/);
    await expect(work.fileVerdict("bob", c.id, { verdict: "x" })).rejects.toThrow(/not found/);
  });

  it("links goals to a Nexus project and lists them with their tasks", async () => {
    const { org, work } = await boot();
    const c = org.createCompany("alice", { name: "Proj Co" });
    const g = work.createGoal("alice", c.id, { title: "Launch site", projectId: "prj_1" });
    work.createGoal("alice", c.id, { title: "Unrelated" });
    const t = work.createTask("alice", c.id, { title: "Write copy", goalId: g.id });
    expect(work.projectGoals("alice", "prj_1")).toEqual([
      {
        goal: expect.objectContaining({ id: g.id, projectId: "prj_1" }),
        company: { id: c.id, name: "Proj Co" },
        tasks: [{ id: t.id, identifier: t.identifier, title: "Write copy", status: "todo" }],
      },
    ]);
    expect(work.projectGoals("bob", "prj_1")).toEqual([]);
    work.updateGoal("alice", g.id, { projectId: null });
    expect(work.projectGoals("alice", "prj_1")).toEqual([]);
  });
});
