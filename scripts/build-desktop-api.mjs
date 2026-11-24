// SPDX-License-Identifier: Apache-2.0
/**
 * Build what the desktop app ships: the API as JavaScript, its production
 * dependencies, the UI build and the database migrations.
 *
 * The API normally runs from TypeScript through Node's type stripping, which
 * only works outside `node_modules`. A packaged app has no checkout, so this
 * bundles the workspace sources (including every `@nexus/*` package) into ESM
 * and keeps npm dependencies external, then stages them beside the bundle from
 * a hoisted production deploy. Layout:
 *
 *   apps/desktop/resources/api/        bundle + node_modules + migrations
 *   apps/desktop/resources/ui/         apps/ui/build/client
 *
 * Both directories are build output and are ignored by git.
 *
 * Usage: node scripts/build-desktop-api.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rolldown } from "rolldown";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = join(ROOT, "apps", "desktop", "resources");
const API_OUT = join(RESOURCES, "api");
const UI_OUT = join(RESOURCES, "ui");
const UI_BUILD = join(ROOT, "apps", "ui", "build", "client");
const MIGRATIONS = join(ROOT, "packages", "db", "migrations");
const DEPLOY = join(ROOT, ".nexus", "desktop-api-deploy");

function fail(message) {
  console.error(`build-desktop-api: ${message}`);
  process.exit(1);
}

/** A bare package specifier, as opposed to a relative or absolute path. */
function isBare(id) {
  return !id.startsWith(".") && !isAbsolute(id) && !/^[A-Za-z]:[\\/]/.test(id);
}

/**
 * Delete a tree. Windows refuses often enough on deep `node_modules` trees (a file
 * still open, a path near the limit) that `fs.rm` alone is not reliable; `rmdir` is.
 */
async function removeTree(dir) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    if (process.platform !== "win32") throw err;
    spawnSync("cmd", ["/c", "rmdir", "/s", "/q", dir], { stdio: "ignore" });
    if (existsSync(dir)) throw err;
  }
}

async function bundle() {
  console.log("[1/4] bundling the API and workspace packages");
  const build = await rolldown({
    input: join(ROOT, "apps", "api", "src", "index.ts"),
    platform: "node",
    // Workspace packages are TypeScript sources; npm packages are installed below.
    external: (id, _importer, isResolved) => !isResolved && isBare(id) && !id.startsWith("@nexus/"),
  });
  await build.write({
    dir: API_OUT,
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames: "chunks/[name]-[hash].js",
  });
}

function deployDependencies() {
  console.log("[2/4] installing the API's production dependencies");
  // One command string: Node refuses to spawn a `.cmd` shim without a shell on Windows,
  // and passing an argument array alongside `shell` is deprecated.
  const result = spawnSync(
    `pnpm --filter @nexus/api deploy --prod --node-linker=hoisted "${DEPLOY}"`,
    { cwd: ROOT, stdio: "inherit", shell: true },
  );
  if (result.status !== 0) fail("pnpm deploy failed");
}

async function stageDependencies() {
  console.log("[3/4] staging the dependencies beside the bundle");
  const modules = join(DEPLOY, "node_modules");
  if (!existsSync(modules)) fail(`no node_modules in ${DEPLOY}`);
  const target = join(API_OUT, "node_modules");
  // A rename, not a copy: `node_modules` is tens of thousands of files, and on
  // Windows a recursive copy of a tree that deep fails part-way with ENOTEMPTY.
  try {
    await rename(modules, target);
  } catch {
    await cp(modules, target, { recursive: true });
  }
  // Bundled above. Left in place, the resolver would prefer these TypeScript
  // sources over the bundle and fail under node_modules type stripping.
  const scoped = join(target, "@nexus");
  for (const entry of await readdir(scoped).catch(() => [])) {
    await removeTree(join(scoped, entry));
  }
  // Read at run time by the embedded-database migrator, not imported.
  await cp(MIGRATIONS, join(API_OUT, "migrations"), { recursive: true });

  const manifest = { name: "nexus-desktop-api", private: true, type: "module", version: "0.1.0" };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(API_OUT, "package.json"), json);
  // The API's version banner walks one directory up from wherever its module
  // lands, so the parent also has to answer as a package.
  await writeFile(join(RESOURCES, "package.json"), json);
}

async function copyUi() {
  console.log("[4/4] copying the built UI");
  if (!existsSync(UI_BUILD))
    fail("apps/ui/build/client is missing; run pnpm --filter @nexus/ui build");
  await cp(UI_BUILD, UI_OUT, { recursive: true });
}

await removeTree(RESOURCES);
await removeTree(DEPLOY);
await mkdir(API_OUT, { recursive: true });
await bundle();
deployDependencies();
await stageDependencies();
await copyUi();

const { version } = JSON.parse(await readFile(join(API_OUT, "package.json"), "utf8"));
console.log(`built apps/desktop/resources (api ${version})`);
