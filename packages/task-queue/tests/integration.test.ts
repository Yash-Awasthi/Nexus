// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-package pipeline integration tests.
 *
 * wiki-updater → task-queue → wiki → search-orchestrator
 * obs-providers end-to-end
 * knowledge-graph in-memory end-to-end
 */

import { describe, it, expect, beforeEach } from "vitest";

import { InMemoryStreamClient, TaskQueue, SyncTaskRunner } from "../src/index.js";

import { WikiUpdatePipeline, WikiStore as UpdaterWikiStore } from "@nexus/wiki-updater";

import { WikiStore, WikiSearch } from "@nexus/wiki";

import {
  SearchOrchestrator,
  MockSearchStrategy,
  StrategyChain,
  TimelineBuilder,
  type SearchResult,
} from "@nexus/search-orchestrator";

interface WikiUpdatePayload {
  documentId: string;
  content: string;
  source: string;
}
interface SearchIndexPayload {
  articleId: string;
  title: string;
  content: string;
  tags: string[];
}

// ── 1. wiki-updater → task-queue ──────────────────────────────────────────────

describe("wiki-updater → task-queue pipeline", () => {
  let streamClient: InMemoryStreamClient;
  let taskQueue: TaskQueue;
  let updaterStore: UpdaterWikiStore;
  let pipeline: WikiUpdatePipeline;
  const processedArticles: string[] = [];

  beforeEach(() => {
    streamClient = new InMemoryStreamClient();
    taskQueue = new TaskQueue("wiki-updates", streamClient);
    updaterStore = new UpdaterWikiStore();
    pipeline = new WikiUpdatePipeline({ store: updaterStore, autoCreate: true });
    processedArticles.length = 0;

    taskQueue.task<WikiUpdatePayload>("wiki:update", async (task) => {
      const result = await pipeline.run({
        document: {
          id: task.payload.documentId,
          content: task.payload.content,
          source: task.payload.source,
        },
      });
      if (result.articleId) processedArticles.push(result.articleId);
      return result;
    });
  });

  it("enqueues and processes 3 wiki update tasks", async () => {
    taskQueue.enqueue<WikiUpdatePayload>("wiki:update", {
      documentId: "d1",
      content: "TypeScript is a strongly-typed superset of JavaScript.",
      source: "ts.md",
    });
    taskQueue.enqueue<WikiUpdatePayload>("wiki:update", {
      documentId: "d2",
      content: "Nexus is a multi-agent AI platform built with TypeScript.",
      source: "nexus.md",
    });
    taskQueue.enqueue<WikiUpdatePayload>("wiki:update", {
      documentId: "d3",
      content: "Vitest is a Vite-native testing framework.",
      source: "vitest.md",
    });

    expect(taskQueue.tasksByStatus("pending").length).toBe(3);

    const { processed, failed } = await new SyncTaskRunner(taskQueue).drainAll();
    expect(processed).toBe(3);
    expect(failed).toBe(0);
    expect(processedArticles.length).toBe(3);
    expect(updaterStore.size()).toBeGreaterThanOrEqual(2);
    expect(
      updaterStore
        .all()
        .map((a) => a.content)
        .join(" "),
    ).toContain("TypeScript");
  });

  it("delays tasks with delayMs option and does not process them immediately", () => {
    taskQueue.enqueue<WikiUpdatePayload>(
      "wiki:update",
      {
        documentId: "d-delayed",
        content: "Delayed doc",
        source: "d.md",
      },
      { delayMs: 60_000 },
    );

    expect(taskQueue.tasksByStatus("delayed").length).toBe(1);
    expect(streamClient.xread("wiki-updates", 10).length).toBe(0);
  });

  it("retries a flaky handler before permanently failing", async () => {
    let callCount = 0;
    taskQueue.task<WikiUpdatePayload>("wiki:flaky", async () => {
      if (++callCount < 2) throw new Error("transient");
      return { ok: true };
    });

    taskQueue.enqueue<WikiUpdatePayload>(
      "wiki:flaky",
      { documentId: "flaky", content: "x", source: "x" },
      { maxRetries: 3 },
    );
    const runner = new SyncTaskRunner(taskQueue);

    // First drain: fails once → delayed
    await runner.drainAll(1);
    const delayed = taskQueue.tasksByStatus("delayed");
    for (const t of delayed) {
      (t as { runAt: number }).runAt = Date.now() - 1;
      streamClient.updateStatus("wiki-updates", t.id, "pending");
    }
    // Second drain: succeeds
    const { processed } = await runner.drainAll(2);
    expect(processed).toBeGreaterThanOrEqual(1);
  });
});

