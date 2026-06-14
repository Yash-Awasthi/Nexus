// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-linear — Linear issue tracking via GraphQL API.
 * Task types: linear.create-issue, linear.update-issue, linear.list-issues
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  NexusAdapterError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const LINEAR_GQL = "https://api.linear.app/graphql";

export interface LinearCreateIssueTask {
  taskType: "linear.create-issue";
  teamId: string;
  title: string;
  description?: string;
  priority?: 0 | 1 | 2 | 3 | 4;
  stateId?: string;
  assigneeId?: string;
}
export interface LinearUpdateIssueTask {
  taskType: "linear.update-issue";
  issueId: string;
  title?: string;
  description?: string;
  stateId?: string;
  priority?: 0 | 1 | 2 | 3 | 4;
}
export interface LinearListIssuesTask {
  taskType: "linear.list-issues";
  teamId: string;
  first?: number;
  filter?: Record<string, unknown>;
}
export type LinearTask = LinearCreateIssueTask | LinearUpdateIssueTask | LinearListIssuesTask;
export interface LinearIssueResult {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string };
}
export interface LinearListResult {
  issues: LinearIssueResult[];
}

async function gql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok)
    throw new AdapterHttpError("nexus-adapter-linear", response.status, await response.text());
  const data = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };
  if (data.errors?.length)
    throw new NexusAdapterError(
      `Linear GQL error: ${data.errors[0]?.message}`,
      "LINEAR_GQL_ERROR",
      { errors: data.errors },
    );
  return data.data ?? {};
}

async function execute(
  task: LinearTask,
  ctx: IExecutionContext,
): Promise<LinearIssueResult | LinearListResult | { ok: boolean }> {
  const token = requireEnv(ctx, "LINEAR_API_KEY");

  if (task.taskType === "linear.create-issue") {
    ctx.logger.info("linear.create-issue", { title: task.title, teamId: task.teamId });
    const data = await gql(
      token,
      `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier title url state { name } } } }`,
      {
        input: {
          teamId: task.teamId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          stateId: task.stateId,
          assigneeId: task.assigneeId,
        },
      },
    );
    return (data["issueCreate"] as { issue: LinearIssueResult }).issue;
  }

  if (task.taskType === "linear.update-issue") {
    ctx.logger.info("linear.update-issue", { issueId: task.issueId });
    const data = await gql(
      token,
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { id identifier title url state { name } } } }`,
      {
        id: task.issueId,
        input: {
          title: task.title,
          description: task.description,
          stateId: task.stateId,
          priority: task.priority,
        },
      },
    );
    return (data["issueUpdate"] as { issue: LinearIssueResult }).issue;
  }

  // linear.list-issues
  ctx.logger.info("linear.list-issues", { teamId: task.teamId });
  const data = await gql(
    token,
    `query ListIssues($teamId: String!, $first: Int) { team(id: $teamId) { issues(first: $first) { nodes { id identifier title url state { name } } } } }`,
    {
      teamId: task.teamId,
      first: task.first ?? 25,
    },
  );
  const nodes =
    ((data["team"] as Record<string, unknown>)?.["issues"] as { nodes: LinearIssueResult[] })
      ?.nodes ?? [];
  return { issues: nodes };
}

export const linearAdapter = defineAdapter<
  LinearTask,
  LinearIssueResult | LinearListResult | { ok: boolean }
>({
  name: "nexus-adapter-linear",
  version: "0.1.0",
  capabilities: ["storage.read", "storage.write"],
  taskTypes: ["linear.create-issue", "linear.update-issue", "linear.list-issues"],
  execute,
});
export default linearAdapter;
