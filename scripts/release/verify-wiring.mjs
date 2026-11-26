// SPDX-License-Identifier: Apache-2.0
/**
 * Static release wiring: prove the installer, feed and signing chain agree
 * without building either platform or owning any credential.
 *
 * The checks read the committed configuration, not a built artifact, so CI can
 * fail on drift (a renamed artifact, a hook moved under `mac`, a feed job that
 * stopped refusing an unsigned manifest) before a tag exists.
 *
 * Usage: node scripts/release/verify-wiring.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { classifyArtifact } from "./build-update-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const yaml = (path) => parseYaml(read(path));

const failures = [];
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`[pass] ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    failures.push(name);
    console.log(`[fail] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pkg = json("apps/desktop/package.json");
const version = pkg.version;
const builder = yaml("apps/desktop/electron-builder.yml");
const release = yaml(".github/workflows/release.yml");
const releaseText = read(".github/workflows/release.yml");

check("installer names classify for every shipped platform", () => {
  const names = [
    `Nexus-Setup-${version}.exe`,
    `Nexus-${version}-x64.dmg`,
    `Nexus-${version}-arm64.dmg`,
    `Nexus-${version}-x64.AppImage`,
  ];
  const info = names.map((name) => ({ name, info: classifyArtifact(name) }));
  assert(
    info.every((entry) => entry.info?.version === version),
    `classifier rejected ${info
      .filter((e) => !e.info)
      .map((e) => e.name)
      .join(", ")}`,
  );
  const platforms = info.filter((e) => e.info).map((e) => `${e.info.platform}/${e.info.arch}`);
  return platforms.join(", ");
});

check("electron-builder artifact templates match the classifier", () => {
  assert(builder.win?.artifactName === "Nexus-Setup-${version}.${ext}", "win.artifactName drifted");
  assert(
    builder.mac?.artifactName === "Nexus-${version}-${arch}.${ext}",
    "mac.artifactName drifted",
  );
  assert(
    builder.linux?.artifactName === "Nexus-${version}-${arch}.${ext}",
    "linux.artifactName drifted",
  );
});

check("the notarise hook is top-level, not per-platform", () => {
  assert(builder.afterSign === "scripts/notarize.cjs", "afterSign must be top-level");
  assert(
    builder.mac?.afterSign === undefined,
    "afterSign under mac is ignored by electron-builder",
  );
  assert(existsSync(join(root, "apps/desktop/scripts/notarize.cjs")), "notarize.cjs is missing");
});

check("macOS build is hardened and carries entitlements", () => {
  assert(builder.mac?.hardenedRuntime === true, "hardenedRuntime is off");
  for (const key of ["entitlements", "entitlementsInherit"]) {
    const path = builder.mac?.[key];
    assert(path, `${key} is unset`);
    assert(existsSync(join(root, "apps/desktop", path)), `${path} does not exist`);
  }
});

check("the API dependency tree ships beside the bundle", () => {
  const entries = builder.extraResources ?? [];
  assert(
    entries.some(
      (entry) => entry?.from === "resources/api/node_modules" && entry?.to === "api/node_modules",
    ),
    "resources/api/node_modules is not in extraResources",
  );
  const nsis = builder.nsis ?? {};
  assert(nsis.perMachine === false, "NSIS must install per-user");
});

check("a tag build packages, signs and refuses an unsigned feed", () => {
  assert(release.on?.push?.tags?.includes("v*"), "release.yml does not trigger on v* tags");
  for (const job of ["desktop", "desktop-feed"]) {
    assert(release.jobs?.[job], `release.yml has no ${job} job`);
  }
  assert(
    release.jobs["desktop-feed"].needs === "desktop",
    "the feed job must wait for both installers",
  );
  const signStep = release.jobs["desktop-feed"].steps.find((step) =>
    String(step.name).includes("Sign"),
  );
  const run = signStep?.run ?? "";
  assert(run.includes("UPDATE_SIGNING_KEY"), "the feed step does not require a signing key");
  assert(run.includes("exit 1"), "the feed step does not fail closed");
  assert(run.includes("UPDATE_PUBLIC_KEY"), "the feed step does not compare the embedded key");
  assert(run.includes("sha256sum") === false, "checksums belong in their own step");
});

check("the desktop job bakes the feed into the app", () => {
  assert(
    releaseText.includes("pnpm --filter @nexus/desktop update:config"),
    "update:config is not run",
  );
  assert(releaseText.includes("vars.UPDATE_PUBLIC_KEY"), "no UPDATE_PUBLIC_KEY variable is used");
  assert(
    releaseText.includes("releases/latest/download"),
    "no default feed URL is derived from the repository",
  );
  assert(
    releaseText.includes("does not match apps/desktop"),
    "nothing checks that the tag equals the app version",
  );
  assert(
    existsSync(join(root, "apps/desktop/scripts/write-update-config.mjs")),
    "writer is missing",
  );
});

check("checksums and release assets cover every artifact", () => {
  assert(
    releaseText.includes("sha256sum *.exe *.dmg manifest.json manifest.json.sig"),
    "checksum list drifted",
  );
  assert(releaseText.includes("apps/desktop/dist-installers/*.exe"), "installer upload missing");
  assert(releaseText.includes("apps/desktop/dist-installers/*.dmg"), "dmg upload missing");
  assert(releaseText.includes("softprops/action-gh-release"), "no release publication step");
  assert(releaseText.includes("sbom-desktop.spdx.json"), "desktop SBOM is not attached");
});

check("update settings are documented for both build and runtime", () => {
  const env = read(".env.example");
  for (const name of ["NEXUS_UPDATE_FEED_URL", "NEXUS_UPDATE_PUBLIC_KEY"]) {
    assert(env.includes(name), `${name} is absent from .env.example`);
  }
  const readme = read("apps/desktop/README.md");
  assert(readme.includes("update-config.json"), "README does not explain the baked config");
  assert(readme.includes("measure:launch"), "README does not mention the timing check");
});

check("the updater still requires a signature before parsing", () => {
  const source = read("apps/desktop/src/updater.ts");
  assert(source.includes("verifyManifestSignature"), "signature verification is gone");
  assert(source.includes("ed25519"), "the key type check is gone");
  assert(source.includes("timingSafeEqual"), "the digest comparison is not constant-time");
});

if (failures.length) {
  console.error(`\nrelease wiring: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nrelease wiring: all checks passed");
