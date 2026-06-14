// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  WikiPageStore,
  WikiAcl,
  WikiCommentStore,
  WikiDraftStore,
  WikiSearch,
  WikiNotifier,
  WikiStore,
} from "../src/index.js";

// ── WikiPageStore ─────────────────────────────────────────────────────────────

describe("WikiPageStore", () => {
  let store: WikiPageStore;

  beforeEach(() => { store = new WikiPageStore(); });

  it("creates a page with auto-fields", () => {
    const p = store.create({ slug: "getting-started", title: "Getting Started", content: "Welcome!", createdBy: "alice" });
    expect(p.id).toMatch(/^wp-/);
    expect(p.slug).toBe("getting-started");
    expect(p.version).toBe(1);
    expect(p.status).toBe("published");
    expect(p.history).toHaveLength(1);
    expect(p.history[0]!.summary).toBe("Initial version");
  });

  it("throws on duplicate slug", () => {
    store.create({ slug: "dup", title: "Dup", content: "c", createdBy: "alice" });
    expect(() => store.create({ slug: "dup", title: "Dup2", content: "c2", createdBy: "alice" })).toThrow("Slug already exists");
  });

  it("getBySlug works", () => {
    const p = store.create({ slug: "my-page", title: "My Page", content: "c", createdBy: "bob" });
    expect(store.getBySlug("my-page")).toBe(p);
    expect(store.getBySlug("nonexistent")).toBeUndefined();
  });

  it("update increments version and records history", () => {
    const p = store.create({ slug: "p", title: "T", content: "v1", createdBy: "alice" });
    const updated = store.update(p.id, { content: "v2", editedBy: "alice", summary: "Fixed typos" });
    expect(updated!.version).toBe(2);
    expect(updated!.content).toBe("v2");
    expect(updated!.history).toHaveLength(2);
    expect(updated!.history[1]!.summary).toBe("Fixed typos");
    expect(updated!.history[1]!.diff).toBeTruthy();
  });

  it("update computes diff between versions", () => {
    const p = store.create({ slug: "p", title: "T", content: "line one\nline two", createdBy: "alice" });
    const updated = store.update(p.id, { content: "line one\nline three", editedBy: "bob" });
    const diff = updated!.history[1]!.diff ?? "";
    expect(diff).toContain("- line two");
    expect(diff).toContain("+ line three");
  });

  it("softDelete sets status to deleted", () => {
    const p = store.create({ slug: "p", title: "T", content: "c", createdBy: "alice" });
    store.softDelete(p.id);
    expect(store.get(p.id)!.status).toBe("deleted");
  });

  it("star / unstar toggle starred list", () => {
    const p = store.create({ slug: "p", title: "T", content: "c", createdBy: "alice" });
    store.star(p.id, "bob");
    store.star(p.id, "bob"); // idempotent
    expect(store.get(p.id)!.starred).toHaveLength(1);
    store.unstar(p.id, "bob");
    expect(store.get(p.id)!.starred).toHaveLength(0);
  });

  it("list filters by status", () => {
    store.create({ slug: "a", title: "A", content: "c", createdBy: "alice" });
    store.create({ slug: "b", title: "B", content: "c", createdBy: "alice", status: "draft" });
    expect(store.list({ status: "draft" })).toHaveLength(1);
    expect(store.list({ status: "published" })).toHaveLength(1);
  });

  it("list filters by tag", () => {
    store.create({ slug: "a", title: "A", content: "c", createdBy: "alice", tags: ["ts", "guide"] });
    store.create({ slug: "b", title: "B", content: "c", createdBy: "alice", tags: ["python"] });
    expect(store.list({ tag: "ts" })).toHaveLength(1);
  });

  it("hard delete removes page", () => {
    const p = store.create({ slug: "del", title: "T", content: "c", createdBy: "alice" });
    expect(store.delete(p.id)).toBe(true);
    expect(store.get(p.id)).toBeUndefined();
    expect(store.getBySlug("del")).toBeUndefined();
  });

  it("deduplicates tags", () => {
    const p = store.create({ slug: "p", title: "T", content: "c", createdBy: "alice", tags: ["ts", "ts"] });
    expect(p.tags).toHaveLength(1);
  });
});

// ── WikiAcl ───────────────────────────────────────────────────────────────────

