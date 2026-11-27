// SPDX-License-Identifier: Apache-2.0
/**
 * A release candidate in a shipping dependency is a decision, not an accident.
 *
 * Three of them are installed here: `drizzle-orm`/`drizzle-kit` 1.0.0-rc.6 (the
 * persistence layer), `@monaco-editor/react` 4.8.0-rc.3 (the editor) and `node-pty`
 * 1.2.0-beta.15 (the terminal). Each is fine to keep — but only while somebody knows why,
 * who owns it, and what would make us leave. `.github/prerelease-policy.json` holds that;
 * this reads every manifest (including the `catalog:` block in `pnpm-workspace.yaml`,
 * which is where most of the versions actually live) and fails when:
 *
 *   - a pre-release is installed that the policy does not name,
 *   - the policy names a version the tree no longer uses (an acceptance that outlived
 *     its dependency is a stale claim),
 *   - an entry has no owner, no exit condition, or an ADR that does not exist.
 *
 * `--write` regenerates the table in `docs/OPS.md`; `--check` compares it.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonical, formatDoc } from "./lib/generated-doc.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const POLICY = join(ROOT, ".github/prerelease-policy.json");
const OPS = join(ROOT, "docs/OPS.md");
const BEGIN = "<!-- begin:prerelease table (scripts/prerelease-audit.mjs) -->";
const END = "<!-- end:prerelease table -->";
const ADR_RANGE = /^\d{4}-/;

/** `1.0.0-rc.6`, `^2.0.0-beta.1`, `npm:pkg@1.2.0-next.3` — anything with a channel tag. */
export function isPrerelease(version) {
  const bare = version.replace(/^npm:[^@]+@/, "").replace(/^[\^~>=<]*/, "");
  return (
    /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+/.test(bare) ||
    /-(rc|beta|alpha|next|canary|pre|dev)\.?\d/.test(bare)
  );
}

function manifests(root = ROOT) {
  const files = [join(root, "package.json")];
  for (const group of ["apps", "packages", "packages/adapters"]) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, "package.json");
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

/** The `catalog:` block of `pnpm-workspace.yaml`, read as `name → version`. */
export function catalog(text) {
  const found = new Map();
  const lines = text.split("\n");
  let inside = false;
  for (const line of lines) {
    if (/^catalog:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^\S/.test(line)) inside = false;
    if (!inside) continue;
    const match = /^\s{2}"?([^":]+)"?:\s*"?([^"\s#]+)"?\s*(?:#.*)?$/.exec(line);
    if (match) found.set(match[1], match[2]);
  }
  return found;
}

/**
 * Every installed pre-release, with where it was declared. `catalog:` entries are named
 * by the catalog key, since that is the line a reader would change.
 */
export function prereleases(root = ROOT) {
  const found = [];
  const workspaceYaml = join(root, "pnpm-workspace.yaml");
  if (existsSync(workspaceYaml)) {
    for (const [name, version] of catalog(readFileSync(workspaceYaml, "utf8"))) {
      if (isPrerelease(version))
        found.push({ name, version, where: "pnpm-workspace.yaml § catalog" });
    }
  }
  for (const file of manifests(root)) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(pkg[section] ?? {})) {
        // `catalog:` and `workspace:*` are resolved elsewhere; the catalog pass covers them.
        if (version.startsWith("catalog:") || version.startsWith("workspace:")) continue;
        if (isPrerelease(String(version)))
          found.push({
            name,
            version: String(version),
            // Forward slashes, so a Windows laptop and a Linux runner report the same path.
            where: file
              .replace(root, "")
              .replace(/^[\\/]/, "")
              .replace(/\\/g, "/"),
          });
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** ADR files that exist, so a policy entry can be checked against the docs directory. */
function adrs(root = ROOT) {
  const dir = join(root, "docs/adr");
  return new Set(existsSync(dir) ? readdirSync(dir).filter((file) => ADR_RANGE.test(file)) : []);
}

/**
 * The table rendered into `docs/OPS.md`. Measured rows only: the version comes from the
 * tree, the owner and the exit condition from the policy.
 */
export function table(root = ROOT) {
  const policy = JSON.parse(
    readFileSync(join(root, ".github/prerelease-policy.json"), "utf8"),
  ).packages;
  const rows = [
    "| Package | Version | Why it is installed | Owner | Exit | ADR |",
    "| ------- | ------- | ------------------- | ----- | ---- | --- |",
  ];
  for (const entry of prereleases(root)) {
    const note = policy[entry.name] ?? {};
    rows.push(
      `| \`${entry.name}\` | \`${entry.version}\` | ${note.why ?? "_unrecorded_"} | ${note.owner ?? "_unowned_"} | ${note.exit ?? "_no exit condition_"} | ${note.adr ? `[${note.adr}](adr/${note.adr})` : "_none_"} |`,
    );
  }
  return rows.join("\n");
}

/** Everything wrong with the tree or the policy, as readable sentences. */
export function problems(root = ROOT) {
  const policy = JSON.parse(
    readFileSync(join(root, ".github/prerelease-policy.json"), "utf8"),
  ).packages;
  const installed = prereleases(root);
  const known = adrs(root);
  const rows = [];
  for (const entry of installed) {
    const note = policy[entry.name];
    if (!note) {
      rows.push(
        `${entry.name}@${entry.version} is a pre-release with no policy entry — add it to .github/prerelease-policy.json`,
      );
      continue;
    }
    if (note.version !== entry.version)
      rows.push(
        `${entry.name}: policy says ${note.version}, tree has ${entry.version} — update the policy with the decision`,
      );
    for (const field of ["owner", "why", "exit"])
      if (!note[field])
        rows.push(`${entry.name}: no \`${field}\` recorded — a pre-release needs all three`);
    if (note.adr && !known.has(note.adr))
      rows.push(`${entry.name}: ADR ${note.adr} does not exist`);
    if (!note.adr)
      rows.push(`${entry.name}: no ADR — the decision is not written down anywhere durable`);
  }
  for (const name of Object.keys(policy))
    if (!installed.some((entry) => entry.name === name))
      rows.push(
        `${name} is in the policy but is no longer a pre-release in the tree — remove the entry`,
      );
  return rows;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const rows = problems();
  const installed = prereleases();
  if (process.argv.includes("--write")) {
    const doc = readFileSync(OPS, "utf8");
    const start = doc.indexOf(BEGIN);
    const end = doc.indexOf(END);
    const body = `${BEGIN}\n${table()}\n${END}`;
    const next =
      start === -1 || end === -1
        ? `${doc}\n\n${body}\n`
        : doc.slice(0, start) + body + doc.slice(end + END.length);
    writeFileSync(OPS, next);
    formatDoc("docs/OPS.md");
    console.log(`prerelease audit: wrote ${installed.length} row(s) into docs/OPS.md`);
    process.exit(0);
  }
  if (process.argv.includes("--check")) {
    const doc = readFileSync(OPS, "utf8");
    // Content, not alignment: `vp fmt` pads the committed table, the generator emits it unpadded.
    if (!canonical(doc).includes(canonical(table()))) {
      console.error(
        "✖ the pre-release table in docs/OPS.md is out of date — run node scripts/prerelease-audit.mjs --write",
      );
      process.exit(1);
    }
  }
  console.log(
    `prerelease audit: ${installed.length} pre-release dependency(ies), ${rows.length} problem(s)`,
  );
  for (const row of rows) console.error(`✖ ${row}`);
  process.exit(rows.length === 0 ? 0 : 1);
}
