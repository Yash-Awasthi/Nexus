// SPDX-License-Identifier: Apache-2.0
/**
 * Lockfile drift: `pnpm-lock.yaml` and the `package.json` files must move together.
 *
 * Two failures this catches, both of which cost a reviewer a re-run:
 *
 *   - the lockfile changed but no `package.json` did — a hand-edited lockfile, or a
 *     merge that resolved dependencies by hand;
 *   - a `package.json` changed but the lockfile did not — CI's
 *     `pnpm install --frozen-lockfile` then fails on a tree that installs fine for
 *     the author, because their store already had the new versions.
 *
 * Run in CI against the pull request's base branch, and locally as
 * `node scripts/lockfile-drift.mjs --base origin/master`.
 */
import { spawnSync } from "node:child_process";

const LOCKFILE = "pnpm-lock.yaml";

/**
 * The verdict for one list of changed paths.
 *
 * `null` means there is nothing to say; otherwise the returned string is the
 * failure message.
 */
export function classify(changed) {
  const paths = changed.map((path) => path.replace(/^\.\//, ""));
  if (paths.length === 0) return null;

  const lockfiles = paths.filter((p) => p === LOCKFILE);
  // A package.json anywhere in the workspace: root, apps/*, packages/*, services/*.
  const manifests = paths.filter((p) => p === "package.json" || p.endsWith("/package.json"));

  if (lockfiles.length > 0 && manifests.length === 0) {
    return `${LOCKFILE} changed without a package.json change. Either the dependency change belongs in a manifest, or the lockfile was edited by hand.`;
  }
  if (manifests.length > 0 && lockfiles.length === 0) {
    return `${manifests.join(", ")} changed without ${LOCKFILE}. Run \`pnpm install\` and commit the lockfile, or \`pnpm install --frozen-lockfile\` fails in CI.`;
  }
  return null;
}

/** Paths that changed between `base` and HEAD. */
export function changedPaths(base) {
  const res = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git diff against ${base} failed: ${res.stderr.trim() || res.status}`);
  }
  return res.stdout.split("\n").filter((line) => line.trim() !== "");
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--base");
  const base =
    at >= 0
      ? argv[at + 1]
      : process.env.GITHUB_BASE_REF
        ? `origin/${process.env.GITHUB_BASE_REF}`
        : "";

  if (!base) {
    // Nothing to compare against: a local run on a branch, or a workflow that was
    // not given a base. Saying so beats a green tick that proves nothing.
    console.log("lockfile-drift: no base branch to compare (pass --base <ref>), nothing checked");
    return 0;
  }

  let changed;
  try {
    changed = changedPaths(base);
  } catch (err) {
    console.log(`lockfile-drift: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const verdict = classify(changed);
  if (verdict) {
    console.error(`lockfile-drift: ${verdict}`);
    console.error(`\nChanged (${changed.length}): ${changed.slice(0, 20).join(", ")}`);
    return 1;
  }
  console.log(`lockfile-drift: ${changed.length} paths changed since ${base}, lockfile agrees`);
  return 0;
}

if (import.meta.main ?? process.argv[1]?.endsWith("lockfile-drift.mjs")) process.exit(main());
