// SPDX-License-Identifier: Apache-2.0
/**
 * Stage B1 — the maturity table is checked against how the routes are actually
 * mounted.
 *
 * `maturityForPath` classifies by URL because that is all the router knows when
 * the spec is built. A table like that rots: a surface extracted out of
 * api-bridge.ts keeps being tagged `bridge`, and a surface deleted keeps a stale
 * entry. These tests read `apiBridgeRoutes` and check both directions.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

import {
  maturityForPath,
  MATURITY_DESCRIPTION,
  type Maturity,
} from "../../src/lib/api-maturity.js";

const srcDir = path.resolve(__dirname, "../../src");
const maturitySrc = fs.readFileSync(path.join(srcDir, "lib/api-maturity.ts"), "utf8");
const bridgeSrc = fs.readFileSync(path.join(srcDir, "routes/api-bridge.ts"), "utf8");

/** The `/api/...` prefixes the table claims belong to a dedicated handler. */
function declaredDedicated(): string[] {
  const block = maturitySrc.slice(
    maturitySrc.indexOf("const DEDICATED_UNDER_API"),
    maturitySrc.indexOf("];", maturitySrc.indexOf("const DEDICATED_UNDER_API")),
  );
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** Route modules api-bridge.ts registers rather than serving itself. */
function registeredSubModules(): string[] {
  return [...bridgeSrc.matchAll(/from "\.\/([a-z0-9-]+)\.js"/g)]
    .map((m) => m[1] as string)
    .filter((name) => new RegExp(`\\b${name.replace(/-/g, "")}Routes\\b`, "i").test(bridgeSrc));
}

describe("maturityForPath", () => {
  it("classifies the versioned surface as durable", () => {
    expect(maturityForPath("/api/v1/council/deliberate")).toBe("durable");
    expect(maturityForPath("/api/v1/auth/login")).toBe("durable");
  });

  it("classifies the bridge as the bridge", () => {
    expect(maturityForPath("/api/leaderboard")).toBe("bridge");
    expect(maturityForPath("/api/chat/stream")).toBe("bridge");
    expect(maturityForPath("/api/ab/stats")).toBe("bridge");
  });

  it("classifies an extracted surface by its own storage, not by its mount", () => {
    expect(maturityForPath("/api/skills")).toBe("durable");
    expect(maturityForPath("/api/archetypes")).toBe("durable");
    // Extracted, but still a module-level Map.
    expect(maturityForPath("/api/sandbox/execute")).toBe("dedicated-volatile");
  });

  it("matches on whole segments, not on string prefixes", () => {
    // /api/skillsomething is not /api/skills.
    expect(maturityForPath("/api/skillsomething")).toBe("bridge");
  });

  it("treats the health probes as durable", () => {
    expect(maturityForPath("/health")).toBe("durable");
    expect(maturityForPath("/health/ready")).toBe("durable");
  });

  it("describes every maturity it can return", () => {
    const values: Maturity[] = ["durable", "dedicated-volatile", "bridge"];
    for (const v of values) expect(MATURITY_DESCRIPTION[v]).toBeTruthy();
  });
});

describe("the table against the mounts", () => {
  it("names a dedicated handler for every module api-bridge.ts registers", () => {
    const declared = declaredDedicated();
    // Module name → the path prefix it owns, where the two differ.
    const prefixFor: Record<string, string> = {
      "connectors-bridge": "/api/connectors",
      "memory-bridge": "/api/memory",
      "local-pty": "/api/pty",
      "stm-bridge": "/api/stm",
    };
    const missing = registeredSubModules().filter((mod) => {
      const prefix = prefixFor[mod] ?? `/api/${mod}`;
      return !declared.includes(prefix);
    });
    expect(missing).toEqual([]);
  });

  it("claims no prefix that no handler file owns", () => {
    const orphans = declaredDedicated().filter((prefix) => {
      const name = prefix.replace("/api/", "");
      const candidates = [name, `${name}-bridge`, name.replace("-", "")];
      return !candidates.some((c) => fs.existsSync(path.join(srcDir, "routes", `${c}.ts`)));
    });
    // local-pty.ts owns /pty: its file is named differently from the path it serves.
    expect(orphans).toEqual(["/api/pty"]);
  });
});
