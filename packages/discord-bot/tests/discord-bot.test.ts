// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  CommandRegistry,
  InteractionRouter,
  EmbedBuilder,
  messageResponse,
  embedResponse,
  deferredResponse,
  pongResponse,
  type DiscordInteraction,
  type CommandHandler,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInteraction(overrides: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return {
    id: "int-1",
    type: 2,
    token: "tok",
    data: { name: "ping", options: [] },
    member: { user: { id: "user-1", username: "Alice" } },
    ...overrides,
  };
}

// ── CommandRegistry ───────────────────────────────────────────────────────────

describe("CommandRegistry", () => {
  it("registers and retrieves a command", () => {
    const reg = new CommandRegistry();
    const handler: CommandHandler = () => ({ type: 4, data: { content: "pong" } });
    reg.register({ name: "ping", description: "Ping" }, handler);
    expect(reg.hasCommand("ping")).toBe(true);
    expect(reg.getHandler("ping")).toBe(handler);
  });

  it("returns undefined for unknown command", () => {
    const reg = new CommandRegistry();
    expect(reg.getHandler("ghost")).toBeUndefined();
    expect(reg.hasCommand("ghost")).toBe(false);
  });

  it("listCommands returns all definitions", () => {
    const reg = new CommandRegistry();
    reg.register({ name: "a", description: "A" }, () => ({ type: 4 }));
    reg.register({ name: "b", description: "B" }, () => ({ type: 4 }));
    expect(reg.listCommands()).toHaveLength(2);
  });

  it("toApplicationCommands equals listCommands", () => {
    const reg = new CommandRegistry();
    reg.register({ name: "x", description: "X" }, () => ({ type: 4 }));
    expect(reg.toApplicationCommands()).toEqual(reg.listCommands());
  });

  it("getDefinition returns the definition", () => {
    const reg = new CommandRegistry();
    reg.register({ name: "ping", description: "Ping the bot" }, () => ({ type: 4 }));
    expect(reg.getDefinition("ping")?.description).toBe("Ping the bot");
  });
});

// ── InteractionRouter ─────────────────────────────────────────────────────────

describe("InteractionRouter", () => {
  it("returns PONG for PING interaction (type=1)", async () => {
    const reg = new CommandRegistry();
    const router = new InteractionRouter(reg);
    const r = await router.handle({ ...makeInteraction(), type: 1 });
    expect(r.type).toBe(1);
  });

  it("routes to correct handler", async () => {
    const reg = new CommandRegistry();
    reg.register(
      { name: "ping", description: "Ping" },
      () => ({ type: 4, data: { content: "pong!" } }),
    );
    const router = new InteractionRouter(reg);
    const r = await router.handle(makeInteraction());
    expect(r.data?.content).toBe("pong!");
  });

  it("passes options to handler", async () => {
    const reg = new CommandRegistry();
    let received: string | undefined;
    reg.register({ name: "echo", description: "Echo" }, (ctx) => {
      received = ctx.options.get("message") as string;
      return { type: 4, data: { content: received } };
    });
    const router = new InteractionRouter(reg);
    await router.handle(
      makeInteraction({
        data: { name: "echo", options: [{ name: "message", value: "hello" }] },
      }),
    );
    expect(received).toBe("hello");
  });

  it("returns unknown response for unregistered command", async () => {
    const reg = new CommandRegistry();
    const router = new InteractionRouter(reg);
    const r = await router.handle(makeInteraction({ data: { name: "notfound" } }));
    expect(r.type).toBe(4);
    expect(r.data?.content).toContain("Unknown");
  });

  it("calls onUnknown handler when provided", async () => {
    const reg = new CommandRegistry();
    const onUnknown = vi.fn(() => ({ type: 4 as const, data: { content: "custom unknown" } }));
    const router = new InteractionRouter(reg, { onUnknown });
    await router.handle(makeInteraction({ data: { name: "notfound" } }));
    expect(onUnknown).toHaveBeenCalled();
  });

  it("catches handler errors and returns error response", async () => {
    const reg = new CommandRegistry();
    reg.register({ name: "boom", description: "Explode" }, () => {
      throw new Error("Something broke");
    });
    const router = new InteractionRouter(reg);
    const r = await router.handle(makeInteraction({ data: { name: "boom" } }));
    expect(r.data?.content).toContain("Something broke");
  });

  it("passes userId from member", async () => {
    const reg = new CommandRegistry();
    let uid: string | undefined;
    reg.register({ name: "whoami", description: "Who" }, (ctx) => {
      uid = ctx.userId;
      return { type: 4 };
    });
    const router = new InteractionRouter(reg);
    await router.handle(makeInteraction({ data: { name: "whoami" } }));
    expect(uid).toBe("user-1");
  });

  it("uses user field when member is absent", async () => {
    const reg = new CommandRegistry();
    let uid: string | undefined;
    reg.register({ name: "dm", description: "DM" }, (ctx) => {
      uid = ctx.userId;
      return { type: 4 };
    });
    const router = new InteractionRouter(reg);
    const interaction = makeInteraction({ data: { name: "dm" }, member: undefined, user: { id: "dm-user", username: "Bob" } });
    await router.handle(interaction);
    expect(uid).toBe("dm-user");
  });
});

// ── Response builders ─────────────────────────────────────────────────────────

describe("messageResponse", () => {
  it("creates a type-4 response", () => {
    const r = messageResponse("hello");
    expect(r.type).toBe(4);
    expect(r.data?.content).toBe("hello");
  });

  it("sets ephemeral flag", () => {
    const r = messageResponse("secret", true);
    expect(r.data?.flags).toBe(64);
  });
});

describe("embedResponse", () => {
  it("wraps embed in response", () => {
    const embed = new EmbedBuilder().setTitle("Test").build();
    const r = embedResponse(embed);
    expect(r.type).toBe(4);
    expect(r.data?.embeds?.[0]?.title).toBe("Test");
  });
});

describe("deferredResponse", () => {
  it("returns type 5", () => {
    expect(deferredResponse().type).toBe(5);
  });
});

describe("pongResponse", () => {
  it("returns type 1", () => {
    expect(pongResponse().type).toBe(1);
  });
});

// ── EmbedBuilder ──────────────────────────────────────────────────────────────

describe("EmbedBuilder", () => {
  it("builds a full embed", () => {
    const embed = new EmbedBuilder()
      .setTitle("Title")
      .setDescription("Desc")
      .setColor(0x7c3aed)
      .setFooter("Footer text")
      .setTimestamp()
      .addField("Field1", "Value1", true)
      .build();

    expect(embed.title).toBe("Title");
    expect(embed.description).toBe("Desc");
    expect(embed.color).toBe(0x7c3aed);
    expect(embed.footer?.text).toBe("Footer text");
    expect(embed.timestamp).toBeTruthy();
    expect(embed.fields?.[0]?.name).toBe("Field1");
    expect(embed.fields?.[0]?.inline).toBe(true);
  });

  it("builds an empty embed", () => {
    const embed = new EmbedBuilder().build();
    expect(embed).toEqual({});
  });

  it("supports method chaining", () => {
    const b = new EmbedBuilder();
    expect(b.setTitle("x")).toBe(b);
  });
});
