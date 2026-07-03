// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NexusClient, NexusError } from "../src/index.js";

describe("NexusClient config", () => {
  it("stores configuration options correctly", () => {
    const client = new NexusClient({
      apiKey: "test-api-key",
      baseUrl: "https://custom.nexus.dev",
      version: "v2",
      timeout: 10000,
    });
    expect((client as any).apiKey).toBe("test-api-key");
    expect((client as any).baseUrl).toBe("https://custom.nexus.dev");
    expect((client as any).version).toBe("v2");
    expect((client as any).timeout).toBe(10000);
  });

  it("throws error if apiKey is missing", () => {
    expect(() => new NexusClient({ apiKey: "" })).toThrow("Nexus apiKey is required");
  });
});

describe("NexusClient HTTP request logic", () => {
  let client: NexusClient;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    client = new NexusClient({ apiKey: "key", baseUrl: "https://api.nexus.dev" });
  });

  it("sends standard Authorization headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ok" }),
    });

    await client.gateway.listModels();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.nexus.dev/api/v1/gateway/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer key",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("throws NexusError on HTTP failure", async () => {
    const errorResponse = {
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized access" }),
    };
    // Mock for both assertions — each rejects.toThrow() triggers one fetch call
    mockFetch.mockResolvedValueOnce(errorResponse).mockResolvedValueOnce(errorResponse);

    await expect(client.gateway.listModels()).rejects.toThrow(NexusError);
    await expect(client.gateway.listModels()).rejects.toThrow("Request failed with status 401");
  });
});

describe("Gateway namespace", () => {
  let client: NexusClient;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    client = new NexusClient({ apiKey: "key" });
  });

  it("sendMessage posts to /gateway/messages", async () => {
    const mockResponse = { id: "msg-1", content: [{ type: "text", text: "hi" }] };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const res = await client.gateway.sendMessage({
      model: "nexus/fast",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.nexus.dev/api/v1/gateway/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "nexus/fast",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      }),
    );
    expect(res).toEqual(mockResponse);
  });

  it("sendMessageStream streams chunks correctly", async () => {
    // Mock the readable stream response
    const mockChunks = [
      'data: {"type": "message_start", "message": {"id": "nexus-1"}}\n\n',
      'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}\n\n',
      'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hello"}}\n\n',
      "data: [DONE]\n\n",
    ];

    let chunkIdx = 0;
    const mockReader = {
      read: async () => {
        if (chunkIdx >= mockChunks.length) {
          return { done: true, value: undefined };
        }
        const text = mockChunks[chunkIdx++];
        return { done: false, value: new TextEncoder().encode(text) };
      },
      releaseLock: () => {},
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => mockReader,
      },
    });

    const stream = client.gateway.sendMessageStream({
      model: "nexus/fast",
      messages: [{ role: "user", content: "hello" }],
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "message_start", message: { id: "nexus-1" } });
    expect(events[2]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    });
  });
});

describe("Council namespace", () => {
  let client: NexusClient;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    client = new NexusClient({ apiKey: "key" });
  });

  it("deliberate posts to /council/deliberate", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { outcome: "approved" } }),
    });

    const res = await client.council.deliberate(
      { title: "Test Proposal", description: "Desc" },
      { timeoutMs: 5000 },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.nexus.dev/api/v1/council/deliberate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          proposal: { title: "Test Proposal", description: "Desc" },
          timeoutMs: 5000,
        }),
      }),
    );
    expect(res.ok).toBe(true);
  });
});

describe("Memory namespace", () => {
  let client: NexusClient;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    client = new NexusClient({ apiKey: "key" });
  });

  it("remember posts text and metadata to /memory", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "mem-123", text: "fact" }),
    });

    const res = await client.memory.remember("fact", { userId: "user-1" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.nexus.dev/api/v1/memory",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          text: "fact",
          userId: "user-1",
        }),
      }),
    );
    expect(res.id).toBe("mem-123");
  });

  it("recall gets nearest items from /memory", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], total: 0 }),
    });

    await client.memory.recall("search query", { limit: 5 });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.nexus.dev/api/v1/memory?query=search+query&limit=5",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });
});
