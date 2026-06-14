// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import confluenceAdapter from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";

const makeCtx = (env: Record<string, string> = {}): IExecutionContext =>
  ({
    taskId: "t",
    startTime: new Date(),
    attempt: 1,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    environment: {
      CONFLUENCE_BASE_URL: "https://acme.atlassian.net",
      CONFLUENCE_EMAIL: "user@acme.com",
      CONFLUENCE_API_TOKEN: "tok",
      ...env,
    },
  }) as unknown as IExecutionContext;

const RAW_PAGE = {
  id: "123",
  title: "My Page",
  status: "current",
  space: { key: "ENG" },
  version: { number: 3 },
  _links: { webui: "/wiki/spaces/ENG/pages/123" },
  body: { storage: { value: "<p>content</p>" } },
};

describe("@nexus/adapter-confluence", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.restoreAllMocks());

  it("name and capabilities", () => {
    expect(confluenceAdapter.name).toBe("nexus-adapter-confluence");
    expect(confluenceAdapter.capabilities).toContain("storage.read");
    expect(confluenceAdapter.capabilities).toContain("storage.write");
  });

  it("canExecute all declared task types", () => {
    for (const t of [
      "confluence.get_page",
      "confluence.search",
      "confluence.create_page",
      "confluence.update_page",
      "confluence.get_space",
    ]) {
      expect(confluenceAdapter.canExecute(t)).toBe(true);
    }
  });

  it("get_page — sends Basic auth header", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_PAGE, text: async () => "" });
    await confluenceAdapter.execute({ taskType: "confluence.get_page", pageId: "123" }, makeCtx());
    const authHeader = (
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    ).Authorization;
    expect(authHeader).toMatch(/^Basic /);
  });

  it("get_page — maps to ConfluencePage with body", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_PAGE, text: async () => "" });
    const page = (await confluenceAdapter.execute(
      { taskType: "confluence.get_page", pageId: "123" },
      makeCtx(),
    )) as { id: string; title: string; version: number; body: string };
    expect(page.id).toBe("123");
    expect(page.title).toBe("My Page");
    expect(page.version).toBe(3);
    expect(page.body).toBe("<p>content</p>");
  });

  it("get_page — uses view body representation when bodyFormat is 'view'", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...RAW_PAGE,
        body: { view: { value: "<p>rendered</p>" } },
      }),
      text: async () => "",
    });
    const page = (await confluenceAdapter.execute(
      { taskType: "confluence.get_page", pageId: "123", bodyFormat: "view" },
      makeCtx(),
    )) as { body: string };
    expect(page.body).toBe("<p>rendered</p>");
  });

  it("get_page — rawToPage returns no body field when neither storage nor view has a value", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "x", title: "", status: "", space: {}, version: {}, _links: {} }),
      text: async () => "",
    });
    const page = (await confluenceAdapter.execute(
      { taskType: "confluence.get_page", pageId: "x" },
      makeCtx(),
    )) as Record<string, unknown>;
    expect(page["body"]).toBeUndefined();
  });

  it("search — sends CQL in query string", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], totalSize: 0, start: 0, limit: 25 }),
      text: async () => "",
    });
    await confluenceAdapter.execute(
      { taskType: "confluence.search", cql: "type=page AND space=ENG" },
      makeCtx(),
    );
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain("cql=");
  });

  it("search — forwards limit and start query params when provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], totalSize: 0, start: 5, limit: 10 }),
      text: async () => "",
    });
    await confluenceAdapter.execute(
      { taskType: "confluence.search", cql: "type=page", limit: 10, start: 5 },
      makeCtx(),
    );
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain("limit=10");
    expect(url).toContain("start=5");
  });

  it("create_page — sends correct body with space key and parent", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_PAGE, text: async () => "" });
    await confluenceAdapter.execute(
      {
        taskType: "confluence.create_page",
        spaceKey: "ENG",
        title: "New Page",
        body: "<p>hello</p>",
        parentId: "100",
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { space: { key: string }; ancestors: { id: string }[] };
    expect(body.space.key).toBe("ENG");
    expect(body.ancestors[0].id).toBe("100");
  });

  it("create_page — omits ancestors when parentId is not provided", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_PAGE, text: async () => "" });
    await confluenceAdapter.execute(
      {
        taskType: "confluence.create_page",
        spaceKey: "ENG",
        title: "Orphan Page",
        body: "<p>no parent</p>",
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { ancestors?: unknown[] };
    expect(body.ancestors).toBeUndefined();
  });

  it("update_page — includes version number", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_PAGE, text: async () => "" });
    await confluenceAdapter.execute(
      {
        taskType: "confluence.update_page",
        pageId: "123",
        title: "Updated",
        body: "<p>new</p>",
        version: 4,
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { version: { number: number } };
    expect(body.version.number).toBe(4);
  });

  it("throws AdapterHttpError on non-OK response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "Forbidden" });
    await expect(
      confluenceAdapter.execute({ taskType: "confluence.get_space", spaceKey: "ENG" }, makeCtx()),
    ).rejects.toThrow();
  });
});
