// SPDX-License-Identifier: Apache-2.0
/**
 * `docs/cli-reference.md` has to describe the CLI that exists, and the CLI has
 * to call routes that exist. This checks both directions:
 *
 *   1. every `## `nexus …`` heading in the doc is a command the CLI defines,
 *      read from the CLI's own commander chains rather than from a list, and
 *      cross-checked against the CLI's top-level `--help`;
 *   2. every route family in `openapi.yaml` has a row in the doc's "Route
 *      families" table, either naming a command that exists or saying
 *      "API only";
 *   3. every literal API path the CLI asks for is a path the spec serves;
 *   4. every top-level command is named somewhere in the doc.
 *
 *   node scripts/cli-parity.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

const DOC = "docs/cli-reference.md";
const SPEC = "openapi.yaml";
const CLI = "apps/cli/src/index.ts";

const read = (path) => readFileSync(join(root, path), "utf8");

/** The `.alias("…")` that belongs to this `.command(…)`, and not to the next one. */
function aliasAfter(source, at) {
  const tail = source.slice(at, at + 400);
  const next = tail.indexOf(".command(");
  return /\.alias\(\s*"([^"]+)"/.exec(next < 0 ? tail : tail.slice(0, next))?.[1];
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The names the CLI's own top level reports, for cross-checking the parse. */
function helpTopLevel() {
  const out = execFileSync(process.execPath, [join(root, CLI), "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  const lines = out.split("\n");
  const at = lines.findIndex((line) => line.trim() === "Commands:");
  const names = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}(\S+)/.exec(line);
    if (!match) continue;
    for (const name of match[1].split("|"))
      if (name !== "help" && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Every command path the CLI registers. Read from the commander chains so this
 * costs no process per command: `const tasks = program.command("tasks")` binds a
 * parent, and `tasks.command("list")` hangs a child off it.
 */
export function cliTree() {
  const entries = [];
  for (const file of sourceFiles(join(root, "apps/cli/src"))) {
    const source = readFileSync(file, "utf8");
    const seen = new Set();
    // `const tasks = program.command("tasks")` binds the path for its children.
    for (const match of source.matchAll(
      /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*\.command\(\s*"([^"]+)"/g,
    )) {
      seen.add(match.index);
      entries.push({
        bind: match[1],
        receiver: match[2],
        name: match[3],
        alias: aliasAfter(source, match.index),
      });
    }
    // `tasks\n  .command("list")` — a newline can sit between the receiver and the
    // dot, and the same call also matches the binding pattern above.
    for (const match of source.matchAll(/(\w+)\s*\.command\(\s*"([^"]+)"/g)) {
      if (seen.has(match.index)) continue;
      entries.push({
        bind: null,
        receiver: match[1],
        name: match[2],
        alias: aliasAfter(source, match.index),
      });
    }
  }

  const bindings = new Map([["program", ""]]);
  const paths = new Set();
  for (let pass = 0; pass < 5; pass++) {
    for (const entry of entries) {
      const parent = bindings.get(entry.receiver);
      if (parent === undefined) continue;
      const path = [parent, entry.name.split(" ")[0]].filter(Boolean).join(" ");
      paths.add(path);
      if (entry.alias)
        for (const alias of entry.alias.split("|"))
          paths.add([parent, alias].filter(Boolean).join(" "));
      if (entry.bind) bindings.set(entry.bind, path);
    }
  }
  return paths;
}

/** `## `nexus a b [--flag]`` → ["a", "b"], plus the heading text for reporting. */
export function documentedCommands(markdown) {
  return [...markdown.matchAll(/^## `nexus ([^`\n]+)`/gm)].map((match) => {
    const words = match[1].split(/\s+/).filter((word) => /^[a-z][a-z-]*$/.test(word));
    return { heading: match[1], argv: words };
  });
}

/** The `| route family | reached by | routes |` rows of the "Route families" table. */
export function documentedFamilies(markdown) {
  const start = markdown.search(/^## Route families$/m);
  if (start < 0) return new Map();
  const body = markdown.slice(start + 1);
  const end = body.search(/^## /m);
  const section = end < 0 ? body : body.slice(0, end);
  const rows = new Map();
  for (const line of section.split("\n")) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2 || !cells[0].startsWith("`")) continue;
    rows.set(cells[0].replaceAll("`", ""), cells[1].replaceAll("`", ""));
  }
  return rows;
}

/** Route families of the spec: the first real segment after /api, else "(root)". */
export function specFamilies(yaml) {
  const families = new Map();
  for (const line of yaml.split("\n")) {
    const match = /^ {2}(\/[^:]+):\s*$/.exec(line);
    if (!match) continue;
    const path = match[1];
    const segments = path.split("/").filter((segment) => segment && !segment.startsWith("{"));
    let key;
    if (!path.startsWith("/api")) key = segments[0] === "v1" ? "openai" : "(root)";
    else {
      const rest = segments.slice(1);
      if (rest[0] === "v1") rest.shift();
      key = rest[0] ?? "(root)";
    }
    families.set(key, (families.get(key) ?? 0) + 1);
  }
  return families;
}

const normalise = (path) => path.replace(/\{[^}]*\}/g, "{x}").replace(/\/$/, "");

/** Every `/api…` path the CLI asks for, with `${…}` turned into a spec parameter. */
export function cliCalls() {
  const calls = [];
  const add = (file, method, raw) => {
    if (!raw.startsWith("/")) return;
    const path = raw.split("?")[0].replace(/\$\{[^}]*\}/g, "{x}");
    calls.push({ file: relative(root, file), method, path });
  };
  for (const file of sourceFiles(join(root, "apps/cli/src"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /api\.(get|post|patch|delete|put|url|sseUrl)(?:<[^>]*>)?\(\s*(["'`])([^"'`]*)\2/g,
    ))
      add(file, match[1], `/api/v1${match[3]}`);
    for (const match of source.matchAll(
      /api\.unversioned(?:<[^>]*>)?\(\s*"([A-Z]+)"\s*,\s*(["'`])([^"'`]*)\2/g,
    ))
      add(file, match[1], match[3]);
    for (const match of source.matchAll(/request(?:<[^>]*>)?\(\s*"([A-Z]+)"\s*,\s*"(\/[^"]*)"/g))
      add(file, match[1], match[2]);
  }
  return calls;
}

export function check({ tree, markdown, yaml, calls, topLevel }) {
  const problems = [];
  const known = (path) => tree.has(path);

  // 1. documented headings are real commands
  for (const { heading, argv } of documentedCommands(markdown)) {
    const path = argv.join(" ");
    if (path !== "" && !known(path))
      problems.push(`${DOC}: \`nexus ${heading}\` is documented but the CLI has no "${path}"`);
  }

  // The parse above is only trustworthy if it agrees with the CLI's own help.
  for (const name of topLevel ?? [])
    if (!tree.has(name))
      problems.push(`scripts/cli-parity.mjs: "${name}" is in the CLI's help but not in its source`);

  // 2. every family is in the table, and every command cell is a real command
  const families = specFamilies(yaml);
  const rows = documentedFamilies(markdown);
  for (const family of families.keys())
    if (!rows.has(family)) problems.push(`${DOC}: route family "${family}" has no row`);
  for (const family of rows.keys())
    if (!families.has(family)) problems.push(`${DOC}: route family "${family}" is not in the spec`);
  for (const [family, reachedBy] of rows) {
    if (reachedBy === "API only") continue;
    if (!reachedBy.startsWith("nexus ")) {
      problems.push(`${DOC}: family "${family}" must name a \`nexus …\` command or say "API only"`);
      continue;
    }
    const command = reachedBy.replace(/^nexus /, "");
    if (!known(command))
      problems.push(`${DOC}: family "${family}" names \`${reachedBy}\`, which does not exist`);
  }

  // 3. every CLI call is a path the spec serves
  const spec = new Set(
    yaml
      .split("\n")
      .map((line) => /^ {2}(\/[^:]+):\s*$/.exec(line)?.[1])
      .filter(Boolean)
      .map(normalise),
  );
  for (const call of calls)
    if (!spec.has(normalise(call.path)))
      problems.push(`${call.file}: ${call.method} ${call.path} is not a path in ${SPEC}`);

  // 4. every top-level command is mentioned
  for (const name of new Set([...tree].map((key) => key.split(" ")[0])))
    if (!markdown.includes(`nexus ${name}`))
      problems.push(`${DOC}: \`nexus ${name}\` exists but is never mentioned`);

  return { problems, families: families.size, commands: tree.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const markdown = read(DOC);
  const yaml = read(SPEC);
  const tree = cliTree();
  const calls = cliCalls();
  const { problems, families, commands } = check({
    tree,
    markdown,
    yaml,
    calls,
    topLevel: helpTopLevel(),
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`cli-parity: ${problem}`);
    console.error(`\ncli-parity failed: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(
    `cli-parity passed: ${commands} CLI commands, ${families} route families, ${calls.length} CLI calls`,
  );
}
