// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-jira — Jira Cloud REST API v3 adapter.
 *
 * Task types
 * ----------
 *   jira.get_issue      Fetch a single issue by key or ID
 *   jira.search         JQL search — returns matching issue summaries
 *   jira.create_issue   Create a new issue in a project
 *   jira.update_issue   Update issue fields
 *   jira.transition     Move an issue to a new status via workflow transition
 *   jira.add_comment    Add a comment to an issue
 *
 * Env vars
 * --------
 *   JIRA_BASE_URL      e.g. https://yourorg.atlassian.net
 *   JIRA_EMAIL         Atlassian account email
 *   JIRA_API_TOKEN     Atlassian API token
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

// ── Task types ────────────────────────────────────────────────────────────────

export interface JiraGetIssueTask {
  taskType: "jira.get_issue";
  issueIdOrKey: string;
  fields?: string[];
}

export interface JiraSearchTask {
  taskType: "jira.search";
  jql: string;
  maxResults?: number;
  startAt?: number;
  fields?: string[];
}

export interface JiraCreateIssueTask {
  taskType: "jira.create_issue";
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  priority?: string;
  assigneeAccountId?: string;
  labels?: string[];
  customFields?: Record<string, unknown>;
}

export interface JiraUpdateIssueTask {
  taskType: "jira.update_issue";
  issueIdOrKey: string;
  fields: Record<string, unknown>;
}

export interface JiraTransitionTask {
  taskType: "jira.transition";
  issueIdOrKey: string;
  transitionId: string;
  comment?: string;
}

export interface JiraAddCommentTask {
  taskType: "jira.add_comment";
  issueIdOrKey: string;
  body: string;
}

export type JiraTask =
  | JiraGetIssueTask
  | JiraSearchTask
  | JiraCreateIssueTask
  | JiraUpdateIssueTask
  | JiraTransitionTask
  | JiraAddCommentTask;

// ── Result types ───────────────────────────────────────────────────────────────

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string;
  assignee: string | null;
  reporter: string | null;
  created: string;
  updated: string;
  labels: string[];
  description: string;
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function basicAuth(email: string, token: string): string {
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}

async function jiraFetch(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  auth: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  // 204 No Content (transition, update) — return empty object
  if (res.status === 204) return {};
  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-jira", res.status, await res.text());
  }
  return res.json();
}

function rawToIssue(raw: Record<string, unknown>): JiraIssue {
  const fields = (raw.fields as Record<string, unknown> | undefined) ?? {};
  const status = fields.status as Record<string, unknown> | undefined;
  const issuetype = fields.issuetype as Record<string, unknown> | undefined;
  const priority = fields.priority as Record<string, unknown> | undefined;
  const assignee = fields.assignee as Record<string, unknown> | null | undefined;
  const reporter = fields.reporter as Record<string, unknown> | null | undefined;
  const descObj = fields.description as Record<string, unknown> | string | null | undefined;
  let description = "";
  if (typeof descObj === "string") description = descObj;
  else if (descObj != null) description = JSON.stringify(descObj);
  return {
    id: raw.id as string,
    key: raw.key as string,
    self: raw.self as string,
    summary: (fields.summary as string | undefined) ?? "",
    status: (status?.name as string | undefined) ?? "",
    issueType: (issuetype?.name as string | undefined) ?? "",
    priority: (priority?.name as string | undefined) ?? "",
    assignee: (assignee?.displayName as string | undefined) ?? null,
    reporter: (reporter?.displayName as string | undefined) ?? null,
    created: (fields.created as string | undefined) ?? "",
    updated: (fields.updated as string | undefined) ?? "",
    labels: (fields.labels as string[] | undefined) ?? [],
    description,
  };
}

// ── Execute ────────────────────────────────────────────────────────────────────

async function execute(task: JiraTask, ctx: IExecutionContext): Promise<unknown> {
  const baseUrl = requireEnv(ctx, "JIRA_BASE_URL").replace(/\/$/, "");
  const email = requireEnv(ctx, "JIRA_EMAIL");
  const token = requireEnv(ctx, "JIRA_API_TOKEN");
  const auth = basicAuth(email, token);
  const api = `${baseUrl}/rest/api/3`;

  switch (task.taskType) {
    case "jira.get_issue": {
      ctx.logger.info("jira.get_issue", { key: task.issueIdOrKey });
      const params = task.fields?.length ? `?fields=${task.fields.join(",")}` : "";
      const raw = (await jiraFetch(
        "GET",
        `${api}/issue/${task.issueIdOrKey}${params}`,
        auth,
      )) as Record<string, unknown>;
      return rawToIssue(raw);
    }

    case "jira.search": {
      ctx.logger.info("jira.search", { jql: task.jql });
      const raw = (await jiraFetch("POST", `${api}/search`, auth, {
        jql: task.jql,
        maxResults: task.maxResults ?? 50,
        startAt: task.startAt ?? 0,
        fields: task.fields ?? ["summary", "status", "issuetype", "priority", "assignee"],
      })) as {
        issues: Record<string, unknown>[];
        total: number;
        startAt: number;
        maxResults: number;
      };
      return {
        issues: raw.issues.map(rawToIssue),
        total: raw.total,
        startAt: raw.startAt,
        maxResults: raw.maxResults,
      } satisfies JiraSearchResult;
    }

    case "jira.create_issue": {
      ctx.logger.info("jira.create_issue", { project: task.projectKey, summary: task.summary });
      const fields: Record<string, unknown> = {
        project: { key: task.projectKey },
        summary: task.summary,
        issuetype: { name: task.issueType },
        ...(task.priority ? { priority: { name: task.priority } } : {}),
        ...(task.assigneeAccountId ? { assignee: { accountId: task.assigneeAccountId } } : {}),
        ...(task.labels?.length ? { labels: task.labels } : {}),
        ...(task.description
          ? {
              description: {
                type: "doc",
                version: 1,
                content: [
                  { type: "paragraph", content: [{ type: "text", text: task.description }] },
                ],
              },
            }
          : {}),
        ...task.customFields,
      };
      return jiraFetch("POST", `${api}/issue`, auth, { fields });
    }

    case "jira.update_issue": {
      ctx.logger.info("jira.update_issue", { key: task.issueIdOrKey });
      return jiraFetch("PUT", `${api}/issue/${task.issueIdOrKey}`, auth, { fields: task.fields });
    }

    case "jira.transition": {
      ctx.logger.info("jira.transition", {
        key: task.issueIdOrKey,
        transitionId: task.transitionId,
      });
      const body: Record<string, unknown> = { transition: { id: task.transitionId } };
      if (task.comment) {
        body.update = {
          comment: [
            {
              add: {
                body: {
                  type: "doc",
                  version: 1,
                  content: [{ type: "paragraph", content: [{ type: "text", text: task.comment }] }],
                },
              },
            },
          ],
        };
      }
      return jiraFetch("POST", `${api}/issue/${task.issueIdOrKey}/transitions`, auth, body);
    }

    case "jira.add_comment": {
      ctx.logger.info("jira.add_comment", { key: task.issueIdOrKey });
      return jiraFetch("POST", `${api}/issue/${task.issueIdOrKey}/comment`, auth, {
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: task.body }] }],
        },
      });
    }
  }
}

export const jiraAdapter = defineAdapter<JiraTask>({
  name: "nexus-adapter-jira",
  version: "0.1.0",
  capabilities: ["database.query", "database.execute"],
  taskTypes: [
    "jira.get_issue",
    "jira.search",
    "jira.create_issue",
    "jira.update_issue",
    "jira.transition",
    "jira.add_comment",
  ],
  execute,
});
export default jiraAdapter;