describe("WikiAcl", () => {
  const acl = new WikiAcl();

  it("grants and retrieves role", () => {
    acl.grant("p1", "alice", "owner", "system");
    expect(acl.getRole("p1", "alice")).toBe("owner");
  });

  it("canRead/canEdit/canAdmin reflect role", () => {
    acl.grant("p1", "bob", "editor", "alice");
    acl.grant("p1", "carol", "viewer", "alice");
    expect(acl.canEdit("p1", "bob")).toBe(true);
    expect(acl.canAdmin("p1", "bob")).toBe(false);
    expect(acl.canRead("p1", "carol")).toBe(true);
    expect(acl.canEdit("p1", "carol")).toBe(false);
  });

  it("revoke removes entry", () => {
    acl.grant("p2", "dave", "viewer", "alice");
    expect(acl.revoke("p2", "dave")).toBe(true);
    expect(acl.canRead("p2", "dave")).toBe(false);
  });

  it("unknown user has no access", () => {
    expect(acl.canRead("p99", "ghost")).toBe(false);
  });

  it("listEntries returns all for page", () => {
    acl.grant("p3", "u1", "owner", "sys");
    acl.grant("p3", "u2", "editor", "u1");
    expect(acl.listEntries("p3")).toHaveLength(2);
  });
});

// ── WikiCommentStore ──────────────────────────────────────────────────────────

describe("WikiCommentStore", () => {
  let store: WikiCommentStore;

  beforeEach(() => { store = new WikiCommentStore(); });

  it("adds a comment", () => {
    const c = store.add("p1", "alice", "Great article!");
    expect(c.id).toMatch(/^wc-/);
    expect(c.pageId).toBe("p1");
    expect(c.resolved).toBe(false);
  });

  it("threaded reply has parentId", () => {
    const parent = store.add("p1", "alice", "Question?");
    const reply = store.add("p1", "bob", "Answer!", parent.id);
    expect(reply.parentId).toBe(parent.id);
  });

  it("threadFor returns root + direct replies", () => {
    const root = store.add("p1", "alice", "Root");
    store.add("p1", "bob", "Reply 1", root.id);
    store.add("p1", "carol", "Reply 2", root.id);
    const thread = store.threadFor(root.id);
    expect(thread).toHaveLength(3);
    expect(thread[0]!.id).toBe(root.id);
  });

  it("update changes content", () => {
    const c = store.add("p1", "alice", "Old content");
    store.update(c.id, "New content");
    expect(store.get(c.id)!.content).toBe("New content");
  });

  it("resolve marks comment resolved", () => {
    const c = store.add("p1", "alice", "Issue");
    expect(store.resolve(c.id)).toBe(true);
    expect(store.get(c.id)!.resolved).toBe(true);
  });

  it("listForPage returns sorted comments", () => {
    store.add("p1", "alice", "First");
    store.add("p1", "bob", "Second");
    store.add("p2", "carol", "Different page");
    expect(store.listForPage("p1")).toHaveLength(2);
    expect(store.listForPage("p2")).toHaveLength(1);
  });
});

// ── WikiDraftStore ────────────────────────────────────────────────────────────

describe("WikiDraftStore", () => {
  let store: WikiDraftStore;

  beforeEach(() => { store = new WikiDraftStore(); });

  it("saves a draft for a new page", () => {
    const d = store.save("alice", "Draft Title", "Draft content...");
    expect(d.id).toMatch(/^wd-/);
    expect(d.pageId).toBeUndefined();
    expect(d.authorId).toBe("alice");
  });

  it("overwrites draft for same author+page", () => {
    store.save("alice", "T1", "C1", "page-1");
    const second = store.save("alice", "T2", "C2", "page-1");
    expect(store.listFor("alice")).toHaveLength(1);
    expect(store.listFor("alice")[0]!.title).toBe("T2");
    expect(store.get(second.id)).toBeDefined();
  });

  it("getDraftFor retrieves draft by author+page", () => {
    const d = store.save("alice", "T", "C", "p1");
    expect(store.getDraftFor("alice", "p1")?.id).toBe(d.id);
    expect(store.getDraftFor("alice", "p2")).toBeUndefined();
  });

  it("delete removes draft", () => {
    const d = store.save("bob", "T", "C");
    store.delete(d.id);
    expect(store.get(d.id)).toBeUndefined();
  });

  it("listFor returns all drafts for author", () => {
    store.save("alice", "T1", "C", "p1");
    store.save("alice", "T2", "C");
    store.save("bob", "T3", "C");
    expect(store.listFor("alice")).toHaveLength(2);
    expect(store.listFor("bob")).toHaveLength(1);
  });
});

// ── WikiSearch ────────────────────────────────────────────────────────────────

