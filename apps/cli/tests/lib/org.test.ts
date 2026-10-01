// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  formatInbox,
  formatStatus,
  inboxRequest,
  pickCompany,
  type CompanyRow,
} from "../../src/lib/org.js";

const row = (id: string, name: string): CompanyRow => ({
  id,
  name,
  status: "active",
  running: 0,
  agents: 1,
  pendingApprovals: 0,
  monthUsd: 0,
});

describe("nexus org", () => {
  it("picks a company by id, name or unique prefix", () => {
    const rows = [row("1", "Acme Labs"), row("2", "Acme Studio"), row("3", "Beta")];
    expect(pickCompany(rows, "2").name).toBe("Acme Studio");
    expect(pickCompany(rows, "beta").id).toBe("3");
    expect(pickCompany(rows, "Acme L").id).toBe("1");
    expect(() => pickCompany(rows, "Acme")).toThrow(/several/);
    expect(() => pickCompany(rows, undefined)).toThrow(/--company/);
    expect(pickCompany([row("9", "Only")], undefined).id).toBe("9");
    expect(() => pickCompany([], undefined)).toThrow(/no companies/);
  });

  it("puts what needs you first", () => {
    const lines = formatStatus({
      company: { name: "Acme", status: "active" },
      needsYou: {
        approvals: [{ id: "abcdef1234", title: "Hire Ada" }],
        approvalCount: 1,
        commandApprovals: 1,
        reviews: [{ title: "AC-3 Launch post" }],
        blocked: [],
        failedRuns: [],
        budgetStops: 0,
      },
      workingNow: [{ agent: "Ada", task: "AC-4 Docs", status: "running" }],
      spend: { todayUsd: 0.01, monthUsd: 0.2 },
    });
    expect(lines).toEqual([
      "Acme (active)",
      "Needs you:",
      "  • decide: Hire Ada  [abcdef12]",
      "  • 1 command(s) waiting to be allowed",
      "  • review: AC-3 Launch post",
      "Working now:",
      "  ▶ Ada: AC-4 Docs",
      "Spend: $0.0100 today, $0.2000 this month",
    ]);
  });
});

describe("nexus org inbox", () => {
  const digest = {
    total: 3,
    companies: [
      {
        companyId: "c1",
        name: "Acme",
        agents: [
          { id: "a1", name: "Lead" },
          { id: "a2", name: "Dev" },
        ],
        items: [
          {
            kind: "approval" as const,
            approvalId: "p1",
            text: "An approval has been waiting: Hire Bo",
          },
          { kind: "blocked" as const, taskId: "t1", text: "AC-1 is blocked: creds" },
          { kind: "review" as const, taskId: "t2", text: "AC-2 has waited for review: docs" },
        ],
      },
    ],
  };

  it("numbers every item across companies, with what can be done to it", () => {
    const lines = formatInbox(digest);
    expect(lines[0]).toBe("Acme");
    expect(lines[1]).toContain("1. An approval has been waiting: Hire Bo");
    expect(lines[1]).toContain("approve | reject");
    expect(lines[2]).toContain("2. AC-1 is blocked");
    expect(lines[2]).toContain("unblock | reassign <agent>");
    expect(lines[3]).toContain("accept | reassign <agent>");
  });

  it("turns an action on a numbered item into the call the app makes", () => {
    expect(inboxRequest(digest, "approve", 1)).toEqual({
      method: "POST",
      path: "/approvals/p1/approve",
      body: {},
    });
    expect(inboxRequest(digest, "unblock", 2)).toEqual({
      method: "POST",
      path: "/tasks/t1/status",
      body: { status: "todo" },
    });
    expect(inboxRequest(digest, "reassign", 3, "dev")).toEqual({
      method: "PATCH",
      path: "/tasks/t2",
      body: { assigneeAgentId: "a2" },
    });
    expect(() => inboxRequest(digest, "accept", 1)).toThrow(/approve or reject/);
    expect(() => inboxRequest(digest, "approve", 9)).toThrow(/no item 9/i);
    expect(() => inboxRequest(digest, "reassign", 2, "nobody")).toThrow(/no agent/i);
  });
});
