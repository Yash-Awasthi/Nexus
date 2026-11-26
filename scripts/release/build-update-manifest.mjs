// SPDX-License-Identifier: Apache-2.0
/**
 * Build the signed update feed the desktop app reads.
 *
 * Input is a directory of installers produced by electron-builder; output is
 * `manifest.json` and its detached Ed25519 signature `manifest.json.sig`.
 * The app verifies the signature with its embedded public key before it parses
 * the manifest, and verifies each artifact's sha256 before it runs anything.
 *
 * Usage:
 *   node scripts/release/build-update-manifest.mjs \
 *     --version 0.2.0 \
 *     --base-url https://updates.example.com/0.2.0 \
 *     --dir release \
 *     --key-file update-signing-key.pem \
 *     --out release/feed
 *
 * With no `--key-file` the command writes only the manifest and exits 1, so CI
 * cannot publish an unsigned feed by forgetting a flag.
 */

import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.json.sig";

/** electron-builder artifact names → platform and arch. Anything else is ignored. */
export function classifyArtifact(name) {
  const win = /^Nexus-Setup-(\d+\.\d+\.\d+)\.exe$/i.exec(name);
  if (win) return { version: win[1], platform: "win32", arch: "x64" };
  const mac = /^Nexus-(\d+\.\d+\.\d+)-(x64|arm64)\.dmg$/i.exec(name);
  if (mac) return { version: mac[1], platform: "darwin", arch: mac[2].toLowerCase() };
  const linux = /^Nexus-(\d+\.\d+\.\d+)-(x64|arm64)\.AppImage$/i.exec(name);
  if (linux) return { version: linux[1], platform: "linux", arch: linux[2].toLowerCase() };
  return undefined;
}

function fail(message) {
  console.error(`build-update-manifest: ${message}`);
  process.exit(1);
}

/** One manifest row per recognized installer, with its size and sha256. */
export function buildManifest({ dir, version, baseUrl }) {
  const base = baseUrl.replace(/\/+$/, "");
  const artifacts = [];
  for (const name of readdirSync(dir).sort()) {
    const info = classifyArtifact(name);
    if (!info) continue;
    if (info.version !== version) continue;
    const path = join(dir, name);
    const body = readFileSync(path);
    artifacts.push({
      platform: info.platform,
      arch: info.arch,
      url: `${base}/${encodeURIComponent(name)}`,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
    });
  }
  if (artifacts.length === 0) fail(`no installers for ${version} in ${dir}`);
  return { version, publishedAt: new Date().toISOString(), artifacts };
}

function parseArgs(argv) {
  const args = { dir: "release", out: "release/feed" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--version") args.version = argv[++i];
    else if (key === "--base-url") args.baseUrl = argv[++i];
    else if (key === "--dir") args.dir = argv[++i];
    else if (key === "--out") args.out = argv[++i];
    else if (key === "--key-file") args.keyFile = argv[++i];
    else fail(`unknown argument ${key}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.baseUrl) fail("--version and --base-url are required");
  if (!args.keyFile) fail("--key-file is required; an unsigned feed is never published");
  const loopback = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?(?:\/|$)/i;
  if (!/^https:\/\//i.test(args.baseUrl) && !loopback.test(args.baseUrl)) {
    fail("--base-url must be https (http is allowed only for loopback probes)");
  }

  const manifest = buildManifest(args);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const key = createPrivateKey(readFileSync(resolve(args.keyFile), "utf8"));
  if (key.asymmetricKeyType !== "ed25519") fail("signing key must be Ed25519");
  const signature = sign(null, bytes, key).toString("base64");

  mkdirSync(resolve(args.out), { recursive: true });
  writeFileSync(join(args.out, MANIFEST_FILE), bytes, { mode: 0o644 });
  writeFileSync(join(args.out, SIGNATURE_FILE), `${signature}\n`, { mode: 0o644 });
  console.log(
    `wrote ${join(args.out, MANIFEST_FILE)} (${manifest.artifacts.length} artifact(s)) ` +
      `and ${join(args.out, SIGNATURE_FILE)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
