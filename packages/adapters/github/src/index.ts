// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-github — GitHub REST API adapter
 *
 * Capabilities: storage.read, storage.write
 * Task types:
 *   github.create-issue    — open a new GitHub issue
 *   github.list-issues     — list issues for a repo (with label/state filters)
 *   github.create-pr       — open a pull request
 *   github.get-pr          — fetch a pull request by number
 *   github.merge-pr        — merge an open pull request
 *   github.create-comment  — add a comment to an issue or PR
 *   github.get-repo        — fetch repo metadata
 *
 * Auth: GITHUB_TOKEN (fine-grained PAT or classic PAT)
 * Base URL override: GITHUB_API_URL (default: https://api.github.com)
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

// ── Task input / output types ─────────────────────────────────────────────────

export interface GitHubCreateIssueTask {
  taskType: "github.create-issue";
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
}

export interface GitHubListIssuesTask {
  taskType: "github.list-issues";
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  labels?: string;
  per_page?: number;
  page?: number;
}

export interface GitHubCreatePRTask {
  taskType: "github.create-pr";
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface GitHubGetPRTask {
  taskType: "github.get-pr";
  owner: string;
  repo: string;
  pull_number: number;
}

export interface GitHubMergePRTask {
  taskType: "github.merge-pr";
  owner: string;
  repo: string;
  pull_number: number;
  commit_title?: string;
  merge_method?: "merge" | "squash" | "rebase";
}

export interface GitHubCreateCommentTask {
  taskType: "github.create-comment";
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}

export interface GitHubGetRepoTask {
  taskType: "github.get-repo";
  owner: string;
  repo: string;
}

export type GitHubTask =
  | GitHubCreateIssueTask
  | GitHubListIssuesTask
  | GitHubCreatePRTask
  | GitHubGetPRTask
  | GitHubMergePRTask
  | GitHubCreateCommentTask
  | GitHubGetRepoTask;

// ── Helpers ───────────────────────────────────────────────────────────────────

function githubFetch(
  path: string,
  token: string,
  method: string = "GET",
  body?: unknown,
  baseUrl: string = "https://api.github.com",
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function assertOk(res: Response, adapterName: string): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text();
    throw new AdapterHttpError(adapterName, res.status, text);
  }
  return res.json();
}

// ── Execute ───────────────────────────────────────────────────────────────────

async function execute(task: GitHubTask, ctx: IExecutionContext): Promise<unknown> {
  const token = requireEnv(ctx, "GITHUB_TOKEN");
  const baseUrl = (ctx.env?.["GITHUB_API_URL"] as string | undefined) ?? "https://api.github.com";

  switch (task.taskType) {
    case "github.create-issue": {
      ctx.logger.info("github.create-issue", { owner: task.owner, repo: task.repo, title: task.title });
      const res = await githubFetch(
        `/repos/${task.owner}/${task.repo}/issues`,
        token, "POST",
        { title: task.title, body: task.body, labels: task.labels, assignees: task.assignees, milestone: task.milestone },
        baseUrl,
      );
      return assertOk(res, "nexus-adapter-github");
    }

    case "github.list-issues": {
      ctx.logger.info("github.list-issues", { owner: task.owner, repo: task.repo });
      const params = new URLSearchParams({
        state: task.state ?? "open",
        per_page: String(task.per_page ?? 30),
        page: String(task.page ?? 1),
        ...(task.labels ? { labels: task.labels } : {}),
      });
      const res = await githubFetch(
        `/repos/${task.owner}/${task.repo}/issues?${params}`,
        token, "GET", undefined, baseUrl,
      );
      return assertOk(res, "nexus-adapter-github");
    }

    case "github.create-pr": {
      ctx.logger.info("github.create-pr", { owner: task.owner, repo: task.repo, head: task.head, base: task.base });
      const res = await githubFetch(
        `/repos/${task.owner}/${task.repo}/pulls`,
        token, "POST",
        { title: task.title, head: task.head, base: task.base, body: task.body, draft: task.draft ?? false },
        baseUrl,
      );
      return assertOk(res, "nexus-adapter-github");
    }

    case "github.get-pr": {
      ctx.logger.info("github.get-pr", { owner: task.owner, repo: task.repo, pull_number: task.pull_number });
      const res = await githubFetch(
        `/repos/${task.owner}/${task.repo}/pulls/${task.pull_number}`,
        token, "GET", undefined, baseUrl,
      );
      return assertOk(res, "nexus-adapter-github");
    }

    case "github.merge-pr": {
      ctx.logger.info("github.merge-pr", { owner: task.owner, repo: task.repo, pull_number: task.pull_number });
      const res = await githubFetch(
        `/repos/${task.owner}/${task.repo}/pulls/${task.pull_number}/merge`,
        token, "PUT",
        { commit_title: task.commit_title, merge_method: task.merge_method ?? "squash" },
        baseUrl,
      );
      return assertOk(res, "nexus-adapter-github");
    }

    case "github.create-comment": {
      ctx.logger.info("github.create-comment", { owner: task.owner, repo: task.repo, issue_number: task.issue_number });
      const res = await githubFetch(
        `/repos/${task.owner}/${task.repo}/issues/${task.issue_number}/comments`,
        token, "POST",
        { body: task.body },
        baseUrl,
      );
      return assertOk(res, "nexus-adapter-github");
    }

    case "github.get-repo": {
      ctx.logger.info("github.get-repo", { owner: task.owner, repo: task.repo });
      const res = await githubFetch(
        `/repos/${task.owner}/${task.repo}`,
        token, "GET", undefined, baseUrl,
      );
      return assertOk(res, "nexus-adapter-github");
    }

    default: {
      const exhaustive: never = task;
      throw new Error(`Unhandled GitHub task type: ${(exhaustive as GitHubTask).taskType}`);
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const githubAdapter = defineAdapter<GitHubTask, unknown>({
  name: "nexus-adapter-github",
  version: "0.1.0",
  capabilities: ["storage.read", "storage.write"],
  taskTypes: [
    "github.create-issue",
    "github.list-issues",
    "github.create-pr",
    "github.get-pr",
    "github.merge-pr",
    "github.create-comment",
    "github.get-repo",
  ],
  execute,
});

export default githubAdapter;
