// SPDX-License-Identifier: Apache-2.0
/**
 * The org store: companies and agents belong to one account, the reporting
 * tree never cycles, and agent status follows the state machine. Uses the
 * JSON-file branch of PersistentStore so a re-import is a real restart.
 */

import { describe, it, expect } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

type Org = typeof import("../../src/lib/org-store.js");

const boot = async (): Promise<Org> => (await bootOrg()).org;

useOrgDataDir();

describe("org store", () => {
  it("keeps each account's companies to itself", async () => {
    const org = await boot();
    const c = org.createCompany("alice", { name: "Acme Labs", mission: "Ship notes" });
    expect(c.taskPrefix).toBe("AL");
    expect(org.createCompany("alice", { name: "Acme Labs" }).taskPrefix).toBe("AL2");
    expect(org.listCompanies("bob")).toEqual([]);
    expect(() => org.getCompany("bob", c.id)).toThrow(/not found/);
    expect(() => org.createAgent("bob", c.id, { name: "x" })).toThrow(/not found/);
    expect(org.nextTaskIdentifier("alice", c.id)).toBe("AL-1");
    expect(org.nextTaskIdentifier("alice", c.id)).toBe("AL-2");
  });

  it("refuses reporting cycles and cross-company managers", async () => {
    const org = await boot();
    const c = org.createCompany("alice", { name: "Tree Co" });
    const other = org.createCompany("alice", { name: "Other" });
    const ceo = org.createAgent("alice", c.id, { name: "CEO", role: "ceo" });
    const cto = org.createAgent("alice", c.id, { name: "CTO", reportsTo: ceo.id });
    const eng = org.createAgent("alice", c.id, { name: "Eng", reportsTo: cto.id });
    const outsider = org.createAgent("alice", other.id, { name: "Out" });

    expect(() => org.updateAgent("alice", ceo.id, { reportsTo: eng.id })).toThrow(/cycle/);
    expect(() => org.updateAgent("alice", ceo.id, { reportsTo: ceo.id })).toThrow(/cycle/);
    expect(() => org.updateAgent("alice", eng.id, { reportsTo: outsider.id })).toThrow(
      /same company/,
    );

    const tree = org.orgChart("alice", c.id);
    expect(tree.map((n) => n.agent.name)).toEqual(["CEO"]);
    expect(tree[0]!.reports[0]!.reports[0]!.agent.name).toBe("Eng");
  });

  it("follows the agent state machine and re-parents on termination", async () => {
    const org = await boot();
    const c = org.createCompany("alice", { name: "States" });
    const ceo = org.createAgent("alice", c.id, { name: "CEO" });
    const mid = org.createAgent("alice", c.id, { name: "Mid", reportsTo: ceo.id });
    const leaf = org.createAgent("alice", c.id, { name: "Leaf", reportsTo: mid.id });

    expect(org.invokability("alice", leaf)).toEqual({ ok: true });
    org.setAgentStatus("alice", ceo.id, "paused");
    expect(org.invokability("alice", org.getAgent("alice", leaf.id))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Manager CEO is paused/),
    });
    org.setAgentStatus("alice", ceo.id, "idle");

    org.setAgentStatus("alice", mid.id, "terminated");
    expect(org.getAgent("alice", leaf.id).reportsTo).toBe(ceo.id);
    expect(() => org.setAgentStatus("alice", mid.id, "idle")).toThrow(/terminated to idle/);
    expect(() => org.updateAgent("alice", mid.id, { name: "x" })).toThrow(/terminated/);

    org.setAgentStatus("alice", leaf.id, "paused", { reason: "budget", actorType: "system" });
    expect(() => org.setAgentStatus("alice", leaf.id, "idle")).toThrow(/budget/);
    org.setAgentStatus("alice", leaf.id, "idle", { actorType: "system" });
    expect(org.getAgent("alice", leaf.id).status).toBe("idle");
  });

  it("sends governance actions, and only those, to the audit sink", async () => {
    const org = await boot();
    const seen: string[] = [];
    org.setAuditSink((row) => seen.push(row.action));
    const c = org.createCompany("alice", { name: "Audit Co" });
    const a = org.createAgent("alice", c.id, { name: "A" });
    org.updateAgent("alice", a.id, { title: "x" });
    org.setAgentStatus("alice", a.id, "paused");
    org.setAgentStatus("alice", a.id, "terminated");
    expect(seen).toEqual(["company.created", "agent.hired", "agent.paused", "agent.terminated"]);
  });

  it("holds a hire for approval when the company asks for it", async () => {
    const org = await boot();
    const c = org.createCompany("alice", { name: "Strict", requireHireApproval: true });
    const a = org.createAgent("alice", c.id, { name: "New" });
    expect(a.status).toBe("pending_approval");
    expect(org.invokability("alice", a).ok).toBe(false);
    expect(() => org.setAgentStatus("alice", a.id, "idle")).toThrow(/waiting for approval/);
    expect(org.setAgentStatus("alice", a.id, "idle", { viaApproval: true }).status).toBe("idle");
  });

  it("survives a restart and purges a deleted company's rows", async () => {
    let org = await boot();
    const c = org.createCompany("carol", { name: "Durable" });
    const a = org.createAgent("carol", c.id, { name: "Keeper", model: "groq/llama" });
    org = await boot();
    expect(org.getAgent("carol", a.id).model).toBe("groq/llama");
    expect(org.listActivity("carol", c.id).map((x) => x.action)).toEqual([
      "agent.hired",
      "company.created",
    ]);
    org.deleteCompany("carol", c.id);
    expect(() => org.getAgent("carol", a.id)).toThrow(/not found/);
    org = await boot();
    expect(org.listCompanies("carol")).toEqual([]);
  });

  it("shares a company into a workspace and finds it from any of its rows", async () => {
    const org = await boot();
    const c = org.createCompany("dave", { name: "Shared Co" });
    const a = org.createAgent("dave", c.id, { name: "Ceo" });
    expect(org.sharedCompanies("erin", ["ws1"])).toEqual([]);
    org.updateCompany("dave", c.id, { workspaceId: "ws1" });
    expect(org.sharedCompanies("erin", ["ws1"]).map((x) => x.id)).toEqual([c.id]);
    expect(org.sharedCompanies("erin", ["ws2"])).toEqual([]);
    expect(org.sharedCompanies("dave", ["ws1"])).toEqual([]);
    expect(org.companyOf(a.id)?.id).toBe(c.id);
    expect(org.companyOf(c.id)?.id).toBe(c.id);
    expect(org.companyOf("nope")).toBeUndefined();
    org.updateCompany("dave", c.id, { workspaceId: null });
    expect(org.sharedCompanies("erin", ["ws1"])).toEqual([]);
  });
});
