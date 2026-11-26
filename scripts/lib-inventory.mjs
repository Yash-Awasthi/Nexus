// SPDX-License-Identifier: Apache-2.0
/**
 * `apps/api/src/lib` is 104 modules and the largest untested surface in the API. Two
 * questions the plan asked about it, answered as measurements rather than prose:
 *
 *   1. Which domain does each module belong to? Every module must match exactly one rule
 *      below. A module that matches none is an unmapped module, which is how a directory
 *      of a hundred files becomes a directory nobody can describe.
 *   2. Does a test name it? A module no test mentions is a module whose behaviour is
 *      trusted rather than checked. Twelve were in that state when this gate was written;
 *      the list may only shrink, so a thirteenth has to be written with a test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = fileURLToPath(new URL("../apps/api/src/lib", import.meta.url));
const TESTS = fileURLToPath(new URL("../apps/api/tests", import.meta.url));

/**
 * Ordered: the first matching rule wins. The order is the reading of the directory —
 * what the module is *for*, not what it is called.
 */
export const DOMAINS = [
  {
    domain: "models",
    why: "talks to a model provider or routes between them",
    match:
      /^(llm-|model-|provider-keys|prompt-cache|semantic-cache|routing-data|oauth-|chat-safety|citations|injection-classifier|moderation-score|models-seed)/,
  },
  {
    domain: "skills",
    why: "imports, compresses or runs a skill",
    match: /^skill-/,
  },
  {
    domain: "org",
    why: "the company-of-agents surfaces",
    match: /^(org-|board-client|weekly-digest|mission-)/,
  },
  {
    domain: "storage",
    why: "owns rows or files that outlive the process",
    match:
      /(-store|^.*history$|^persistent-store|^pg-pool|^session-graph|^knowledge-graph-store|^drive-durability|^archetype-store|^threads-store|^notifications-store|^shared-kv|^migrate-embedded|^migration-lock|^memory-|^diff-history|^cost-log|^council-transcript)/,
  },
  {
    domain: "security",
    why: "decides whether a caller may do something",
    match:
      /^(secret-|crypto-utils|auth-hardening|pat-|security-|exec-|untrusted-|sso-|sign-in-finish|grant-admin|session-revocation|owner|audit-|trust-proxy|issue-access-token|public-url|gdpr-erasure|user-context)/,
  },
  {
    domain: "runtime",
    why: "schedules work inside this process",
    match:
      /^(agent-|idle-map|rate-|startup-env|plugin-host|lsp|symbols|channels|reactions|request-traces|sentry-reporter|with-key-lock)/,
  },
  {
    domain: "integrations",
    why: "speaks a protocol that is not ours",
    match: /^(cf-adapter|duckduckgo|mailer|site-import|lru-utils|extract-text)/,
  },
  { domain: "api-shape", why: "defines the HTTP contract", match: /^(api-maturity|reply-errors)$/ },
];

/** Modules with no test that names them. May only shrink. */
export const UNTESTED = [
  "audit-emitter",
  "board-client",
  "exec-guard",
  "oauth-drivers",
  "plugin-host",
  "sentry-reporter",
  "sign-in-finish",
  "sso-link",
  "semantic-cache",
];

export function modules(dir = LIB) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => file.replace(/\.ts$/, ""))
    .sort();
}

/** The module → domain table, with every module appearing exactly once. */
export function classify(names = modules()) {
  const rows = [];
  const unmapped = [];
  for (const name of names) {
    const rule = DOMAINS.find((candidate) => candidate.match.test(name));
    if (rule) rows.push({ name, domain: rule.domain, why: rule.why });
    else unmapped.push(name);
  }
  return { rows, unmapped };
}

/** Every `.ts` under `apps/api/tests`, concatenated: a mention anywhere counts. */
function testCorpus(dir = TESTS) {
  const parts = [];
  const names = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        parts.push(readFileSync(full, "utf8"));
        names.push(entry.name.replace(/\.test\.ts$/, ""));
      }
    }
  };
  walk(dir);
  return { text: parts.join("\n"), names };
}

/**
 * The modules no test accounts for. Two ways to be accounted for: a test imports the
 * module (`lib/<name>`), or a test file is named after it (`channels.test.ts` for
 * `lib/channels.ts`) — a route test that exercises the module end to end covers it just
 * as well as a unit test that imports it.
 */
export function untested(corpus, names = modules()) {
  const { text, names: files } = corpus;
  return names.filter(
    (name) =>
      !new RegExp(`lib/${name}(?![a-z-])`, "i").test(text) &&
      !files.some((file) => new RegExp(`^${name}(-|$)`, "i").test(file)),
  );
}

export function report(dir = LIB, corpus = testCorpus()) {
  const names = modules(dir);
  const { rows, unmapped } = classify(names);
  const missing = untested(corpus, names);
  return {
    total: names.length,
    rows,
    unmapped,
    untested: missing,
    // An allowlisted module that a test now names is a ratchet the other way: the list
    // must shrink, so leaving it behind means the list no longer describes the tree. Only
    // modules that still exist count — a deleted module is a different kind of drift.
    stale: UNTESTED.filter((name) => names.includes(name) && !missing.includes(name)),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const measured = report();
  const rows = [
    ...measured.unmapped.map((name) => `lib/${name}.ts belongs to no domain — add a rule`),
    ...measured.untested
      .filter((name) => !UNTESTED.includes(name))
      .map((name) => `lib/${name}.ts has no test — write apps/api/tests/lib/${name}.test.ts`),
    ...measured.stale.map((name) => `lib/${name}.ts is now tested — remove it from UNTESTED`),
  ];
  const byDomain = new Map();
  for (const row of measured.rows) byDomain.set(row.domain, (byDomain.get(row.domain) ?? 0) + 1);
  const summary = [...byDomain.entries()].map(([domain, n]) => `${domain} ${n}`).join(", ");
  console.log(
    `lib inventory: ${measured.total} modules (${summary}); ${measured.untested.length} untested`,
  );
  for (const row of rows) console.error(`✖ ${row}`);
  process.exit(rows.length === 0 ? 0 : 1);
}
