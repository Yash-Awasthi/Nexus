// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-notion — Notion API v1 adapter.
 *
 * Task types
 * ----------
 *   notion.query_database   Filter/sort rows in a Notion database
 *   notion.get_page         Fetch a page by ID (with block children)
 *   notion.create_page      Create a page inside a database or parent page
 *   notion.update_page      Update page properties
 *   notion.search           Full-text search across all workspace pages
 *
 * Env vars
 * --------
 *   NOTION_API_KEY   Notion integration token (secret_…)
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ── Task types ────────────────────────────────────────────────────────────────

export interface NotionQueryDatabaseTask {
  taskType: "notion.query_database";
  databaseId: string;
  filter?: Record<string, unknown>;
  sorts?: { property: string; direction: "ascending" | "descending" }[];
  pageSize?: number;
  startCursor?: string;
}

export interface NotionGetPageTask {
  taskType: "notion.get_page";
  pageId: string;
  /** Also fetch block children (default: true) */
  includeContent?: boolean;
}

export interface NotionCreatePageTask {
  taskType: "notion.create_page";
  /** Database ID or page ID to create under */
  parentId: string;
  parentType: "database_id" | "page_id";
  properties: Record<string, unknown>;
  children?: unknown[];
}

export interface NotionUpdatePageTask {
  taskType: "notion.update_page";
  pageId: string;
  properties: Record<string, unknown>;
  /** Archive the page (soft-delete) */
  archived?: boolean;
}

export interface NotionSearchTask {
  taskType: "notion.search";
  query: string;
  filter?: { property: "object"; value: "page" | "database" };
  pageSize?: number;
}

export type NotionTask =
  | NotionQueryDatabaseTask
  | NotionGetPageTask
  | NotionCreatePageTask
  | NotionUpdatePageTask
  | NotionSearchTask;

// ── Result types ───────────────────────────────────────────────────────────────

export interface NotionPage {
  id: string;
  object: string;
  url: string;
  properties: Record<string, unknown>;
  createdTime: string;
  lastEditedTime: string;
}

export interface NotionListResult {
  results: NotionPage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface NotionPageWithContent extends NotionPage {
  blocks: unknown[];
}

// ── Internal fetch helper ──────────────────────────────────────────────────────

async function notionFetch(
  method: "GET" | "POST" | "PATCH",
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-notion", res.status, await res.text());
  }
  return res.json();
}

function toPage(raw: Record<string, unknown>): NotionPage {
  return {
    id: raw.id as string,
    object: raw.object as string,
    url: (raw.url as string | undefined) ?? "",
    properties: (raw.properties as Record<string, unknown> | undefined) ?? {},
    createdTime: (raw.created_time as string | undefined) ?? "",
    lastEditedTime: (raw.last_edited_time as string | undefined) ?? "",
  };
}

// ── Execute ────────────────────────────────────────────────────────────────────

async function execute(
  task: NotionTask,
  ctx: IExecutionContext,
): Promise<NotionListResult | NotionPage | NotionPageWithContent | unknown> {
  const apiKey = requireEnv(ctx, "NOTION_API_KEY");

  switch (task.taskType) {
    case "notion.query_database": {
      ctx.logger.info("notion.query_database", { databaseId: task.databaseId });
      const body: Record<string, unknown> = {};
      if (task.filter) body.filter = task.filter;
      if (task.sorts) body.sorts = task.sorts;
      if (task.pageSize) body.page_size = task.pageSize;
      if (task.startCursor) body.start_cursor = task.startCursor;
      const raw = (await notionFetch(
        "POST",
        `/databases/${task.databaseId}/query`,
        apiKey,
        body,
      )) as { results: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null };
      return {
        results: raw.results.map(toPage),
        hasMore: raw.has_more,
        nextCursor: raw.next_cursor,
      } satisfies NotionListResult;
    }

    case "notion.get_page": {
      ctx.logger.info("notion.get_page", { pageId: task.pageId });
      const page = (await notionFetch("GET", `/pages/${task.pageId}`, apiKey)) as Record<
        string,
        unknown
      >;
      const base = toPage(page);
      if (task.includeContent === false) return base;
      const blocksRaw = (await notionFetch("GET", `/blocks/${task.pageId}/children`, apiKey)) as {
        results: unknown[];
      };
      return { ...base, blocks: blocksRaw.results } satisfies NotionPageWithContent;
    }

    case "notion.create_page": {
      ctx.logger.info("notion.create_page", { parentId: task.parentId });
      return notionFetch("POST", "/pages", apiKey, {
        parent: { [task.parentType]: task.parentId },
        properties: task.properties,
        ...(task.children ? { children: task.children } : {}),
      });
    }

    case "notion.update_page": {
      ctx.logger.info("notion.update_page", { pageId: task.pageId });
      return notionFetch("PATCH", `/pages/${task.pageId}`, apiKey, {
        properties: task.properties,
        ...(task.archived != null ? { archived: task.archived } : {}),
      });
    }

    case "notion.search": {
      ctx.logger.info("notion.search", { query: task.query });
      const body: Record<string, unknown> = { query: task.query };
      if (task.filter) body.filter = task.filter;
      if (task.pageSize) body.page_size = task.pageSize;
      const raw = (await notionFetch("POST", "/search", apiKey, body)) as {
        results: Record<string, unknown>[];
        has_more: boolean;
        next_cursor: string | null;
      };
      return {
        results: raw.results.map(toPage),
        hasMore: raw.has_more,
        nextCursor: raw.next_cursor,
      } satisfies NotionListResult;
    }
  }
}

export const notionAdapter = defineAdapter<NotionTask>({
  name: "nexus-adapter-notion",
  version: "0.1.0",
  capabilities: ["storage.read", "storage.write"],
  taskTypes: [
    "notion.query_database",
    "notion.get_page",
    "notion.create_page",
    "notion.update_page",
    "notion.search",
  ],
  execute,
});
export default notionAdapter;
