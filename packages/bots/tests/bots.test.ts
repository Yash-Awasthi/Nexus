// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BotError,
  SlackBotAdapter,
  TeamsBotAdapter,
  TelegramBotAdapter,
  echoHandler,
  nullHandler,
  signSlackRequest,
  type BotMessage,
  type BotReply,
  type BotHandler,
  type BotHooks,
  type BotTriggerMode,
  type FetchFn,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const SIGNING_SECRET = "test-secret-abc123";

function makeFetch(
  responses: Array<{ ok: boolean; status?: number; body?: unknown }> = [],
): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: true, status: 200, body: { ok: true } };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body ?? { ok: true },
    } as Response;
  });
}

function makeHooks(): BotHooks {
  return { emit: vi.fn().mockResolvedValue({ handled: 1, aborted: false, errors: [] }) };
}

// ── Slack payloads ─────────────────────────────────────────────────────────

const challengePayload = {
  type: "url_verification",
  challenge: "abc123",
  token: "tok",
};

function messagePayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    event_id: "Ev0001",
    event: {
      type: "message",
      text: "Hello bot!",
      channel: "C123",
      user: "U456",
      ts: "1717000000.000100",
      ...overrides,
    },
  };
}

// ── Teams payloads ─────────────────────────────────────────────────────────

function teamsActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "act-001",
    text: "Hi bot",
    timestamp: "2026-06-13T10:00:00Z",
    serviceUrl: "https://smba.example.com",
    from: { id: "user-1", name: "Yash" },
    conversation: { id: "conv-1", isGroup: false },
    channelData: { teamsChannelId: "19:abc@thread.tacv2" },
    ...overrides,
  };
}

