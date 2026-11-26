// SPDX-License-Identifier: Apache-2.0
/**
 * A retention policy that exists in three places is three policies waiting to disagree.
 *
 * `RETENTION` in packages/contracts is the single statement; this rule fails when a
 * second copy of any of its numbers appears in source, and fails if any code path
 * learns to remove an audit entry — the one store whose policy is "never".
 *
 * It cannot check behaviour (the store tests do that); it checks that the number a
 * reader finds in the code is the number the policy states.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOTS = ["apps", "packages", "scripts", "services"];
const POLICY = "packages/contracts/src/shared/retention.ts";
const SKIP = new Set(["node_modules", "dist", "coverage", ".turbo", "generated", "build", ".venv"]);

/** Every TypeScript and JavaScript source file in the tree, skip lists applied. */
export function sources(roots = ROOTS) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|cjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) found.push(full);
    }
  };
  for (const root of roots) walk(root);
  return found;
}

/** `[file, line]` for every line matching one of the patterns. */
export function matches(files, patterns) {
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
      for (const [name, pattern] of patterns) {
        if (pattern.test(line))
          hits.push({
            file: file.split(path.sep).join("/"),
            line: index + 1,
            rule: name,
            text: line.trim(),
          });
      }
    });
  }
  return hits;
}

const FILES = sources();
const POLICY_TEXT = readFileSync(POLICY, "utf8");

test("the scan sees the tree, or the rules below prove nothing", () => {
  assert.ok(FILES.length > 500, `only ${FILES.length} source files found`);
  assert.match(
    POLICY_TEXT,
    /maxEntries: 1_000/,
    "the traces cap is no longer in the policy module",
  );
  assert.match(
    POLICY_TEXT,
    /ttlMs: 30 \* DAY_MS/,
    "the notification expiry is no longer in the policy module",
  );
  assert.match(
    POLICY_TEXT,
    /indefinite: true/,
    "the audit-log policy is no longer in the policy module",
  );
});

test("no second copy of the traces cap exists outside the policy", () => {
  const copies = matches(
    FILES.filter((file) => file.split(path.sep).join("/") !== POLICY),
    [["traces cap", /MAX_TRACES\s*=\s*\d+/]],
  );
  assert.deepEqual(copies, []);
});

/**
 * The stores that keep user-facing data for 30 days and were written before RETENTION
 * existed. They are not wrong today, and changing a store's retention is a decision, not a
 * cleanup — so they are listed here, and the list may only shrink.
 *
 * Transport and session constants are deliberately out of scope: a 5-minute OAuth state or
 * a 30-second driver cache is a protocol lifetime, not a retention policy.
 */
const OWN_TTL = new Map([
  ["apps/api/src/lib/diff-history.ts", "edit diffs"],
  ["apps/api/src/lib/mission-store.ts", "missions"],
  ["apps/api/src/lib/session-graph.ts", "session graphs"],
  ["packages/sandbox/src/drive-fs.ts", "idle drive volumes"],
]);
/** A 30-day store lifetime: data kept for a month, by a store rather than by the policy. */
const STORE_TTL =
  /^\s*(?:export\s+)?const\s+\w*(?:TTL|IDLE)_MS\s*=\s*30\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/;

test("a store that keeps its own expiry is listed, and the list cannot grow", () => {
  const literal = matches(
    FILES.filter((file) => file !== POLICY),
    [["store ttl", STORE_TTL]],
  );
  const unlisted = literal.filter((hit) => !OWN_TTL.has(hit.file));
  assert.deepEqual(
    unlisted,
    [],
    "state the policy in RETENTION, or add the store to OWN_TTL with its reason",
  );
  // A listed store that no longer holds a literal is a list entry that outlived its reason.
  for (const [file] of OWN_TTL) {
    assert.ok(
      literal.some((hit) => hit.file === file),
      `${file} is listed as holding its own expiry but has none — remove the entry`,
    );
  }
});

test("no second copy of the notification expiry exists outside the policy", () => {
  const copies = matches(
    FILES.filter((file) => file.split(path.sep).join("/") !== POLICY),
    [["notif ttl", /NOTIF_TTL_MS\s*=\s*\d/]],
  );
  assert.deepEqual(copies, []);
});

test("nothing deletes an audit entry", () => {
  const deletions = matches(FILES, [
    ["sql", /DELETE\s+FROM\s+"?audit_log"?/i],
    ["drizzle", /delete\(\s*auditLog\s*\)/],
    ["truncate", /TRUNCATE\s+"?audit_log"?/i],
  ]);
  assert.deepEqual(deletions, [], "the audit log is evidence: no code path may remove an entry");
});

test("the policy cannot be satisfied by a rule that never matches", () => {
  // A canary: the same matcher, on a synthetic line, must report it.
  const hits = matches([POLICY], [["canary", /indefinite: true/]]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.rule, "canary");
});
