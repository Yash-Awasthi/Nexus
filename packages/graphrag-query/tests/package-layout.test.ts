// SPDX-License-Identifier: Apache-2.0
/**
 * Regression guard: @nexus/graphrag-query must stay consumable by plain Node. Inside the
 * workspace it exports its TypeScript source, which Node 26 loads by stripping
 * types (relative imports name the .ts file); the published manifest swaps in
 * the compiled dist through publishConfig.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Manifest {
  type?: string;
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  publishConfig?: Manifest;
}
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as Manifest;

describe("@nexus/graphrag-query package layout (plain-node consumability)", () => {
  it("is an ESM package (type: module), like every @nexus/* sibling", () => {
    expect(pkg.type).toBe("module");
  });

  it("exports its source inside the workspace", () => {
    expect(pkg.main).toBe("./src/index.ts");
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
  });

  it("publishes main/types/exports from the built dist", () => {
    expect(pkg.publishConfig?.main).toBe("./dist/index.js");
    expect(pkg.publishConfig?.types).toBe("./dist/index.d.ts");
    expect(pkg.publishConfig?.exports?.["."]).toEqual({
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
  });

  it("loads in plain Node without a loader", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import('@nexus/graphrag-query'); console.log(Object.keys(m).length > 0);",
      ],
      { cwd: resolve(__dirname, ".."), encoding: "utf8" },
    );
    expect(out.trim()).toBe("true");
  });
});
