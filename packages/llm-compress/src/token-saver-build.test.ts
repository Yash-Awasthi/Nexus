// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { cargoClippyProcessor, compressOutputForCommand } from "./token-saver.js";

describe("buildOutputProcessor — error retention", () => {
  const errorLog = [
    "> tsc -p tsconfig.json",
    "",
    "src/index.ts:4:13 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "",
    "  4 const x: number = 'hello';",
    "                ~",
    "",
    "  Found 1 error in src/index.ts.",
    "",
    "error Command failed with exit code 1.",
  ].join("\n");

  it("routes an npm build command and retains error blocks over a terse summary", () => {
    const r = compressOutputForCommand("npm run build", errorLog);
    expect(r.processor).toBe("build");
    expect(r.wasCompressed).toBe(true);
    // TS error + its code-frame survive; summary and failure lines remain.
    expect(r.output).toContain("error TS2322:");
    expect(r.output).toContain("const x: number = 'hello';");
    expect(r.output).toContain("Found 1 error");
  });

  it("drops install progress noise while keeping a compile error", () => {
    const out = [
      "npm WARN deprecated old-pkg@1.0.0",
      "added 42 packages, and audited 43 packages in 2s",
      "[1/4] Resolving packages...",
      "Compiling mypkg v0.1.0",
      "",
      "error[E0308]: mismatched types",
      "  --> src/lib.rs:10:5",
      "   |",
      '10 |     let x: i32 = "s";',
      "   |     ^^^",
      "error: could not compile `mypkg` due to previous error",
    ].join("\n");
    const r = compressOutputForCommand("npm install mypkg", out);
    expect(r.processor).toBe("build");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("error[E0308]: mismatched types");
    expect(r.output).toContain("could not compile");
    expect(r.output).not.toContain("added 42 packages");
    expect(r.output).not.toContain("Compiling mypkg");
  });

  it("summarizes a clean build with warning count + final output line", () => {
    const out = [
      "> webpack --mode production",
      "assets by status 240 KiB [compared for emit]",
      "  asset main.js 231 KiB [emitted] [minimized]",
      "webpack compiled successfully",
      "2 warnings",
    ].join("\n");
    const r = compressOutputForCommand("npm run build", out);
    expect(r.processor).toBe("build");
    expect(r.wasCompressed).toBe(true);
    // python's warn(ing)?\b does not match the plural "warnings" line, so no count
    expect(r.output).toContain("Build succeeded.");
    expect(r.output).toContain("webpack compiled successfully");
    expect(r.output).not.toContain("2 warnings");
  });

  it("keeps piped output untouched (partial output guard)", () => {
    const out = "Building...  [0/1] step\\nBuild failed with error here";
    const r = compressOutputForCommand("npm run build | tee build.log", out);
    expect(r.processor).toBe("build");
    expect(r.wasCompressed).toBe(false);
    expect(r.output).toBe(out);
  });

  it("groups tsc --noEmit errors per TS code", () => {
    const lines: string[] = [];
    for (let i = 0; i < 6; i++)
      lines.push(`src/f${i}.ts(${10 + i},5): error TS2322: type mismatch`);
    lines.push("src/a.ts(1,1): error TS2304: Cannot find name 'x'.");
    lines.push("Found 7 errors.");
    const r = compressOutputForCommand("npx tsc --noEmit", lines.join("\n"));
    expect(r.processor).toBe("build");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("7 type errors across 2 codes:");
    expect(r.output).toContain("  TS2322: 6 occurrences");
    expect(r.output).toContain("    ... (4 more)");
    expect(r.output).toContain("Found 7 errors.");
  });
});

describe("buildOutputProcessor — audit and docker", () => {
  it("groups npm audit output by severity with package names", () => {
    const out = [
      "=== npm audit security report ===",
      "lodash  <4.17.21",
      "Severity: high",
      "minimist  <1.2.6",
      "Severity: critical",
      "ws  <7.4.6",
      "Severity: high",
      "3 vulnerabilities found",
      "Run `npm audit fix` to fix them.",
    ].join("\n");
    const r = compressOutputForCommand("npm audit --audit-level=high", out);
    expect(r.processor).toBe("build");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("3 vulnerabilities found:");
    expect(r.output).toContain("  critical: 1 (minimist)");
    expect(r.output).toContain("  high: 2 (lodash, ws)");
    expect(r.output).toContain("Run `npm audit fix` to fix them.");
  });

  it("keeps docker build steps + final tag and drops sha/progress noise", () => {
    const out = [
      "Step 1/3 : FROM node:20",
      " ---> a1b2c3d4e5f6",
      "Step 2/3 : RUN npm ci",
      " ---> Running in abc123def456",
      "Downloading base layers 45%",
      'Step 3/3 : CMD ["node", "index.js"]',
      " ---> b2c3d4e5f6a7",
      "Successfully built c3d4e5f6a7b8",
      "Successfully tagged app:latest",
    ].join("\n");
    const r = compressOutputForCommand("docker build -t app .", out);
    expect(r.processor).toBe("build");
    expect(r.output).toContain("Step 1/3 : FROM node:20");
    expect(r.output).toContain("Successfully built c3d4e5f6a7b8");
    expect(r.output).not.toContain("Downloading");
    expect(r.output).not.toContain("Running in");
    expect(r.output).not.toContain("45%");
  });
});

describe("cargoClippyProcessor", () => {
  // N repeated standalone rustc warnings, each with span/help context.
  // Rustc emits the lint id in the prefix bracket: warning[rule]: message.
  function warnings(rule: string, msg: string, count: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(
        `warning[${rule}]: ${msg}`,
        `  --> src/lib.rs:${20 + i}:5`,
        "   |",
        "11 |     some code",
        "   |",
        `   = help: change it`,
        "",
      );
    }
    return lines;
  }

  it("routes cargo clippy to the processor and reports checked + grouped rules", () => {
    const lines = [
      "Checking mypkg v0.1.0",
      ...warnings("needless_return", "unneeded `return` statement", 4),
    ];
    lines.push("warning: 1 warning emitted", "    Finished `dev` profile");
    const out = lines.join("\n");
    const r = compressOutputForCommand("cargo clippy --all-targets", out);
    expect(r.processor).toBe("cargo_clippy");
    expect(r.wasCompressed).toBe(true);
    // The processor itself (engine chain to lint may or may not re-group).
    const p = cargoClippyProcessor.process("cargo clippy --all-targets", out);
    expect(p).toContain("[1 checked]");
    expect(p).toContain("warning[needless_return] (style): 4 occurrences");
    expect(p).toContain("... (2 more)");
    expect(p).toContain("Finished");
  });

  it("keeps full error blocks and counts compiled crates", () => {
    const out = [
      "Compiling mypkg v0.1.0",
      "error[E0308]: mismatched types",
      "  --> src/lib.rs:9:5",
      "   |",
      '9  |     let x: i32 = "s";',
      "   |         ^",
      "   |",
      "   = note: expected `i32`, found `&str`",
    ].join("\n");
    const p = cargoClippyProcessor.process("cargo clippy", out);
    expect(p).toContain("[1 compiled]");
    expect(p).toContain("error[E0308]: mismatched types");
    expect(p).toContain("expected `i32`, found `&str`");
  });
});
