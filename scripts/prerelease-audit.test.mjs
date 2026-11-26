// SPDX-License-Identifier: Apache-2.0
/**
 * The pre-release gate has four ways to be wrong and the tests cover each: a pre-release
 * nobody wrote down, a policy entry that drifted from the tree, an entry missing its
 * owner/reason/exit, and an ADR that does not exist. A gate that only knows how to pass
 * is a table.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { catalog, isPrerelease, problems, prereleases } from "./prerelease-audit.mjs";

const scratch = mkdtempSync(join(tmpdir(), "prerelease-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A fake repository: a workspace file, one manifest, one ADR directory, and the policy
 * file — the four things the audit reads.
 */
function repo({
  workspace = "",
  manifest = {},
  policy = { packages: {} },
  adrs = ["0020-rc.md"],
} = {}) {
  const dir = mkdtempSync(join(scratch, "repo-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", private: true }));
  if (workspace) writeFileSync(join(dir, "pnpm-workspace.yaml"), workspace);
  mkdirSync(join(dir, "apps/api"), { recursive: true });
  writeFileSync(join(dir, "apps/api/package.json"), JSON.stringify({ name: "api", ...manifest }));
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github/prerelease-policy.json"), JSON.stringify(policy));
  mkdirSync(join(dir, "docs/adr"), { recursive: true });
  for (const adr of adrs) writeFileSync(join(dir, "docs/adr", adr), "# adr\n");
  return dir;
}

test("channel tags are recognised, stable versions are not", () => {
  for (const version of [
    "1.0.0-rc.6",
    "^2.0.0-beta.1",
    "npm:@scope/pkg@3.0.0-next.2",
    "~1.2.0-canary.7",
  ])
    assert.equal(isPrerelease(version), true, version);
  for (const version of [
    "1.0.0",
    "^6.0.2",
    "npm:typescript@7.0.2",
    "8.3.8000",
    "workspace:*",
    "catalog:",
  ])
    assert.equal(isPrerelease(version), false, version);
});

test("the catalog block is read without swallowing the rest of the file", () => {
  const yaml = [
    "catalog:",
    '  "a": 1.0.0-rc.1',
    "  b: ^2.0.0",
    "",
    "overrides:",
    "  c: 3.0.0-beta.1",
  ].join("\n");
  assert.deepEqual(
    [...catalog(yaml)],
    [
      ["a", "1.0.0-rc.1"],
      ["b", "^2.0.0"],
    ],
  );
});

test("a pre-release in a manifest is found where it is declared", () => {
  const dir = repo({
    manifest: { dependencies: { "node-pty": "1.2.0-beta.15", react: "^19.0.0" } },
  });
  assert.deepEqual(prereleases(dir), [
    { name: "node-pty", version: "1.2.0-beta.15", where: "apps/api/package.json" },
  ]);
});

test("`catalog:` versions are audited once, not once per manifest that uses them", () => {
  const dir = repo({
    workspace: "catalog:\n  drizzle-orm: 1.0.0-rc.6\n",
    manifest: { dependencies: { "drizzle-orm": "catalog:" } },
  });
  assert.deepEqual(prereleases(dir), [
    { name: "drizzle-orm", version: "1.0.0-rc.6", where: "pnpm-workspace.yaml § catalog" },
  ]);
});

test("the shipped tree has a complete policy", () => {
  assert.deepEqual(problems(), []);
});

test("an unrecorded pre-release fails, and says where to record it", () => {
  const dir = repo({ manifest: { dependencies: { "node-pty": "1.2.0-beta.15" } } });
  assert.match(
    problems(dir).join("\n"),
    /node-pty@1\.2\.0-beta\.15 is a pre-release with no policy entry/,
  );
});

test("a policy that drifted from the tree fails in both directions", () => {
  const note = { owner: "pty", why: "why", exit: "exit", adr: "0020-rc.md" };
  const drifted = repo({
    manifest: { dependencies: { "node-pty": "1.2.0-beta.16" } },
    policy: { packages: { "node-pty": { version: "1.2.0-beta.15", ...note } } },
  });
  assert.match(
    problems(drifted).join("\n"),
    /policy says 1\.2\.0-beta\.15, tree has 1\.2\.0-beta\.16/,
  );

  const stale = repo({
    policy: { packages: { "node-pty": { version: "1.2.0-beta.15", ...note } } },
  });
  assert.match(
    problems(stale).join("\n"),
    /node-pty is in the policy but is no longer a pre-release/,
  );
});

test("an entry with no owner, reason, exit or ADR fails for the missing half", () => {
  const dir = repo({
    manifest: { dependencies: { "node-pty": "1.2.0-beta.15" } },
    policy: { packages: { "node-pty": { version: "1.2.0-beta.15" } } },
  });
  const rows = problems(dir).join("\n");
  assert.match(rows, /no `owner` recorded/);
  assert.match(rows, /no `why` recorded/);
  assert.match(rows, /no `exit` recorded/);
  assert.match(rows, /no ADR/);
});

test("an ADR that does not exist cannot justify an entry", () => {
  const dir = repo({
    manifest: { dependencies: { "node-pty": "1.2.0-beta.15" } },
    policy: {
      packages: {
        "node-pty": {
          version: "1.2.0-beta.15",
          owner: "pty",
          why: "why",
          exit: "exit",
          adr: "0099-missing.md",
        },
      },
    },
  });
  assert.match(problems(dir).join("\n"), /ADR 0099-missing\.md does not exist/);
});

test("the table in docs/OPS.md is generated from the policy and the tree", () => {
  const doc = readFileSync(new URL("../docs/OPS.md", import.meta.url), "utf8");
  for (const entry of prereleases())
    assert.ok(
      doc.includes(`\`${entry.name}\` | \`${entry.version}\``),
      `${entry.name} is not in the table`,
    );
});
