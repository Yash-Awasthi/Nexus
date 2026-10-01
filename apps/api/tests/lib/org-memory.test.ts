// SPDX-License-Identifier: Apache-2.0
/**
 * Organizational memory: finished runs and board comments become lessons at no
 * model cost, recall ranks them by relevance, and later runs see them.
 */

import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

useOrgDataDir();

describe("org memory", () => {
  it("learns from finished work and board feedback, and feeds it to later runs", async () => {
    const { memory, rt, work, org } = await bootOrg(async () => ({
      memory: await import("../../src/lib/org-memory.js"),
    }));

    const c = org.createCompany("alice", { name: "Learn Co" });
    const a = org.createAgent("alice", c.id, {
      name: "Writer",
      heartbeat: { wakeOnAssign: false },
    });
    const prompts: string[] = [];
    rt.registerAdapter("nexus", async (ctx) => {
      prompts.push(ctx.prompt.user);
      return {
        ok: true,
        output:
          'Headline: "Notes that think with you".\n```json\n{"status":"done","summary":"wrote the landing headline"}\n```',
      };
    });

    const first = work.createTask("alice", c.id, {
      title: "Write landing page headline",
      assigneeAgentId: a.id,
    });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    work.addComment("alice", first.id, "Too vague. Name the audience: students.", {
      type: "user",
      id: "alice",
    });

    const all = memory.listLessons("alice", c.id);
    expect(all.map((l) => l.kind)).toEqual(["feedback", "outcome"]);
    expect(all[1]!.text).toContain("wrote the landing headline");
    expect(all[1]!.text).not.toContain('"status"');

    memory.addLesson({
      ownerId: "alice",
      companyId: c.id,
      agentId: null,
      kind: "note",
      text: "Payroll runs on Fridays.",
      source: null,
    });
    const hits = memory.recall("alice", c.id, "landing page headline for students");
    expect(hits[0]!.kind).toBe("feedback");
    expect(hits.map((h) => h.text).join(" ")).not.toContain("Payroll");
    expect(memory.recall("alice", c.id, "zzz unrelated")).toEqual([]);
    expect(memory.recall("bob", c.id, "landing headline")).toEqual([]);

    work.createTask("alice", c.id, { title: "Write pricing page headline", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(prompts[1]).toContain("What this company learned before");
    expect(prompts[1]).toContain("Name the audience: students");
    expect(memory.listLessons("alice", c.id).find((l) => l.kind === "feedback")!.uses).toBe(1);
  });

  it("recalls the agent's knowledge bases and the owner's memory into its prompt", async () => {
    const { memory, rt, work, org } = await bootOrg(async () => ({
      memory: await import("../../src/lib/org-memory.js"),
    }));
    const c = org.createCompany("alice", { name: "Know Co" });
    const a = org.createAgent("alice", c.id, { name: "Dev", knowledgeBaseIds: ["kb1"] });
    const asked: { owner: string; query: string; kbs: string[] }[] = [];
    memory.setKnowledgeRecall(async (owner, query, kbs) => {
      asked.push({ owner, query, kbs });
      return [{ source: "style-guide.md", text: "Always write in British English." }];
    });
    const prompts: string[] = [];
    rt.registerAdapter("nexus", async (ctx) => {
      prompts.push(ctx.prompt.user);
      return { ok: true, output: '```json\n{"status":"done"}\n```' };
    });
    work.createTask("alice", c.id, { title: "Write the colour guide", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    memory.setKnowledgeRecall(null);
    expect(asked[0]).toMatchObject({ owner: "alice", kbs: ["kb1"] });
    expect(asked[0]!.query).toContain("Write the colour guide");
    expect(prompts[0]).toContain("[style-guide.md] Always write in British English.");
  });
});
