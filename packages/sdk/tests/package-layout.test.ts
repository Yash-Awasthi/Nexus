// SPDX-License-Identifier: Apache-2.0
/**
 * Regression guard (pass 84 packaging audit): @nexus/sdk must stay
 * consumable by plain Node — exports pointed at `./src/index.ts`, which Node
 * cannot load (relative `.js` → `.ts` imports). Fixed to the family layout:
 * main/types/exports → `./dist/index.js` + `./dist/index.d.ts`.
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

describe("@nexus/sdk package layout (plain-node consumability)", () => {
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