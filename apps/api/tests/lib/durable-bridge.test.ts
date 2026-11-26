// SPDX-License-Identifier: Apache-2.0
/**
 * The maturity tags in the spec are a promise to whoever builds on the API:
 * `durable` means the data is still there after a restart, `bridge` means the
 * response is synthetic. The promise breaks in one specific, quiet way — a route
 * gets extracted out of `api-bridge.ts`, keeps writing to a real store, and keeps
 * its `bridge` tag because nobody re-checked the table.
 *
 * These tests read the route registrations and hold the two to each other:
 *
 *   forward — a bridge-file handler that writes durable state may not be tagged
 *             `bridge` (that is the extraction case above);
 *   reverse — a route a bridge file serves may be tagged `durable` only if that
 *             file actually has storage behind it.
 *
 * Registration literals are relative to `/api`, because every bridge file is
 * registered inside the `/api`-prefixed scope in `server.ts`. Handlers are located
 * by their own registration line, so the window for the write check is exactly
 * one handler and cannot borrow a write from the next one.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vite-plus/test";

import { maturityForPath } from "../../src/lib/api-maturity.ts";

const srcDir = path.resolve(__dirname, "../../src");
const routesDir = path.join(srcDir, "routes");

/** Registered inside the `/api` scope in server.ts; literals are therefore relative. */
const BRIDGE_FILES = ["api-bridge.ts", "billing-bridge.ts", "memory-bridge.ts"] as const;

/** Writes that outlive the process. A read of a store is not in this list. */
const DURABLE_WRITE = new RegExp(
  [
    // SQL, filesystem, and persistence primitives.
    String.raw`\bdb\.(insert|update|delete)\(`,
    String.raw`INSERT INTO|UPDATE \w+ SET`,
    String.raw`writeFile(Sync)?\(|appendFile(Sync)?\(`,
    // A method on something that looks like a store: `mem.forget(...)`,
    // `costLog.record(...)`, `store.put(...)`. Reads (`mem.list(...)`) are not
    // writes and must not be reported as one.
    String.raw`\b(mem|memory|store|\w+Store|\w+Repo|repo|db)\s*\.\s*(forget|delete|deleteAll|put|upsert|append|remove|save|record|write|persist|set)\s*\(`,
  ].join("|"),
);

/** Anything that ties a file to storage at all — enough for the reverse check. */
const STORAGE_PLUMBING =
  /PersistentStore|persistentStore|costLogStore|costLog|drizzle|nezus_kv|nexus_kv|getMemory|\.query\(/;

const REGISTRATION = /\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*["'`]([^"'`]+)/;

export interface BridgeRoute {
  file: string;
  method: string;
  /** Mounted path: `/api` + the registration literal. */
  path: string;
  /** Handler source, from its registration line to the next registration. */
  body: string;
}

/** Every route a bridge file registers, with the body of its handler. */
export function bridgeRoutes(files: readonly string[]): BridgeRoute[] {
  const found: BridgeRoute[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(routesDir, file), "utf8").split("\n");
    const starts: { line: number; method: string; literal: string }[] = [];
    lines.forEach((line, index) => {
      const match = REGISTRATION.exec(line);
      if (match) starts.push({ line: index, method: match[1]!.toUpperCase(), literal: match[2]! });
    });
    starts.forEach((start, index) => {
      const end = starts[index + 1]?.line ?? lines.length;
      found.push({
        file,
        method: start.method,
        path: `/api${start.literal}`,
        body: lines.slice(start.line, end).join("\n"),
      });
    });
  }
  return found;
}

/** Bridge-tagged routes whose handler writes to durable storage anyway. */
export function mislabelled(route: BridgeRoute): boolean {
  return DURABLE_WRITE.test(route.body) && maturityForPath(route.path) === "bridge";
}

describe("a bridge route may not write durable state", () => {
  const routes = bridgeRoutes(BRIDGE_FILES);

  it("has routes to check — a scan that finds nothing must not pass", () => {
    // Without this, a refactor that changes how routes are registered would turn
    // every assertion below into a vacuous pass.
    expect(routes.length).toBeGreaterThanOrEqual(12);
    expect(routes.filter((r) => DURABLE_WRITE.test(r.body)).length).toBeGreaterThanOrEqual(2);
  });

  it("tags every writing bridge handler durable", () => {
    const offenders = routes
      .filter(mislabelled)
      .map((r) => `${r.method} ${r.path} (${r.file}) writes durable state but is tagged bridge`);
    expect(offenders).toEqual([]);
  });

  it("reports a handler that writes through a store as mislabelled", () => {
    // The check above is only worth anything if it would notice the extraction.
    const extracted: BridgeRoute = {
      file: "api-bridge.ts",
      method: "POST",
      path: "/api/ab/skills",
      body: `  app.post("/ab/skills", async (request, reply) => {
    await skillsStore.save({ name: request.body.name });
    return reply.send({ ok: true });
  });`,
    };
    expect(mislabelled(extracted)).toBe(true);
    // ...and a handler whose state is a module-level Map is fine as bridge.
    const inMemory: BridgeRoute = {
      file: "api-bridge.ts",
      method: "POST",
      path: "/api/ab/assign",
      body: `  app.post("/ab/assign", async (request, reply) => {
    variants.set(request.body.id, request.body.variant);
    return reply.send({ ok: true });
  });`,
    };
    expect(mislabelled(inMemory)).toBe(false);
  });

  it("keeps storage behind every route a bridge file tags durable", () => {
    // The other direction: a route is only `durable` because something persists
    // it. A bridge file with no storage plumbing at all cannot honestly serve one.
    const durablePaths = routes.filter((r) => maturityForPath(r.path) === "durable");
    expect(durablePaths.length).toBeGreaterThan(0);
    const plumbedFiles = new Set(
      BRIDGE_FILES.filter((file) =>
        STORAGE_PLUMBING.test(fs.readFileSync(path.join(routesDir, file), "utf8")),
      ),
    );
    const unearned = durablePaths
      .filter((r) => !plumbedFiles.has(r.file as (typeof BRIDGE_FILES)[number]))
      .map((r) => `${r.method} ${r.path} (${r.file}) is tagged durable with no store in the file`);
    expect(unearned).toEqual([]);
  });
});
