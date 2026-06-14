// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  BroadcastDispatcher,
  WebhookChannel,
  EmailChannel,
  NullChannel,
  AudienceSegment,
  BroadcastError,
  hasEmail,
  hasWebhook,
  hasTag,
  everyone,
  type BroadcastMessage,
  type Recipient,
  type FetchFn,
  type EmailSender,
} from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMsg(id = "msg1"): BroadcastMessage {
  return { id, subject: "Hello", body: "World", metadata: { env: "test" } };
}

function makeRecipient(overrides: Partial<Recipient> = {}): Recipient {
  return { id: "r1", email: "user@example.com", webhookUrl: "https://hook.example.com", ...overrides };
}

function makeFetch(ok = true, status = 200): { fetch: FetchFn; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, body: init?.body ?? "" });
    return { ok, status, statusText: ok ? "OK" : "Bad Gateway" };
  };
  return { fetch, calls };
}

function makeEmailSender(): { sender: EmailSender; sent: Array<{ to: string; subject: string }> } {
  const sent: Array<{ to: string; subject: string }> = [];
  const sender: EmailSender = {
    async send({ to, subject }) { sent.push({ to, subject }); },
  };
  return { sender, sent };
}

// ── AudienceSegment ───────────────────────────────────────────────────────────

describe("AudienceSegment", () => {
  it("everyone matches all recipients", () => {
    expect(everyone.matches(makeRecipient())).toBe(true);
    expect(everyone.matches({ id: "x" })).toBe(true);
  });

  it("hasEmail matches recipients with email", () => {
    expect(hasEmail.matches(makeRecipient({ email: "a@b.com" }))).toBe(true);
    expect(hasEmail.matches(makeRecipient({ email: undefined }))).toBe(false);
  });

  it("hasWebhook matches recipients with webhookUrl", () => {
    expect(hasWebhook.matches(makeRecipient({ webhookUrl: "https://x.com" }))).toBe(true);
    expect(hasWebhook.matches(makeRecipient({ webhookUrl: undefined }))).toBe(false);
  });

  it("hasTag matches recipients with specific tag", () => {
    const seg = hasTag("vip");
    expect(seg.matches(makeRecipient({ tags: ["vip", "beta"] }))).toBe(true);
    expect(seg.matches(makeRecipient({ tags: ["beta"] }))).toBe(false);
    expect(seg.matches(makeRecipient({ tags: undefined }))).toBe(false);
  });

  it("and composes segments (both must match)", () => {
    const seg = hasEmail.and(hasWebhook);
    expect(seg.matches(makeRecipient())).toBe(true);
    expect(seg.matches(makeRecipient({ webhookUrl: undefined }))).toBe(false);
  });

  it("or composes segments (either must match)", () => {
    const seg = hasEmail.or(hasWebhook);
    expect(seg.matches(makeRecipient({ email: undefined }))).toBe(true); // has webhook
    expect(seg.matches({ id: "x" })).toBe(false);
  });

  it("not negates a segment", () => {
    const noEmail = hasEmail.not();
    expect(noEmail.matches(makeRecipient({ email: undefined }))).toBe(true);
    expect(noEmail.matches(makeRecipient({ email: "a@b.com" }))).toBe(false);
  });

  it("custom segment function works", () => {
    const goldUsers = new AudienceSegment((r) => r.metadata?.tier === "gold");
    expect(goldUsers.matches({ id: "x", metadata: { tier: "gold" } })).toBe(true);
    expect(goldUsers.matches({ id: "y", metadata: { tier: "silver" } })).toBe(false);
  });
});

// ── WebhookChannel ────────────────────────────────────────────────────────────

