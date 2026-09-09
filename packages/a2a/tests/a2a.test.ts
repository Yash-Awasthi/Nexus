// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  A2AClient,
  A2AClientError,
  A2ADelegationCoordinator,
  delegateWithRetry,
  delegateFanOut,
  parseSseStream,
  type A2AAgentCard,
  type A2AStreamEvent,
  type A2ATask,
  type A2AMessage,
  type DelegationTarget,
} from "../src/index.js";

const RPC_URL = "https://agent.example.com/a2a";

// A JSON-RPC success Response carrying `result`.
function rpcResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// A JSON-RPC error Response.
function rpcError(code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code, message } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// An SSE Response whose frames each wrap a JSON-RPC result.
function sseResponse(events: unknown[]): Response {
  const body = events
    .map((ev) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: "1", result: ev })}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const CARD: A2AAgentCard = {
  name: "Weather Agent",
  description: "Answers weather questions",
  url: RPC_URL,
  version: "1.0.0",
  protocolVersion: "0.3.0",
  capabilities: { streaming: true },
  skills: [{ id: "forecast", name: "Forecast" }],
};

const DONE_TASK: A2ATask = {
  kind: "task",
  id: "task-1",
  contextId: "ctx-1",
  status: { state: "completed" },
  artifacts: [{ artifactId: "a1", parts: [{ kind: "text", text: "sunny" }] }],
};

// ── textMessage ───────────────────────────────────────────────────────────────

describe("A2AClient.textMessage", () => {
  it("builds a user text message with a messageId", () => {
    const msg = A2AClient.textMessage("hello");
    expect(msg.role).toBe("user");
    expect(msg.parts[0]).toEqual({ kind: "text", text: "hello" });
    expect(msg.messageId).toBeTruthy();
  });

  it("threads taskId / contextId when provided", () => {
    const msg = A2AClient.textMessage("hi", { taskId: "t9", contextId: "c9" });
    expect(msg.taskId).toBe("t9");
    expect(msg.contextId).toBe("c9");
  });
});

// ── getAgentCard ──────────────────────────────────────────────────────────────

describe("A2AClient.getAgentCard", () => {
  it("GETs the well-known path resolved against the RPC origin", async () => {
    let capturedUrl = "";
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(CARD), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    const card = await client.getAgentCard();
    expect(capturedUrl).toBe("https://agent.example.com/.well-known/agent-card.json");
    expect(card.name).toBe("Weather Agent");
  });

  it("caches the card — a second call does not refetch", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(CARD), { status: 200 }),
      ) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await client.getAgentCard();
    await client.getAgentCard();
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    expect(client.agentCard?.name).toBe("Weather Agent");
  });

  it("throws A2AClientError on non-ok response", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await expect(client.getAgentCard()).rejects.toMatchObject({ code: "HTTP_ERROR" });
  });
});

// ── No impersonation ──────────────────────────────────────────────────────────

describe("A2AClient authentication (no impersonation)", () => {
  async function captureHeaders(opts: {
    apiKey?: string;
    extraHeaders?: Record<string, string>;
  }): Promise<Record<string, string>> {
    let headers: Record<string, string> = {};
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return rpcResult(DONE_TASK);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn, ...opts });
    await client.getTask("task-1");
    return headers;
  }

  it("authenticates with the client's own bearer token", async () => {
    const headers = await captureHeaders({ apiKey: "good" });
    expect(headers["Authorization"]).toBe("Bearer good");
  });

  it("drops a caller-supplied Authorization header", async () => {
    const headers = await captureHeaders({
      apiKey: "good",
      extraHeaders: { Authorization: "Bearer forged" },
    });
    expect(headers["Authorization"]).toBe("Bearer good");
  });

  it("sets no Authorization at all when a caller tries to inject one without an apiKey", async () => {
    const headers = await captureHeaders({ extraHeaders: { authorization: "Bearer forged" } });
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
  });
});

// ── sendMessage / getTask / cancelTask ────────────────────────────────────────

