// SPDX-License-Identifier: Apache-2.0
// Gap 15 — 22 new document connectors
import { describe, it, expect, vi } from "vitest";
import {
  isDocumentConnector,
  AirtableDocumentConnector,
  AsanaDocumentConnector,
  BitbucketDocumentConnector,
  BookstackDocumentConnector,
  CanvasDocumentConnector,
  ClickUpDocumentConnector,
  CodaDocumentConnector,
  DiscordDocumentConnector,
  DiscourseDocumentConnector,
  DropboxDocumentConnector,
  FirefliesDocumentConnector,
  FreshdeskDocumentConnector,
  GitBookDocumentConnector,
  GongDocumentConnector,
  GoogleDriveDocumentConnector,
  GuruDocumentConnector,
  HubSpotDocumentConnector,
  ImapDocumentConnector,
  LoopiODocumentConnector,
  MediaWikiDocumentConnector,
  SharePointDocumentConnector,
  ZendeskDocumentConnector,
  type FetchFn,
  type SyncedDocument,
  type ImapQueryFn,
} from "../src/index.js";

// Default when responses run out: fail fast so infinite loops surface immediately
function makeFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown }>): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: false, status: 500, body: {} };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body ?? {},
    } as Response;
  });
}

const okFetch = (body: unknown = {}) => makeFetch([{ ok: true, body }]);

// ─────────────────────────────────────────────────────────────────────────────
// AirtableDocumentConnector
// connect() → GET /baseId/tableId?maxRecords=1
// sync()    → GET /baseId/tableId?pageSize=100  (same fetchFn, sequential calls)
// ─────────────────────────────────────────────────────────────────────────────

