// SPDX-License-Identifier: Apache-2.0
/**
 * Sign a release checksum list with the Ed25519 update key.
 *
 * `SHA256SUMS.sig` is a detached signature over `SHA256SUMS`, so a downloaded
 * release can prove the hash list itself was not edited after publication.
 *
 * Usage:
 *   node scripts/release/sign-checksums.mjs \
 *     --file release/SHA256SUMS \
 *     --key-file update-signing-key.pem \
 *     --out release/SHA256SUMS.sig
 *
 * With no `--key-file` the command exits 1, so CI cannot publish an unsigned
 * hash list by forgetting the release key.
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  console.error(`sign-checksums: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--file") args.file = argv[++i];
    else if (key === "--key-file") args.keyFile = argv[++i];
    else if (key === "--out") args.out = argv[++i];
    else fail(`unknown argument ${key}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) fail("--file is required");
  if (!args.out) fail("--out is required");
  if (!args.keyFile) fail("--key-file is required; an unsigned hash list is never published");

  const bytes = readFileSync(resolve(args.file));
  const key = createPrivateKey(readFileSync(resolve(args.keyFile), "utf8"));
  if (key.asymmetricKeyType !== "ed25519") fail("signing key must be Ed25519");
  const signature = sign(null, bytes, key).toString("base64");

  writeFileSync(resolve(args.out), `${signature}\n`, { mode: 0o644 });
  console.log(`signed ${args.file} -> ${args.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
