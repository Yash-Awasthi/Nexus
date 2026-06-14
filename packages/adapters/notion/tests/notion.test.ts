// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import notionAdapter from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";

const makeCtx = (environment: Record<string, string> = {}): IExecutionContext =>
  ({
    taskId: "t",
    startTime: new Date(),
    attempt: 1,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    environment,
  }) as unknown as IExecutionContext;

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body, text: async () => "" });

describe("@nexus/adapter-notion", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.restoreAllMocks());

  it("name and capabilities", () => {
    expect(notionAdapter.name).toBe("nexus-adapter-notion");
    expect(notionAdapter.capabilities).toContain("storage.read");
    expect(notionAdapter.capabilities).toContain("storage.write");
  });

  it("canExecute all declared task types", () => {
    for (const t of [
      "notion.query_database",
      "notion.get_page",
      "notion.create_page",
      "notion.update_page",
      "notion.search",
    ]) {
      expect(notionAdapter.canExecute(t)).toBe(true);
    }
    expect(notionAdapter.canExecute("confluence.get_page")).toBe(false);
  });

  it("query_database — sends POST to /databases/:id/query with filter", async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ results: [], has_more: false, next_cursor: null }));
    const result = (await notionAdapter.execute(
      {
        taskType: "notion.query_database",
        databaseId: "db1",
        filter: { property: "Status", select: { equals: "Done" } },
      },
      makeCtx({ NOTION_API_KEY: "secret_test" }),
    )) as { hasMore: boolean };
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/databases/db1/query");
    expect((opts.headers as Record<string, string>)["Notion-Version"]).toBe("2022-06-28");
    expect(result.hasMore).toBe(false);
  });

  it("query_database — includes sorts, pageSize, startCursor in body when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ results: [], has_more: true, next_cursor: "cur-abc" }),
    );
    await notionAdapter.execute(
      {
        taskType: "notion.query_database",
        databaseId: "db2",
        sorts: [{ property: "Name", direction: "ascending" }],
        pageSize: 10,
        startCursor: "start-xyz",
      },
      makeCtx({ NOTION_API_KEY: "k" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { sorts: unknown[]; page_size: number; start_cursor: string };
    expect(body.sorts).toHaveLength(1);
    expect(body.page_size).toBe(10);
    expect(body.start_cursor).toBe("start-xyz");
  });

  it("get_page — fetches page then block children by default", async () => {
    const rawPage = {
      id: "p1",
      object: "page",
      url: "https://notion.so/p1",
      properties: {},
      created_time: "",
      last_edited_time: "",
    };
    fetchMock
      .mockResolvedValueOnce(jsonOk(rawPage))
      .mockResolvedValueOnce(jsonOk({ results: [{ id: "b1", type: "paragraph" }] }));
    const result = (await notionAdapter.execute(
      { taskType: "notion.get_page", pageId: "p1" },
      makeCtx({ NOTION_API_KEY: "k" }),
    )) as { blocks: unknown[] };
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.blocks).toHaveLength(1);
  });

  it("get_page — skips block fetch when includeContent:false", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        id: "p2",
        object: "page",
        url: "",
        properties: {},
        created_time: "",
        last_edited_time: "",
      }),
    );
    await notionAdapter.execute(
      { taskType: "notion.get_page", pageId: "p2", includeContent: false },
      makeCtx({ NOTION_API_KEY: "k" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("get_page — toPage falls back to empty strings/objects when fields are absent", async () => {
    // Raw page with only id + object — url, properties, created_time, last_edited_time absent
    // This covers the ?? "" and ?? {} fallback branches in toPage()
    fetchMock
      .mockResolvedValueOnce(jsonOk({ id: "p3", object: "page" }))
      .mockResolvedValueOnce(jsonOk({ results: [] }));
    const result = (await notionAdapter.execute(
      { taskType: "notion.get_page", pageId: "p3" },
      makeCtx({ NOTION_API_KEY: "k" }),
    )) as { url: string; properties: Record<string, unknown>; createdTime: string };
    expect(result.url).toBe("");
    expect(result.properties).toEqual({});
    expect(result.createdTime).toBe("");
  });

  it("create_page — sends parent + properties", async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ id: "newpage" }));
    await notionAdapter.execute(
      {
        taskType: "notion.create_page",
        parentId: "db1",
        parentType: "database_id",
        properties: { Name: { title: [{ text: { content: "Hello" } }] } },
      },
      makeCtx({ NOTION_API_KEY: "k" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { parent: { database_id: string } };
    expect(body.parent.database_id).toBe("db1");
  });

  it("create_page — includes children in body when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ id: "childpage" }));
    await notionAdapter.execute(
      {
        taskType: "notion.create_page",
        parentId: "page-parent",
        parentType: "page_id",
        properties: {},
        children: [{ object: "block", type: "paragraph" }],
      },
      makeCtx({ NOTION_API_KEY: "k" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { children: unknown[] };
    expect(body.children).toHaveLength(1);
  });

  it("update_page — sends PATCH to /pages/:id with properties (no archived)", async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ id: "p1" }));
    await notionAdapter.execute(
      {
        taskType: "notion.update_page",
        pageId: "p1",
        properties: { Status: { select: { name: "Done" } } },
      },
      makeCtx({ NOTION_API_KEY: "k" }),
    );
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/pages/p1");
    expect(opts.method).toBe("PATCH");
    const body = JSON.parse(opts.body as string) as { archived?: boolean };
    // archived field must be absent when not provided
    expect(body.archived).toBeUndefined();
  });

  it("update_page — includes archived: true in body when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ id: "p2" }));
    await notionAdapter.execute(
      {
        taskType: "notion.update_page",
        pageId: "p2",
        properties: {},
        archived: true,
      },
      makeCtx({ NOTION_API_KEY: "k" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { archived: boolean };
    expect(body.archived).toBe(true);
  });

  it("search — maps results to NotionPage[]", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        results: [
          {
            id: "r1",
            object: "page",
            url: "https://notion.so/r1",
            properties: {},
            created_time: "2024-01-01",
            last_edited_time: "2024-01-02",
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    const r = (await notionAdapter.execute(
      { taskType: "notion.search", query: "design doc" },
      makeCtx({ NOTION_API_KEY: "k" }),
    )) as { results: { id: string }[] };
    expect(r.results[0]?.id).toBe("r1");
  });

  it("search — sends filter and pageSize in body when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ results: [], has_more: false, next_cursor: null }));
    await notionAdapter.execute(
      {
        taskType: "notion.search",
        query: "pages",
        filter: { property: "object", value: "page" },
        pageSize: 5,
      },
      makeCtx({ NOTION_API_KEY: "k" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { filter: unknown; page_size: number };
    expect(body.filter).toBeDefined();
    expect(body.page_size).toBe(5);
  });

  it("throws AdapterHttpError on 401", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" });
    await expect(
      notionAdapter.execute(
        { taskType: "notion.search", query: "x" },
        makeCtx({ NOTION_API_KEY: "bad" }),
      ),
    ).rejects.toThrow();
  });
});