describe("WebhookChannel", () => {
  it("canDeliver returns true when recipient has webhookUrl", () => {
    const { fetch } = makeFetch();
    const ch = new WebhookChannel(fetch);
    expect(ch.canDeliver(makeRecipient())).toBe(true);
    expect(ch.canDeliver(makeRecipient({ webhookUrl: undefined }))).toBe(false);
  });

  it("name is 'webhook'", () => {
    const { fetch } = makeFetch();
    expect(new WebhookChannel(fetch).name).toBe("webhook");
  });

  it("send POSTs to webhookUrl with JSON body", async () => {
    const { fetch, calls } = makeFetch();
    const ch = new WebhookChannel(fetch);
    await ch.send(makeMsg(), makeRecipient({ webhookUrl: "https://hook.test/x" }));
    expect(calls[0]!.url).toBe("https://hook.test/x");
    const body = JSON.parse(calls[0]!.body);
    expect(body.messageId).toBe("msg1");
    expect(body.subject).toBe("Hello");
  });

  it("send returns success=true on 200", async () => {
    const { fetch } = makeFetch(true, 200);
    const ch = new WebhookChannel(fetch);
    const r = await ch.send(makeMsg(), makeRecipient());
    expect(r.success).toBe(true);
  });

  it("send returns success=false on non-2xx", async () => {
    const { fetch } = makeFetch(false, 502);
    const ch = new WebhookChannel(fetch);
    const r = await ch.send(makeMsg(), makeRecipient());
    expect(r.success).toBe(false);
    expect(r.error).toContain("502");
  });

  it("send returns success=false when recipient has no webhookUrl", async () => {
    const { fetch } = makeFetch();
    const ch = new WebhookChannel(fetch);
    const r = await ch.send(makeMsg(), makeRecipient({ webhookUrl: undefined }));
    expect(r.success).toBe(false);
  });

  it("send returns success=false when fetch throws", async () => {
    const fetch: FetchFn = async () => { throw new Error("timeout"); };
    const ch = new WebhookChannel(fetch);
    const r = await ch.send(makeMsg(), makeRecipient());
    expect(r.success).toBe(false);
    expect(r.error).toContain("timeout");
  });

  it("passes custom headers to fetch", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetch: FetchFn = async (_url, init) => {
      calls.push((init?.headers ?? {}) as Record<string, string>);
      return { ok: true, status: 200, statusText: "OK" };
    };
    const ch = new WebhookChannel(fetch, { headers: { "X-Secret": "abc" } });
    await ch.send(makeMsg(), makeRecipient());
    expect(calls[0]!["X-Secret"]).toBe("abc");
  });
});

// ── EmailChannel ──────────────────────────────────────────────────────────────

describe("EmailChannel", () => {
  it("canDeliver returns true when recipient has email", () => {
    const { sender } = makeEmailSender();
    const ch = new EmailChannel(sender);
    expect(ch.canDeliver(makeRecipient())).toBe(true);
    expect(ch.canDeliver({ id: "x" })).toBe(false);
  });

  it("name is 'email'", () => {
    const { sender } = makeEmailSender();
    expect(new EmailChannel(sender).name).toBe("email");
  });

  it("send calls sender.send with correct args", async () => {
    const { sender, sent } = makeEmailSender();
    const ch = new EmailChannel(sender);
    await ch.send(makeMsg(), makeRecipient({ email: "yash@example.com" }));
    expect(sent[0]!.to).toBe("yash@example.com");
    expect(sent[0]!.subject).toBe("Hello");
  });

  it("send returns success=true on success", async () => {
    const { sender } = makeEmailSender();
    const ch = new EmailChannel(sender);
    const r = await ch.send(makeMsg(), makeRecipient());
    expect(r.success).toBe(true);
  });

  it("send returns success=false when sender throws", async () => {
    const failSender: EmailSender = { async send() { throw new Error("SMTP error"); } };
    const ch = new EmailChannel(failSender);
    const r = await ch.send(makeMsg(), makeRecipient());
    expect(r.success).toBe(false);
    expect(r.error).toContain("SMTP");
  });

  it("send returns failure when no email on recipient", async () => {
    const { sender } = makeEmailSender();
    const ch = new EmailChannel(sender);
    const r = await ch.send(makeMsg(), { id: "x" });
    expect(r.success).toBe(false);
  });
});

// ── NullChannel ───────────────────────────────────────────────────────────────

describe("NullChannel", () => {
  it("records sent messages without delivering", async () => {
    const ch = new NullChannel();
    await ch.send(makeMsg(), makeRecipient());
    expect(ch.sent).toHaveLength(1);
  });

  it("canDeliver uses provided predicate", () => {
    const ch = new NullChannel("test", (r) => !!r.email);
    expect(ch.canDeliver(makeRecipient())).toBe(true);
    expect(ch.canDeliver({ id: "x" })).toBe(false);
  });

  it("clear empties sent list", async () => {
    const ch = new NullChannel();
    await ch.send(makeMsg(), makeRecipient());
    ch.clear();
    expect(ch.sent).toHaveLength(0);
  });

  it("uses provided name", () => {
    expect(new NullChannel("my-channel").name).toBe("my-channel");
  });
});

// ── BroadcastDispatcher ───────────────────────────────────────────────────────

