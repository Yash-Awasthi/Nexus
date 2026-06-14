// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  NexusClient,
  NexusError,
  ChatSession,
  MockHttpTransport,
  validateWebhookSignature,
  SDK_VERSION,
  type ToolDefinition,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClient(transport?: MockHttpTransport) {
  const t = transport ?? new MockHttpTransport();
  return {
    client: new NexusClient({ apiKey: "test-key", baseUrl: "https://test.nexus.dev" }, t),
    transport: t,
  };
}

const MOCK_RESPONSE = {
  id: "msg-1",
  content: "Hello from Nexus!",
  model: "claude-3-5-sonnet-20241022",
  sessionId: "session-abc",
  usage: { inputTokens: 10, outputTokens: 20 },
};

// ── NexusClient ───────────────────────────────────────────────────────────────

describe("NexusClient config", () => {
  it("stores apiKey and baseUrl", () => {
    const { client } = makeClient();
    expect(client.apiKey).toBe("test-key");
    expect(client.baseUrl).toBe("https://test.nexus.dev");
  });

  it("defaults model to claude-3-5-sonnet", () => {
    const { client } = makeClient();
    expect(client.defaultModel).toContain("claude");
  });

  it("accepts custom defaultModel", () => {
    const t = new MockHttpTransport();
    const c = new NexusClient({ apiKey: "k", defaultModel: "gpt-4" }, t);
    expect(c.defaultModel).toBe("gpt-4");
  });
});

describe("NexusClient.sendMessage", () => {
  it("sends a POST request to /chat", async () => {
    const { client, transport } = makeClient();
    transport.onPost("/chat", () => MOCK_RESPONSE);
    await client.sendMessage("Hello");
    expect(transport.requests[0]!.method).toBe("POST");
    expect(transport.requests[0]!.url).toContain("/chat");
  });

  it("returns mapped response", async () => {
    const { client, transport } = makeClient();
    transport.onPost("/chat", () => MOCK_RESPONSE);
    const r = await client.sendMessage("Hello");
    expect(r.id).toBe("msg-1");
    expect(r.content).toBe("Hello from Nexus!");
    expect(r.usage.inputTokens).toBe(10);
  });

  it("returns durationMs", async () => {
    const { client, transport } = makeClient();
    transport.onPost("/chat", () => MOCK_RESPONSE);
    const r = await client.sendMessage("Hi");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes model option in request body", async () => {
    const { client, transport } = makeClient();
    transport.onPost("/chat", () => MOCK_RESPONSE);
    await client.sendMessage("Hi", { model: "gpt-4o" });
    const body = transport.requests[0]!.body as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-4o");
  });

  it("passes tools in request body", async () => {
    const { client, transport } = makeClient();
    transport.onPost("/chat", () => MOCK_RESPONSE);
    const tools: ToolDefinition[] = [
      { name: "search", description: "Search the web", parameters: { query: { type: "string" } } },
    ];
    await client.sendMessage("Find nexus", { tools });
    const body = transport.requests[0]!.body as Record<string, unknown>;
    expect(Array.isArray(body["tools"])).toBe(true);
  });
});

// ── ChatSession ───────────────────────────────────────────────────────────────

describe("ChatSession", () => {
  let client: NexusClient;
  let transport: MockHttpTransport;

  beforeEach(() => {
    transport = new MockHttpTransport();
    transport.onPost("/chat", () => MOCK_RESPONSE);
    client = new NexusClient({ apiKey: "k" }, transport);
  });

  it("createSession returns a ChatSession", () => {
    const s = client.createSession();
    expect(s).toBeInstanceOf(ChatSession);
    expect(s.sessionId).toBeTruthy();
  });

  it("send appends user and assistant messages", async () => {
    const s = client.createSession();
    await s.send("Hello");
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]!.role).toBe("user");
    expect(s.messages[1]!.role).toBe("assistant");
  });

  it("messageCount reflects sent messages", async () => {
    const s = client.createSession();
    await s.send("Q1");
    await s.send("Q2");
    expect(s.messageCount).toBe(4);
  });

  it("setSystemPrompt prepends system message", () => {
    const s = client.createSession();
    s.setSystemPrompt("You are helpful");
    expect(s.messages[0]!.role).toBe("system");
    expect(s.messages[0]!.content).toBe("You are helpful");
  });

  it("setSystemPrompt replaces existing system message", () => {
    const s = client.createSession();
    s.setSystemPrompt("First");
    s.setSystemPrompt("Second");
    const sys = s.messages.filter((m) => m.role === "system");
    expect(sys).toHaveLength(1);
    expect(sys[0]!.content).toBe("Second");
  });

  it("clear removes all messages", async () => {
    const s = client.createSession();
    await s.send("Hello");
    s.clear();
    expect(s.messageCount).toBe(0);
  });

  it("clear supports chaining", () => {
    const s = client.createSession();
    expect(s.clear()).toBe(s);
  });

  it("messages returns a copy (immutable)", async () => {
    const s = client.createSession();
    await s.send("Hi");
    const msgs = s.messages;
    msgs.push({ role: "user", content: "injected" });
    expect(s.messageCount).toBe(2); // unchanged
  });
});

// ── NexusError ────────────────────────────────────────────────────────────────

describe("NexusError", () => {
  it("has correct code and name", () => {
    const e = new NexusError("AUTH_ERROR", "Unauthorized", 401);
    expect(e.code).toBe("AUTH_ERROR");
    expect(e.name).toBe("NexusError");
    expect(e.statusCode).toBe(401);
    expect(e.message).toBe("Unauthorized");
  });

  it("is an instance of Error", () => {
    expect(new NexusError("TIMEOUT", "Timed out")).toBeInstanceOf(Error);
  });
});

// ── MockHttpTransport ─────────────────────────────────────────────────────────

describe("MockHttpTransport", () => {
  it("records POST requests", async () => {
    const t = new MockHttpTransport();
    await t.post("https://api.nexus.dev/v1/chat", { msg: "hi" }, {});
    expect(t.requests[0]!.method).toBe("POST");
    expect(t.requests[0]!.body).toEqual({ msg: "hi" });
  });

  it("records GET requests", async () => {
    const t = new MockHttpTransport();
    await t.get("https://api.nexus.dev/v1/sessions", {});
    expect(t.requests[0]!.method).toBe("GET");
  });

  it("returns registered handler response", async () => {
    const t = new MockHttpTransport();
    t.onPost("/chat", () => ({ id: "r1" }));
    const r = await t.post("https://api.nexus.dev/v1/chat", {}, {}) as { id: string };
    expect(r.id).toBe("r1");
  });
});

// ── validateWebhookSignature ──────────────────────────────────────────────────

describe("validateWebhookSignature", () => {
  it("validates correct signature", async () => {
    const secret = "webhook-secret";
    const body = JSON.stringify({ event: "message.created" });

    // Compute expected signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");

    const r = await validateWebhookSignature(body, `sha256=${hex}`, secret);
    expect(r.valid).toBe(true);
  });

  it("rejects invalid signature", async () => {
    const r = await validateWebhookSignature("body", "sha256=deadbeef", "secret");
    expect(r.valid).toBe(false);
  });

  it("rejects header without sha256= prefix", async () => {
    const r = await validateWebhookSignature("body", "invalid-header", "secret");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("sha256=");
  });
});

// ── SDK_VERSION ───────────────────────────────────────────────────────────────

describe("SDK_VERSION", () => {
  it("is a string in semver format", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
