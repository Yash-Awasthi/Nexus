// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryAnalyticsClient,
  PostHogAnalyticsClient,
  NexusAnalytics,
  NexusEvents,
} from "../src/index.js";

// ── InMemoryAnalyticsClient ───────────────────────────────────────────────────

describe("InMemoryAnalyticsClient", () => {
  let client: InMemoryAnalyticsClient;
  beforeEach(() => {
    client = new InMemoryAnalyticsClient();
  });

  it("tracks events", async () => {
    await client.track("page_view", "user-1", { url: "/home" });
    expect(client.events).toHaveLength(1);
    expect(client.events[0]!.event).toBe("page_view");
    expect(client.events[0]!.properties["url"]).toBe("/home");
  });

  it("stores distinct_id with event", async () => {
    await client.track("click", "alice");
    expect(client.events[0]!.distinctId).toBe("alice");
  });

  it("records identities", async () => {
    await client.identify("alice", { name: "Alice", plan: "pro" });
    expect(client.identities).toHaveLength(1);
    expect(client.identities[0]!.properties["name"]).toBe("Alice");
  });

  it("records page views", async () => {
    await client.page("alice", "https://nexus.dev/chat");
    expect(client.pages).toHaveLength(1);
    expect(client.pages[0]!.url).toBe("https://nexus.dev/chat");
  });

  it("flush is a no-op", async () => {
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("reset clears all data", async () => {
    await client.track("e", "u");
    await client.identify("u", {});
    await client.page("u", "/");
    client.reset();
    expect(client.events).toHaveLength(0);
    expect(client.identities).toHaveLength(0);
    expect(client.pages).toHaveLength(0);
  });

  it("getEventsByName filters correctly", async () => {
    await client.track("click", "u1");
    await client.track("view", "u1");
    await client.track("click", "u2");
    expect(client.getEventsByName("click")).toHaveLength(2);
    expect(client.getEventsByName("view")).toHaveLength(1);
  });

  it("getEventsForUser filters by user", async () => {
    await client.track("click", "alice");
    await client.track("click", "bob");
    expect(client.getEventsForUser("alice")).toHaveLength(1);
  });

  it("stores timestamp", async () => {
    await client.track("e", "u");
    expect(client.events[0]!.timestamp).toBeTruthy();
  });
});

// ── PostHogAnalyticsClient ────────────────────────────────────────────────────

describe("PostHogAnalyticsClient", () => {
  it("queues events", async () => {
    const client = new PostHogAnalyticsClient({ apiKey: "test-key" });
    await client.track("event", "user-1");
    expect(client.queueSize).toBe(1);
  });

  it("disabled client does not queue", async () => {
    const client = new PostHogAnalyticsClient({ apiKey: "key", disabled: true });
    await client.track("event", "u");
    expect(client.queueSize).toBe(0);
  });

  it("flush clears queue", async () => {
    const client = new PostHogAnalyticsClient({ apiKey: "key" });
    await client.track("e", "u");
    await client.flush();
    expect(client.queueSize).toBe(0);
  });

  it("auto-flushes when batchSize reached", async () => {
    const client = new PostHogAnalyticsClient({ apiKey: "key", batchSize: 2 });
    await client.track("e", "u");
    await client.track("e", "u");
    // After reaching batch size, queue is flushed
    expect(client.queueSize).toBe(0);
  });

  it("page call creates $pageview event", async () => {
    const client = new PostHogAnalyticsClient({ apiKey: "key" });
    await client.page("u", "https://nexus.dev");
    expect(client.queueSize).toBe(1);
  });

  it("disabled page does nothing", async () => {
    const client = new PostHogAnalyticsClient({ apiKey: "key", disabled: true });
    await client.page("u", "https://nexus.dev");
    expect(client.queueSize).toBe(0);
  });
});

// ── NexusAnalytics ────────────────────────────────────────────────────────────

describe("NexusAnalytics", () => {
  let mem: InMemoryAnalyticsClient;
  let nx: NexusAnalytics;

  beforeEach(() => {
    mem = new InMemoryAnalyticsClient();
    nx = new NexusAnalytics(mem);
  });

  it("tracks chatMessageSent", async () => {
    await nx.chatMessageSent("user-1", "claude-3", "session-abc");
    const events = mem.getEventsByName(NexusEvents.CHAT_MESSAGE_SENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.properties["model"]).toBe("claude-3");
    expect(events[0]!.properties["session_id"]).toBe("session-abc");
  });

  it("tracks chatMessageRated with rating", async () => {
    await nx.chatMessageRated("user-1", "msg-99", "up");
    const events = mem.getEventsByName(NexusEvents.CHAT_MESSAGE_RATED);
    expect(events[0]!.properties["rating"]).toBe("up");
  });

  it("tracks agentTaskStarted", async () => {
    await nx.agentTaskStarted("user-1", "task-1", "search");
    expect(mem.getEventsByName(NexusEvents.AGENT_TASK_STARTED)).toHaveLength(1);
  });

  it("tracks agentTaskCompleted with durationMs", async () => {
    await nx.agentTaskCompleted("user-1", "task-1", 1500);
    const e = mem.getEventsByName(NexusEvents.AGENT_TASK_COMPLETED)[0]!;
    expect(e.properties["duration_ms"]).toBe(1500);
  });

  it("identify delegates to client", async () => {
    await nx.identify("user-1", { plan: "pro" });
    expect(mem.identities[0]!.properties["plan"]).toBe("pro");
  });

  it("page delegates to client", async () => {
    await nx.page("user-1", "/chat");
    expect(mem.pages[0]!.url).toBe("/chat");
  });
});

// ── NexusEvents catalogue ─────────────────────────────────────────────────────

describe("NexusEvents", () => {
  it("has expected event names", () => {
    expect(NexusEvents.CHAT_MESSAGE_SENT).toBe("chat_message_sent");
    expect(NexusEvents.AGENT_TASK_STARTED).toBe("agent_task_started");
    expect(NexusEvents.MEMORY_STORED).toBe("memory_stored");
  });
});
