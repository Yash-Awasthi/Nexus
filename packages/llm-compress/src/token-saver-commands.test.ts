// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { compressOutputForCommand } from "./token-saver.js";

describe("lintOutputProcessor", () => {
  /** Violation lines per rule: (col, rule) repeated across two files. */
  const block = (file: string, cols: [number, string][]): string[] =>
    cols.map(([col, rule]) => `  ${col}:${col + 2}  error  message for ${rule}  ${rule}`);
  const eslintOut = [
    "src/a.ts",
    ...block("src/a.ts", [[1, "no-var"], [2, "no-var"], [3, "no-var"], [4, "no-var"], [10, "semi"], [11, "semi"], [12, "semi"], [13, "semi"]]),
    "src/b.ts",
    ...block("src/b.ts", [[1, "no-var"], [2, "no-var"], [3, "no-var"], [4, "no-var"], [10, "semi"], [11, "semi"], [12, "semi"], [13, "semi"]]),
    "",
    "✖ 16 problems (16 errors, 0 warnings)",
  ].join("\n");

  it("routes an eslint command and groups violations per rule with file tally", () => {
    const r = compressOutputForCommand("npx eslint src", eslintOut);
    expect(r.processor).toBe("lint");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("16 issues across 2 rules:");
    // 8 occurrences across both files group with a file count; 2 examples shown.
    expect(r.output).toContain("  semi: 8 occurrences in 2 files");
    expect(r.output).toContain("  no-var: 8 occurrences in 2 files");
    expect(r.output).toContain("... (6 more)");
    expect(r.output).toContain("✖ 16 problems (16 errors, 0 warnings)");
  });

  it("parses ruff inline and mypy bracket-code formats", () => {
    const ruff = [
      "src/app.py:10:5: E501 line too long",
      "src/app.py:11:5: E501 line too long",
      "src/app.py:12:5: E501 line too long",
      "src/app.py:13:5: E501 line too long",
      "src/app.py:14:5: E501 line too long",
      "src/app.py:15:5: E501 line too long",
      "src/util.py:1:1: F401 'os' imported but unused",
    ].join("\n");
    const r = compressOutputForCommand("ruff check .", ruff);
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("7 issues across 2 rules:");
    // single-file rules only show the file tally when spread across >1 file
    expect(r.output).toContain("  E501: 6 occurrences");
    expect(r.output).toContain("  src/util.py:1:1: F401 'os' imported but unused");

    const mypyLines: string[] = [];
    for (let i = 0; i < 8; i++) mypyLines.push(`app.py:${10 + i}: error: Missing return statement  [no-any-return]`);
    const rm = compressOutputForCommand("mypy app.py", mypyLines.join("\n"));
    expect(rm.wasCompressed).toBe(true);
    expect(rm.output).toContain("8 issues across 1 rules:");
    expect(rm.output).toContain("  no-any-return: 8 occurrences");
  });

  it("leaves output untouched when no violations are parsed (summary-only)", () => {
    const out = "Found 0 errors. Everything clean.";
    const r = compressOutputForCommand("eslint .", out);
    expect(r.processor).toBe("lint");
    expect(r.wasCompressed).toBe(false);
    expect(r.output).toBe(out);
  });
});

describe("structuredLogProcessor", () => {
  const entries = (n: number, level = "info", msg = "request handled"): string =>
    Array.from({ length: n }, (_, i) => JSON.stringify({ ts: `2026-01-01T00:00:0${i % 10}Z`, level, msg: `${msg} ${i}` })).join("\n");

  it("routes a stern command with >50% JSON lines to a level tally + errors", () => {
    const logs = [
      entries(12, "info"),
      entries(6, "warn", "slow query"),
      entries(2, "error", "connection refused"),
      "not json at all",
      "also not json",
    ].join("\n");
    const r = compressOutputForCommand("stern api-server", logs);
    expect(r.processor).toBe("structured_log");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("20 log entries:");
    expect(r.output).toContain("  error: 2");
    expect(r.output).toContain("  warn: 6");
    expect(r.output).toContain("  info: 12");
    expect(r.output).toContain("[ERROR] connection refused 0");
    expect(r.output).toContain("[ERROR] connection refused 1");
  });

  it("falls back to head/error/tail compression below the 50% JSON threshold", () => {
    const logs = Array.from({ length: 40 }, (_, i) => `2026-01-01T00:00:0${i % 10}Z [INFO] plain line ${i}`).join("\n");
    const r = compressOutputForCommand("stern api", logs);
    expect(r.processor).toBe("structured_log");
    expect(r.wasCompressed).toBe(true);
    // head 5 + tail 10 kept, middle dropped with a truncation marker.
    expect(r.output).toContain("plain line 0");
    expect(r.output).toContain("plain line 39");
    expect(r.output).toContain("lines truncated");
  });
});

