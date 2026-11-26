// SPDX-License-Identifier: Apache-2.0
/**
 * What the slow paths cost, measured the same way every time.
 *
 * Four things decide whether working in this repository is pleasant and whether a
 * container starts quickly: how long a cold build takes, how long the same build
 * takes when nothing changed, how long the test suite takes, and how long the UI
 * dev server needs before it answers a request. None of them were ever written
 * down, so "it feels slower" had no number to be wrong about.
 *
 * Every measurement is a wall time around a real command, on this machine, with
 * the host label recorded beside it. A laptop number and a runner number are not
 * comparable, so `--check` only judges a workload that has a baseline from the
 * same host; anything else is printed as unmeasured rather than passed.
 *
 *   node scripts/perf-budget.mjs                  measure everything, print a table
 *   node scripts/perf-budget.mjs --only test      measure one workload
 *   node scripts/perf-budget.mjs --record         write .github/perf-baseline.json
 *   node scripts/perf-budget.mjs --check          fail on a >25% regression here
 *
 * The expensive half (build, test) is deliberately not in `make verify`: it is the
 * thing being measured, so running it on every edit would measure a queue.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { measureBoot } from "./api-boot-budget.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = `${ROOT}.github/perf-baseline.json`;

/** Over this much slower than the recorded baseline, a workload fails `--check`. */
export const TOLERANCE_PCT = 25;

/**
 * Which machine produced a number.
 *
 * Deliberately coarse — CPU model, core count and platform — because that is what
 * decides a compile time. A hostname is not: it differs between a laptop that was
 * renamed and the same laptop in CI, which would make every comparison "no baseline".
 */
export function hostLabel({
  osPlatform = platform(),
  cpuModel = cpus()[0]?.model ?? "unknown-cpu",
  cores = cpus().length,
  bytes = totalmem(),
} = {}) {
  const model = String(cpuModel).replace(/\s+/g, " ").trim();
  const gb = Math.round(bytes / 1024 ** 3);
  return `${osPlatform}-${model}-${cores}c-${gb}gb`;
}

const HERE = hostLabel();

/** Run a command to completion and return its wall time. Output is kept on failure only. */
function time(label, cmd, args, opts = {}) {
  const started = process.hrtime.bigint();
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: opts.quiet ? "pipe" : "inherit",
    env: { ...process.env, CI: "1", ...opts.env },
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (res.status !== 0) {
    const tail = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
    throw new Error(`${label} exited ${res.status}\n${tail}`);
  }
  return ms;
}

/** Remove the incremental and turbo state that makes a build warm. */
function cleanBuildState() {
  for (const path of [".turbo/cache", "apps/ui/build", ".react-router"]) {
    rmSync(`${ROOT}${path}`, { recursive: true, force: true });
  }
  // tsbuildinfo files are gitignored, so they are found by walking: everything a
  // previous `tsc -b` remembered goes, or the "cold" build is only half cold.
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".turbo") {
        continue;
      }
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsbuildinfo")) rmSync(full, { force: true });
    }
  };
  walk(ROOT.replace(/\/$/, ""));
}

/**
 * Dev-server start: from spawning the server to the first 200 on `/`.
 *
 * The dev server compiles the route tree on demand, so the number is "how long
 * until a developer sees the page", not "how long until the process exists".
 */
async function measureDevServer({ timeoutMs = 180_000 } = {}) {
  const { spawn } = await import("node:child_process");
  const started = process.hrtime.bigint();
  const child = spawn("pnpm", ["--filter", "@nexus/ui", "dev"], {
    cwd: ROOT,
    shell: process.platform === "win32",
    env: { ...process.env, CI: "1", NEXUS_API_URL: "http://127.0.0.1:1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = "http://127.0.0.1:5173/";
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return Number(process.hrtime.bigint() - started) / 1e6;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`ui dev server did not answer ${url} within ${timeoutMs}ms`);
  } finally {
    // A dev server spawns a watcher; on Windows killing the shell orphans it.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
}

/**
 * The workloads, each a name a human would use. `cost` is what the number means,
 * so a regression report says something better than "a number went up".
 */
export const WORKLOADS = {
  buildCold: {
    what: "clean `pnpm build`: no turbo cache, no tsbuildinfo, no previous UI output",
    run: async () => {
      cleanBuildState();
      return time("buildCold", "pnpm", ["build"]);
    },
  },
  buildWarm: {
    what: "the same `pnpm build` immediately again, with every cache in place",
    run: async () => time("buildWarm", "pnpm", ["build"]),
  },
  test: {
    what: "`pnpm test` — every workspace suite through turbo",
    run: async () => time("test", "pnpm", ["test"]),
  },
  uiDev: {
    what: "UI dev server: spawn to the first 200 on http://127.0.0.1:5173/",
    run: async () => measureDevServer(),
  },
  apiBoot: {
    what: "API: `import server.ts` to a served GET /health, embedded database",
    run: async () => (await measureBoot()).elapsedMs,
  },
};

/** The committed baselines, keyed by workload. A missing file is an empty set. */
export function readBaseline(path = BASELINE) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Compare a measurement with the baseline for this host. Returns `ok` false only
 * when the baseline exists, is from the same host, and the new number is more than
 * `TOLERANCE_PCT` worse — a laptop cannot "regress" against a runner.
 */
export function judge(workload, ms, baseline = readBaseline(), host = HERE) {
  const entry = baseline[workload];
  if (!entry) return { ok: true, reason: "no baseline recorded" };
  if (entry.host !== host) {
    return { ok: true, reason: `baseline is from ${entry.host}, this is ${host}` };
  }
  if (!entry.ms) return { ok: true, reason: "baseline has no number" };
  const pct = ((ms - entry.ms) / entry.ms) * 100;
  if (pct <= TOLERANCE_PCT) {
    return { ok: true, reason: `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs ${entry.ms}ms` };
  }
  return {
    ok: false,
    reason: `${pct.toFixed(0)}% over the ${entry.ms}ms baseline from ${entry.host}`,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  const names = only ? only.split(",") : Object.keys(WORKLOADS);
  for (const name of names) {
    if (!WORKLOADS[name]) {
      console.error(`✖ unknown workload "${name}" — one of ${Object.keys(WORKLOADS).join(", ")}`);
      process.exit(2);
    }
  }

  const baseline = readBaseline();
  const results = {};
  let failed = 0;
  console.log(`perf: host ${HERE}`);
  for (const name of names) {
    console.log(`\n▶ ${name} — ${WORKLOADS[name].what}`);
    let ms;
    try {
      ms = await WORKLOADS[name].run();
    } catch (error) {
      console.error(`✖ ${name} failed: ${error.message}`);
      process.exit(1);
    }
    const verdict = judge(name, ms, baseline);
    results[name] = { ms: Math.round(ms), host: HERE, at: new Date().toISOString() };
    console.log(
      `${verdict.ok ? "✔" : "✖"} ${name}: ${Math.round(ms)}ms — ${verdict.reason}`,
    );
    if (!verdict.ok && argv.includes("--check")) failed++;
  }

  if (argv.includes("--record")) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ ...readBaseline(), ...results }, null, 2)}\n`,
    );
    console.log(`\nperf: recorded ${Object.keys(results).join(", ")} into .github/perf-baseline.json`);
    process.exit(0);
  }
  if (argv.includes("--check")) {
    console.log(failed === 0 ? "\nperf: within budget" : `\nperf: ${failed} workload(s) over budget`);
    process.exit(failed === 0 ? 0 : 1);
  }
}