describe("A2AClient unary calls", () => {
  it("sendMessage returns the task result", async () => {
    const fetchFn = vi.fn().mockResolvedValue(rpcResult(DONE_TASK)) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    const result = (await client.sendMessage({
      message: A2AClient.textMessage("weather?"),
    })) as A2ATask;
    expect(result.id).toBe("task-1");
    expect(result.status.state).toBe("completed");
  });

  it("sendMessage posts method message/send with the message param", async () => {
    let body: { method: string; params: { message: { parts: unknown[] } } } | undefined;
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return rpcResult(DONE_TASK);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await client.sendMessage({ message: A2AClient.textMessage("weather?") });
    expect(body?.method).toBe("message/send");
    expect(body?.params.message.parts).toHaveLength(1);
  });

  it("getTask passes id and historyLength", async () => {
    let body: { method: string; params: Record<string, unknown> } | undefined;
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return rpcResult(DONE_TASK);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await client.getTask("task-1", 5);
    expect(body?.method).toBe("tasks/get");
    expect(body?.params["id"]).toBe("task-1");
    expect(body?.params["historyLength"]).toBe(5);
  });

  it("cancelTask posts tasks/cancel", async () => {
    let body: { method: string } | undefined;
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return rpcResult({ ...DONE_TASK, status: { state: "canceled" } });
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    const t = await client.cancelTask("task-1");
    expect(body?.method).toBe("tasks/cancel");
    expect(t.status.state).toBe("canceled");
  });

  it("throws A2AClientError on a JSON-RPC error", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(rpcError(-32001, "Task not found")) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await expect(client.getTask("missing")).rejects.toMatchObject({ code: "RPC_ERROR" });
  });

  it("throws A2AClientError on a non-ok HTTP response", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await expect(client.getTask("x")).rejects.toMatchObject({ code: "HTTP_ERROR" });
  });
});

// ── SSE streaming ─────────────────────────────────────────────────────────────