function makeTeamsAdapter(handler: BotHandler, fetchFn: FetchFn, hooks?: BotHooks) {
  return new TeamsBotAdapter({
    appId: "app-id",
    appPassword: "app-secret",
    handler,
    fetch: fetchFn,
    hooks,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BotError
// ─────────────────────────────────────────────────────────────────────────────

describe("BotError", () => {
  it("is an Error with correct name", () => {
    const e = new BotError("HANDLER_FAILED", "oops");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BotError");
  });

  it("exposes code and message", () => {
    const e = new BotError("SIGNATURE_INVALID", "bad sig");
    expect(e.code).toBe("SIGNATURE_INVALID");
    expect(e.message).toBe("bad sig");
  });

  it("stores optional context", () => {
    const e = new BotError("SEND_FAILED", "err", { channel: "C1" });
    expect(e.context).toEqual({ channel: "C1" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Built-in handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("built-in handlers", () => {
  const msg: BotMessage = {
    id: "1",
    platform: "slack",
    channelId: "C1",
    userId: "U1",
    text: "hello",
    timestamp: 0,
    raw: {},
  };

  it("echoHandler echoes text", async () => {
    const reply = await echoHandler(msg);
    expect(reply.text).toBe("Echo: hello");
  });

  it("nullHandler returns empty string", async () => {
    const reply = await nullHandler(msg);
    expect(reply.text).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// signSlackRequest
// ─────────────────────────────────────────────────────────────────────────────

describe("signSlackRequest", () => {
  it("returns a v0= prefixed signature", () => {
    const { signature } = signSlackRequest('{"type":"x"}', SIGNING_SECRET);
    expect(signature).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it("uses provided timestamp", () => {
    const { timestamp } = signSlackRequest("body", SIGNING_SECRET, 9999);
    expect(timestamp).toBe("9999");
  });

  it("defaults timestamp to current time", () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestamp } = signSlackRequest("body", SIGNING_SECRET);
    expect(parseInt(timestamp, 10)).toBeGreaterThanOrEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SlackBotAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("SlackBotAdapter — URL verification", () => {
  it("returns challenge on url_verification event", async () => {
    const adapter = new SlackBotAdapter({
      token: "xoxb-test",
      handler: echoHandler,
      fetch: makeFetch(),
    });
    const result = await adapter.handleEvent(challengePayload);
    expect(result.challenge).toBe("abc123");
    expect(result.handled).toBe(false);
  });

  it("does not invoke handler on url_verification", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "x" });
    const adapter = new SlackBotAdapter({ token: "t", handler, fetch: makeFetch() });
    await adapter.handleEvent(challengePayload);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("SlackBotAdapter — message events", () => {
  let fetchFn: FetchFn;

  beforeEach(() => {
    fetchFn = makeFetch([{ ok: true, body: { ok: true, ts: "1717000001.000200" } }]);
  });

  it("invokes handler with normalized BotMessage", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "Hi!" });
    const adapter = new SlackBotAdapter({ token: "t", handler, fetch: fetchFn });
    await adapter.handleEvent(messagePayload());
    expect(handler).toHaveBeenCalledOnce();
    const msg = handler.mock.calls[0]![0]!;
    expect(msg.platform).toBe("slack");
    expect(msg.text).toBe("Hello bot!");
    expect(msg.channelId).toBe("C123");
    expect(msg.userId).toBe("U456");
    expect(msg.id).toBe("Ev0001");
  });

  it("result.handled is true and reply is returned", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "Pong" });
    const adapter = new SlackBotAdapter({ token: "t", handler, fetch: fetchFn });
    const result = await adapter.handleEvent(messagePayload());
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toBe("Pong");
  });

  it("sends reply via chat.postMessage", async () => {
    const adapter = new SlackBotAdapter({
      token: "xoxb-test",
      handler: echoHandler,
      fetch: fetchFn,
    });
    await adapter.handleEvent(messagePayload());
    expect(fetchFn).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
    const callBody = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(callBody.channel).toBe("C123");
    expect(callBody.text).toContain("Echo:");
  });

  it("includes Authorization Bearer in send call", async () => {
    const adapter = new SlackBotAdapter({
      token: "xoxb-token",
      handler: echoHandler,
      fetch: fetchFn,
    });
    await adapter.handleEvent(messagePayload());
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer xoxb-token");
  });

  it("skips bot_id messages to prevent loops", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "x" });
    const adapter = new SlackBotAdapter({ token: "t", handler, fetch: fetchFn });
    const result = await adapter.handleEvent(messagePayload({ bot_id: "B001" }));
    expect(result.handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns handled:false for empty text", async () => {
    const adapter = new SlackBotAdapter({ token: "t", handler: echoHandler, fetch: fetchFn });
    const result = await adapter.handleEvent(messagePayload({ text: "  " }));
    expect(result.handled).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns handled:false for non-message event types", async () => {
    const adapter = new SlackBotAdapter({ token: "t", handler: echoHandler, fetch: fetchFn });
    const result = await adapter.handleEvent(messagePayload({ type: "app_mention" }));
    // event type is app_mention — not "message" so handled:false
    expect(result.handled).toBe(false);
  });

  it("returns handled:false for unknown top-level type", async () => {
    const adapter = new SlackBotAdapter({ token: "t", handler: echoHandler, fetch: fetchFn });
    const result = await adapter.handleEvent({ type: "weird_event" });
    expect(result.handled).toBe(false);
    expect(result.error).toContain("Unsupported");
  });

  it("sendFailed is true when chat.postMessage returns non-ok HTTP", async () => {
    const badFetch = makeFetch([{ ok: false, status: 500 }]);
    const adapter = new SlackBotAdapter({ token: "t", handler: echoHandler, fetch: badFetch });
    const result = await adapter.handleEvent(messagePayload());
    expect(result.sendFailed).toBe(true);
    expect(result.handled).toBe(true); // handler still ran
  });

  it("sendFailed is true when Slack API returns ok:false JSON", async () => {
    const badFetch = makeFetch([{ ok: true, body: { ok: false, error: "channel_not_found" } }]);
    const adapter = new SlackBotAdapter({ token: "t", handler: echoHandler, fetch: badFetch });
    const result = await adapter.handleEvent(messagePayload());
    expect(result.sendFailed).toBe(true);
  });

  it("throws HANDLER_FAILED when handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("crash"));
    const adapter = new SlackBotAdapter({ token: "t", handler, fetch: fetchFn });
    await expect(adapter.handleEvent(messagePayload())).rejects.toMatchObject({
      code: "HANDLER_FAILED",
    });
  });

  it("threadId is set from ts when no thread_ts", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ok" });
    const adapter = new SlackBotAdapter({ token: "t", handler, fetch: fetchFn });
    await adapter.handleEvent(messagePayload());
    expect(handler.mock.calls[0]![0]!.threadId).toBe("1717000000.000100");
  });

  it("threadId prefers thread_ts over ts", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ok" });
    const adapter = new SlackBotAdapter({ token: "t", handler, fetch: fetchFn });
    await adapter.handleEvent(messagePayload({ thread_ts: "1717000000.000001" }));
    expect(handler.mock.calls[0]![0]!.threadId).toBe("1717000000.000001");
  });

  it("timestamp is converted from Slack ts string to epoch ms", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ok" });
    const adapter = new SlackBotAdapter({ token: "t", handler, fetch: fetchFn });
    await adapter.handleEvent(messagePayload({ ts: "1717000000.000100" }));
    expect(handler.mock.calls[0]![0]!.timestamp).toBe(1717000000000);
  });
});

describe("SlackBotAdapter — signature verification", () => {
  it("passes when signature is valid", async () => {
    const body = JSON.stringify(messagePayload());
    const { signature, timestamp } = signSlackRequest(body, SIGNING_SECRET);
    const fetchFn = makeFetch([{ ok: true, body: { ok: true } }]);
    const adapter = new SlackBotAdapter({
      token: "t",
      signingSecret: SIGNING_SECRET,
      handler: echoHandler,
      fetch: fetchFn,
    });
    await expect(
      adapter.handleEvent(body, {
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      }),
    ).resolves.toBeDefined();
  });

  it("throws SIGNATURE_INVALID when signature is wrong", async () => {
    const body = JSON.stringify(messagePayload());
    const adapter = new SlackBotAdapter({
      token: "t",
      signingSecret: SIGNING_SECRET,
      handler: echoHandler,
      fetch: makeFetch(),
    });
    await expect(
      adapter.handleEvent(body, {
        "x-slack-signature": "v0=badhash",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      }),
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("throws SIGNATURE_INVALID when timestamp is stale (> 5 min)", async () => {
    const body = JSON.stringify(messagePayload());
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const { signature } = signSlackRequest(body, SIGNING_SECRET, staleTs);
    const adapter = new SlackBotAdapter({
      token: "t",
      signingSecret: SIGNING_SECRET,
      handler: echoHandler,
      fetch: makeFetch(),
    });
    await expect(
      adapter.handleEvent(body, {
        "x-slack-signature": signature,
        "x-slack-request-timestamp": String(staleTs),
      }),
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("skips verification when no signingSecret provided", async () => {
    const adapter = new SlackBotAdapter({
      token: "t",
      handler: echoHandler,
      fetch: makeFetch([{ ok: true, body: { ok: true } }]),
    });
    await expect(adapter.handleEvent(messagePayload())).resolves.toBeDefined();
  });
});

describe("SlackBotAdapter — hooks", () => {
  it("emits task.before and task.after on message handling", async () => {
    const hooks = makeHooks();
    const fetchFn = makeFetch([{ ok: true, body: { ok: true } }]);
    const adapter = new SlackBotAdapter({
      token: "t",
      handler: echoHandler,
      fetch: fetchFn,
      hooks,
    });
    await adapter.handleEvent(messagePayload());
    expect(hooks.emit).toHaveBeenCalledTimes(2);
    const events = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("task.before");
    expect(events).toContain("task.after");
  });

  it("task.before payload includes platform and channelId", async () => {
    const hooks = makeHooks();
    const fetchFn = makeFetch([{ ok: true, body: { ok: true } }]);
    const adapter = new SlackBotAdapter({
      token: "t",
      handler: echoHandler,
      fetch: fetchFn,
      hooks,
    });
    await adapter.handleEvent(messagePayload());
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      platform: "slack",
      channelId: "C123",
    });
  });

  it("hook errors are non-fatal", async () => {
    const hooks: BotHooks = { emit: vi.fn().mockRejectedValue(new Error("hook err")) };
    const fetchFn = makeFetch([{ ok: true, body: { ok: true } }]);
    const adapter = new SlackBotAdapter({
      token: "t",
      handler: echoHandler,
      fetch: fetchFn,
      hooks,
    });
    await expect(adapter.handleEvent(messagePayload())).resolves.toBeDefined();
  });
});

describe("SlackBotAdapter — direct send", () => {
  it("send() calls chat.postMessage with correct payload", async () => {
    const fetchFn = makeFetch([{ ok: true, body: { ok: true } }]);
    const adapter = new SlackBotAdapter({ token: "xoxb-x", handler: echoHandler, fetch: fetchFn });
    await adapter.send("C999", "Direct message");
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.channel).toBe("C999");
    expect(body.text).toBe("Direct message");
  });

  it("send() includes thread_ts when provided", async () => {
    const fetchFn = makeFetch([{ ok: true, body: { ok: true } }]);
    const adapter = new SlackBotAdapter({ token: "t", handler: echoHandler, fetch: fetchFn });
    await adapter.send("C1", "reply", { threadTs: "1717000000.000001" });
    const body = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string,
    );
    expect(body.thread_ts).toBe("1717000000.000001");
  });

  it("send() throws SEND_FAILED when API returns non-ok HTTP", async () => {
    const fetchFn = makeFetch([{ ok: false, status: 429 }]);
    const adapter = new SlackBotAdapter({ token: "t", handler: echoHandler, fetch: fetchFn });
    await expect(adapter.send("C1", "text")).rejects.toMatchObject({ code: "SEND_FAILED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TeamsBotAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe("TeamsBotAdapter — message activities", () => {
  let fetchFn: FetchFn;

  beforeEach(() => {
    // First fetch = token endpoint; second = reply send
    fetchFn = makeFetch([
      { ok: true, body: { access_token: "test-token" } },
      { ok: true, body: { id: "reply-act-1" } },
    ]);
  });

  it("invokes handler with normalized BotMessage", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "Hi!" });
    const adapter = makeTeamsAdapter(handler, fetchFn);
    await adapter.handleActivity(teamsActivity());
    expect(handler).toHaveBeenCalledOnce();
    const msg = handler.mock.calls[0]![0]!;
    expect(msg.platform).toBe("teams");
    expect(msg.text).toBe("Hi bot");
    expect(msg.userId).toBe("user-1");
    expect(msg.channelId).toBe("19:abc@thread.tacv2");
  });

  it("result.handled is true and reply returned", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "Pong" });
    const adapter = makeTeamsAdapter(handler, fetchFn);
    const result = await adapter.handleActivity(teamsActivity());
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toBe("Pong");
  });

  it("acquires token from AAD before sending reply", async () => {
    const adapter = makeTeamsAdapter(echoHandler, fetchFn);
    await adapter.handleActivity(teamsActivity());
    const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
    // First call is token endpoint
    expect(calls[0]![0]).toContain("oauth2/v2.0/token");
  });

  it("sends reply to serviceUrl from activity", async () => {
    const adapter = makeTeamsAdapter(echoHandler, fetchFn);
    await adapter.handleActivity(teamsActivity({ serviceUrl: "https://custom.smba.example.com" }));
    const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1]![0]).toContain("https://custom.smba.example.com");
  });

  it("reply URL includes conversationId and activityId", async () => {
    const adapter = makeTeamsAdapter(echoHandler, fetchFn);
    await adapter.handleActivity(teamsActivity());
    const replyUrl = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    expect(replyUrl).toContain("conv-1");
    expect(replyUrl).toContain("act-001");
  });

  it("sends Bearer token in Authorization header for reply", async () => {
    const adapter = makeTeamsAdapter(echoHandler, fetchFn);
    await adapter.handleActivity(teamsActivity());
    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("falls back to conversation.id as channelId when no teamsChannelId", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ok" });
    const adapter = makeTeamsAdapter(handler, fetchFn);
    await adapter.handleActivity(teamsActivity({ channelData: {} }));
    expect(handler.mock.calls[0]![0]!.channelId).toBe("conv-1");
  });

  it("threadId is set to conversation.id", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ok" });
    const adapter = makeTeamsAdapter(handler, fetchFn);
    await adapter.handleActivity(teamsActivity());
    expect(handler.mock.calls[0]![0]!.threadId).toBe("conv-1");
  });

  it("timestamp is parsed from ISO string", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ok" });
    const adapter = makeTeamsAdapter(handler, fetchFn);
    await adapter.handleActivity(teamsActivity({ timestamp: "2026-06-13T10:00:00Z" }));
    expect(handler.mock.calls[0]![0]!.timestamp).toBe(new Date("2026-06-13T10:00:00Z").getTime());
  });

  it("returns handled:false for non-message activities", async () => {
    const adapter = makeTeamsAdapter(echoHandler, fetchFn);
    const result = await adapter.handleActivity(teamsActivity({ type: "conversationUpdate" }));
    expect(result.handled).toBe(false);
    expect(result.error).toContain("Unsupported");
  });

  it("returns handled:false for empty text", async () => {
    const adapter = makeTeamsAdapter(echoHandler, fetchFn);
    const result = await adapter.handleActivity(teamsActivity({ text: "" }));
    expect(result.handled).toBe(false);
  });

  it("throws PAYLOAD_INVALID on invalid JSON body", async () => {
    const adapter = makeTeamsAdapter(echoHandler, fetchFn);
    await expect(adapter.handleActivity("{bad json")).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });
  });

  it("throws HANDLER_FAILED when handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const adapter = makeTeamsAdapter(handler, fetchFn);
    await expect(adapter.handleActivity(teamsActivity())).rejects.toMatchObject({
      code: "HANDLER_FAILED",
    });
  });

  it("sendFailed is true when token endpoint fails", async () => {
    const badFetch = makeFetch([{ ok: false, status: 401, body: {} }]);
    const adapter = makeTeamsAdapter(echoHandler, badFetch);
    const result = await adapter.handleActivity(teamsActivity());
    expect(result.sendFailed).toBe(true);
    expect(result.handled).toBe(true);
  });

  it("sendFailed is true when reply send fails", async () => {
    const badFetch = makeFetch([
      { ok: true, body: { access_token: "tok" } },
      { ok: false, status: 500 },
    ]);
    const adapter = makeTeamsAdapter(echoHandler, badFetch);
    const result = await adapter.handleActivity(teamsActivity());
    expect(result.sendFailed).toBe(true);
  });

  it("sendFailed is true when token response has no access_token", async () => {
    const badFetch = makeFetch([
      { ok: true, body: {} }, // no access_token
    ]);
    const adapter = makeTeamsAdapter(echoHandler, badFetch);
    const result = await adapter.handleActivity(teamsActivity());
    expect(result.sendFailed).toBe(true);
  });
});

