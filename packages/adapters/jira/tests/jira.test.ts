// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jiraAdapter from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";

const makeCtx = (): IExecutionContext =>
  ({
    taskId: "t",
    startTime: new Date(),
    attempt: 1,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    environment: {
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "dev@acme.com",
      JIRA_API_TOKEN: "tok",
    },
  }) as unknown as IExecutionContext;

const RAW_ISSUE = {
  id: "10001",
  key: "ENG-42",
  self: "https://acme.atlassian.net/rest/api/3/issue/10001",
  fields: {
    summary: "Fix login bug",
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    assignee: { displayName: "Alice" },
    reporter: { displayName: "Bob" },
    created: "2024-01-01",
    updated: "2024-01-02",
    labels: ["backend"],
    description: null,
  },
};

describe("@nexus/adapter-jira", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.restoreAllMocks());

  it("name and capabilities", () => {
    expect(jiraAdapter.name).toBe("nexus-adapter-jira");
    expect(jiraAdapter.capabilities).toContain("database.query");
    expect(jiraAdapter.capabilities).toContain("database.execute");
  });

  it("canExecute all six task types", () => {
    for (const t of [
      "jira.get_issue",
      "jira.search",
      "jira.create_issue",
      "jira.update_issue",
      "jira.transition",
      "jira.add_comment",
    ]) {
      expect(jiraAdapter.canExecute(t)).toBe(true);
    }
  });

  it("get_issue — uses Basic auth and maps to JiraIssue", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => RAW_ISSUE,
      text: async () => "",
    });
    const issue = (await jiraAdapter.execute(
      { taskType: "jira.get_issue", issueIdOrKey: "ENG-42" },
      makeCtx(),
    )) as { key: string; summary: string; status: string };
    expect(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>,
    ).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) as string });
    expect(issue.key).toBe("ENG-42");
    expect(issue.summary).toBe("Fix login bug");
    expect(issue.status).toBe("In Progress");
  });

  it("get_issue — appends ?fields= query when fields are provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => RAW_ISSUE,
      text: async () => "",
    });
    await jiraAdapter.execute(
      { taskType: "jira.get_issue", issueIdOrKey: "ENG-42", fields: ["summary", "status"] },
      makeCtx(),
    );
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain("?fields=summary,status");
  });

  it("get_issue — rawToIssue falls back to empty defaults when fields are absent", async () => {
    // Minimal raw issue — no fields at all: covers all the ?? "" / ?? [] null-path branches
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "x", key: "ENG-0", self: "" }),
      text: async () => "",
    });
    const issue = (await jiraAdapter.execute(
      { taskType: "jira.get_issue", issueIdOrKey: "ENG-0" },
      makeCtx(),
    )) as { summary: string; status: string; labels: string[] };
    expect(issue.summary).toBe("");
    expect(issue.status).toBe("");
    expect(issue.labels).toEqual([]);
  });

  it("get_issue — rawToIssue handles string description", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...RAW_ISSUE,
        fields: { ...RAW_ISSUE.fields, description: "plain text" },
      }),
      text: async () => "",
    });
    const issue = (await jiraAdapter.execute(
      { taskType: "jira.get_issue", issueIdOrKey: "ENG-42" },
      makeCtx(),
    )) as { description: string };
    expect(issue.description).toBe("plain text");
  });

  it("get_issue — rawToIssue handles ADF object description", async () => {
    const adf = { type: "doc", version: 1, content: [] };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...RAW_ISSUE,
        fields: { ...RAW_ISSUE.fields, description: adf },
      }),
      text: async () => "",
    });
    const issue = (await jiraAdapter.execute(
      { taskType: "jira.get_issue", issueIdOrKey: "ENG-42" },
      makeCtx(),
    )) as { description: string };
    expect(issue.description).toBe(JSON.stringify(adf));
  });

  it("search — sends JQL in POST body and maps results", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: [RAW_ISSUE], total: 1, startAt: 0, maxResults: 50 }),
      text: async () => "",
    });
    const result = (await jiraAdapter.execute(
      { taskType: "jira.search", jql: "project = ENG AND status = 'In Progress'" },
      makeCtx(),
    )) as { issues: { key: string }[]; total: number };
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { jql: string };
    expect(body.jql).toContain("ENG");
    expect(result.total).toBe(1);
    expect(result.issues[0]?.key).toBe("ENG-42");
  });

  it("search — uses custom maxResults, startAt, fields when provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: [], total: 0, startAt: 10, maxResults: 5 }),
      text: async () => "",
    });
    await jiraAdapter.execute(
      {
        taskType: "jira.search",
        jql: "project = ENG",
        maxResults: 5,
        startAt: 10,
        fields: ["summary", "priority"],
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { maxResults: number; startAt: number; fields: string[] };
    expect(body.maxResults).toBe(5);
    expect(body.startAt).toBe(10);
    expect(body.fields).toContain("summary");
  });

  it("create_issue — sends correct project and issuetype", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "10002", key: "ENG-43", self: "" }),
      text: async () => "",
    });
    await jiraAdapter.execute(
      {
        taskType: "jira.create_issue",
        projectKey: "ENG",
        summary: "New feature",
        issueType: "Story",
        description: "Implement X",
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { fields: { project: { key: string }; issuetype: { name: string } } };
    expect(body.fields.project.key).toBe("ENG");
    expect(body.fields.issuetype.name).toBe("Story");
  });

  it("create_issue — omits description field when not provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "10003", key: "ENG-44", self: "" }),
      text: async () => "",
    });
    await jiraAdapter.execute(
      {
        taskType: "jira.create_issue",
        projectKey: "ENG",
        summary: "Quick task",
        issueType: "Task",
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { fields: Record<string, unknown> };
    expect(body.fields.description).toBeUndefined();
  });

  it("create_issue — includes priority, assignee, and labels when provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "10004", key: "ENG-45", self: "" }),
      text: async () => "",
    });
    await jiraAdapter.execute(
      {
        taskType: "jira.create_issue",
        projectKey: "ENG",
        summary: "Urgent task",
        issueType: "Bug",
        priority: "Critical",
        assigneeAccountId: "acc-123",
        labels: ["urgent", "backend"],
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      fields: {
        priority: { name: string };
        assignee: { accountId: string };
        labels: string[];
      };
    };
    expect(body.fields.priority.name).toBe("Critical");
    expect(body.fields.assignee.accountId).toBe("acc-123");
    expect(body.fields.labels).toContain("urgent");
  });

  it("update_issue — sends PUT with fields to /issue/:key", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
      text: async () => "",
    });
    const result = await jiraAdapter.execute(
      {
        taskType: "jira.update_issue",
        issueIdOrKey: "ENG-42",
        fields: { summary: "Updated summary" },
      },
      makeCtx(),
    );
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/issue/ENG-42");
    expect(opts.method).toBe("PUT");
    expect(result).toEqual({});
  });

  it("transition — returns empty object on 204", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
      text: async () => "",
    });
    const r = await jiraAdapter.execute(
      { taskType: "jira.transition", issueIdOrKey: "ENG-42", transitionId: "31" },
      makeCtx(),
    );
    expect(r).toEqual({});
  });

  it("transition — includes comment in update body when provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
      text: async () => "",
    });
    await jiraAdapter.execute(
      {
        taskType: "jira.transition",
        issueIdOrKey: "ENG-42",
        transitionId: "31",
        comment: "Moved to done",
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { update: { comment: { add: { body: { type: string } } }[] } };
    expect(body.update.comment[0]?.add.body.type).toBe("doc");
  });

  it("add_comment — sends ADF body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "comment-1" }),
      text: async () => "",
    });
    await jiraAdapter.execute(
      { taskType: "jira.add_comment", issueIdOrKey: "ENG-42", body: "LGTM" },
      makeCtx(),
    );
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain("/comment");
  });

  it("throws on non-OK response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "Not found" });
    await expect(
      jiraAdapter.execute({ taskType: "jira.get_issue", issueIdOrKey: "FAKE-1" }, makeCtx()),
    ).rejects.toThrow();
  });
});