describe("BroadcastDispatcher", () => {
  let dispatcher: BroadcastDispatcher;
  let ch: NullChannel;

  beforeEach(() => {
    dispatcher = new BroadcastDispatcher();
    ch = new NullChannel("null");
    dispatcher.addChannel(ch);
  });

  it("broadcast delivers to all recipients", async () => {
    dispatcher.addRecipient(makeRecipient({ id: "r1" }));
    dispatcher.addRecipient(makeRecipient({ id: "r2" }));
    const records = await dispatcher.broadcast(makeMsg());
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.status === "delivered")).toBe(true);
  });

  it("broadcast applies segment filter", async () => {
    dispatcher.addRecipient({ id: "email-only", email: "a@b.com" });
    dispatcher.addRecipient({ id: "webhook-only", webhookUrl: "https://x.com" });
    const records = await dispatcher.broadcast(makeMsg(), hasEmail);
    expect(records).toHaveLength(1);
    expect(records[0]!.recipientId).toBe("email-only");
  });

  it("broadcast skips channel if canDeliver returns false", async () => {
    const emailCh = new NullChannel("email", (r) => !!r.email);
    dispatcher.addChannel(emailCh);
    dispatcher.addRecipient({ id: "no-email" });
    const records = await dispatcher.broadcast(makeMsg());
    const emailRecords = records.filter((r) => r.channel === "email");
    expect(emailRecords).toHaveLength(0);
  });

  it("getDeliveries returns all delivery records", async () => {
    dispatcher.addRecipient(makeRecipient());
    await dispatcher.broadcast(makeMsg("m1"));
    await dispatcher.broadcast(makeMsg("m2"));
    expect(dispatcher.getDeliveries()).toHaveLength(2);
  });

  it("getDeliveries filters by messageId", async () => {
    dispatcher.addRecipient(makeRecipient());
    await dispatcher.broadcast(makeMsg("m1"));
    await dispatcher.broadcast(makeMsg("m2"));
    expect(dispatcher.getDeliveries("m1")).toHaveLength(1);
    expect(dispatcher.getDeliveries("m1")[0]!.messageId).toBe("m1");
  });

  it("removeRecipient stops them receiving further broadcasts", async () => {
    dispatcher.addRecipient(makeRecipient({ id: "r1" }));
    dispatcher.addRecipient(makeRecipient({ id: "r2" }));
    dispatcher.removeRecipient("r1");
    const records = await dispatcher.broadcast(makeMsg());
    expect(records.every((r) => r.recipientId !== "r1")).toBe(true);
  });

  it("removeRecipient returns false for unknown recipient", () => {
    expect(dispatcher.removeRecipient("ghost")).toBe(false);
  });

  it("clearDeliveries empties the delivery log", async () => {
    dispatcher.addRecipient(makeRecipient());
    await dispatcher.broadcast(makeMsg());
    dispatcher.clearDeliveries();
    expect(dispatcher.getDeliveries()).toHaveLength(0);
  });

  it("multiple channels send to same recipient independently", async () => {
    const ch2 = new NullChannel("null2");
    dispatcher.addChannel(ch2);
    dispatcher.addRecipient(makeRecipient());
    const records = await dispatcher.broadcast(makeMsg());
    expect(records).toHaveLength(2); // one per channel
  });

  it("failed delivery records status='failed'", async () => {
    const failCh: IBroadcastChannel = {
      name: "fail",
      canDeliver: () => true,
      send: async (msg, r) => ({ recipientId: r.id, channel: "fail", success: false, error: "oops" }),
    };
    dispatcher.addChannel(failCh);
    dispatcher.addRecipient(makeRecipient());
    const records = await dispatcher.broadcast(makeMsg());
    const failed = records.find((r) => r.channel === "fail")!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("oops");
  });

  it("listRecipients returns all added recipients", () => {
    dispatcher.addRecipient(makeRecipient({ id: "a" }));
    dispatcher.addRecipient(makeRecipient({ id: "b" }));
    expect(dispatcher.listRecipients()).toHaveLength(2);
  });
});

interface IBroadcastChannel {
  name: string;
  canDeliver(recipient: Recipient): boolean;
  send(message: BroadcastMessage, recipient: Recipient): Promise<import("../src/index.js").SendResult>;
}

// ── BroadcastError ────────────────────────────────────────────────────────────

describe("BroadcastError", () => {
  it("has correct name, code, and message", () => {
    const e = new BroadcastError("delivery failed", "DELIVERY_FAILED");
    expect(e.name).toBe("BroadcastError");
    expect(e.code).toBe("DELIVERY_FAILED");
    expect(e instanceof Error).toBe(true);
  });
});
