// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-confluence — Confluence Cloud REST API v2 adapter.
 *
 * Task types
 * ----------
 *   confluence.get_page      Fetch a page by ID (with body storage/view)
 *   confluence.search        CQL full-text search
 *   confluence.create_page   Create a page in a space
 *   confluence.update_page   Update page title or body
 *   confluence.get_space     Fetch space metadata by key
 *
 * Env vars
 * --------
 *   CONFLUENCE_BASE_URL    e.g. https://yourorg.atlassian.net
 *   CONFLUENCE_EMAIL       Atlassian account email
 *   CONFLUENCE_API_TOKEN   Atlassian API token
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

// ── Task types ────────────────────────────────────────────────────────────────

export interface ConfluenceGetPageTask {
  taskType: "confluence.get_page";
  pageId: string;
  /** Body representation to include: "storage" (XML) | "view" (HTML) */
  bodyFormat?: "storage" | "view";
}

export interface ConfluenceSearchTask {
  taskType: "confluence.search";
  /** CQL query string */
  cql: string;
  limit?: number;
  start?: number;
}

export interface ConfluenceCreatePageTask {
  taskType: "confluence.create_page";
  spaceKey: string;
  title: string;
  /** Storage-format XHTML body */
  body: string;
  parentId?: string;
  status?: "current" | "draft";
}

export interface ConfluenceUpdatePageTask {
  taskType: "confluence.update_page";
  pageId: string;
  title: string;
  /** Storage-format XHTML body */
  body: string;
  /** Current page version number — required by Confluence for optimistic locking */
  version: number;
  status?: "current" | "draft";
}

export interface ConfluenceGetSpaceTask {
  taskType: "confluence.get_space";
  spaceKey: string;
}

export type ConfluenceTask =
  | ConfluenceGetPageTask
  | ConfluenceSearchTask
  | ConfluenceCreatePageTask
  | ConfluenceUpdatePageTask
  | ConfluenceGetSpaceTask;

// ── Result types ───────────────────────────────────────────────────────────────

export interface ConfluencePage {
  id: string;
  title: string;
  status: string;
  spaceKey: string;
  version: number;
  webUrl: string;
  body?: string;
}

export interface ConfluenceSearchResult {
  results: ConfluencePage[];
  totalSize: number;
  start: number;
  limit: number;
}

// ── Internal fetch helper ──────────────────────────────────────────────────────

function basicAuth(email: string, token: string): string {
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}

async function confluenceFetch(
  method: "GET" | "POST" | "PUT",
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
  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-confluence", res.status, await res.text());
  }
  return res.json();
}

function rawToPage(raw: Record<string, unknown>): ConfluencePage {
  const space = raw.space as Record<string, unknown> | undefined;
  const version = raw.version as Record<string, unknown> | undefined;
  const links = raw._links as Record<string, unknown> | undefined;
  const body = raw.body as Record<string, unknown> | undefined;
  const storage = body?.storage as Record<string, unknown> | undefined;
  const view = body?.view as Record<string, unknown> | undefined;
  return {
    id: raw.id as string,
    title: (raw.title as string | undefined) ?? "",
    status: (raw.status as string | undefined) ?? "",
    spaceKey: (space?.key as string | undefined) ?? "",
    version: (version?.number as number | undefined) ?? 0,
    webUrl: (links?.webui as string | undefined) ?? "",
    ...(storage?.value != null
      ? { body: storage.value as string }
      : view?.value != null
        ? { body: view.value as string }
        : {}),
  };
}

// ── Execute ────────────────────────────────────────────────────────────────────

async function execute(task: ConfluenceTask, ctx: IExecutionContext): Promise<unknown> {
  const baseUrl = requireEnv(ctx, "CONFLUENCE_BASE_URL").replace(/\/$/, "");
  const email = requireEnv(ctx, "CONFLUENCE_EMAIL");
  const token = requireEnv(ctx, "CONFLUENCE_API_TOKEN");
  const auth = basicAuth(email, token);
  const api = `${baseUrl}/wiki/rest/api`;

  switch (task.taskType) {
    case "confluence.get_page": {
      ctx.logger.info("confluence.get_page", { pageId: task.pageId });
      const fmt = task.bodyFormat ?? "storage";
      const url = `${api}/content/${task.pageId}?expand=body.${fmt},version,space`;
      return rawToPage((await confluenceFetch("GET", url, auth)) as Record<string, unknown>);
    }

    case "confluence.search": {
      ctx.logger.info("confluence.search", { cql: task.cql });
      const params = new URLSearchParams({ cql: task.cql });
      if (task.limit != null) params.set("limit", String(task.limit));
      if (task.start != null) params.set("start", String(task.start));
      const raw = (await confluenceFetch(
        "GET",
        `${api}/content/search?${params.toString()}`,
        auth,
      )) as { results: Record<string, unknown>[]; totalSize: number; start: number; limit: number };
      return {
        results: raw.results.map(rawToPage),
        totalSize: raw.totalSize,
        start: raw.start,
        limit: raw.limit,
      } satisfies ConfluenceSearchResult;
    }

    case "confluence.create_page": {
      ctx.logger.info("confluence.create_page", { title: task.title, spaceKey: task.spaceKey });
      const body: Record<string, unknown> = {
        type: "page",
        title: task.title,
        status: task.status ?? "current",
        space: { key: task.spaceKey },
        body: { storage: { value: task.body, representation: "storage" } },
      };
      if (task.parentId) body.ancestors = [{ id: task.parentId }];
      return rawToPage(
        (await confluenceFetch("POST", `${api}/content`, auth, body)) as Record<string, unknown>,
      );
    }

    case "confluence.update_page": {
      ctx.logger.info("confluence.update_page", { pageId: task.pageId });
      return rawToPage(
        (await confluenceFetch("PUT", `${api}/content/${task.pageId}`, auth, {
          type: "page",
          title: task.title,
          status: task.status ?? "current",
          version: { number: task.version },
          body: { storage: { value: task.body, representation: "storage" } },
        })) as Record<string, unknown>,
      );
    }

    case "confluence.get_space": {
      ctx.logger.info("confluence.get_space", { spaceKey: task.spaceKey });
      return confluenceFetch("GET", `${api}/space/${task.spaceKey}`, auth);
    }
  }
}

export const confluenceAdapter = defineAdapter<ConfluenceTask>({
  name: "nexus-adapter-confluence",
  version: "0.1.0",
  capabilities: ["storage.read", "storage.write"],
  taskTypes: [
    "confluence.get_page",
    "confluence.search",
    "confluence.create_page",
    "confluence.update_page",
    "confluence.get_space",
  ],
  execute,
});
export default confluenceAdapter;