describe("packageListProcessor", () => {
  const pipRows = (n: number): string => {
    const rows: string[] = ["Package    Version", "---------- -------"];
    for (let i = 0; i < n; i++) rows.push(`pkg-${String(i).padStart(2, "0")} ${i}.${i}.${i}`);
    return rows.join("\n");
  };

  it("collapses long pip list output to a count + top entries", () => {
    const r = compressOutputForCommand("pip list", pipRows(50));
    expect(r.processor).toBe("package_list");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("50 packages installed:");
    expect(r.output).toContain("  pkg-00 0.0.0");
    expect(r.output).toContain("... (35 more)");
    // headers are never counted
    expect(r.output).not.toContain("Package    Version");
  });

  it("keeps npm ls under 20 lines untouched and compresses trees over it", () => {
    const small = ["proj@1.0.0 /w/proj", "└── lodash@4.17.21"].join("\n");
    expect(compressOutputForCommand("npm ls", small).output).toBe(small);

    const lines = ["proj@1.0.0 /w/proj", "├── dep-a@1.0.0", "│   └── dep-b@0.2.0"];
    for (let i = 0; i < 30; i++) lines.push(`├── flat-pkg-${i}@1.0.0`);
    lines.push("└── broken@2.0.0", "", "npm ERR! missing: broken@2.0.0");
    const r = compressOutputForCommand("npm ls --all", lines.join("\n"));
    expect(r.output).toContain("33 total dependencies:");
    expect(r.output).toContain("Issues (1):");
    expect(r.output).toContain("Top-level");
  });

  it("handles pip freeze and conda list count formats", () => {
    const freeze = Array.from({ length: 30 }, (_, i) => `pkg==${i}.0.0`).join("\n");
    const rf = compressOutputForCommand("pip3 freeze", freeze);
    expect(rf.output).toContain("30 packages:");
    const conda = Array.from({ length: 25 }, (_, i) => `lib${i}        1.0.${i}    conda-forge`).join("\n");
    const rc = compressOutputForCommand("conda list", conda);
    expect(rc.output).toContain("25 packages installed:");
  });
});