describe("TeamsBotAdapter — hooks", () => {
  it("emits task.before and task.after", async () => {
    const hooks = makeHooks();
    const fetchFn = makeFetch([
      { ok: true, body: { access_token: "tok" } },
      { ok: true, body: {} },
    ]);
    const adapter = makeTeamsAdapter(echoHandler, fetchFn, hooks);
    await adapter.handleActivity(teamsActivity());
    const events = (hooks.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("task.before");
    expect(events).toContain("task.after");
  });

  it("task.before payload includes platform:teams and channelId", async () => {
    const hooks = makeHooks();
    const fetchFn = makeFetch([
      { ok: true, body: { access_token: "tok" } },
      { ok: true, body: {} },
    ]);
    const adapter = makeTeamsAdapter(echoHandler, fetchFn, hooks);
    await adapter.handleActivity(teamsActivity());
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      platform: "teams",
      channelId: "19:abc@thread.tacv2",
    });
  });

  it("hook errors are non-fatal", async () => {
    const hooks: BotHooks = { emit: vi.fn().mockRejectedValue(new Error("err")) };
    const fetchFn = makeFetch([
      { ok: true, body: { access_token: "tok" } },
      { ok: true, body: {} },
    ]);
    const adapter = makeTeamsAdapter(echoHandler, fetchFn, hooks);
    await expect(adapter.handleActivity(teamsActivity())).resolves.toBeDefined();
  });

  it("uses custom bot name in hook payloads", async () => {
    const hooks = makeHooks();
    const fetchFn = makeFetch([
      { ok: true, body: { access_token: "tok" } },
      { ok: true, body: {} },
    ]);
    const adapter = new TeamsBotAdapter({
      appId: "id",
      appPassword: "pwd",
      handler: echoHandler,
      fetch: fetchFn,
      hooks,
      name: "my-teams-bot",
    });
    await adapter.handleActivity(teamsActivity());
    expect((hooks.emit as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      bot: "my-teams-bot",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SlackBotAdapter — trigger modes
// ─────────────────────────────────────────────────────────────────────────────

function makeSlack(
  opts: {
    triggerMode?: BotTriggerMode;
    botUserId?: string;
    allowedUserIds?: string[];
    handler?: BotHandler;
  } = {},
) {
  return new SlackBotAdapter({
    token: "xoxb-test",
    handler: opts.handler ?? echoHandler,
    fetch: makeFetch([{ ok: true }]),
    triggerMode: opts.triggerMode,
    botUserId: opts.botUserId,
    allowedUserIds: opts.allowedUserIds,
  });
}

describe("SlackBotAdapter — triggerMode", () => {
  it("default 'all' mode handles every non-bot message", async () => {
    const slack = makeSlack(); // default triggerMode:"all"
    const result = await slack.handleEvent(messagePayload());
    expect(result.handled).toBe(true);
  });

  it("mention mode: handles message that mentions the bot", async () => {
    const slack = makeSlack({ triggerMode: "mention", botUserId: "U999" });
    const result = await slack.handleEvent(
      messagePayload({ event: undefined, text: "<@U999> help" }),
    );
    // rebuild properly
    const payload = {
      type: "event_callback",
      event_id: "Ev001",
      event: { type: "message", text: "<@U999> help", channel: "C1", user: "U1", ts: "1.0" },
    };
    const r = await slack.handleEvent(payload);
    expect(r.handled).toBe(true);
  });

  it("mention mode: skips message without bot mention", async () => {
    const slack = makeSlack({ triggerMode: "mention", botUserId: "U999" });
    const r = await slack.handleEvent(messagePayload({ text: "just chatting" }));
    expect(r.handled).toBe(false);
  });

  it("mention mode: passes through when botUserId not configured", async () => {
    const slack = makeSlack({ triggerMode: "mention" }); // no botUserId
    const r = await slack.handleEvent(messagePayload({ text: "no mention" }));
    expect(r.handled).toBe(true);
  });

  it("command mode: handles message starting with /", async () => {
    const slack = makeSlack({ triggerMode: "command" });
    const r = await slack.handleEvent(messagePayload({ text: "/help me" }));
    expect(r.handled).toBe(true);
  });

  it("command mode: skips regular message", async () => {
    const slack = makeSlack({ triggerMode: "command" });
    const r = await slack.handleEvent(messagePayload({ text: "hello there" }));
    expect(r.handled).toBe(false);
  });

  it("command mode: skips message with leading space before non-slash", async () => {
    const slack = makeSlack({ triggerMode: "command" });
    const r = await slack.handleEvent(messagePayload({ text: "  not a command" }));
    expect(r.handled).toBe(false);
  });
});

describe("SlackBotAdapter — allowedUserIds", () => {
  it("allows users in the allowlist", async () => {
    const slack = makeSlack({ allowedUserIds: ["U456"] });
    const r = await slack.handleEvent(messagePayload()); // user is U456 from helper
    expect(r.handled).toBe(true);
  });

  it("blocks users not in the allowlist", async () => {
    const slack = makeSlack({ allowedUserIds: ["U999"] });
    const r = await slack.handleEvent(messagePayload()); // user is U456
    expect(r.handled).toBe(false);
  });

  it("allows all users when allowedUserIds is not set", async () => {
    const slack = makeSlack(); // no allowedUserIds
    const r = await slack.handleEvent(messagePayload());
    expect(r.handled).toBe(true);
  });

  it("allows multiple users in the allowlist", async () => {
    const slack = makeSlack({ allowedUserIds: ["U111", "U456", "U789"] });
    const r = await slack.handleEvent(messagePayload()); // user U456
    expect(r.handled).toBe(true);
  });

  it("trigger mode and allowedUserIds both gate the handler", async () => {
    // mention mode + allowlist: need BOTH conditions to pass
    const slack = makeSlack({
      triggerMode: "mention",
      botUserId: "U999",
      allowedUserIds: ["U456"],
    });
    // correct user, no mention → blocked by trigger mode
    const r1 = await slack.handleEvent(messagePayload({ text: "hello" }));
    expect(r1.handled).toBe(false);

    // mention present, wrong user → blocked by allowlist
    const r2 = await slack.handleEvent({
      type: "event_callback",
      event_id: "E",
      event: { type: "message", text: "<@U999> help", channel: "C1", user: "U_OTHER", ts: "1.0" },
    });
    expect(r2.handled).toBe(false);

    // mention + correct user → passes both gates
    const slack2 = makeSlack({
      triggerMode: "mention",
      botUserId: "U999",
      allowedUserIds: ["U456"],
      handler: echoHandler,
    });
    // need to reset fetch
    const slack3 = new SlackBotAdapter({
      token: "xoxb-test",
      handler: echoHandler,
      fetch: makeFetch([{ ok: true }]),
      triggerMode: "mention",
      botUserId: "U999",
      allowedUserIds: ["U456"],
    });
    const r3 = await slack3.handleEvent({
      type: "event_callback",
      event_id: "E",
      event: { type: "message", text: "<@U999> help me", channel: "C1", user: "U456", ts: "1.0" },
    });
    expect(r3.handled).toBe(true);
  });
});

// ── Telegram payloads ────────────────────────────────────────────────────────

function tgUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 100,
    message: {
      message_id: 5,
      from: { id: 4242, is_bot: false, username: "yash", first_name: "Yash" },
      chat: { id: -1001, type: "supergroup" },
      text: "Hello Nexus",
      date: 1717000000,
      ...overrides,
    },
  };
}

function makeTelegram(
  handler: BotHandler,
  fetchFn: FetchFn,
  extra: Partial<Parameters<typeof TelegramBotAdapter.prototype.constructor>[0]> = {},
) {
  return new TelegramBotAdapter({
    token: "123:ABC",
    handler,
    fetch: fetchFn,
    apiBase: "https://tg.test",
    ...extra,
  });
}

describe("TelegramBotAdapter.handleUpdate", () => {
  it("normalizes an update, invokes handler, and sends a reply", async () => {
    const fetchFn = makeFetch([{ ok: true, body: { ok: true } }]);
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "Pong" });
    const bot = makeTelegram(handler, fetchFn);

    const res = await bot.handleUpdate(tgUpdate());

    expect(res.handled).toBe(true);
    expect(res.sendFailed).toBeFalsy();
    const msg = handler.mock.calls[0]![0] as BotMessage;
    expect(msg.platform).toBe("telegram");
    expect(msg.channelId).toBe("-1001");
    expect(msg.userId).toBe("4242");
    expect(msg.text).toBe("Hello Nexus");
    // sendMessage called against the injected API base + token
    expect(fetchFn).toHaveBeenCalledWith(
      "https://tg.test/bot123:ABC/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ignores updates from other bots (loop prevention)", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "x" });
    const bot = makeTelegram(handler, makeFetch());
    const res = await bot.handleUpdate(tgUpdate({ from: { id: 1, is_bot: true } }));
    expect(res.handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores empty-text and message-less updates", async () => {
    const bot = makeTelegram(vi.fn<BotHandler>().mockResolvedValue({ text: "x" }), makeFetch());
    expect((await bot.handleUpdate(tgUpdate({ text: "" }))).handled).toBe(false);
    expect((await bot.handleUpdate({ update_id: 1 })).handled).toBe(false);
  });

  it("verifies the webhook secret token and rejects mismatches", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ok" });
    const bot = makeTelegram(handler, makeFetch(), { secretToken: "s3cret" });

    // Correct secret → handled
    const ok = await bot.handleUpdate(tgUpdate(), {
      "x-telegram-bot-api-secret-token": "s3cret",
    });
    expect(ok.handled).toBe(true);

    // Wrong secret → throws SIGNATURE_INVALID
    await expect(
      bot.handleUpdate(tgUpdate(), { "x-telegram-bot-api-secret-token": "nope" }),
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("respects command trigger mode", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ran" });
    const bot = makeTelegram(handler, makeFetch(), { triggerMode: "command" as BotTriggerMode });

    expect((await bot.handleUpdate(tgUpdate({ text: "just chatting" }))).handled).toBe(false);
    expect((await bot.handleUpdate(tgUpdate({ text: "/start" }))).handled).toBe(true);
  });

  it("enforces the user allowlist", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "hi" });
    const bot = makeTelegram(handler, makeFetch(), { allowedUserIds: ["999"] });
    const res = await bot.handleUpdate(tgUpdate()); // user 4242 not allowed
    expect(res.handled).toBe(false);
  });

  it("reports sendFailed when the Telegram API rejects", async () => {
    const fetchFn = makeFetch([
      { ok: false, status: 403, body: { ok: false, description: "blocked" } },
    ]);
    const bot = makeTelegram(echoHandler, fetchFn);
    const res = await bot.handleUpdate(tgUpdate());
    expect(res.handled).toBe(true);
    expect(res.sendFailed).toBe(true);
  });

  it("emits task.before / task.after hooks", async () => {
    const hooks = makeHooks();
    const bot = makeTelegram(echoHandler, makeFetch(), { hooks });
    await bot.handleUpdate(tgUpdate());
    expect(hooks.emit).toHaveBeenCalledWith(
      "task.before",
      expect.objectContaining({ platform: "telegram" }),
    );
    expect(hooks.emit).toHaveBeenCalledWith(
      "task.after",
      expect.objectContaining({ platform: "telegram" }),
    );
  });
});

describe("TelegramBotAdapter.pollOnce", () => {
  it("dispatches fetched updates and advances the offset", async () => {
    const handler = vi.fn<BotHandler>().mockResolvedValue({ text: "ok" });
    // First fetch = getUpdates batch; subsequent = sendMessage calls
    const fetchFn = makeFetch([
      {
        ok: true,
        body: {
          ok: true,
          result: [
            tgUpdate({}),
            {
              update_id: 101,
              message: { message_id: 6, from: { id: 7 }, chat: { id: 8 }, text: "yo", date: 1 },
            },
          ],
        },
      },
      { ok: true, body: { ok: true } },
      { ok: true, body: { ok: true } },
    ]);
    const bot = makeTelegram(handler, fetchFn);
    const { processed, nextOffset } = await bot.pollOnce(100);
    expect(processed).toBe(2);
    expect(nextOffset).toBe(102); // max update_id (101) + 1
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
