// SPDX-License-Identifier: Apache-2.0
/**
 * Two things can go wrong with a pinned packaging toolchain and neither is a compiler error:
 * the pin can be bumped without the compatibility record being updated, and the pin can age
 * silently. The first is checked on every pull request, the second weekly against the
 * registry — so both are tested here with the registry faked.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { behind, drifted, pinned, recorded } from "./electron-current.mjs";

const scratch = mkdtempSync(join(tmpdir(), "electron-current-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function manifest(devDependencies) {
  const file = join(scratch, `package-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ name: "desktop", devDependencies }));
  return file;
}

function doc(rows) {
  const file = join(scratch, `doc-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, ["| Dependency | Pinned |", "| --- | --- |", ...rows].join("\n"));
  return file;
}

test("the shipped tree and its record agree", () => {
  assert.deepEqual(pinned(), recorded());
});

test("a bump without a record update is visible", () => {
  const head = pinned(manifest({ electron: "46.0.0", "electron-builder": "27.0.0" }));
  assert.deepEqual(head, { electron: "46.0.0", "electron-builder": "27.0.0" });
  assert.notDeepEqual(head, recorded());
});

test("the record is read as data, not as prose", () => {
  const file = doc(["| `electron` | `45.4.1` |", "| `electron-builder`| `26.18.0` |"]);
  assert.deepEqual(recorded(file), { electron: "45.4.1", "electron-builder": "26.18.0" });
});

test("a major behind is a bump to test; a patch behind is not noise we act on", () => {
  assert.equal(behind("45.4.1", "46.0.0"), 1);
  assert.equal(behind("45.4.1", "47.1.0"), 2);
  assert.equal(behind("45.4.1", "45.9.9"), 0, "same major: the pin already allows the fix");
  assert.equal(behind("45.4.1", "45.4.1"), 0);
});

test("the registry check reports a major bump and stays quiet about a patch", async () => {
  const answers = {
    "https://registry.npmjs.org/electron/latest": { version: "46.2.0" },
    "https://registry.npmjs.org/electron-builder/latest": { version: "26.18.1" },
  };
  const rows = await drifted(async (url) => answers[url]);
  assert.deepEqual(Object.keys(rows), ["electron"]);
  assert.match(rows.electron.reason, /1 major version\(s\) behind/);
});

test("an unreachable registry is a skip, not a failure", async () => {
  const rows = await drifted(async () => {
    throw new Error("offline");
  }).catch((error) => error);
  assert.ok(rows instanceof Error, "the caller decides; the script prints [skip]");
});
