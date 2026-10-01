// SPDX-License-Identifier: Apache-2.0
/**
 * Stage D1 — the archetype registry is durable and per-user, and it is what
 * decides who sits on a council.
 *
 * The file-backed branch of PersistentStore is exercised here on purpose: the
 * shared test setup points DATABASE_URL at an unreachable host and stubs `pg`,
 * so the Postgres branch would write nowhere and prove nothing about restarts.
 * Clearing DATABASE_URL before the dynamic import selects the JSON-file branch,
 * and re-importing the module with a cleared registry is what a restart looks
 * like from the store's point of view.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

type StoreModule = typeof import("../../src/lib/archetype-store.js");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-archetype-store-"));
let previousDatabaseUrl: string | undefined;
let previousDataDir: string | undefined;

/** Import the store as a cold process would: empty module registry, no memory. */
async function bootStore(): Promise<StoreModule> {
  vi.resetModules();
  const mod = (await import("../../src/lib/archetype-store.js")) as StoreModule;
  await mod.loadArchetypeStore();
  return mod;
}

beforeAll(() => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDataDir = process.env.NEXUS_DATA_DIR;
  delete process.env.DATABASE_URL;
  process.env.NEXUS_DATA_DIR = dataDir;
});

afterAll(() => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousDataDir === undefined) delete process.env.NEXUS_DATA_DIR;
  else process.env.NEXUS_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("archetype registry durability", () => {
  it("keeps a custom archetype, and its model, across a restart", async () => {
    const first = await bootStore();
    const created = first.createArchetype("user-1", {
      name: "The Auditor",
      thinkingStyle: "Ledger-first",
      systemPrompt: "You are The Auditor.",
      model: "claude-sonnet-4-6",
      temperature: 0.2,
    });

    const second = await bootStore();
    const survivor = second.listCustomArchetypes("user-1").find((a) => a.id === created.id);
    expect(survivor).toBeDefined();
    expect(survivor?.model).toBe("claude-sonnet-4-6");
    expect(survivor?.temperature).toBe(0.2);
  });

  it("seeds the built-in personas and leaves them read-only", async () => {
    const store = await bootStore();
    const builtins = store.listArchetypes("user-1").filter((a) => a.builtin);
    expect(builtins.length).toBeGreaterThanOrEqual(14);
    expect(store.updateArchetype("user-1", "architect", { name: "Hijacked" })).toBe("readonly");
    expect(store.deleteArchetype("user-1", "architect")).toBe("readonly");
  });
});

describe("archetype registry scoping", () => {
  it("does not show or expose one user's archetype to another", async () => {
    const store = await bootStore();
    const mine = store.createArchetype("owner-a", { name: "Mine", systemPrompt: "p" });

    expect(store.listCustomArchetypes("owner-b").some((a) => a.id === mine.id)).toBe(false);
    expect(store.updateArchetype("owner-b", mine.id, { name: "Stolen" })).toBe("not_found");
    expect(store.deleteArchetype("owner-b", mine.id)).toBe("not_found");
    expect(store.listCustomArchetypes("owner-a").some((a) => a.id === mine.id)).toBe(true);
  });
});

describe("resolveCouncilMembers", () => {
  it("seats the caller's own archetype, carrying its model", async () => {
    const store = await bootStore();
    store.createArchetype("owner-c", {
      name: "The Auditor",
      systemPrompt: "You are The Auditor.",
      model: "gpt-4o",
      temperature: 0.1,
    });

    const members = store.resolveCouncilMembers("owner-c", "technical", 5);
    const auditor = members.find((m) => m.name === "The Auditor");
    expect(auditor).toBeDefined();
    expect(auditor?.model).toBe("gpt-4o");
    expect(auditor?.temperature).toBe(0.1);
    expect(members).toHaveLength(5);
  });

  it("fills the remaining seats from the summons for the category", async () => {
    const store = await bootStore();
    const members = store.resolveCouncilMembers("owner-with-nothing", "technical", 5);
    expect(members.map((m) => m.id)).toEqual([
      "architect",
      "minimalist",
      "empiricist",
      "outsider",
      "strategist",
    ]);
  });

  it("never seats more members than asked for", async () => {
    const store = await bootStore();
    for (let i = 0; i < 8; i += 1) {
      store.createArchetype("owner-d", { name: `Member ${i}`, systemPrompt: `p${i}` });
    }
    expect(store.resolveCouncilMembers("owner-d", "default", 3)).toHaveLength(3);
  });
});

describe("copies of built-in personas", () => {
  it("drops a custom row that only repeats a built-in, and keeps an edited one", async () => {
    const first = await bootStore();
    const builtin = first.listArchetypes("user-copy").find((a) => a.id === "contrarian")!;
    first.createArchetype("user-copy", {
      name: builtin.name,
      thinkingStyle: builtin.thinkingStyle,
      systemPrompt: builtin.systemPrompt,
    });
    const edited = first.createArchetype("user-copy", {
      name: builtin.name,
      thinkingStyle: builtin.thinkingStyle,
      systemPrompt: `${builtin.systemPrompt} Focus on pricing.`,
    });

    const second = await bootStore();
    expect(second.listCustomArchetypes("user-copy").map((a) => a.id)).toEqual([edited.id]);
  });
});
