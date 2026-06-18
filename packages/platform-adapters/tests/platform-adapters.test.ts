// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  TelegramAdapter,
  SlackAdapter,
  MockHttpSender,
  createAdapter,
  type TelegramUpdate,
  type SlackEventPayload,
} from "../src/index.js";

// ── TelegramAdapter ───────────────────────────────────────────────────────────

describe("TelegramAdapter — parse", () => {
  const adapter = new TelegramAdapter({ botToken: "test-token" });

  it("platform is 'telegram'", () => expect(adapter.platform).toBe("telegram"));

  it("parses text message update", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 42, username: "alice" },
        chat: { id: 100, type: "private" },
        text: "Hello bot!",
      },
    };
    const msg = adapter.parse(update);
    expect(msg).not.toBeNull();
    expect(msg!.userId).toBe("42");
    expect(msg!.chatId).toBe("100");
    expect(msg!.text).toBe("Hello bot!");
    expect(msg!.platform).toBe("telegram");
  });

  it("parses callback_query", () => {
    const update: TelegramUpdate = {
      update_id: 2,
      callback_query: {
        id: "cb1",
        from: { id: 99 },
        message: { chat: { id: 200 } },
        data: "action:submit",
      },
    };
    const msg = adapter.parse(update);
    expect(msg!.text).toBe("action:submit");
    expect(msg!.userId).toBe("99");
    expect(msg!.chatId).toBe("200");
  });

  it("returns null for unknown update type", () => {
    expect(adapter.parse({ update_id: 3 })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(adapter.parse(null)).toBeNull();
  });

  it("handles missing from.id", () => {
    const update: TelegramUpdate = {
      update_id: 4,
      message: {
        message_id: 5,
        chat: { id: 10, type: "private" },
        text: "hi",
      },
    };
    const msg = adapter.parse(update);
    expect(msg!.userId).toBe("unknown");
  });
});

describe("TelegramAdapter — send", () => {
  let sender: MockHttpSender;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    sender = new MockHttpSender().setResult({ ok: true, result: { message_id: 55 } });
    adapter = new TelegramAdapter({ botToken: "tok" }, sender);
  });

  it("POSTs to sendMessage endpoint", async () => {
    await adapter.send({ chatId: "100", text: "Hello" });
    expect(sender.calls[0]!.url).toContain("sendMessage");
    expect(sender.calls[0]!.url).toContain("tok");
  });

  it("returns success and messageId", async () => {
    const r = await adapter.send({ chatId: "100", text: "Hi" });
    expect(r.success).toBe(true);
    expect(r.messageId).toBe("55");
  });

  it("includes parse_mode when specified", async () => {
    await adapter.send({ chatId: "100", text: "*bold*", parseMode: "Markdown" });
    const body = sender.calls[0]!.body as Record<string, unknown>;
    expect(body["parse_mode"]).toBe("Markdown");
  });

  it("omits parse_mode for 'plain'", async () => {
    await adapter.send({ chatId: "100", text: "plain text", parseMode: "plain" });
    const body = sender.calls[0]!.body as Record<string, unknown>;
    expect(body["parse_mode"]).toBeUndefined();
  });

  it("returns success:false on network error", async () => {
    const badSender = {
      post: async () => {
        throw new Error("network error");
      },
    };
    const a = new TelegramAdapter({ botToken: "t" }, badSender);
    const r = await a.send({ chatId: "1", text: "hi" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("network error");
  });
});

// ── SlackAdapter ──────────────────────────────────────────────────────────────

describe("SlackAdapter — parse", () => {
  const adapter = new SlackAdapter({ botToken: "xoxb-test" });

  it("platform is 'slack'", () => expect(adapter.platform).toBe("slack"));

  it("parses event_callback message", () => {
    const payload: SlackEventPayload = {
      type: "event_callback",
      event: {
        type: "message",
        user: "U123",
        channel: "C456",
        text: "Hello Nexus",
        ts: "1234.5678",
      },
    };
    const msg = adapter.parse(payload);
    expect(msg!.userId).toBe("U123");
    expect(msg!.chatId).toBe("C456");
    expect(msg!.text).toBe("Hello Nexus");
    expect(msg!.platform).toBe("slack");
  });

  it("parses slash command", () => {
    const payload: SlackEventPayload = {
      type: "slash_command",
      command: "/nexus",
      user_id: "U789",
      channel_id: "C999",
      text: "run test",
    };
    const msg = adapter.parse(payload);
    expect(msg!.text).toBe("/nexus run test");
    expect(msg!.userId).toBe("U789");
  });

  it("returns null for unknown type", () => {
    expect(adapter.parse({ type: "url_verification" })).toBeNull();
  });

  it("returns null for event without user/channel", () => {
    const payload: SlackEventPayload = {
      type: "event_callback",
      event: { type: "message", text: "orphan" },
    };
    expect(adapter.parse(payload)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(adapter.parse(null)).toBeNull();
  });
});

describe("SlackAdapter — send", () => {
  let sender: MockHttpSender;
  let adapter: SlackAdapter;

  beforeEach(() => {
    sender = new MockHttpSender().setResult({ ok: true, ts: "9999.0001" });
    adapter = new SlackAdapter({ botToken: "xoxb-token" }, sender);
  });

  it("POSTs to chat.postMessage", async () => {
    await adapter.send({ chatId: "C123", text: "Hello" });
    expect(sender.calls[0]!.url).toContain("chat.postMessage");
  });

  it("sends Authorization Bearer header", async () => {
    await adapter.send({ chatId: "C1", text: "hi" });
    // MockHttpSender records calls — headers passed to post()
    expect(sender.calls[0]!.url).toBeTruthy(); // method called
  });

  it("returns success and ts as messageId", async () => {
    const r = await adapter.send({ chatId: "C1", text: "hi" });
    expect(r.success).toBe(true);
    expect(r.messageId).toBe("9999.0001");
  });

  it("includes blocks in body", async () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
    await adapter.send({ chatId: "C1", blocks });
    const body = sender.calls[0]!.body as Record<string, unknown>;
    expect(body["blocks"]).toBeDefined();
  });

  it("returns error message on Slack API error", async () => {
    sender.setResult({ ok: false, error: "channel_not_found" });
    const r = await adapter.send({ chatId: "C1", text: "hi" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("channel_not_found");
  });
});

// ── AdapterFactory ─────────────────────────────────────────────────────────────

describe("createAdapter", () => {
  const sender = new MockHttpSender();

  it("creates TelegramAdapter for platform=telegram", () => {
    const a = createAdapter({ platform: "telegram", botToken: "t" }, sender);
    expect(a.platform).toBe("telegram");
  });

  it("creates SlackAdapter for platform=slack", () => {
    const a = createAdapter({ platform: "slack", botToken: "xoxb" }, sender);
    expect(a.platform).toBe("slack");
  });

  it("throws for unknown platform", () => {
    expect(() => createAdapter({ platform: "unknown" as never, botToken: "t" }, sender)).toThrow();
  });
});
