// SPDX-License-Identifier: Apache-2.0
/**
 * Verify a downloaded release directory without installing anything.
 *
 * Checks the published `SHA256SUMS`, the detached Ed25519 signature over
 * `manifest.json`, and every artifact the manifest names (sha256 + size), so a
 * release page can be audited on any OS. The public key is the one the app
 * embeds, not the signing key.
 *
 * Usage:
 *   node scripts/release/verify-artifacts.mjs \
 *     --dir release --public-key update-public.pem
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  console.error(`verify-artifacts: ${message}`);
  process.exit(1);
}

function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--public-key") args.publicKey = argv[++i];
    else fail(`unknown argument ${argv[i]}`);
  }
  return args;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** `sha256sum` writes `<hex>  <name>`; a Windows tool may write `<hex> *<name>`. */
export function parseChecksums(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line);
      if (!match) throw new Error(`not a checksum line: ${line.slice(0, 80)}`);
      return { sha256: match[1].toLowerCase(), name: match[2] };
    });
}

export function verifyDirectory({ dir, publicKeyPem }) {
  const required = ["manifest.json", "manifest.json.sig", "SHA256SUMS"];
  for (const name of required) {
    if (!existsSync(join(dir, name))) fail(`missing ${name}`);
  }

  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  const signature = Buffer.from(
    readFileSync(join(dir, "manifest.json.sig"), "utf8").trim(),
    "base64",
  );
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    fail("the public key is not a valid SPKI key");
  }
  if (key.asymmetricKeyType !== "ed25519") fail("the public key is not Ed25519");
  if (!verify(null, manifestBytes, key, signature)) fail("manifest signature does not verify");

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail("manifest has no artifacts");
  }

  const checksums = new Map(
    parseChecksums(readFileSync(join(dir, "SHA256SUMS"), "utf8")).map((row) => [
      row.name,
      row.sha256,
    ]),
  );
  for (const [name, expected] of checksums) {
    const path = join(dir, name);
    if (!existsSync(path)) fail(`SHA256SUMS names a missing file: ${name}`);
    const actual = sha256(path);
    if (actual !== expected) fail(`checksum mismatch for ${name}`);
  }

  for (const artifact of manifest.artifacts) {
    const name = basename(decodeURIComponent(new URL(artifact.url).pathname));
    const path = join(dir, name);
    if (!existsSync(path)) fail(`manifest names a missing artifact: ${name}`);
    const body = readFileSync(path);
    if (body.length !== artifact.size) fail(`size mismatch for ${name}`);
    if (createHash("sha256").update(body).digest("hex") !== artifact.sha256) {
      fail(`sha256 mismatch for ${name}`);
    }
    if (checksums.get(name) && checksums.get(name) !== artifact.sha256) {
      fail(`${name} differs between SHA256SUMS and manifest.json`);
    }
  }

  if (
    !checksums.has("manifest.json") ||
    checksums.get("manifest.json") !== sha256(join(dir, "manifest.json"))
  ) {
    fail("SHA256SUMS does not cover manifest.json");
  }
  return {
    version: manifest.version,
    artifacts: manifest.artifacts.length,
    checksums: checksums.size,
  };
}

function main() {
  const args = argsOf(process.argv.slice(2));
  if (!args.dir) fail("--dir is required");
  if (!args.publicKey) fail("--public-key is required (the key the app embeds)");
  const result = verifyDirectory({
    dir: resolve(args.dir),
    publicKeyPem: readFileSync(resolve(args.publicKey), "utf8"),
  });
  console.log(
    `release ${result.version}: signature valid, ${result.artifacts} artifact(s) and ` +
      `${result.checksums} checksum(s) verified`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
