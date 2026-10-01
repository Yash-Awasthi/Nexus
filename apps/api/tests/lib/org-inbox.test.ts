// SPDX-License-Identifier: Apache-2.0
/**
 * The daily inbox: waiting reviews, blocked work, stale approvals and budgets past their
 * warning share, gathered into one notification a day with no model call.
 */
import { describe, expect, it } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

useOrgDataDir();

const boot = () =>
  bootOrg(async () => ({
    budget: await import("../../src/lib/org-budget.js"),
    inbox: await import("../../src/lib/org-inbox.js"),
    notes: await import("../../src/lib/notifications-store.js"),
  }));

const HOUR = 3600_000;

describe("org inbox digest", () => {
  it("gathers what waits on the owner and sends it once a day", async () => {
    const { org, work, budget, inbox, notes } = await boot();
    const c = org.createCompany("alice", { name: "Inbox Co", requireHireApproval: true });
    const lead = org.createAgent("alice", c.id, {
      name: "Lead",
      heartbeat: { wakeOnAssign: false },
    });
    org.createAgent("alice", c.id, { name: "Hire", reportsTo: lead.id });
    const pr = work.createTask("alice", c.id, { title: "Ship login", assigneeAgentId: lead.id });
    work.setTaskStatus("alice", pr.id, "in_progress");
    work.setTaskStatus("alice", pr.id, "in_review");
    const stuck = work.createTask("alice", c.id, { title: "Migrate db", assigneeAgentId: lead.id });
    work.setTaskStatus("alice", stuck.id, "blocked");
    budget.upsertPolicy("alice", c.id, { amountUsd: 1, warnPercent: 50, hardStop: false });
    budget.recordRunSpend({
      ownerId: "alice",
      companyId: c.id,
      agentId: lead.id,
      taskId: null,
      costUsd: 0.7,
    });

    // Noon UTC two days on: stale enough to count, and +1h stays on the same digest day.
    const later = new Date(Math.floor(Date.now() / (24 * HOUR)) * 24 * HOUR + 60 * HOUR);
    const digest = inbox.inboxDigest("alice", later);
    const items = digest.companies.flatMap((x) => x.items);
    const text = items.map((i) => i.text).join("\n");
    expect(digest.companies.map((x) => x.name)).toEqual(["Inbox Co"]);
    expect(text).toContain(pr.identifier);
    expect(text).toContain(stuck.identifier);
    expect(text).toMatch(/approval.*waiting/i);
    expect(text).toMatch(/budget/i);
    expect(inbox.inboxDigest("bob", later).companies).toEqual([]);
    // Each item names what it is about, so the inbox can act on it in place.
    expect(items.find((i) => i.kind === "review")?.taskId).toBe(pr.id);
    expect(items.find((i) => i.kind === "blocked")?.taskId).toBe(stuck.id);
    expect(items.find((i) => i.kind === "approval")?.approvalId).toBeTruthy();
    // Only hired agents can take a reassigned task.
    expect(digest.companies[0]!.agents.map((a) => a.name)).not.toContain("Hire");

    expect(await inbox.sendInboxDigests(later)).toEqual(["alice"]);
    expect(await inbox.sendInboxDigests(new Date(later.getTime() + HOUR))).toEqual([]);
    const { notifications } = await notes.listNotifications("alice");
    expect(notifications.filter((n) => n.title.startsWith("Your company inbox"))).toHaveLength(1);
    expect(notifications[0]!.message).toContain(pr.identifier);
    expect(notifications[0]!.link).toBe(`/org?c=${c.id}&inbox=open`);

    expect(await inbox.sendInboxDigests(new Date(later.getTime() + 25 * HOUR))).toEqual(["alice"]);
  });

  it("takes how long an approval waits before it counts from the environment", async () => {
    const { org, inbox } = await boot();
    const c = org.createCompany("dave", { name: "Fast Co", requireHireApproval: true });
    org.createAgent("dave", c.id, { name: "New" });
    const kinds = () =>
      inbox.inboxDigest("dave").companies.flatMap((x) => x.items.map((i) => i.kind));
    expect(kinds()).not.toContain("approval");
    process.env.NEXUS_ORG_APPROVAL_STALE_HOURS = "0";
    try {
      expect(kinds()).toContain("approval");
    } finally {
      delete process.env.NEXUS_ORG_APPROVAL_STALE_HOURS;
    }
  });

  it("sends nothing when nothing waits", async () => {
    const { org, inbox } = await boot();
    org.createCompany("carol", { name: "Quiet Co" });
    expect(inbox.inboxDigest("carol").companies).toEqual([]);
    expect(await inbox.sendInboxDigests()).not.toContain("carol");
  });
});
