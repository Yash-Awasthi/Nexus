// SPDX-License-Identifier: Apache-2.0
/**
 * What a page costs the reader.
 *
 * A React Router build is one chunk per route plus shared ones, so "the bundle is
 * 6.7 MB" says nothing about any particular page: `/invitations` downloads 45 kB and
 * `/workflows` used to download 3.4 MB because a provider-logo barrel was inlined
 * for a 14px square. This script attributes every byte to the route that pulls it
 * in, using the Vite manifest the build already writes, and holds each route to a
 * budget.
 *
 * The number it gates is gzipped size of the route's static closure — its own chunk
 * plus every chunk imported at module scope plus its CSS. Chunks behind a dynamic
 * import are deliberately excluded: those are the pages and panels that must not be
 * downloaded by a page that does not use them, and `three.module` is forbidden in
 * every static closure so that stays true.
 *
 *   pnpm --filter @nexus/ui build
 *   node scripts/bundle-budget.mjs            check every route against its budget
 *   node scripts/bundle-budget.mjs --record   re-measure the budgets (x1.1 headroom)
 *   node scripts/bundle-budget.mjs --json     the table, for a build summary
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(ROOT, "apps/ui/build/client");
const MANIFEST = join(BUILD, ".vite/manifest.json");
const BUDGET = join(ROOT, ".github/bundle-budget.json");

/** Route modules only: a shared chunk is judged through the routes that import it. */
const ROUTE_PREFIX = "app/routes/";

/**
 * One route's static download weight.
 *
 * `imports` is Vite's static-import list, which is what a browser fetches before the
 * route can render. `dynamicImports` is not followed — that is the point of them.
 */
export function routeClosures(manifest, readSize) {
  const closures = new Map();
  const walk = (key, seen) => {
    const entry = manifest[key];
    if (!entry) return seen;
    if (entry.file) seen.add(entry.file);
    for (const css of entry.css ?? []) seen.add(css);
    // `assets` are statically imported files that are not modules themselves.
    for (const asset of entry.assets ?? []) seen.add(asset);
    for (const next of entry.imports ?? []) walk(next, seen);
    return seen;
  };
  for (const key of Object.keys(manifest)) {
    if (!key.startsWith(ROUTE_PREFIX)) continue;
    const route = key.slice(ROUTE_PREFIX.length).split("?")[0];
    const files = [...walk(key, new Set())];
    let rawBytes = 0;
    let gzipBytes = 0;
    for (const file of files) {
      const { raw, gzip } = readSize(file);
      rawBytes += raw;
      gzipBytes += gzip;
    }
    closures.set(route, { files, rawBytes, gzipBytes });
  }
  return closures;
}

/** The committed budgets. A missing file is the default rule only. */
export function readBudget(path = BUDGET) {
  if (!existsSync(path)) return { defaultGzipKb: 200, perRoute: {}, forbidden: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Decide one route. Three ways to fail, each with its own message so the fix is
 * obvious: over its own budget, over the default, or carrying a module that must
 * only ever arrive through a dynamic import.
 */
export function judgeRoute(route, closure, budget, gzKb = (bytes) => bytes / 1024) {
  const gzipKb = gzKb(closure.gzipBytes);
  const limit = budget.perRoute?.[route]?.gzipKb ?? budget.defaultGzipKb;
  const problems = [];
  if (typeof limit !== "number") {
    problems.push({ kind: "no-budget", message: `${route} has no budget and there is no default` });
  } else if (gzipKb > limit) {
    problems.push({
      kind: "over-budget",
      message: `${route} is ${Math.round(gzipKb)} kB gzipped, over its ${limit} kB budget`,
    });
  }
  for (const [module, rule] of Object.entries(budget.forbidden ?? {})) {
    const match = closure.files.find((file) => file.includes(module));
    if (!match) continue;
    if ((rule.allowedIn ?? []).includes(route)) continue;
    problems.push({
      kind: "forbidden",
      message: `${route} statically includes ${match} — ${rule.why ?? "load it behind a dynamic import"}`,
    });
  }
  return { gzipKb, limit, problems };
}

/** Gzip a built asset once; the closure walk asks for the same files repeatedly. */
export function sizedReader(dir) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    let value = { raw: 0, gzip: 0 };
    try {
      const bytes = readFileSync(join(dir, file));
      value = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
    } catch {
      // A manifest can name a file a previous build left behind; that is not a size.
    }
    cache.set(file, value);
    return value;
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (!existsSync(MANIFEST)) {
    console.error(
      "✖ no build to measure — run `pnpm --filter @nexus/ui build` first (the manifest is written by the build)",
    );
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const closures = routeClosures(manifest, sizedReader(BUILD));
  const budget = readBudget();
  const rows = [...closures.entries()].sort((a, b) => b[1].gzipBytes - a[1].gzipBytes);

  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        rows.map(([route, c]) => ({ route, gzipKb: Math.round(c.gzipBytes / 1024), rawKb: Math.round(c.rawBytes / 1024) })),
        null,
        2,
      ),
    );
    process.exit(0);
  }

  let failed = 0;
  if (!argv.includes("--record")) {
    console.log(`bundle: ${rows.length} routes, budget ${budget.defaultGzipKb} kB gzipped each\n`);
    for (const [route, closure] of rows) {
      const { gzipKb, limit, problems } = judgeRoute(route, closure, budget);
      const over = problems.filter((p) => p.kind === "over-budget");
      const mark = problems.length ? "✖" : "✔";
      console.log(`${mark} ${route.padEnd(26)} ${String(Math.round(gzipKb)).padStart(5)} kB / ${limit} kB`);
      for (const problem of problems) {
        console.log(`    ${problem.message}`);
      }
      if (over.length) {
        // Name the largest file, because "too big" without a filename is a puzzle.
        const biggest = [...closure.files]
          .map((file) => ({ file, ...sizedReader(BUILD)(file) }))
          .sort((a, b) => b.gzip - a.gzip)[0];
        if (biggest) console.log(`    largest: ${biggest.file} (${Math.round(biggest.gzip / 1024)} kB)`);
      }
      if (problems.length) failed++;
    }
  }

  if (argv.includes("--record")) {
    const next = {
      ...budget,
      defaultGzipKb: budget.defaultGzipKb ?? 200,
      perRoute: Object.fromEntries(
        rows.map(([route, closure]) => [
          route,
          { gzipKb: Math.ceil((closure.gzipBytes / 1024) * 1.1) },
        ]),
      ),
    };
    writeFileSync(BUDGET, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`bundle: recorded ${rows.length} route budgets into .github/bundle-budget.json`);
    process.exit(0);
  }

  console.log(
    failed === 0
      ? `\nbundle: every route is within budget`
      : `\nbundle: ${failed} route(s) over budget or carrying a lazy-only module`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
