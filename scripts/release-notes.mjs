// SPDX-License-Identifier: Apache-2.0
/**
 * Release notes, produced from the changesets that are already required to merge a change.
 *
 * Changesets are the input and nothing else is: a note assembled from commit subjects says what was typed, while a
 * changeset says what changed for a user and who decided the semver bump. The document is generated between
 * markers and checked in CI, so "release notes" cannot be a manual step somebody skips the week they are busy.
 *
 * The output is printed by `--print` and compared by `syncGeneratedDoc`, so the same text is used for the gate and
 * for the file. Version numbers and dates are left out on purpose: this is the *pending* set, and a note that
 * claims a release number will be wrong after the next commit. The changelog that ships with a tag is
 * `@changesets/cli`'s job.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHANGESET_DIR = path.join(ROOT, ".changeset");

/** Bump order, most significant first, so the summary line reads like a decision. */
const BUMPS = ["major", "minor", "patch"];

/**
 * Parse one changeset file: a front-matter block of `"pkg": bump` lines, a blank line, then prose.
 *
 * Hand-parsed because a YAML dependency for four lines of `"name": bump` is a dependency to keep patched forever.
 * The shape is fixed by the tool that writes it, and a file that does not match is reported by name rather than
 * skipped — a changeset silently omitted from the notes is the one that mattered.
 */
export function parseChangeset(name, text) {
  const match = text.match(/^---\n([\s\S]*?)\n?---\n([\s\S]*)$/);
  if (!match) return { name, error: "no front matter" };
  const releases = [];
  for (const line of match[1].split("\n")) {
    const entry = line.match(/^\s*"?([@\w./-]+)"?\s*:\s*(major|minor|patch)\s*$/);
    if (entry) releases.push({ pkg: entry[1], bump: entry[2] });
  }
  const body = match[2]
    .trim()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (releases.length === 0) return { name, error: "no package releases" };
  if (body === "") return { name, error: "no description" };
  return { name, releases, body };
}

/** Every changeset in the tree, in a stable order, with unreadable ones kept (and reported) rather than dropped. */
export function readChangesets(dir = CHANGESET_DIR) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => parseChangeset(file, readFileSync(path.join(dir, file), "utf8")));
}

/** The highest bump across a changeset, or null when it has none. */
export function highestBump(releases) {
  for (const bump of BUMPS) if (releases.some((release) => release.bump === bump)) return bump;
  return null;
}

/** Package names with their highest bump, sorted — the "what is in this release" list. */
export function releaseSummary(changesets) {
  const byPackage = new Map();
  for (const changeset of changesets) {
    for (const { pkg, bump } of changeset.releases ?? []) {
      const current = byPackage.get(pkg);
      if (!current || BUMPS.indexOf(bump) < BUMPS.indexOf(current)) byPackage.set(pkg, bump);
    }
  }
  return [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The markdown block for `docs/RELEASE-NOTES.md`. */
export function renderReleaseNotes(changesets) {
  const broken = changesets.filter((changeset) => changeset.error);
  const valid = changesets.filter((changeset) => !changeset.error);
  const lines = [];

  if (valid.length === 0) {
    lines.push(
      "_No unreleased changesets._",
      "",
      "A change without a changeset does not appear here, and CI",
      "fails a pull request that changes a published package without one.",
    );
  } else {
    const summary = releaseSummary(valid);
    lines.push(
      `**${valid.length} changeset(s) pending**, affecting ${summary.length} package(s): ` +
        summary.map(([pkg, bump]) => `\`${pkg}\` (${bump})`).join(", "),
      "",
    );
    for (const changeset of valid) {
      const bumps = [...new Set((changeset.releases ?? []).map((release) => release.bump))].sort(
        (a, b) => BUMPS.indexOf(a) - BUMPS.indexOf(b),
      );
      lines.push(
        `### ${changeset.name.replace(/\.md$/, "")} — ${bumps.join("/")}`,
        "",
        changeset.body,
        "",
      );
    }
  }

  if (broken.length > 0) {
    lines.push("", "**Malformed changesets** (these are not in the release until fixed):", "");
    for (const changeset of broken) lines.push(`- \`${changeset.name}\`: ${changeset.error}`);
  }

  return lines.join("\n").trim();
}

// Print only when run as a program: `syncGeneratedDoc` invokes this file to capture the block, and importing it
// from a test must not write to stdout.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename))
  console.log(renderReleaseNotes(readChangesets()));
