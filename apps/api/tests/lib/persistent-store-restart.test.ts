// SPDX-License-Identifier: Apache-2.0
/**
 * A JSON-file store gives back every entry under the key it was set with after a restart:
 * per-account (`.for()`) keys, composite keys like `owner:name`, and values with no `id`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

vi.mock("../../src/lib/pg-pool.js", () => ({ getPgPool: () => null }));
process.env.NEXUS_DATA_DIR = mkdtempSync(join(tmpdir(), "store-restart-"));

async function boot() {
  vi.resetModules();
  const { PersistentStore } = await import("../../src/lib/persistent-store.js");
  return PersistentStore;
}

it("keeps every entry under its own key across a restart", async () => {
  let Store = await boot();
  const before = new Store<Record<string, unknown>>("restart_probe");
  await before.load();
  before.for({ nexusUserId: "alice" }).set("k1", { id: "k1", v: 1 });
  before.set("alice:OPENAI_KEY", { owner: "alice", name: "OPENAI_KEY" });
  before.set("council:alice", { members: ["a", "b"] });

  Store = await boot();
  const after = new Store<Record<string, unknown>>("restart_probe");
  await after.load();
  expect(after.for({ nexusUserId: "alice" }).get("k1")).toEqual({ id: "k1", v: 1 });
  expect(after.get("alice:OPENAI_KEY")).toEqual({ owner: "alice", name: "OPENAI_KEY" });
  expect(after.get("council:alice")).toEqual({ members: ["a", "b"] });
  expect(after.size).toBe(3);
});

it("save resolves once the row is written, so another process can read it", async () => {
  const Store = await boot();
  const store = new Store<{ id: string }>("save_probe");
  await store.save("a", { id: "a" });
  const Again = await boot();
  const other = new Again<{ id: string }>("save_probe");
  await other.load();
  expect(other.get("a")).toEqual({ id: "a" });
});
