// SPDX-License-Identifier: Apache-2.0
/**
 * What the boot path costs.
 *
 * `buildServer()` registers 90-odd route modules synchronously before the first request can
 * be served. That work is invisible until it is slow: a plugin that starts a timer, opens a
 * socket or awaits a network call delays every container start and every restart, and the
 * only symptom is "the API took a while".
 *
 * This boots the real server with an in-memory database and measures the time to a working
 * `/health`, then fails when it exceeds the budget in `.github/boot-budget.json`. The
 * budget is measured, not hoped for: raising it is a commit somebody has to justify.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUDGET = `${ROOT}.github/boot-budget.json`;

/** The committed budget: milliseconds from `import` to a served `/health`. */
export function budget(path = BUDGET) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Boot the API and time it. `DATABASE_URL` points at PGlite in memory so the measurement is
 * the boot path, not a network round trip; every other integration is left unset, which is
 * the offline case the health probe already handles.
 */
export async function measureBoot() {
  process.env.DATABASE_URL ??= "pglite://:memory:boot-budget";
  const started = process.hrtime.bigint();
  // A file:// URL, not a path: on Windows an absolute path is read as a `c:` scheme.
  const { buildServer } = await import(pathToFileURL(`${ROOT}apps/api/src/server.ts`).href);
  const app = await buildServer();
  const health = await app.inject({ method: "GET", url: "/health" });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const routes = app.printRoutes({ commonPrefix: false }).split("\n").filter((line) => line.includes("(")).length;
  await app.close();
  return { elapsedMs, status: health.statusCode, routes };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const limits = budget();
  const measured = await measureBoot();
  const rounded = Math.round(measured.elapsedMs);
  console.log(
    `api boot: ${rounded}ms to /health ${measured.status}, ${measured.routes} route lines (budget ${limits.bootMs}ms)`,
  );
  if (process.argv.includes("--write")) {
    writeFileSync(
      BUDGET,
      `${JSON.stringify({ ...limits, bootMs: Math.ceil(rounded * 1.2) }, null, 2)}\n`,
    );
    console.log(`api boot: budget raised to ${Math.ceil(rounded * 1.2)}ms`);
    process.exit(0);
  }
  if (measured.status !== 200) {
    console.error(`✖ /health answered ${measured.status} — the boot path is broken, not slow`);
    process.exit(1);
  }
  if (limits.maxRoutes && measured.routes > limits.maxRoutes) {
    console.error(
      `✖ ${measured.routes} route lines exceeds the ${limits.maxRoutes} cap — a route module is registering more than it documents`,
    );
    process.exit(1);
  }
  if (rounded > limits.bootMs) {
    console.error(
      `✖ api boot ${rounded}ms exceeds the ${limits.bootMs}ms budget — find the module that awaits something during registration`,
    );
    process.exit(1);
  }
}
