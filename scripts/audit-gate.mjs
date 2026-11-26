// SPDX-License-Identifier: Apache-2.0
/**
 * `pnpm audit` prints and moves on; a warning a week is a warning nobody reads.
 * High and critical advisories block here instead — with an allowlist for the
 * ones that genuinely cannot be fixed yet, and every entry carries an expiry date
 * so "temporarily accepted" decays into "fixed" rather than into "forgotten".
 *
 *   node scripts/audit-gate.mjs            # whole tree (prod + dev)
 *   node scripts/audit-gate.mjs --prod     # what actually ships
 *   node scripts/audit-gate.mjs --from audit.json   # a saved result, for tests
 *
 * Exit 1 when a high/critical advisory is not allowlisted, or when an entry in the
 * allowlist is past its expiry. Lower severities are reported and never block.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = ".github/audit-allowlist.json";
const BLOCKING = new Set(["high", "critical"]);

/** Severities in the order pnpm reports them, so "at least high" is comparable. */
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** pnpm audit JSON → one entry per advisory, keyed by the id the allowlist names. */
export function advisoriesOf(report) {
  const advisories = report?.advisories ?? {};
  // npm-style reports keep the same data under `vulnerabilities`, with `via` entries
  // carrying the advisory. Support both so a pnpm major cannot silently pass.
  const vulnerabilities = report?.vulnerabilities ?? {};
  const out = [];
  for (const [key, advisory] of Object.entries(advisories)) {
    out.push({
      id: String(advisory.github_advisory_id ?? advisory.id ?? key),
      package: String(advisory.module_name ?? advisory.name ?? "unknown"),
      severity: String(advisory.severity ?? "info").toLowerCase(),
      title: String(advisory.title ?? ""),
    });
  }
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    for (const via of entry?.via ?? []) {
      if (typeof via !== "object") continue;
      out.push({
        id: String(via.source ?? via.url ?? via.title ?? name),
        package: name,
        severity: String(entry.severity ?? via.severity ?? "info").toLowerCase(),
        title: String(via.title ?? ""),
      });
    }
  }
  // The same advisory can arrive from both shapes; keep one.
  const seen = new Map();
  for (const advisory of out) seen.set(`${advisory.id}|${advisory.package}`, advisory);
  return [...seen.values()];
}

/**
 * The decision: what blocks, which allowlist entries have expired, which no longer
 * match anything. `now` is a date so the check is testable without a clock.
 */
export function decide(advisories, allowlist, now) {
  const blocked = advisories.filter((a) => BLOCKING.has(a.severity));
  const allowed = new Map(allowlist.map((entry) => [String(entry.id), entry]));

  const expired = [];
  const stillValid = new Map();
  for (const entry of allowlist) {
    const expires = new Date(`${entry.expires}T23:59:59Z`);
    if (Number.isNaN(expires.getTime())) {
      expired.push({ ...entry, why: "no valid expiry date" });
      continue;
    }
    if (expires < now) expired.push({ ...entry, why: `expired ${entry.expires}` });
    else stillValid.set(String(entry.id), entry);
  }

  const unallowed = [];
  const used = new Set();
  for (const advisory of blocked) {
    if (stillValid.has(advisory.id)) {
      used.add(advisory.id);
      continue;
    }
    unallowed.push(advisory);
  }

  const stale = allowlist
    .filter((entry) => !used.has(String(entry.id)))
    .map((entry) => String(entry.id));

  return { unallowed, expired, stale, blockedCount: blocked.length };
}

function runAudit(prodOnly) {
  const args = ["audit", "--json"];
  if (prodOnly) args.push("--prod");
  let last = "";
  // The registry answers 502 or times out now and then; one retry separates a flaky
  // network from a real result. A run that cannot produce JSON exits 2 — a gate that
  // fails open is worse than no gate.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = spawnSync("pnpm", args, {
      encoding: "utf8",
      shell: process.platform === "win32",
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    const start = text.indexOf("{");
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        last = text.slice(0, 800);
      }
    } else {
      last = text.slice(0, 800) || `exit ${res.status} with no output`;
    }
  }
  throw new Error(`audit-gate: pnpm audit produced no JSON after 2 attempts:\n${last}`);
}

function main() {
  const argv = process.argv.slice(2);
  const prodOnly = argv.includes("--prod");
  const fromIndex = argv.indexOf("--from");

  const report =
    fromIndex >= 0 ? JSON.parse(readFileSync(argv[fromIndex + 1], "utf8")) : runAudit(prodOnly);
  const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  const { unallowed, expired, stale, blockedCount } = decide(
    advisoriesOf(report),
    allowlist,
    new Date(),
  );

  const scope = prodOnly ? "production tree" : "whole tree";
  console.log(
    `audit-gate: ${scope}, ${blockedCount} high/critical advisories, ${allowlist.length} allowlisted`,
  );

  if (stale.length > 0) {
    // Not a failure: an advisory that disappeared is the fix landing. It does mean
    // the entry is now lying about the tree.
    for (const id of stale) console.log(`  ${id}: allowlisted but no longer reported — remove it`);
  }
  for (const entry of expired) {
    console.error(`  ${entry.id} (${entry.package ?? "?"}): allowlist entry ${entry.why}`);
  }
  for (const advisory of unallowed) {
    console.error(
      `  ${advisory.id} ${advisory.package} ${advisory.severity}: ${advisory.title || "no title"}`,
    );
  }
  if (unallowed.length > 0 || expired.length > 0) {
    console.error(
      `\naudit-gate: ${unallowed.length} unallowlisted and ${expired.length} expired. Fix the dependency, or add an entry to ${ALLOWLIST} with a reason and an expiry date.`,
    );
    return 1;
  }
  console.log("audit-gate: nothing blocking");
  return 0;
}

if (process.argv[1]?.endsWith("audit-gate.mjs")) {
  try {
    process.exit(main());
  } catch (error) {
    // Not a pass: the check could not be made. CI shows the reason and fails.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