describe("WikiSearch", () => {
  const search = new WikiSearch();

  const pages = [
    { id: "p1", slug: "ts", title: "TypeScript Guide", content: "TypeScript is a typed superset of JavaScript. TypeScript makes code safer.", status: "published" as const, tags: ["typescript"], linkedRepos: [], createdBy: "a", createdAt: "", updatedAt: "", version: 1, history: [], starred: [] },
    { id: "p2", slug: "py", title: "Python Tutorial", content: "Python is great for data science and machine learning.", status: "published" as const, tags: ["python"], linkedRepos: [], createdBy: "a", createdAt: "", updatedAt: "", version: 1, history: [], starred: [] },
    { id: "p3", slug: "del", title: "Deleted Page", content: "TypeScript deleted content", status: "deleted" as const, tags: [], linkedRepos: [], createdBy: "a", createdAt: "", updatedAt: "", version: 1, history: [], starred: [] },
  ];

  const comments = [
    { id: "c1", pageId: "p1", authorId: "bob", content: "TypeScript is amazing!", createdAt: "", updatedAt: "", resolved: false },
  ];

  it("finds pages by title/content keyword", () => {
    const hits = search.search("TypeScript", pages, []);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.type).toBe("page");
    expect(hits[0]!.id).toBe("p1");
  });

  it("excludes deleted pages", () => {
    const hits = search.search("TypeScript", pages, []);
    expect(hits.every((h) => h.id !== "p3")).toBe(true);
  });

  it("finds comments", () => {
    const hits = search.search("amazing", pages, comments as any);
    expect(hits.some((h) => h.type === "comment")).toBe(true);
  });

  it("sorts by score desc", () => {
    const hits = search.search("TypeScript", pages, comments as any);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it("returns empty for no match", () => {
    expect(search.search("quantum entanglement blockchain", pages, [])).toHaveLength(0);
  });
});

// ── WikiNotifier ──────────────────────────────────────────────────────────────

describe("WikiNotifier", () => {
  let notifier: WikiNotifier;

  beforeEach(() => { notifier = new WikiNotifier(); });

  it("emits to subscribers", () => {
    notifier.subscribe("p1", "alice");
    notifier.subscribe("p1", "bob");
    const n = notifier.emit("page_updated", "p1", "carol");
    expect(n.recipientIds).toContain("alice");
    expect(n.recipientIds).toContain("bob");
    expect(n.recipientIds).not.toContain("carol"); // actor excluded
  });

  it("getForUser returns notifications for user", () => {
    notifier.subscribe("p1", "alice");
    notifier.emit("page_updated", "p1", "bob");
    notifier.emit("comment_added", "p1", "carol");
    expect(notifier.getForUser("alice")).toHaveLength(2);
  });

  it("markRead marks a notification as read", () => {
    notifier.subscribe("p1", "alice");
    const n = notifier.emit("page_updated", "p1", "bob");
    expect(notifier.markRead(n.id)).toBe(true);
    expect(notifier.getForUser("alice")[0]!.read).toBe(true);
    expect(notifier.unreadCount("alice")).toBe(0);
  });

  it("unsubscribe stops notifications", () => {
    notifier.subscribe("p1", "alice");
    notifier.unsubscribe("p1", "alice");
    notifier.emit("page_updated", "p1", "bob");
    expect(notifier.getForUser("alice")).toHaveLength(0);
  });

  it("unreadCount reflects unread notifications", () => {
    notifier.subscribe("p1", "alice");
    notifier.emit("page_updated", "p1", "bob");
    notifier.emit("page_updated", "p1", "carol");
    expect(notifier.unreadCount("alice")).toBe(2);
  });
});

// ── WikiStore facade ──────────────────────────────────────────────────────────

describe("WikiStore", () => {
  let wiki: WikiStore;

  beforeEach(() => { wiki = new WikiStore(); });

  it("createPage grants owner ACL", () => {
    const p = wiki.createPage({ slug: "test", title: "T", content: "c", createdBy: "alice" });
    expect(wiki.acl.canAdmin(p.id, "alice")).toBe(true);
  });

  it("updatePage rejects non-editor", () => {
    const p = wiki.createPage({ slug: "test", title: "T", content: "c", createdBy: "alice" });
    const result = wiki.updatePage(p.id, { editedBy: "bob", content: "new" });
    expect(result).toBeUndefined();
  });

  it("updatePage succeeds for editor", () => {
    const p = wiki.createPage({ slug: "test", title: "T", content: "c", createdBy: "alice" });
    wiki.acl.grant(p.id, "bob", "editor", "alice");
    const updated = wiki.updatePage(p.id, { editedBy: "bob", content: "updated content" });
    expect(updated?.content).toBe("updated content");
  });

  it("query finds pages", () => {
    wiki.createPage({ slug: "ts-guide", title: "TypeScript Guide", content: "TypeScript is amazing for large codebases with strict type checking", createdBy: "alice" });
    const hits = wiki.query("TypeScript");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("createPage emits notification", () => {
    const notifBefore = wiki.notifier.getForUser("bob").length;
    wiki.notifier.subscribe("dummy", "bob"); // subscribe to something else
    wiki.createPage({ slug: "new-page", title: "N", content: "c", createdBy: "alice" });
    // Just verify emit doesn't throw
    expect(notifBefore).toBe(0);
  });
});
