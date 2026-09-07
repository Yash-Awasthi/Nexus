// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { compressOutputForCommand } from "./token-saver.js";

function bigDiff(additions: number): string {
  const lines = [
    "diff --git a/src/worker.ts b/src/worker.ts",
    "index 1111111..2222222 100644",
    "--- a/src/worker.ts",
    "+++ b/src/worker.ts",
    "@@ -10,0 +11," + additions + " @@ export function run() {",
  ];
  for (let i = 0; i < additions; i++) lines.push(`+const line${i} = ${i};`);
  return lines.join("\n");
}

describe("gitOutputProcessor — diff", () => {
  it("routes git diff and truncates an oversized single hunk with a marker", () => {
    const out = bigDiff(60);
    const r = compressOutputForCommand("git diff", out);
    expect(r.processor).toBe("git");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("diff --git a/src/worker.ts b/src/worker.ts");
    // 50 of the 60 added lines survive; the rest truncate.
    expect(r.output).toContain("+const line0 = 0;");
    expect(r.output).toContain("+const line49 = 49;");
    expect(r.output).not.toContain("+const line50 = 50;");
    expect(r.output).toContain("... (truncated after 50 lines)");
    // index/---/+++ header lines are dropped, @@ kept
    expect(r.output).not.toContain("index 1111111");
    expect(r.output).not.toContain("--- a/src/worker.ts");
    expect(r.output).toContain("@@ -10,0 +11,60 @@");
  });

  it("preserves metadata for hunk-less diffs (renames/binary)", () => {
    const out = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");
    const r = compressOutputForCommand("git diff -M", out);
    expect(r.output).toContain("similarity index 100%");
    expect(r.output).toContain("rename from old.ts");
    expect(r.output).toContain("rename to new.ts");
  });

  it("reduces lockfile diffs to a one-line summary and compresses the real diff", () => {
    const lockLines = [
      "diff --git a/package-lock.json b/package-lock.json",
      "index aaaa..bbbb 100644",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1,3 +1,5 @@",
    ];
    for (let i = 0; i < 30; i++) lockLines.push(`+  "dep-${i}": {`);
    const appLines = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index cccc..dddd 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -5,7 +5,7 @@ export function main() {",
      "     const x = 1;",
      "-    oldCall();",
      "+    newCall();",
      "     const y = 2;",
    ];
    const r = compressOutputForCommand("git diff", [...lockLines, ...appLines].join("\n"));
    expect(r.processor).toBe("git");
    expect(r.output).toContain("diff --git package-lock.json");
    expect(r.output).toContain("(lockfile changed, ");
    // the real file's change survives, intact
    expect(r.output).toContain("-    oldCall();");
    expect(r.output).toContain("+    newCall();");
    // lockfile body itself never appears
    expect(r.output).not.toContain('"dep-0"');
  });

  it("groups --name-status output by directory above 20 lines", () => {
    const files: string[] = [];
    for (let i = 0; i < 25; i++) files.push(`M\tsrc/gen/f${i}.ts`);
    for (let i = 0; i < 3; i++) files.push(`A\tREADME${i}.md`);
    const r = compressOutputForCommand("git diff --name-status HEAD~1", files.join("\n"));
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("28 files changed:");
    expect(r.output).toContain("  src/gen/ (25 files)");
    expect(r.output).toContain("  A\tREADME0.md");
  });

  it("strips +/- bars from short --stat output", () => {
    const out = [" src/a.ts | 12 +++++-------", " src/b.ts | 3 ---", " 2 files changed, 15 insertions(+)"].join("\n");
    const r = compressOutputForCommand("git diff --stat", out);
    expect(r.processor).toBe("git");
    expect(r.output).toContain(" src/a.ts | 12");
    expect(r.output).not.toContain("+++++");
  });
});

