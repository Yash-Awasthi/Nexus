// SPDX-License-Identifier: Apache-2.0
/**
 * Release notes are generated from changesets, so the parser is the whole feature: a changeset it silently skips is
 * a shipped change nobody can read about. These cases are the shapes that actually appear — plus the two that
 * matter more than the happy path, a malformed file and an empty tree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  highestBump,
  parseChangeset,
  readChangesets,
  releaseSummary,
  renderReleaseNotes,
} from "./release-notes.mjs";

const GOOD = `---
"@nexus/api": minor
"@nexus/ui": patch
---

Add the export route and a receipt on delete.

- one line of detail
`;

test("a changeset is parsed into packages, bumps and prose", () => {
  const parsed = parseChangeset("export.md", GOOD);
  assert.deepEqual(parsed.releases, [
    { pkg: "@nexus/api", bump: "minor" },
    { pkg: "@nexus/ui", bump: "patch" },
  ]);
  assert.match(parsed.body, /^Add the export route/);
  assert.match(parsed.body, /one line of detail$/);
  assert.equal(parsed.error, undefined);
});

test("unquoted and scoped package names both parse", () => {
  const parsed = parseChangeset("x.md", "---\n@nexus/db: patch\n---\nfix a thing\n");
  assert.deepEqual(parsed.releases, [{ pkg: "@nexus/db", bump: "patch" }]);
});

test("a malformed changeset is reported, not skipped", () => {
  assert.match(parseChangeset("bad.md", "# no front matter\n").error, /front matter/);
  assert.match(parseChangeset("empty.md", "---\n---\nbody\n").error, /no package releases/);
  assert.match(
    parseChangeset("silent.md", '---\n"@nexus/api": patch\n---\n').error,
    /no description/,
  );
});

test("the highest bump wins for a package, and the summary sorts by name", () => {
  const summary = releaseSummary([
    {
      releases: [
        { pkg: "@nexus/ui", bump: "patch" },
        { pkg: "@nexus/api", bump: "patch" },
      ],
    },
    { releases: [{ pkg: "@nexus/api", bump: "major" }] },
  ]);
  assert.deepEqual(summary, [
    ["@nexus/api", "major"],
    ["@nexus/ui", "patch"],
  ]);
  assert.equal(highestBump([{ bump: "patch" }, { bump: "minor" }]), "minor");
  assert.equal(highestBump([]), null);
});

test("the rendered block names every pending changeset and every affected package", () => {
  const text = renderReleaseNotes([parseChangeset("export.md", GOOD)]);
  assert.match(text, /1 changeset\(s\) pending/);
  assert.match(text, /`@nexus\/api` \(minor\)/);
  assert.match(text, /### export — minor\/patch/);
  assert.match(text, /Add the export route/);
});

test("an empty tree says so instead of rendering an empty section", () => {
  const text = renderReleaseNotes([]);
  assert.match(text, /No unreleased changesets/);
  assert.match(text, /CI/);
});

test("the real tree parses, and its one pending changeset reaches the notes", () => {
  const real = readChangesets();
  assert.ok(real.length > 0, "the repository should have at least one pending changeset");
  assert.deepEqual(
    real.filter((changeset) => changeset.error),
    [],
  );
  const text = renderReleaseNotes(real);
  assert.match(text, /changeset\(s\) pending/);
  for (const changeset of real) assert.ok(text.includes(changeset.name.replace(/\.md$/, "")));
});
