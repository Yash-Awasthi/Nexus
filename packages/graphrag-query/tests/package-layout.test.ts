// SPDX-License-Identifier: Apache-2.0
/**
 * Regression guard (pass 83 real-surface check): @nexus/graphrag-query must
 * stay consumable by plain Node — the CLI's built bin (and any ESM consumer)
 * resolves @nexus/* through package.json `exports`, and this package was the
 * only @nexus/* package pointing at `src/index.ts` with no `"type": "module"`.
 * That combination broke the shipped bin at load:
 *   - `main: src/index.ts` made Node load TS source and fail on the relative
 *     `.js` → `.ts` imports (ERR_MODULE_NOT_FOUND), and
 *   - the missing `"type": "module"` made tsc emit CJS, whose `require()` of
 *     sibling import-only-export packages failed (ERR_PACKAGE_PATH_NOT_EXPORTED).
 * Fix: `main`/`exports` → `./dist/index.js` + `"type": "module"` (matching
 * every sibling package). These assertions lock that layout in.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8"),
) as {
  type?: string;
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
};

describe("@nexus/graphrag-query package layout (plain-node consumability)", () => {
  it("is an ESM package (type: module), like every @nexus/* sibling", () => {
    expect(pkg.type).toBe("module");
  });

  it("points main/types at the built dist, not at TS source", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
  });

  it("exports '.' with an import condition at dist/index.js", () => {
    const dot = pkg.exports?.["."] as
      | { import?: string; types?: string }
      | string
      | undefined;
    if (typeof dot === "string") {
      expect(dot).toBe("./dist/index.js");
    } else {
      expect(dot?.import).toBe("./dist/index.js");
      expect(dot?.types).toBe("./dist/index.d.ts");
    }
  });
});