describe("gitOutputProcessor — status/branch/log/transfer/blame", () => {
  it("summarizes a long verbose status into counts + per-directory lines", () => {
    const lines = ["On branch feature/x", "Your branch is ahead of 'origin/main' by 3 commits."];
    for (let i = 0; i < 6; i++) lines.push(`\tmodified:   src/handlers/h${i}.ts`);
    lines.push("\tnew file:   src/handlers/hnew.ts", "\tdeleted:    docs/old.md");
    const r = compressOutputForCommand("git status", lines.join("\n"));
    expect(r.processor).toBe("git");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("On branch feature/x");
    expect(r.output).toContain("Files: 8 (A:1, D:1, M:6)");
    // 7 changes under src/handlers > 8-file collapse threshold? no: 7 files <= 8 → listed raw
    expect(r.output).toContain("src/handlers/M h0.ts");
    expect(r.output).toContain("docs/D old.md");
  });

  it("compresses the short format with dirs when many files change", () => {
    const lines = ["## main...origin/main"];
    for (let i = 0; i < 12; i++) lines.push(` M src/gen/f${i}.ts`);
    const r = compressOutputForCommand("git status --short", lines.join("\n"));
    expect(r.output).toContain("Files: 12 (M:12)");
    expect(r.output).toContain("  src/gen/ (12 files: M:12)");
  });

  it("keeps a clean working tree untouched", () => {
    const out = ["On branch main", "Your branch is up to date with 'origin/main'.", "nothing to commit, working tree clean"].join("\n");
    const r = compressOutputForCommand("git status", out);
    expect(r.processor).toBe("git");
    expect(r.wasCompressed).toBe(false);
  });

  it("compacts full git log to hash + subject per commit", () => {
    const entries: string[] = [];
    for (let i = 0; i < 15; i++) {
      const hash = `abc${String(i).padStart(37, "0")}`;
      entries.push(`commit ${hash}`, `Author: Dev <dev@x.io>`, `Date:   2026-01-0${i % 10} 10:00:00 +0000`, "", `    fix: item ${i}`, "");
    }
    const r = compressOutputForCommand("git log", entries.join("\n"));
    expect(r.processor).toBe("git");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("abc00000 fix: item 0");
    expect(r.output).toContain("... (5 more commits)");
    expect(r.output).not.toContain("Author:");
  });

  it("condenses a large branch list to the current branch + count", () => {
    const lines = ["* main"];
    for (let i = 0; i < 25; i++) lines.push(`  feature/branch-${i}`);
    const r = compressOutputForCommand("git branch -a", lines.join("\n"));
    expect(r.processor).toBe("git");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("* main");
    expect(r.output).toContain("(25 other branches)");
    expect(r.output).toContain("feature/branch-0");
    expect(r.output).not.toContain("feature/branch-20");
  });

  it("drops push/fetch progress noise and keeps the outcome lines", () => {
    const out = [
      "remote: Enumerating objects: 42, done.",
      "remote: Counting objects: 100% (42/42), done.",
      "Receiving objects: 100% (42/42), 12.34 KiB | 1.00 MiB/s, done.",
      "To github.com:user/repo.git",
      "   abc1234..def5678  main -> main",
    ].join("\n");
    const r = compressOutputForCommand("git push origin main", out);
    expect(r.processor).toBe("git");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("To github.com:user/repo.git");
    expect(r.output).not.toContain("Enumerating");
    expect(r.output).not.toContain("100%");
  });

  it("groups git blame output by author with percentages", () => {
    const lines: string[] = [];
    const mk = (hash: string, author: string, line: number, text: string): string =>
      `${hash} (${author} 2026-01-01 10:00:00 +0000  ${line}) ${text}`;
    for (let i = 0; i < 20; i++) lines.push(mk("aaaa1111", "Alice", i + 1, `a${i}`));
    for (let i = 0; i < 10; i++) lines.push(mk("bbbb2222", "Bob", i + 1, `b${i}`));
    const r = compressOutputForCommand("git blame src/app.ts", lines.join("\n"));
    expect(r.processor).toBe("git");
    expect(r.output).toContain("30 lines, 2 authors:");
    expect(r.output).toContain("  Alice: 20 lines (66%)");
    expect(r.output).toContain("Last 10 lines:");
  });

  it("truncates reflog past the entry budget", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `aaaa000${i} HEAD@{${i}}: commit: msg ${i}`);
    const r = compressOutputForCommand("git reflog", lines.join("\n"));
    expect(r.output).toContain("... (5 more entries)");
  });
});
