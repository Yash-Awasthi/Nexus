// SPDX-License-Identifier: Apache-2.0
/**
 * A quickstart rots in one specific way: a command in the block stops existing. The
 * root script is renamed, the CLI bin moves, the port changes in the docs and not in the
 * code, and the first thing a new user does fails.
 *
 * This reads the README's "Option C" block as data and resolves each command against the
 * repository: root scripts must exist in package.json, `--filter <pkg> exec <bin>` must
 * name a workspace package whose bin exists, and the URL the block tells you to curl must
 * be a route the API registers.
 *
 * It does not measure the fifteen minutes — that needs a clean machine, and a number
 * invented here would be worse than none.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const README = "README.md";

/** The fenced block under `### Option C`, and the prose around it. */
export function quickstart(text = readFileSync(README, "utf8")) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("### Option C"));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,3} /.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n");
  const block = section.match(/```bash\n([\s\S]*?)```/);
  return {
    section,
    commands: (block?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter(Boolean),
  };
}

const root = JSON.parse(readFileSync("package.json", "utf8"));
const { section, commands } = quickstart();

test("the quickstart exists and is five steps or fewer", () => {
  assert.ok(section.length > 400, "README has no Option C quickstart");
  assert.ok(commands.length >= 4, `only ${commands.length} commands found`);
  for (const step of ["pnpm install", "nexus doctor", "pnpm dev", "/health"])
    assert.ok(section.includes(step), `the quickstart no longer mentions ${step}`);
});

test("every root script it runs exists", () => {
  for (const command of commands) {
    const match = command.match(/^pnpm (?:run )?([a-z][\w:-]*)/);
    if (!match) continue;
    const name = match[1];
    if (["install", "i"].includes(name)) continue;
    assert.ok(
      root.scripts?.[name],
      `README runs \`pnpm ${name}\`, which package.json does not define`,
    );
  }
});

test("the CLI filter names a real package with a real bin", () => {
  for (const command of commands) {
    const match = command.match(/--filter (\S+) exec (\S+)/);
    if (!match) continue;
    const [, filter, bin] = match;
    const dir = filter.replace("@nexus/", "");
    const manifest = `apps/${dir}/package.json`;
    const fallback = `packages/${dir}/package.json`;
    const path = existsSync(manifest) ? manifest : fallback;
    assert.ok(existsSync(path), `no workspace package for ${filter}`);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.name, filter, `${path} is ${parsed.name}`);
    const bins = Object.keys(parsed.bin ?? {});
    assert.ok(bins.includes(bin), `${filter} has no \`${bin}\` bin (has ${bins.join(", ")})`);
  }
});

test("the health URL it curls is a route the API serves", () => {
  const route = readFileSync("apps/api/src/routes/health.ts", "utf8");
  for (const command of commands) {
    const match = command.match(/localhost:(\d+)(\/[\w/-]*)/);
    if (!match) continue;
    const [, port, url] = match;
    const devPort = readFileSync("apps/api/src/index.ts", "utf8").match(/PORT\D+(\d{4})/);
    if (devPort) assert.equal(port, devPort[1], `README says port ${port}`);
    const path = url.split("/").filter(Boolean).pop() ?? "";
    assert.ok(route.includes(`"/${path}"`), `/api/${path} is not registered by health routes`);
  }
});