// ── 2. wiki → search-orchestrator ────────────────────────────────────────────

describe("wiki → search-orchestrator pipeline", () => {
  it("creates wiki pages and performs full-text search", () => {
    const wikiStore = new WikiStore();
    const page2 = wikiStore.createPage({
      slug: "nexus-overview",
      title: "Nexus Platform Overview",
      content: "Nexus is a multi-agent AI platform with 16 model aliases and 13 drivers.",
      createdBy: "yash",
      tags: ["nexus", "ai"],
    });
    wikiStore.createPage({
      slug: "typescript-guide",
      title: "TypeScript Guide",
      content: "TypeScript adds static typing to JavaScript. Use interfaces and generics.",
      createdBy: "yash",
      tags: ["typescript"],
    });

    const search = new WikiSearch();
    const tsHits = search.search("typescript", wikiStore.pages.list(), []);
    expect(tsHits.length).toBe(1);
    expect(tsHits[0]?.title).toBe("TypeScript Guide");

    const maHits = search.search("multi-agent", wikiStore.pages.list(), []);
    expect(maHits.length).toBe(1);
    expect(maHits[0]?.id).toBe(page2.id);
  });

  it("tracks page versions with diffs", () => {
    const wikiStore = new WikiStore();
    const page = wikiStore.createPage({
      slug: "v-page",
      title: "V Page",
      content: "v1 content.",
      createdBy: "yash",
      tags: [],
    });
    expect(page.version).toBe(1);

    wikiStore.acl.grant(page.id, "editor", "editor", "yash");
    const updated = wikiStore.updatePage(page.id, {
      content: "v2 content — expanded.",
      editedBy: "editor",
      summary: "Expanded",
    });

    expect(updated!.version).toBe(2);
    expect(updated!.history[1]!.diff).toContain("+");
  });

  it("notifies subscribers on page update", () => {
    const wikiStore = new WikiStore();
    const page = wikiStore.createPage({
      slug: "notif-page",
      title: "Notif",
      content: "Initial.",
      createdBy: "alice",
      tags: [],
    });
    wikiStore.notifier.subscribe(page.id, "bob");
    wikiStore.acl.grant(page.id, "alice", "editor", "alice");
    wikiStore.updatePage(page.id, { content: "Updated.", editedBy: "alice" });

    const notifs = wikiStore.notifier.getForUser("bob");
    expect(notifs.length).toBeGreaterThan(0);
    expect(notifs[0]!.event).toBe("page_updated");
  });
});

// ── 3. Full 4-package pipeline ─────────────────────────────────────────────────

describe("full pipeline: wiki-updater → task-queue → wiki → search", () => {
  it("processes 3 docs: wiki:update → search:index → full-text hits", async () => {
    const streamClient = new InMemoryStreamClient();
    const queue = new TaskQueue("full-pipeline", streamClient);
    const updaterStore = new UpdaterWikiStore();
    const wikiStore = new WikiStore();
    const pipeline = new WikiUpdatePipeline({ store: updaterStore, autoCreate: true });
    const search = new WikiSearch();
    const indexed: SearchResult[] = [];

    queue.task<WikiUpdatePayload>("wiki:update", async (task) => {
      const result = await pipeline.run({
        document: {
          id: task.payload.documentId,
          content: task.payload.content,
          source: task.payload.source,
        },
      });
      if (result.articleId) {
        const article = updaterStore.get(result.articleId);
        if (article)
          queue.enqueue<SearchIndexPayload>("search:index", {
            articleId: result.articleId,
            title: article.title,
            content: article.content,
            tags: article.tags,
          });
      }
      return result;
    });

    queue.task<SearchIndexPayload>("search:index", async (task) => {
      try {
        wikiStore.createPage({
          slug: `art-${task.payload.articleId}`,
          title: task.payload.title,
          content: task.payload.content,
          createdBy: "bot",
          tags: task.payload.tags,
        });
      } catch {
        /* slug collision */
      }
      indexed.push({
        id: task.payload.articleId,
        content: task.payload.content,
        source: "mock",
        type: "document",
        score: 0.95,
        timestamp: new Date().toISOString(),
      });
      return { ok: true };
    });

    const DOCS = [
      {
        id: "d1",
        content: "Vitest provides a Vite-native test runner with HMR support.",
        source: "vitest",
      },
      {
        id: "d2",
        content: "The Nexus knowledge graph uses sha256 deterministic node IDs.",
        source: "kg",
      },
      {
        id: "d3",
        content: "Redis Streams provide at-most-once delivery semantics.",
        source: "redis",
      },
    ];
    for (const d of DOCS)
      queue.enqueue<WikiUpdatePayload>("wiki:update", {
        documentId: d.id,
        content: d.content,
        source: d.source,
      });

    const { processed, failed } = await new SyncTaskRunner(queue).drainAll(5);
    expect(processed).toBe(6); // 3 wiki:update + 3 search:index
    expect(failed).toBe(0);
    expect(updaterStore.size()).toBeGreaterThanOrEqual(2);
    expect(wikiStore.pages.count()).toBeGreaterThanOrEqual(2);
    expect(indexed.length).toBe(3);

    const kgHits = search.search("knowledge graph", wikiStore.pages.list(), []);
    expect(kgHits.length).toBe(1);
    expect(kgHits[0]?.snippet).toContain("sha256");
  });
});

