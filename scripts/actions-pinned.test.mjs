// SPDX-License-Identifier: Apache-2.0
/**
 * A tag is a movable pointer. `actions/checkout@v7` is whatever that repository's
 * maintainers — or whoever takes the account over — push to `v7` next, and a
 * workflow runs with the token's permissions. Pinning to a commit SHA is what makes
 * a run reproducible and a compromise of the tag immovable.
 *
 * The tag is not lost: it stays in a trailing comment, so a reader (and Dependabot)
 * can still see what the SHA is meant to be.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const WORKFLOWS = ".github/workflows";
/** `owner/repo@<sha> # vX` — local actions and docker refs are not pinned this way. */
const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}\s+#\s*\S+$/;

/** Every `uses:` value in the tree, with where it came from. */
export function uses(files) {
  const found = [];
  for (const { file, text } of files) {
    text.split("\n").forEach((line, index) => {
      const match = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/.exec(line);
      if (match) found.push({ file, line: index + 1, value: match[1] });
    });
  }
  return found;
}

/** Refs that are neither pinned to a SHA nor exempt (`./local`, `docker://`). */
export function unpinned(found) {
  return found
    .filter((entry) => !entry.value.startsWith("./") && !entry.value.startsWith("docker://"))
    .filter((entry) => !PINNED.test(entry.value))
    .map((entry) => `${entry.file}:${entry.line} ${entry.value}`);
}

function workflowFiles() {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({
      file: path.join(WORKFLOWS, name),
      text: readFileSync(path.join(WORKFLOWS, name), "utf8"),
    }));
}

const FILES = workflowFiles();
const ALL = uses(FILES);

test("read the workflows, or the rule below proves nothing", () => {
  assert.ok(FILES.length >= 12, `only ${FILES.length} workflow files found`);
  assert.ok(ALL.length >= 50, `only ${ALL.length} uses: lines found`);
});

test("every action is pinned to a commit SHA and names its tag", () => {
  assert.deepEqual(unpinned(ALL), []);
});

test("a floating tag is reported, a SHA with its tag comment is not", () => {
  const found = uses([
    {
      file: "synthetic.yml",
      text: [
        "steps:",
        "  - uses: actions/checkout@v7",
        "  - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7",
        "  - uses: ./local-action",
        "  - uses: docker://alpine:3.20",
        "  - uses: actions/cache@caa296126883cff596d87d8935842f9db880ef25",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(unpinned(found), [
    "synthetic.yml:2 actions/checkout@v7",
    // A SHA without the tag is reproducible but unreadable: the comment is required.
    "synthetic.yml:6 actions/cache@caa296126883cff596d87d8935842f9db880ef25",
  ]);
});