describe("fileListingProcessor", () => {
  const longListing = [
    "total 96",
    "drwxr-xr-x  5 alice dev   160 Jan 17 12:34 src",
    "-rw-r--r--  1 alice dev  2048 Jan 17 12:31 index.ts",
    "-rw-r--r--  1 alice dev  4096 Jan 17 12:31 app.ts",
    "-rw-r--r--  1 alice dev  1024 Jan 17 12:31 util.ts",
    "-rw-r--r--  1 alice dev   512 Jan 17 12:31 test.ts",
    "lrwxrwxrwx  1 alice dev    12 Jan 17 12:31 latest -> app.ts",
  ].join("\n");

  it("strips ls -l metadata to type/size/name", () => {
    const r = compressOutputForCommand("ls -la", longListing);
    expect(r.processor).toBe("file_listing");
    expect(r.output).toContain("  src/");
    expect(r.output).toContain("2K  index.ts");
    expect(r.output).toContain("4K  app.ts");
    expect(r.output).toContain("512B  test.ts");
    expect(r.output).toContain("latest");
    expect(r.output).not.toContain("alice");
    expect(r.output).not.toContain("total 96");
  });

  it("groups plain long ls output by extension above the threshold", () => {
    const items = ["src:", "index.ts", "app.ts", "util.ts", "test.ts", "logo.png", "README.md"];
    for (let i = 0; i < 10; i++) items.push(`module${i}.ts`);
    const r = compressOutputForCommand("ls", items.join("\n"));
    expect(r.output).toContain("17 items:");
    expect(r.output).toContain("  dirs (1): src:");
    expect(r.output).toContain("*.ts (14):");
    expect(r.output).toContain("*.png: logo.png");
    expect(r.output).toContain("*.md: README.md");
  });

  it("groups find output by directory with file counts", () => {
    const paths: string[] = [];
    for (let i = 0; i < 8; i++) paths.push(`src/handlers/h${i}.ts`);
    paths.push("src/handlers/h8.ts", "src/handlers/h9.ts");
    for (let i = 0; i < 30; i++) paths.push(`test/t${i}.test.ts`);
    const r = compressOutputForCommand("find . -name '*.ts'", paths.join("\n"));
    expect(r.output).toContain("40 files found:");
    expect(r.output).toContain("  src/handlers/ (10 files): h0.ts, h1.ts, h2.ts ...");
    expect(r.output).toContain("  test/ (30 files: *.ts:30)");
  });

  it("keeps tree under the threshold and truncates over it with its summary", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `│   ├── file${i}.ts`);
    lines.push("12 directories, 40 files");
    const r = compressOutputForCommand("tree -a src", lines.join("\n"));
    expect(r.processor).toBe("file_listing");
    expect(r.output).toContain("lines truncated");
    expect(r.output).toContain("12 directories, 40 files");
  });
});

describe("searchProcessor", () => {
  const matches = (file: string, n: number, seed = "TODO"): string[] =>
    Array.from({ length: n }, (_, i) => `${file}:${i + 1}:${seed} marker ${i}`);

  it("groups rg output per file with per-file caps", () => {
    const lines = [...matches("src/a.ts", 6), ...matches("src/b.ts", 7), ...matches("src/c.ts", 7)];
    const r = compressOutputForCommand("rg TODO src", lines.join("\n"));
    expect(r.processor).toBe("search");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("20 matches across 3 files:");
    expect(r.output).toContain("src/b.ts: (7 matches)");
    // per-file cap of 3: content lines shown with line numbers but no file prefix
    expect(r.output).toContain("  1:TODO marker 0");
    expect(r.output).toContain("  ... (4 more)");
  });

  it("rolls very large result sets up per directory", () => {
    const lines: string[] = [];
    for (let f = 0; f < 20; f++) lines.push(...matches(`src/gen${f}.ts`, 4, "FIXME"));
    for (let f = 0; f < 20; f++) lines.push(...matches(`test/gen${f}.test.ts`, 3, "FIXME"));
    const r = compressOutputForCommand("rg FIXME .", lines.join("\n"));
    expect(r.processor).toBe("search");
    expect(r.output).toContain("140 matches across 40 files in 2 directories:");
    expect(r.output).toContain("src/ (80 matches in 20 files)");
    expect(r.output).toContain("test/ (60 matches in 20 files)");
    expect(r.output).toContain("... (17 more files in this directory)");
  });

  it("leaves short or single-plain-match output untouched", () => {
    const small = "a.ts:1:TODO x";
    const r = compressOutputForCommand("rg TODO", small);
    expect(r.wasCompressed).toBe(false);
    expect(r.output).toBe(small);
  });

  it("delegates fd file listings to directory grouping", () => {
    const paths: string[] = [];
    for (let i = 0; i < 12; i++) paths.push(`lib/helper${i}.ts`);
    for (let i = 0; i < 12; i++) paths.push(`bin/run${i}.ts`);
    const r = compressOutputForCommand("fd -e ts", paths.join("\n"));
    expect(r.output).toContain("24 files found:");
    expect(r.output).toContain("  lib/ (12 files: *.ts:12)");
    expect(r.output).toContain("  bin/ (12 files: *.ts:12)");
  });
});
