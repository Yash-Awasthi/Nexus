// SPDX-License-Identifier: Apache-2.0
/**
 * Bake the update feed URL and public key into the packaged shell.
 *
 * An installed app is launched from a shortcut, so it has no `NEXUS_UPDATE_*`
 * environment. `dist/main.js` therefore reads `dist/update-config.json` (inside
 * the asar) when the variables are absent. This script writes that file from
 * the environment at package time, or removes it when nothing is set, which
 * leaves the updater safely disabled instead of pointing at a guessed feed. A
 * public key is not a secret; it is what the client verifies with.
 *
 * Usage (before electron-builder):
 *   NEXUS_UPDATE_FEED_URL=https://… NEXUS_UPDATE_PUBLIC_KEY=… \
 *     pnpm --filter @nexus/desktop update:config
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "dist");
const outFile = join(outDir, "update-config.json");

const feedUrl = (process.env.NEXUS_UPDATE_FEED_URL ?? "").trim().replace(/\/+$/, "");
const publicKey = (process.env.NEXUS_UPDATE_PUBLIC_KEY ?? "").trim();
const log = process.env.NEXUS_UPDATE_LOG === "off" ? () => {} : console.log;

const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(feedUrl);
if (feedUrl && !/^https:\/\//.test(feedUrl) && !loopback) {
  console.error("write-update-config: NEXUS_UPDATE_FEED_URL must be https or loopback http");
  process.exit(1);
}
if (
  feedUrl &&
  publicKey &&
  !publicKey.startsWith("-----BEGIN PUBLIC KEY-----") &&
  publicKey.length < 40
) {
  console.error("write-update-config: NEXUS_UPDATE_PUBLIC_KEY is too short to be a public key");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
if (!feedUrl || !publicKey) {
  rmSync(outFile, { force: true });
  log("write-update-config: no feed/key set; the packaged updater stays disabled");
  process.exit(0);
}

writeFileSync(outFile, `${JSON.stringify({ feedUrl, publicKey }, null, 2)}\n`, { mode: 0o644 });
log(`write-update-config: wrote ${outFile} for ${feedUrl}`);