describe("A2AClient.sendMessageStream", () => {
  it("yields each SSE event as a parsed result until the final status update", async () => {
    const events: A2AStreamEvent[] = [
      { kind: "status-update", taskId: "task-1", status: { state: "working" }, final: false },
      {
        kind: "artifact-update",
        taskId: "task-1",
        artifact: { artifactId: "a1", parts: [{ kind: "text", text: "sunny" }] },
      },
      { kind: "status-update", taskId: "task-1", status: { state: "completed" }, final: true },
    ];
    const fetchFn = vi.fn().mockResolvedValue(sseResponse(events)) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });

    const seen: A2AStreamEvent[] = [];
    for await (const ev of client.sendMessageStream({
      message: A2AClient.textMessage("weather?"),
    })) {
      seen.push(ev);
    }
    expect(seen).toHaveLength(3);
    expect(seen[0]?.kind).toBe("status-update");
    const last = seen[2] as { final: boolean };
    expect(last.final).toBe(true);
  });

  it("requests text/event-stream via method message/stream", async () => {
    let accept = "";
    let method = "";
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      accept = (init.headers as Record<string, string>)["Accept"] ?? "";
      method = (JSON.parse(init.body as string) as { method: string }).method;
      return sseResponse([
        { kind: "status-update", taskId: "t", status: { state: "completed" }, final: true },
      ]);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    // Drain the generator.
    for await (const _ of client.sendMessageStream({ message: A2AClient.textMessage("x") })) {
      void _;
    }
    expect(accept).toBe("text/event-stream");
    expect(method).toBe("message/stream");
  });

  it("throws STREAMING_UNSUPPORTED when the card disables streaming", async () => {
    const noStream: A2AAgentCard = { ...CARD, capabilities: { streaming: false } };
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(".well-known"))
        return new Response(JSON.stringify(noStream), { status: 200 });
      return sseResponse([]);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await client.getAgentCard();
    const iter = client.sendMessageStream({ message: A2AClient.textMessage("x") });
    await expect(iter.next()).rejects.toMatchObject({ code: "STREAMING_UNSUPPORTED" });
  });

  it("surfaces a JSON-RPC error embedded in an SSE frame", async () => {
    const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "boom" } })}\n\n`;
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 })) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    const iter = client.sendMessageStream({ message: A2AClient.textMessage("x") });
    await expect(iter.next()).rejects.toMatchObject({ code: "RPC_ERROR" });
  });
});

// ── delegate() blocking semantics (§16.3) ────────────────────────────────────

describe("A2AClient.delegate (blocking)", () => {
  it("requests configuration.blocking:true on message/send", async () => {
    let body: { params: { configuration?: { blocking?: boolean } } } | undefined;
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return rpcResult(DONE_TASK);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await client.delegate(A2AClient.textMessage("weather?"));
    expect(body?.params.configuration?.blocking).toBe(true);
  });

  it("polls tasks/get when the peer answers with a working task, until terminal", async () => {
    const WORKING: A2ATask = { kind: "task", id: "task-9", status: { state: "working" } };
    const methods: string[] = [];
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { method: string; params: { id?: string } };
      methods.push(body.method);
      if (body.method === "message/send") return rpcResult(WORKING);
      if (body.method === "tasks/get" && body.params.id === "task-9") {
        return rpcResult({ ...DONE_TASK, id: "task-9" });
      }
      return rpcResult(DONE_TASK);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    const result = (await client.delegate(A2AClient.textMessage("weather?"), {
      pollIntervalMs: 1,
      maxPolls: 5,
    })) as A2ATask;
    expect(result.id).toBe("task-9");
    expect(result.status.state).toBe("completed");
    expect(methods).toContain("tasks/get");
  });

  it("returns a direct message reply without polling", async () => {
    const reply: A2AMessage = {
      kind: "message",
      role: "agent",
      parts: [{ kind: "text", text: "hi" }],
      messageId: "m1",
    };
    const methods: string[] = [];
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { method: string };
      methods.push(body.method);
      return rpcResult(reply);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    const result = await client.delegate(A2AClient.textMessage("hi"), { maxPolls: 3 });
    expect(result.kind).toBe("message");
    expect(methods).toEqual(["message/send"]); // never polled
  });

  it("returns a completed task immediately without polling", async () => {
    const methods: string[] = [];
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { method: string };
      methods.push(body.method);
      return rpcResult(DONE_TASK);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn });
    await client.delegate(A2AClient.textMessage("x"), { maxPolls: 3 });
    expect(methods).toEqual(["message/send"]);
  });
});

// ── Delegation orchestration (§15.2) ─────────────────────────────────────────

describe("delegateWithRetry", () => {
  function clientReturning(result: A2ATask | A2AMessage): A2AClient {
    return new A2AClient({
      rpcUrl: RPC_URL,
      fetchFn: vi.fn().mockResolvedValue(rpcResult(result)) as unknown as typeof fetch,
    });
  }

  function clientFailing(times: number): A2AClient {
    const fetchFn = vi.fn();
    for (let i = 0; i < times; i++) {
      fetchFn.mockRejectedValueOnce(new A2AClientError("boom", "HTTP_ERROR", { status: 500 }));
    }
    return new A2AClient({ rpcUrl: RPC_URL, fetchFn: fetchFn as unknown as typeof fetch });
  }

  it("returns the completed task on success", async () => {
    const out = await delegateWithRetry({
      label: "weather",
      client: clientReturning(DONE_TASK),
      message: A2AClient.textMessage("weather?"),
    });
    expect(out.ok).toBe(true);
    expect(out.task?.id).toBe("task-1");
    expect(out.label).toBe("weather");
  });

  it("returns a direct message reply as ok", async () => {
    const reply: A2AMessage = {
      kind: "message",
      role: "agent",
      parts: [{ kind: "text", text: "hi" }],
      messageId: "m1",
    };
    const out = await delegateWithRetry({
      client: clientReturning(reply),
      message: A2AClient.textMessage("hi"),
    });
    expect(out.ok).toBe(true);
    expect(out.reply?.messageId).toBe("m1");
  });

  it("retries transport failures with backoff then succeeds", async () => {
    const sleeps: number[] = [];
    const fetchFn = vi.fn();
    fetchFn.mockRejectedValueOnce(new A2AClientError("boom", "HTTP_ERROR", { status: 500 }));
    fetchFn.mockResolvedValueOnce(rpcResult(DONE_TASK));
    const client = new A2AClient({ rpcUrl: RPC_URL, fetchFn: fetchFn as unknown as typeof fetch });

    const out = await delegateWithRetry(
      { client, message: A2AClient.textMessage("x") },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        backoffMultiplier: 2,
        sleepFn: async (ms) => sleeps.push(ms),
      },
    );
    expect(out.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([10]); // 10ms base, first retry only
  });

  it("exhausts attempts and returns the last error", async () => {
    const sleeps: number[] = [];
    const out = await delegateWithRetry(
      { client: clientFailing(3), message: A2AClient.textMessage("x") },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        backoffMultiplier: 2,
        sleepFn: async (ms) => sleeps.push(ms),
      },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toBeInstanceOf(A2AClientError);
    expect(sleeps).toEqual([10, 20]); // 10ms then 20ms backoff
  });

  it("does NOT retry a peer-failed task (peer decision, not transport)", async () => {
    const failedTask: A2ATask = { ...DONE_TASK, status: { state: "failed" } };
    const client = clientReturning(failedTask);
    const out = await delegateWithRetry(
      { client, message: A2AClient.textMessage("x") },
      { maxAttempts: 5, baseDelayMs: 1, sleepFn: async () => {} },
    );
    expect(out.ok).toBe(false);
    expect(out.task?.status.state).toBe("failed");
    expect(
      (client as unknown as { fetchFn: { mock: { calls: unknown[] } } }).fetchFn.mock.calls,
    ).toHaveLength(1);
  });
});

describe("delegateFanOut + A2ADelegationCoordinator", () => {
  it("fans out to several peers and isolates failures", async () => {
    const okClient = new A2AClient({
      rpcUrl: RPC_URL,
      fetchFn: vi.fn().mockResolvedValue(rpcResult(DONE_TASK)) as unknown as typeof fetch,
    });
    const deadClient = new A2AClient({
      rpcUrl: RPC_URL,
      fetchFn: vi
        .fn()
        .mockRejectedValue(
          new A2AClientError("down", "HTTP_ERROR", { status: 503 }),
        ) as unknown as typeof fetch,
    });
    const targets: DelegationTarget[] = [
      { label: "peer-a", client: okClient, message: A2AClient.textMessage("q") },
      { label: "peer-b", client: deadClient, message: A2AClient.textMessage("q") },
    ];
    const outcomes = await delegateFanOut(targets, { maxAttempts: 1 });
    expect(outcomes).toHaveLength(2);
    const byLabel = Object.fromEntries(outcomes.map((o) => [o.label!, o]));
    expect(byLabel["peer-a"]!.ok).toBe(true);
    expect(byLabel["peer-b"]!.ok).toBe(false);
  });

  it("coordinator tracks a session and aggregates outcomes", async () => {
    const okClient = new A2AClient({
      rpcUrl: RPC_URL,
      fetchFn: vi.fn().mockResolvedValue(rpcResult(DONE_TASK)) as unknown as typeof fetch,
    });
    const coord = new A2ADelegationCoordinator("council-1");
    expect(coord.sessionId).toBe("council-1");
    const outcomes = await coord.delegate(
      [{ label: "peer-a", client: okClient, message: A2AClient.textMessage("q") }],
      { maxAttempts: 1 },
    );
    expect(outcomes).toHaveLength(1);
    expect(coord.succeeded()).toHaveLength(1);
    expect(coord.failed()).toHaveLength(0);
    expect(coord.allSucceeded).toBe(true);
    expect(coord.all()).toHaveLength(1);
  });

  it("coordinator allSucceeded is false when any peer fails", async () => {
    const deadClient = new A2AClient({
      rpcUrl: RPC_URL,
      fetchFn: vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch,
    });
    const coord = new A2ADelegationCoordinator();
    await coord.delegate(
      [{ label: "peer-a", client: deadClient, message: A2AClient.textMessage("q") }],
      { maxAttempts: 1 },
    );
    expect(coord.allSucceeded).toBe(false);
    expect(coord.failed()).toHaveLength(1);
  });
});

// ── parseSseStream ────────────────────────────────────────────────────────────

describe("parseSseStream", () => {
  it("splits frames on blank lines and strips the data: prefix", async () => {
    const body = new Response('data: {"a":1}\n\ndata: {"a":2}\n\n').body;
    const out: string[] = [];
    for await (const d of parseSseStream(body as ReadableStream<Uint8Array>)) out.push(d);
    expect(out).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("joins multiple data: lines within one frame", async () => {
    const body = new Response("data: line1\ndata: line2\n\n").body;
    const out: string[] = [];
    for await (const d of parseSseStream(body as ReadableStream<Uint8Array>)) out.push(d);
    expect(out).toEqual(["line1\nline2"]);
  });

  it("handles CRLF line endings", async () => {
    const body = new Response('data: {"ok":true}\r\n\r\n').body;
    const out: string[] = [];
    for await (const d of parseSseStream(body as ReadableStream<Uint8Array>)) out.push(d);
    expect(out).toEqual(['{"ok":true}']);
  });

  it("ignores non-data fields", async () => {
    const body = new Response("event: message\nid: 7\ndata: payload\n\n").body;
    const out: string[] = [];
    for await (const d of parseSseStream(body as ReadableStream<Uint8Array>)) out.push(d);
    expect(out).toEqual(["payload"]);
  });
});
