// SPDX-License-Identifier: Apache-2.0
/**
 * Measures how long the packaged app takes to show its first window with and
 * without an update feed, so "the check never delays launch" has a number.
 *
 * Run after `pnpm --filter @nexus/desktop dist:win`:
 *   node apps/desktop/scripts/measure-launch.mjs
 *
 * A feed that accepts the connection and never answers is the worst case: the
 * 5 s timeout is still armed when the window has to appear.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const exe = resolve(here, "..", "dist-installers", "win-unpacked", "Nexus.exe");
const publicKey = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "der" })
  .toString("base64");

async function trial(label, feedUrl) {
  const dataDir = mkdtempSync(join(tmpdir(), "nexus-launch-"));
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: dataDir };
  delete env["NEXUS_DESKTOP_URL"];
  delete env["NEXUS_API_URL"];
  if (feedUrl) {
    env["NEXUS_UPDATE_FEED_URL"] = feedUrl;
    env["NEXUS_UPDATE_PUBLIC_KEY"] = publicKey;
    env["NEXUS_UPDATE_LOG"] = "debug";
  }
  const started = Date.now();
  const app = await electron.launch({ executablePath: exe, env, timeout: 120_000 });
  const page = await app.firstWindow({ timeout: 120_000 });
  const ms = Date.now() - started;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`${label}: window in ${ms} ms`);
  return ms;
}

const hang = createServer(() => {
  // Accept and never answer: a feed that stalls instead of failing fast.
});
await new Promise((r) => hang.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${hang.address().port}/manifest.json`;
try {
  const base = [await trial("no feed", null), await trial("no feed", null)];
  const hung = [await trial("hanging feed", url), await trial("hanging feed", url)];
  const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  console.log(`average: no feed ${avg(base)} ms, hanging feed ${avg(hung)} ms`);
} finally {
  hang.closeAllConnections();
  hang.close();
}
