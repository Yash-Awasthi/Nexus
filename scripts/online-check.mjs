// SPDX-License-Identifier: Apache-2.0
/**
 * Online acceptance: the deployed host answers what Phase 2 depends on, one pass/fail line each.
 *
 * Reads the host from NEXUS_ONLINE_BASE_URL and sends NEXUS_ONLINE_API_KEY as a bearer token on
 * every request, so a host or proxy that gates these paths answers 401 here rather than during a
 * demo. When either variable is unset nothing is attempted: the run reports `skip` with the
 * reason and exits 0. A check that was attempted and failed is a `fail` and exits 1.
 *
 * Usage: node scripts/online-check.mjs [--dry-run]
 *   --dry-run lists the checks and the URLs, sends no requests.
 */

const BASE_URL = (process.env.NEXUS_ONLINE_BASE_URL ?? "").trim().replace(/\/+$/, "");
const API_KEY = (process.env.NEXUS_ONLINE_API_KEY ?? "").trim();
const TIMEOUT_MS = 8_000;
const DRY_RUN = process.argv.includes("--dry-run");

const results = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
  console.log(`[${status}] ${name}${detail ? `: ${detail}` : ""}`);
}

/** The generated spec is served at the root, outside /api/v1 (apps/api/src/server.ts). */
const checks = [
  {
    name: "online health",
    path: "/health/ready",
    accept: "application/json",
    async verify(res) {
      const body = await res.json();
      const dependencies = body.checks ?? {};
      return {
        ok: res.ok && body.status !== "down",
        detail: `HTTP ${res.status}, status ${body.status}, checks ${JSON.stringify(dependencies)}`,
      };
    },
  },
  {
    name: "online oauth",
    path: "/api/v1/oauth/providers",
    accept: "application/json",
    async verify(res) {
      const body = await res.json();
      const shaped = typeof body.google === "boolean" && typeof body.github === "boolean";
      return {
        ok: res.ok && shaped,
        detail: `HTTP ${res.status}, ${JSON.stringify(body)}`,
      };
    },
  },
  {
    name: "online openapi",
    path: "/openapi.json",
    accept: "application/json",
    async verify(res) {
      const body = await res.json();
      const paths = Object.keys(body.paths ?? {}).length;
      return {
        ok: res.ok && typeof body.openapi === "string" && paths > 0,
        detail: `HTTP ${res.status}, OpenAPI ${body.openapi ?? "missing"}, ${paths} path(s)`,
      };
    },
  },
  {
    name: "online ui",
    path: "/",
    accept: "text/html",
    async verify(res) {
      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      return {
        ok: res.ok && type.includes("text/html") && body.length > 0,
        detail: `HTTP ${res.status}, ${type || "no content-type"}, ${body.length} bytes`,
      };
    },
  },
];

async function check({ name, path, accept, verify }) {
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      headers: { accept, authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const { ok, detail } = await verify(res);
    record(ok ? "pass" : "fail", name, `${url} ${detail}`);
  } catch (err) {
    // fetch reports "fetch failed" for every transport error; the cause carries the reason.
    const cause =
      err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
    record("fail", name, `${url} ${err instanceof Error ? err.message : String(err)}${cause}`);
  }
}

const missing = [
  [BASE_URL, "NEXUS_ONLINE_BASE_URL"],
  [API_KEY, "NEXUS_ONLINE_API_KEY"],
]
  .filter(([value]) => !value)
  .map(([, name]) => name);

if (DRY_RUN) {
  for (const { name, path, accept } of checks) {
    console.log(
      `[dry] ${name}: GET ${BASE_URL || "<NEXUS_ONLINE_BASE_URL>"}${path} ` +
        `(${TIMEOUT_MS} ms, accept ${accept}, bearer)`,
    );
  }
  console.log(
    `\n${checks.length} checks planned, 0 requests sent` +
      (missing.length > 0 ? ` (would skip: ${missing.join(", ")} not set)` : ""),
  );
  process.exit(0);
}

if (missing.length > 0) {
  record(
    "skip",
    "online",
    `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set`,
  );
} else {
  let validUrl = true;
  try {
    const { protocol } = new URL(BASE_URL);
    if (protocol !== "http:" && protocol !== "https:")
      throw new Error(`unsupported protocol ${protocol}`);
  } catch (err) {
    validUrl = false;
    record(
      "fail",
      "online",
      `NEXUS_ONLINE_BASE_URL is not an http(s) URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (validUrl) for (const item of checks) await check(item);
}

const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;
console.log(`\n${results.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
