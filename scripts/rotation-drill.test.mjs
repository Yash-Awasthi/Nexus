// SPDX-License-Identifier: Apache-2.0
/**
 * A rotation procedure is only usable on the day it is needed if every name in it is
 * still true: the env var the deployment sets, the route that rotates a stored key, the
 * audit action that proves it happened.
 *
 * So the runbook's drill is read as data and checked against the source. This does not
 * run the drill — only a human with a provider console can — it stops the procedure from
 * rotting into instructions that point at a route which no longer exists.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { envNames, section } from "./markdown-sections.mjs";

const RUNBOOK = "docs/runbook.md";
const ENV_EXAMPLE = ".env.example";

/** What `.env.example` documents, commented out or not. */
export function documentedEnv(text) {
  const found = new Set();
  for (const [, name] of text.matchAll(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gm)) found.add(name);
  return found;
}

const text = readFileSync(RUNBOOK, "utf8");
const drill = section(text);

test("the drill exists and has both halves", () => {
  assert.ok(drill, "no `## 11.` section in docs/runbook.md");
  assert.ok(drill.split("\n").length > 40, "the drill is too short to be a procedure");
  assert.match(drill, /provider key/i, "the stored-key half is missing");
  assert.match(drill, /OAuth client secret/i, "the env-only half is missing");
  assert.match(drill, /Drill record/, "no place to write the measured wall time");
  assert.match(drill, /\| _unrun_\s+\|/, "the record must show the drill has not been run yet");
});

test("every env var the drill tells you to set is documented", () => {
  const documented = documentedEnv(readFileSync(ENV_EXAMPLE, "utf8"));
  const named = envNames(drill);
  assert.ok(named.length >= 4, `only ${named.length} env names found in the drill`);
  const missing = named.filter((name) => /_(SECRET|KEY)$/.test(name) && !documented.has(name));
  assert.deepEqual(missing, [], "names in the drill that .env.example does not document");
});

test("the OAuth half names the secrets the providers actually require", () => {
  const providers = readFileSync("packages/llm-oauth/src/providers.ts", "utf8");
  const required = [...providers.matchAll(/requiredEnv:\s*\[([^\]]+)\]/g)].flatMap(([, list]) =>
    [...list.matchAll(/"([A-Z0-9_]+)"/g)].map(([, name]) => name),
  );
  const secrets = required.filter((name) => /_OAUTH_CLIENT_SECRET$/.test(name));
  assert.ok(
    secrets.length >= 2,
    `expected several OAuth client secrets, found ${secrets.join(", ")}`,
  );
  for (const secret of secrets) {
    assert.ok(
      drill.includes(secret),
      `${secret} is required by the code and absent from the drill`,
    );
  }
});

test("the BYOK half names a route and an audit action that exist", () => {
  const route = readFileSync("apps/api/src/routes/provider-keys.ts", "utf8");
  assert.match(route, /app\.post/, "no POST handler in provider-keys");
  assert.match(route, /"\/user\/provider-keys"/, "the route the drill posts to is gone");
  assert.match(drill, /POST -H "authorization: Bearer \$NEXUS_TOKEN"/);
  const action = /action:\s*existing \?\s*"([a-z_.]+)"\s*:\s*"([a-z_.]+)"/.exec(route);
  assert.ok(action, "provider-keys no longer records create/rotate audit actions");
  assert.ok(drill.includes(action[1]), `the drill does not mention ${action[1]}`);
});

/** Every route path the drill tells you to curl has to be a route this API serves. */
test("every path in the drill's curl commands is a registered route", () => {
  const sources = readdirSync("apps/api/src/routes")
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(path.join("apps/api/src/routes", name), "utf8"))
    .join("\n");
  const paths = [...drill.matchAll(/"\$NEXUS_URL(\/api\/[a-z0-9/{}:-]+)"/g)].map(
    ([, href]) => href,
  );
  assert.ok(paths.length >= 2, `only ${paths.length} curl paths found in the drill`);
  for (const href of paths) {
    // /api/x is the bridge's mount prefix; the handler registers "/x".
    const registered = href.replace(/^\/api/, "");
    assert.ok(
      sources.includes(`"${registered}"`),
      `${href} is in the drill but no route registers ${registered}`,
    );
  }
});

test("the at-rest keys are named, with the consequence of rotating them", () => {
  for (const name of ["NEXUS_SECRETS_KEY", "NEXUS_OAUTH_VAULT_KEY"]) {
    assert.ok(drill.includes(name), `${name} must be named: touching it breaks every stored value`);
  }
  assert.match(drill, /unreadable/, "rotating an at-rest key orphans the ciphertext — say so");
  assert.match(drill, /out of scope/i, "the drill must say what it deliberately does not cover");
});

test("a section whose name does not exist reads as nothing, not as everything", () => {
  assert.equal(section(text, /^## 99\. /), null);
  assert.deepEqual(envNames("`lower_case` and `NEXUS_REAL_NAME`"), ["NEXUS_REAL_NAME"]);
});

test("every doc that mentions rotation points at the drill", () => {
  const docs = readdirSync("docs")
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(path.join("docs", name), "utf8") }));
  const owners = docs.filter(({ text: body }) =>
    /rotat(e|ing) (a|the) (provider key|OAuth)/i.test(body),
  );
  for (const { name } of owners) {
    assert.ok(
      name === "runbook.md" || docs.find((d) => d.name === name).text.includes("runbook.md#11"),
      `${name} mentions rotation without linking the drill`,
    );
  }
  assert.ok(existsSync("docs/runbook.md"));
});