describe("AirtableDocumentConnector", () => {
  const cfg = { apiKey: "key123", baseId: "app123", tableId: "tbl456" };

  it("id encodes baseId/tableId", () => {
    expect(new AirtableDocumentConnector(cfg).id).toBe("airtable-doc::app123/tbl456");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new AirtableDocumentConnector(cfg))).toBe(true);
  });

  it("connect() returns ok:true on 200", async () => {
    const conn = new AirtableDocumentConnector({ ...cfg, fetch: okFetch({ records: [] }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() returns ok:false on 401", async () => {
    const conn = new AirtableDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields records (2 fetch calls: connect then sync)", async () => {
    const syncBody = { records: [{ id: "rec1", fields: { Name: "Row 1", Notes: "content" } }] };
    const conn = new AirtableDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: {} }, // connect() → maxRecords=1
        { ok: true, body: syncBody }, // sync() → pageSize=100
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Row 1");
  });

  it("sync() respects limit", async () => {
    const syncBody = {
      records: [
        { id: "rec1", fields: { Name: "A" } },
        { id: "rec2", fields: { Name: "B" } },
      ],
    };
    const conn = new AirtableDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: {} },
        { ok: true, body: syncBody },
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 1 })) docs.push(d);
    expect(docs).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AsanaDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("AsanaDocumentConnector", () => {
  const cfg = { accessToken: "tok", projectGid: "gid123" };

  it("id encodes projectGid", () => {
    expect(new AsanaDocumentConnector(cfg).id).toBe("asana-doc::gid123");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new AsanaDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new AsanaDocumentConnector({ ...cfg, fetch: okFetch({ data: { name: "Yash" } }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new AsanaDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields tasks", async () => {
    const syncBody = {
      data: [
        {
          gid: "t1",
          name: "Task One",
          notes: "content",
          permalink_url: "https://app.asana.com/task/1",
        },
      ],
    };
    const conn = new AsanaDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { data: { name: "u" } } },
        { ok: true, body: syncBody },
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Task One");
  });

  it("sync() respects limit", async () => {
    const syncBody = {
      data: [
        { gid: "t1", name: "A" },
        { gid: "t2", name: "B" },
      ],
    };
    const conn = new AsanaDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { data: { name: "u" } } },
        { ok: true, body: syncBody },
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 1 })) docs.push(d);
    expect(docs).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BitbucketDocumentConnector
// title format: "Issue #${id}: ${title}"
// ─────────────────────────────────────────────────────────────────────────────

describe("BitbucketDocumentConnector", () => {
  const cfg = { workspace: "ws", repoSlug: "repo", username: "user", appPassword: "pass" };

  it("id encodes workspace/repo", () => {
    expect(new BitbucketDocumentConnector(cfg).id).toBe("bitbucket-doc::ws/repo");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new BitbucketDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new BitbucketDocumentConnector({
      ...cfg,
      fetch: okFetch({ display_name: "User" }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new BitbucketDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields issues with formatted title", async () => {
    const syncBody = {
      values: [
        {
          id: 1,
          title: "Bug #1",
          content: { raw: "details" },
          links: { html: { href: "https://bb.io/1" } },
        },
      ],
    };
    const conn = new BitbucketDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { display_name: "u" } },
        { ok: true, body: syncBody },
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    // Connector prepends "Issue #N: " to the issue title
    expect(docs[0]?.title).toBe("Issue #1: Bug #1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BookstackDocumentConnector
// connect() → GET /api/users?count=1  (different endpoint from sync)
// sync()    → GET /api/pages?count=50&page=1, then GET /api/pages/${id}
// ─────────────────────────────────────────────────────────────────────────────

describe("BookstackDocumentConnector", () => {
  const cfg = { baseUrl: "https://books.example.com", tokenId: "tid", tokenSecret: "tsec" };

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new BookstackDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new BookstackDocumentConnector({ ...cfg, fetch: okFetch({ data: [] }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new BookstackDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields pages (3 fetch calls: connect, list, detail)", async () => {
    const listBody = { data: [{ id: 1, name: "Page One", book_id: 2, slug: "page-one" }] };
    const pageBody = { html: "<p>content</p>" };
    const conn = new BookstackDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: {} }, // connect() → /api/users
        { ok: true, body: listBody }, // sync() → /api/pages list (1 page, < 50 → breaks)
        { ok: true, body: pageBody }, // sync() → /api/pages/1 detail
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Page One");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasDocumentConnector
// config: { baseUrl, accessToken }  (NOT "domain")
// title: "[CourseN] AnnouncementTitle"
// ─────────────────────────────────────────────────────────────────────────────

describe("CanvasDocumentConnector", () => {
  const cfg = { baseUrl: "https://canvas.example.edu", accessToken: "tok" };

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new CanvasDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new CanvasDocumentConnector({ ...cfg, fetch: okFetch({ id: 1, name: "Me" }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("sync() yields announcements with [Course] prefix", async () => {
    const coursesBody = [{ id: 10, name: "Math 101" }];
    const announcementsBody = [
      {
        id: 1,
        title: "Midterm Info",
        message: "details",
        html_url: "https://canvas.example.edu/courses/10/discussion_topics/1",
      },
    ];
    const conn = new CanvasDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { id: 1, name: "Me" } }, // connect()
        { ok: true, body: coursesBody }, // sync() → get courses
        { ok: true, body: announcementsBody }, // sync() → get announcements for course 10
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    // Title is prefixed with course name
    expect(docs[0]?.title).toBe("[Math 101] Midterm Info");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ClickUpDocumentConnector
// sync inner loop: while(true) { ... if (json.last_page) break; }
// Must provide last_page:true to terminate the loop
// ─────────────────────────────────────────────────────────────────────────────

describe("ClickUpDocumentConnector", () => {
  const cfg = { apiKey: "key", spaceId: "sp1" };

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new ClickUpDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new ClickUpDocumentConnector({
      ...cfg,
      fetch: okFetch({ user: { username: "yash" } }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("sync() yields tasks (last_page:true terminates inner loop)", async () => {
    const listsBody = { lists: [{ id: "l1", name: "List A" }] };
    const tasksBody = {
      tasks: [
        { id: "t1", name: "Task One", description: "desc", url: "https://app.clickup.com/t/t1" },
      ],
      last_page: true, // critical: without this the while(true) never breaks
    };
    const conn = new ClickUpDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { user: { username: "u" } } },
        { ok: true, body: listsBody },
        { ok: true, body: tasksBody },
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toContain("Task One");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CodaDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("CodaDocumentConnector", () => {
  const cfg = { apiKey: "key", docId: "doc1" };

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new CodaDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new CodaDocumentConnector({
      ...cfg,
      fetch: okFetch({ id: "doc1", name: "My Doc" }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new CodaDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields pages with markdown content", async () => {
    const listBody = { items: [{ id: "p1", name: "Intro" }] };
    const exportBody = { markdown: "# Hello" };
    const conn = new CodaDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { id: "doc1", name: "My Doc" } }, // connect()
        { ok: true, body: listBody }, // sync() list pages
        { ok: true, body: exportBody }, // sync() export page
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Intro");
    expect(docs[0]?.content).toBe("# Hello");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DiscordDocumentConnector
// config: channelIds (array, NOT channelId singular)
// id: "discord-doc" (not per-channel)
// breaks when msgs.length < 100 (not paginated further)
// ─────────────────────────────────────────────────────────────────────────────

describe("DiscordDocumentConnector", () => {
  const cfg = { botToken: "tok", channelIds: ["ch1"] };

  it("id is 'discord-doc'", () => {
    expect(new DiscordDocumentConnector(cfg).id).toBe("discord-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new DiscordDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new DiscordDocumentConnector({
      ...cfg,
      fetch: okFetch({ id: "bot1", username: "MyBot" }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("sync() yields messages (< 100 msgs → no further page fetch)", async () => {
    const msgs = [
      { id: "m2", content: "Hello", author: { username: "alice" }, timestamp: "2024-01-01" },
      { id: "m1", content: "World", author: { username: "bob" }, timestamp: "2024-01-02" },
    ];
    const conn = new DiscordDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { id: "bot1" } }, // connect()
        { ok: true, body: msgs }, // sync() ch1 page 1 (2 msgs < 100 → done)
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
  });

  it("sync() respects limit", async () => {
    const msgs = [
      { id: "m1", content: "A", author: { username: "a" }, timestamp: "2024-01-01" },
      { id: "m2", content: "B", author: { username: "b" }, timestamp: "2024-01-02" },
    ];
    const conn = new DiscordDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { id: "bot1" } },
        { ok: true, body: msgs },
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync({ limit: 1 })) docs.push(d);
    expect(docs).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DiscourseDocumentConnector
// connect() → GET /users/${apiUsername}.json  (different from sync)
// sync()    → GET /latest.json?page=0, page=1, …
// ─────────────────────────────────────────────────────────────────────────────

describe("DiscourseDocumentConnector", () => {
  const cfg = { baseUrl: "https://discuss.example.com", apiKey: "key", apiUsername: "user" };

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new DiscourseDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new DiscourseDocumentConnector({ ...cfg, fetch: okFetch({ user: {} }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("sync() yields topics — connect and sync use different endpoints", async () => {
    const topicsBody = {
      topic_list: {
        topics: [{ id: 1, title: "Hello World", excerpt: "first post", slug: "hello-world" }],
      },
    };
    const conn = new DiscourseDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { user: {} } }, // connect() → /users/user.json
        { ok: true, body: topicsBody }, // sync() page 0 → /latest.json
        { ok: true, body: { topic_list: { topics: [] } } }, // sync() page 1 → empty → break
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Hello World");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DropboxDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("DropboxDocumentConnector", () => {
  const cfg = { accessToken: "tok" };

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new DropboxDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new DropboxDocumentConnector({ ...cfg, fetch: okFetch({ account_id: "abc" }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new DropboxDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields files and skips folders", async () => {
    const listBody = {
      entries: [
        { ".tag": "folder", id: "id:f1", name: "subfolder", path_display: "/subfolder" },
        { ".tag": "file", id: "id:file1", name: "notes.txt", path_display: "/notes.txt" },
      ],
      has_more: false,
    };
    const conn = new DropboxDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { account_id: "abc" } }, // connect()
        { ok: true, body: listBody }, // sync() list_folder
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("notes.txt");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FirefliesDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("FirefliesDocumentConnector", () => {
  const cfg = { apiKey: "key" };

  it("id is 'fireflies-doc'", () => {
    expect(new FirefliesDocumentConnector(cfg).id).toBe("fireflies-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new FirefliesDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok when no GQL errors", async () => {
    const conn = new FirefliesDocumentConnector({
      ...cfg,
      fetch: okFetch({ data: { user: { email: "y@x.com" } } }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails when GQL errors present", async () => {
    const conn = new FirefliesDocumentConnector({
      ...cfg,
      fetch: okFetch({ errors: [{ message: "Unauthorized" }] }),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields transcripts", async () => {
    const transcriptsBody = {
      data: {
        transcripts: [
          {
            id: "t1",
            title: "Call with Bob",
            date: "2024-01-01",
            summary: { overview: "discussed roadmap" },
          },
        ],
      },
    };
    const conn = new FirefliesDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { data: { user: { email: "y@x.com" } } } }, // connect()
        { ok: true, body: transcriptsBody }, // sync()
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Call with Bob");
    expect(docs[0]?.content).toBe("discussed roadmap");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FreshdeskDocumentConnector
// title format: "Ticket #${id}: ${subject}"
// loop: while(true) { ... if (tickets.length < 100) break; }
// ─────────────────────────────────────────────────────────────────────────────

describe("FreshdeskDocumentConnector", () => {
  const cfg = { domain: "mycompany", apiKey: "key" };

  it("id encodes domain", () => {
    expect(new FreshdeskDocumentConnector(cfg).id).toBe("freshdesk-doc::mycompany");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new FreshdeskDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new FreshdeskDocumentConnector({
      ...cfg,
      fetch: okFetch({ email: "agent@co.com" }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new FreshdeskDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields tickets with formatted title (1 ticket < 100 → last page)", async () => {
    const ticketsBody = [
      { id: 1, subject: "Login issue", description_text: "can't login", status: 2 },
    ];
    const conn = new FreshdeskDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { email: "a@b.com" } }, // connect()
        { ok: true, body: ticketsBody }, // sync() page 1 (1 ticket < 100 → done)
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Ticket #1: Login issue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GitBookDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("GitBookDocumentConnector", () => {
  const cfg = { apiKey: "key", spaceId: "sp1" };

  it("id encodes spaceId", () => {
    expect(new GitBookDocumentConnector(cfg).id).toBe("gitbook-doc::sp1");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new GitBookDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new GitBookDocumentConnector({
      ...cfg,
      fetch: okFetch({ id: "sp1", title: "My Space" }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("sync() yields pages", async () => {
    const pagesBody = { items: [{ id: "p1", title: "Introduction", path: "/intro" }] };
    const conn = new GitBookDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { id: "sp1", title: "Docs" } }, // connect()
        { ok: true, body: pagesBody }, // sync()
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Introduction");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GongDocumentConnector
// ─────────────────────────────────────────────────────────────────────────────

describe("GongDocumentConnector", () => {
  const cfg = { accessKey: "ak", accessKeySecret: "aks" };

  it("id is 'gong-doc'", () => {
    expect(new GongDocumentConnector(cfg).id).toBe("gong-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new GongDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new GongDocumentConnector({ ...cfg, fetch: okFetch({ requestedUserId: "u1" }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new GongDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields calls", async () => {
    const callsBody = {
      calls: [{ id: "c1", title: "Sales call", started: "2024-01-01T10:00:00Z" }],
    };
    const conn = new GongDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { requestedUserId: "u1" } }, // connect()
        { ok: true, body: callsBody }, // sync()
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Sales call");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GoogleDriveDocumentConnector
// id: "gdrive-doc" (not "googledrive-doc")
// ─────────────────────────────────────────────────────────────────────────────

describe("GoogleDriveDocumentConnector", () => {
  const cfg = { accessToken: "tok" };

  it("id is 'gdrive-doc'", () => {
    expect(new GoogleDriveDocumentConnector(cfg).id).toBe("gdrive-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new GoogleDriveDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new GoogleDriveDocumentConnector({
      ...cfg,
      fetch: okFetch({ user: { displayName: "Yash" } }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new GoogleDriveDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields files", async () => {
    const filesBody = {
      files: [
        {
          id: "f1",
          name: "Report.pdf",
          mimeType: "application/pdf",
          webViewLink: "https://drive.google.com/f1",
        },
      ],
    };
    const conn = new GoogleDriveDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { user: { displayName: "Yash" } } }, // connect()
        { ok: true, body: filesBody }, // sync()
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Report.pdf");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GuruDocumentConnector
// loop breaks when cards.length < 50
// ─────────────────────────────────────────────────────────────────────────────

describe("GuruDocumentConnector", () => {
  const cfg = { username: "user@co.com", apiToken: "tok" };

  it("id is 'guru-doc'", () => {
    expect(new GuruDocumentConnector(cfg).id).toBe("guru-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new GuruDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new GuruDocumentConnector({
      ...cfg,
      fetch: okFetch({ user: { email: "u@co.com" } }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("sync() yields cards (< 50 = last page, no extra request needed)", async () => {
    const cardsBody = [
      {
        id: "c1",
        preferredPhrase: "How to do X",
        content: { text: "Do Y first" },
        shareLink: "https://app.getguru.com/cards/c1",
      },
    ];
    const conn = new GuruDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { user: { email: "u@co.com" } } }, // connect()
        { ok: true, body: cardsBody }, // sync() page 0 (1 card < 50 → done)
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("How to do X");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HubSpotDocumentConnector
// loop breaks when paging.next is absent
// ─────────────────────────────────────────────────────────────────────────────

describe("HubSpotDocumentConnector", () => {
  const cfg = { accessToken: "tok" };

  it("id is 'hubspot-doc'", () => {
    expect(new HubSpotDocumentConnector(cfg).id).toBe("hubspot-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new HubSpotDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new HubSpotDocumentConnector({ ...cfg, fetch: okFetch({ portalId: 123 }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new HubSpotDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields CRM objects across object types", async () => {
    // Default objectTypes: ["contacts", "companies", "deals", "tickets"]
    // 1 contact result (no paging.next → inner loop breaks), 0 for the rest
    const contactsPage = {
      results: [{ id: "c1", properties: { firstname: "Alice", email: "a@b.com" } }],
    };
    const emptyPage = { results: [] };
    const conn = new HubSpotDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { portalId: 123 } }, // connect()
        { ok: true, body: contactsPage }, // contacts page (no paging → done)
        { ok: true, body: emptyPage }, // companies
        { ok: true, body: emptyPage }, // deals
        { ok: true, body: emptyPage }, // tickets
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ImapDocumentConnector
// Uses injectable queryFn instead of fetch (IMAP is socket-based, not HTTP)
// ─────────────────────────────────────────────────────────────────────────────

describe("ImapDocumentConnector", () => {
  const cfg = { host: "imap.gmail.com", user: "yash@gmail.com", password: "pass" };

  it("id encodes user@host", () => {
    expect(new ImapDocumentConnector(cfg).id).toBe("imap-doc::yash@gmail.com@imap.gmail.com");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new ImapDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok without queryFn (informational mode)", async () => {
    expect((await new ImapDocumentConnector(cfg).connect()).ok).toBe(true);
  });

  it("connect() ok with queryFn that resolves", async () => {
    const queryFn: ImapQueryFn = vi.fn().mockResolvedValue([]);
    expect((await new ImapDocumentConnector({ ...cfg, queryFn }).connect()).ok).toBe(true);
  });

  it("connect() fails when queryFn throws", async () => {
    const queryFn: ImapQueryFn = vi.fn().mockRejectedValue(new Error("auth failed"));
    const r = await new ImapDocumentConnector({ ...cfg, queryFn }).connect();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("IMAP connect failed");
  });

  it("sync() yields messages from queryFn", async () => {
    const messages = [
      {
        uid: "101",
        subject: "Meeting notes",
        from: "boss@co.com",
        date: "2024-01-01",
        text: "agenda",
      },
      {
        uid: "102",
        subject: "Re: Meeting",
        from: "peer@co.com",
        date: "2024-01-02",
        text: "agreed",
      },
    ];
    const queryFn: ImapQueryFn = vi.fn().mockResolvedValue(messages);
    const conn = new ImapDocumentConnector({ ...cfg, queryFn });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.title).toBe("Meeting notes");
  });

  it("sync() uses (no subject) fallback", async () => {
    const queryFn: ImapQueryFn = vi
      .fn()
      .mockResolvedValue([
        { uid: "103", subject: "", from: "x@y.com", date: "2024-01-03", text: "" },
      ]);
    const conn = new ImapDocumentConnector({ ...cfg, queryFn });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs[0]?.title).toBe("(no subject)");
  });

  it("sync() passes limit to queryFn", async () => {
    const queryFn: ImapQueryFn = vi.fn().mockResolvedValue([]);
    const conn = new ImapDocumentConnector({ ...cfg, queryFn });
    await conn.connect();
    for await (const _ of conn.sync({ limit: 5 })) {
      /* drain */
    }
    expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LoopiODocumentConnector
// loop breaks when items.length < 50
// ─────────────────────────────────────────────────────────────────────────────

describe("LoopiODocumentConnector", () => {
  const cfg = { apiKey: "key" };

  it("id is 'loopio-doc'", () => {
    expect(new LoopiODocumentConnector(cfg).id).toBe("loopio-doc");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new LoopiODocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new LoopiODocumentConnector({ ...cfg, fetch: okFetch({ items: [] }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new LoopiODocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields entries (1 entry < 50 → last page)", async () => {
    const entriesBody = { items: [{ id: 1, question: "What is X?", answer: "X is Y." }] };
    const conn = new LoopiODocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { items: [] } }, // connect()
        { ok: true, body: entriesBody }, // sync() offset=0 (1 item < 50 → done)
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("What is X?");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MediaWikiDocumentConnector
// config: category (NOT cmtitle) — "Science" not "Category:Science"
// ─────────────────────────────────────────────────────────────────────────────

describe("MediaWikiDocumentConnector", () => {
  const apiUrl = "https://en.wikipedia.org/w/api.php";

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new MediaWikiDocumentConnector({ apiUrl }))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new MediaWikiDocumentConnector({ apiUrl, fetch: okFetch({ query: {} }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("sync() via category field yields pages", async () => {
    const categoryBody = { query: { categorymembers: [{ title: "Physics" }] } };
    const pageBody = { query: { pages: { "1": { pageid: 1, extract: "The study of matter." } } } };
    const conn = new MediaWikiDocumentConnector({
      apiUrl,
      category: "Science", // field is "category", connector adds "Category:" prefix itself
      fetch: makeFetch([
        { ok: true, body: { query: {} } }, // connect()
        { ok: true, body: categoryBody }, // sync() categorymembers query
        { ok: true, body: pageBody }, // sync() extract for "Physics"
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Physics");
    expect(docs[0]?.content).toBe("The study of matter.");
  });

  it("sync() via pageTitles yields pages", async () => {
    const pageBody = {
      query: { pages: { "2": { pageid: 2, extract: "The study of reactions." } } },
    };
    const conn = new MediaWikiDocumentConnector({
      apiUrl,
      pageTitles: ["Chemistry"],
      fetch: makeFetch([
        { ok: true, body: { query: {} } }, // connect()
        { ok: true, body: pageBody }, // sync() extract for "Chemistry"
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Chemistry");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SharePointDocumentConnector
// sync() goes directly to /sites/${siteId}/drive/root/children (no intermediate drive-id fetch)
// ─────────────────────────────────────────────────────────────────────────────

describe("SharePointDocumentConnector", () => {
  const cfg = { accessToken: "tok", siteUrl: "https://tenant.sharepoint.com/sites/mysite" };

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new SharePointDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new SharePointDocumentConnector({
      ...cfg,
      fetch: okFetch({ id: "site1", displayName: "My Site" }),
    });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new SharePointDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields files, skips folders", async () => {
    // Sync goes directly to /drive/root/children — no intermediate "get drive" call
    const filesBody = {
      value: [
        {
          id: "fold1",
          name: "Archived",
          webUrl: "https://tenant.sharepoint.com/Archived",
          folder: {},
        },
        {
          id: "f1",
          name: "Proposal.docx",
          webUrl: "https://tenant.sharepoint.com/Proposal.docx",
          file: {},
        },
      ],
    };
    const conn = new SharePointDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { id: "site1" } }, // connect()
        { ok: true, body: filesBody }, // sync() root/children (no @odata.nextLink → done)
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Proposal.docx");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ZendeskDocumentConnector
// title format: "Ticket #${id}: ${subject}"
// ─────────────────────────────────────────────────────────────────────────────

describe("ZendeskDocumentConnector", () => {
  const cfg = { subdomain: "myco", email: "agent@myco.com", apiToken: "tok" };

  it("id encodes subdomain", () => {
    expect(new ZendeskDocumentConnector(cfg).id).toBe("zendesk-doc::myco");
  });

  it("is a DocumentConnector", () => {
    expect(isDocumentConnector(new ZendeskDocumentConnector(cfg))).toBe(true);
  });

  it("connect() ok on 200", async () => {
    const conn = new ZendeskDocumentConnector({ ...cfg, fetch: okFetch({ user: { id: 1 } }) });
    expect((await conn.connect()).ok).toBe(true);
  });

  it("connect() fails on 401", async () => {
    const conn = new ZendeskDocumentConnector({
      ...cfg,
      fetch: makeFetch([{ ok: false, status: 401 }]),
    });
    expect((await conn.connect()).ok).toBe(false);
  });

  it("sync() yields tickets with formatted title", async () => {
    const ticketsBody = {
      tickets: [{ id: 101, subject: "Can't login", description: "error", status: "open" }],
    };
    const conn = new ZendeskDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { user: { id: 1 } } }, // connect()
        { ok: true, body: ticketsBody }, // sync() page 1 (no next_page → done)
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Ticket #101: Can't login");
  });

  it("sync() follows next_page pagination", async () => {
    const page1Body = {
      tickets: [{ id: 1, subject: "Ticket A", description: "a", status: "open" }],
      next_page: "https://myco.zendesk.com/api/v2/tickets.json?page=2",
    };
    const page2Body = {
      tickets: [{ id: 2, subject: "Ticket B", description: "b", status: "closed" }],
    };
    const conn = new ZendeskDocumentConnector({
      ...cfg,
      fetch: makeFetch([
        { ok: true, body: { user: { id: 1 } } }, // connect()
        { ok: true, body: page1Body }, // sync() page 1 (has next_page)
        { ok: true, body: page2Body }, // sync() page 2 (no next_page → done)
      ]),
    });
    await conn.connect();
    const docs: SyncedDocument[] = [];
    for await (const d of conn.sync()) docs.push(d);
    expect(docs).toHaveLength(2);
    expect(docs[1]?.title).toBe("Ticket #2: Ticket B");
  });
});
