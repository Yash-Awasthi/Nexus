// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop shell pins Electron and electron-builder exactly, because a packaging
 * toolchain that moves on its own is a release that fails without a code change.
 *
 * Two questions, two modes:
 *
 *   --check   (default, no network) do the manifest and the record agree? The versions in
 *             `apps/desktop/package.json` must be the ones `docs/DEPLOYMENT.md` says were
 *             tested, so a bump cannot ship without the compatibility line being updated.
 *   --online  ask the registry what the current release is and fail when a pinned version
 *             is behind a major. Run weekly, not on every pull request: the answer changes
 *             without anything in this repository changing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = `${ROOT}apps/desktop/package.json`;
const DOC = `${ROOT}docs/DEPLOYMENT.md`;
const PACKAGES = ["electron", "electron-builder"];

/** The pinned version of each packaging dependency, as the app declares it. */
export function pinned(manifestPath = MANIFEST) {
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  const found = {};
  for (const name of PACKAGES) {
    const version = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];
    if (version) found[name] = version;
  }
  return found;
}

/**
 * The compatibility row the docs promise: `| electron | 45.4.1 | … |`. Read as data, so
 * the doc and the manifest are compared rather than both trusted.
 */
export function recorded(docPath = DOC) {
  const text = readFileSync(docPath, "utf8");
  const found = {};
  for (const name of PACKAGES) {
    const match = new RegExp(`\\|\\s*\`?${name}\`?\\s*\\|\\s*\`?([0-9][^|\`\\s]*)`, "i").exec(text);
    if (match) found[name] = match[1];
  }
  return found;
}

/** Major-version distance, so `45.4.1` vs `46.0.0` is reported as a major bump. */
export function behind(pinnedVersion, current) {
  const major = (version) => Number(version.replace(/^[^0-9]*/, "").split(".")[0]);
  const behindBy = major(current) - major(pinnedVersion);
  return behindBy > 0 ? behindBy : 0;
}

/** `{ name: { version, reason } }` for anything the registry disagrees with. */
export async function drifted(fetchJson = defaultFetch) {
  const head = pinned();
  const rows = {};
  for (const name of PACKAGES) {
    const body = await fetchJson(`https://registry.npmjs.org/${name}/latest`);
    const current = body.version;
    if (!current || current === head[name]) continue;
    const majors = behind(head[name], current);
    if (majors > 0) rows[name] = { version: current, reason: `${majors} major version(s) behind` };
  }
  return rows;
}

async function defaultFetch(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const head = pinned();
  const doc = recorded();
  const rows = PACKAGES.filter((name) => head[name] && doc[name] !== head[name]).map(
    (name) =>
      `docs/DEPLOYMENT.md records ${name} ${doc[name] ?? "(nothing)"} but apps/desktop/package.json pins ${head[name]} — record the compatibility result`,
  );
  console.log(
    `electron ${head.electron ?? "missing"}, electron-builder ${head["electron-builder"] ?? "missing"}`,
  );
  if (process.argv.includes("--online")) {
    try {
      const stale = await drifted();
      for (const [name, row] of Object.entries(stale))
        rows.push(
          `${name} ${head[name]} is ${row.reason} (current ${row.version}) — test the bump and update the pin`,
        );
    } catch (error) {
      console.log(`[skip] registry check unavailable: ${error.message}`);
    }
  }
  for (const row of rows) console.error(`✖ ${row}`);
  process.exit(rows.length === 0 ? 0 : 1);
}