// ── 4. search-orchestrator strategy chain ────────────────────────────────────

describe("search-orchestrator strategy chain", () => {
  it("falls back to next strategy when first is empty", async () => {
    const empty = new MockSearchStrategy("mock", { empty: true });
    const fallback = new MockSearchStrategy("mock", {
      results: [
        {
          id: "r1",
          content: "fallback result",
          source: "mock" as const,
          type: "document" as const,
          score: 0.8,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    const chain = new StrategyChain({ strategies: [empty, fallback] });
    const resp = await new SearchOrchestrator({ chain }).search({ query: "q" });
    expect(resp.results.length).toBe(1);
    expect(resp.results[0]!.content).toContain("fallback");
  });

  it("builds timeline segments from multi-day results", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    const strategy = new MockSearchStrategy("mock", {
      results: [
        {
          id: "r1",
          content: "today",
          source: "mock" as const,
          type: "document" as const,
          score: 0.9,
          timestamp: now.toISOString(),
        },
        {
          id: "r2",
          content: "yesterday",
          source: "mock" as const,
          type: "document" as const,
          score: 0.7,
          timestamp: yesterday.toISOString(),
        },
      ],
    });
    const orchestrator = new SearchOrchestrator({
      chain: new StrategyChain({ strategies: [strategy] }),
      timelineBuilder: new TimelineBuilder(),
    });
    const timeline = await orchestrator.searchTimeline({ query: "t" });
    expect(timeline.segments.length).toBe(2);
    expect(timeline.totalResults).toBe(2);
  });

  it("filters results by minScore", async () => {
    const strategy = new MockSearchStrategy("mock", {
      results: [
        {
          id: "hi",
          content: "high",
          source: "mock" as const,
          type: "document" as const,
          score: 0.9,
          timestamp: new Date().toISOString(),
        },
        {
          id: "lo",
          content: "low",
          source: "mock" as const,
          type: "document" as const,
          score: 0.2,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    const resp = await new SearchOrchestrator({
      chain: new StrategyChain({ strategies: [strategy] }),
    }).search({ query: "q", filters: { minScore: 0.5 } });
    expect(resp.results.every((r) => r.score >= 0.5)).toBe(true);
    expect(resp.results.find((r) => r.id === "lo")).toBeUndefined();
  });
});

// ── 5. obs-providers end-to-end ───────────────────────────────────────────────

describe("obs-providers in-memory end-to-end", () => {
  it("generates observations and handles provider fallback", async () => {
    const { MockObservationProvider, ProviderRegistry } = await import("@nexus/obs-providers");
    const registry = new ProviderRegistry();
    registry.register(
      new MockObservationProvider("primary", "mock-v1", {
        observation: "User prefers brief answers.",
      }),
    );

    const result = await registry.generateWithFallback({
      sessionId: "s1",
      events: [{ type: "user_message", content: "Keep it short.", timestamp: Date.now() }],
    });

    expect(result.observation).toBe("User prefers brief answers.");
    expect(result.provider).toBe("primary");
    expect(result.errorClass).toBeUndefined();
  });

  it("falls back to secondary provider on primary error", async () => {
    const { MockObservationProvider, ProviderRegistry } = await import("@nexus/obs-providers");
    const registry = new ProviderRegistry();
    registry.register(new MockObservationProvider("primary", "v1", { throws: "RATE_LIMIT" }));
    registry.register(
      new MockObservationProvider("fallback", "v2", { observation: "Fallback obs." }),
    );

    const result = await registry.generateWithFallback({
      sessionId: "s2",
      events: [{ type: "user_message", content: "Test", timestamp: Date.now() }],
    });

    expect(result.observation).toBe("Fallback obs.");
    expect(result.provider).toBe("fallback");
  });
});

// ── 6. knowledge-graph in-memory end-to-end ───────────────────────────────────

describe("knowledge-graph in-memory end-to-end", () => {
  it("builds graph, traverses edges, and merges duplicate nodes", async () => {
    const { InMemoryKGStore, KnowledgeGraph, makeNodeId, makeEdgeId } =
      await import("@nexus/knowledge-graph");

    const store = new InMemoryKGStore();
    const kg = new KnowledgeGraph(store);
    const now = Math.floor(Date.now() / 1000);

    const aliceId = makeNodeId("Alice", "PERSON");
    const bobId = makeNodeId("Bob", "PERSON");
    const acmeId = makeNodeId("Acme Corp", "ORG");

    await store.upsertNode({
      id: aliceId,
      name: "Alice",
      type: "PERSON",
      confidence: 1.0,
      properties: {},
      sources: ["test"],
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertNode({
      id: bobId,
      name: "Bob",
      type: "PERSON",
      confidence: 1.0,
      properties: {},
      sources: ["test"],
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertNode({
      id: acmeId,
      name: "Acme Corp",
      type: "ORG",
      confidence: 1.0,
      properties: {},
      sources: ["test"],
      createdAt: now,
      updatedAt: now,
    });

    const e1 = makeEdgeId(aliceId, "works_at", acmeId);
    const e2 = makeEdgeId(bobId, "works_at", acmeId);
    const e3 = makeEdgeId(aliceId, "mentors", bobId);

    await store.upsertEdge({
      id: e1,
      subjectId: aliceId,
      predicate: "works_at",
      objectId: acmeId,
      confidence: 0.95,
      sources: ["test"],
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertEdge({
      id: e2,
      subjectId: bobId,
      predicate: "works_at",
      objectId: acmeId,
      confidence: 0.9,
      sources: ["test"],
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertEdge({
      id: e3,
      subjectId: aliceId,
      predicate: "mentors",
      objectId: bobId,
      confidence: 0.8,
      sources: ["test"],
      createdAt: now,
      updatedAt: now,
    });

    const stats = await kg.stats();
    expect(stats.nodes).toBe(3);
    expect(stats.edges).toBe(3);
    expect(stats.nodesByType["PERSON"]).toBe(2);
    expect(stats.nodesByType["ORG"]).toBe(1);

    // Type filter
    const persons = await kg.queryNodes({ type: "PERSON" });
    expect(persons.length).toBe(2);

    // Name substring search
    const search = await kg.queryNodes({ nameContains: "ali" });
    expect(search.length).toBe(1);
    expect(search[0]!.name).toBe("Alice");

    // Outbound traversal from Alice → [Acme Corp, Bob]
    const { node, neighbors } = await kg.findRelated(aliceId, { direction: "outbound" });
    expect(node!.name).toBe("Alice");
    expect(neighbors.map((n) => n.node.name).sort()).toEqual(["Acme Corp", "Bob"]);

    // Inbound to Acme Corp ← [Alice, Bob]
    const acmeRel = await kg.findRelated(acmeId, { direction: "inbound" });
    expect(acmeRel.neighbors.length).toBe(2);

    // Upsert merge — confidence takes max, sources union
    await store.upsertEdge({
      id: e1,
      subjectId: aliceId,
      predicate: "works_at",
      objectId: acmeId,
      confidence: 0.99,
      sources: ["enriched"],
      createdAt: now,
      updatedAt: now,
    });
    const merged = await store.getEdge(e1);
    expect(merged!.confidence).toBe(0.99);
    expect(merged!.sources).toContain("test");
    expect(merged!.sources).toContain("enriched");
  });
});
