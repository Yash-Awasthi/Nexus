// SPDX-License-Identifier: Apache-2.0
/**
 * The architecture diagrams are generated from the tree, so they cannot describe a
 * repository that no longer exists.
 *
 * For each layer this reads the real `package.json` edges and emits a Mermaid graph
 * between markers in docs/ARCHITECTURE.md. `--check` fails when the committed file
 * disagrees with what the tree says, which is the only way a diagram stays true:
 * somebody has to notice, and CI notices every time.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { report } from "./lib-inventory.mjs";

const DOC = "docs/ARCHITECTURE.md";
const BEGIN = "<!-- begin:generated layers (scripts/arch-diagrams.mjs) -->";
const END = "<!-- end:generated layers -->";

/** Every workspace package, with the `@nexus/*` names it depends on. */
function workspace() {
  const found = new Map();
  for (const root of ["apps", "packages"]) {
    for (const name of readdirSync(root)) {
      const manifest = path.join(root, name, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      const deps = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies })
        .filter((dep) => dep.startsWith("@nexus/"))
        .sort();
      found.set(parsed.name ?? `${root}/${name}`, { dir: `${root}/${name}`, deps });
    }
  }
  return found;
}

/** Mermaid node ids cannot contain `@` or `/`. */
const id = (name) => name.replace(/^@nexus\//, "pkg_").replace(/[^a-zA-Z0-9_]/g, "_");

const LAYERS = [
  { title: "API (apps/api)", roots: ["@nexus/api"], includeDeps: false },
  { title: "Worker (apps/worker)", roots: ["@nexus/worker"], includeDeps: false },
  { title: "UI (apps/ui)", roots: ["@nexus/ui"], includeDeps: false },
  {
    title: "Sandbox (apps/sandbox-helper + @nexus/sandbox)",
    roots: ["@nexus/sandbox-helper"],
    includeDeps: false,
  },
  {
    title: "Desktop and extension (apps/desktop, apps/extension)",
    roots: ["@nexus/desktop", "@nexus/extension"],
    includeDeps: false,
  },
];

/** One Mermaid graph per layer: the app in the middle, its workspace dependencies around it. */
function diagram(packages, layer) {
  const lines = ["```mermaid", "graph LR"];
  for (const root of layer.roots) {
    const pkg = packages.get(root);
    if (!pkg) {
      lines.push(`  ${id(root)}["${root} (not a workspace package)"]`);
      continue;
    }
    lines.push(`  ${id(root)}["${root}"]`);
    for (const dep of pkg.deps) {
      const target = packages.get(dep);
      lines.push(`  ${id(dep)}["${dep}${target ? ` · ${target.dir}` : " · external"}"]`);
      lines.push(`  ${id(root)} --> ${id(dep)}`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}

/** Packages with exactly one workspace consumer: the merge candidates, measured. */
export function singleConsumer(packages = workspace()) {
  const consumers = new Map();
  for (const [consumer, pkg] of packages)
    for (const dep of pkg.deps) {
      const seen = consumers.get(dep) ?? [];
      seen.push(consumer);
      consumers.set(dep, seen);
    }
  return [...packages.keys()]
    .filter((name) => (consumers.get(name) ?? []).length === 1)
    .sort()
    .map((name) => ({ name, consumer: consumers.get(name)[0] }));
}

/** The generated block: five layer diagrams plus the durability classes. */
export function generated(packages = workspace()) {
  const parts = [BEGIN, ""];
  for (const layer of LAYERS) {
    parts.push(`### ${layer.title}`, "", diagram(packages, layer), "");
  }
  parts.push(
    "### Durability classes",
    "",
    "Declared per route in `apps/api/src/lib/api-maturity.ts` and asserted by",
    "`apps/api/tests/lib/durable-bridge.test.ts`: `durable` writes survive a restart,",
    "`bridge` mutates through to a durable store before answering, and",
    "`dedicated-volatile` is deliberately not durable.",
    "",
    "### Packages with one consumer",
    "",
    "Measured, not chosen: these packages are imported by exactly one workspace package,",
    "so folding them into that consumer removes a `package.json` without a design debate.",
    "A package with two consumers is a real boundary; these are candidates, in the order",
    "the count grows.",
    "",
    "| Package | Only consumer |",
    "| ------- | ------------- |",
    ...singleConsumer(packages).map((pkg) => `| \`${pkg.name}\` | \`${pkg.consumer}\` |`),
    "",
    "#### `apps/api/src/lib` by domain",
    "",
    "The same rule set keeps `scripts/lib-inventory.mjs` honest: every module in",
    "`apps/api/src/lib` belongs to exactly one domain, and a module no test names is on a",
    "list that may only shrink.",
    "",
    "| Domain | Modules | What it is for |",
    "| ------ | ------- | -------------- |",
    ...domainsTable(),
    "",
    END,
  );
  return parts.join("\n");
}

/** The lib domain counts, one row per domain, in the order the rules are declared. */
function domainsTable() {
  const { rows } = report();
  const byDomain = new Map();
  for (const row of rows) byDomain.set(row.domain, (byDomain.get(row.domain) ?? []).concat(row));
  return [...byDomain.entries()].map(
    ([domain, entries]) => `| \`${domain}\` | ${entries.length} | ${entries[0].why} |`,
  );
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1] ?? "").href) {
  const check = process.argv.includes("--check");
  const doc = readFileSync(DOC, "utf8");
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  const body =
    start === -1 || end === -1
      ? `${doc.trimEnd()}\n\n## Layer diagrams\n\n${generated()}\n`
      : `${doc.slice(0, start)}${generated()}${doc.slice(end + END.length)}`;
  if (check) {
    if (body !== doc) {
      console.error(
        "✖ docs/ARCHITECTURE.md layer diagrams are out of date — run `node scripts/arch-diagrams.mjs`",
      );
      process.exit(1);
    }
    console.log(`arch diagrams: ${LAYERS.length} layers match the tree`);
  } else {
    writeFileSync(DOC, body);
    console.log(`arch diagrams: wrote ${LAYERS.length} layers into ${DOC}`);
  }
}
