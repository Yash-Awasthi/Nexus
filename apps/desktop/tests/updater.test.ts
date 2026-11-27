// SPDX-License-Identifier: Apache-2.0
/**
 * The updater's security properties, driven without Electron or a network:
 * the feed must be signed by the configured Ed25519 key, an artifact must match
 * its sha256 byte for byte, and only a verified file in the update directory is
 * ever handed to an installer.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  assertSafeFeedUrl,
  cleanupOldUpdates,
  confirmRunningVersion,
  describeUpdate,
  downloadVerified,
  fetchManifest,
  inRollout,
  installOnQuit,
  isNewerVersion,
  parseManifest,
  parseUpdateConfig,
  parseVersion,
  readConfirmed,
  readPending,
  releaseChannel,
  rollbackInstaller,
  stageUpdate,
  updatesDir,
  verifyManifestSignature,
  type FetchLike,
  type UpdateManifest,
} from "../src/updater";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-updater-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fetch that answers from a fixed file table and records what it was asked for. */
function fakeFetch(
  files: Record<
    string,
    { body: Buffer | string; status?: number; headers?: Record<string, string> }
  >,
): FetchLike {
  return async (input) => {
    const entry = files[input];
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(entry.body as unknown as BodyInit, {
      status: entry.status ?? 200,
      headers: entry.headers,
    });
  };
}

function makeManifest(
  artifactPath: string,
  version = "0.2.0",
): { manifest: UpdateManifest; bytes: Buffer; signature: Buffer } {
  const body = readFileSync(artifactPath);
  const manifest: UpdateManifest = {
    version,
    publishedAt: "2026-11-24T00:00:00.000Z",
    artifacts: [
      {
        platform: "win32",
        arch: "x64",
        url: "https://updates.example.test/Nexus-0.2.0.exe",
        sha256: createHash("sha256").update(body).digest("hex"),
        size: body.length,
      },
    ],
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  return { manifest, bytes, signature: sign(null, bytes, privateKey) };
}

describe("version handling", () => {
  it("compares dotted numeric versions", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
    expect(() => parseVersion("latest")).toThrow(/not a dotted numeric version/);
  });
});

describe("feed URLs", () => {
  it("accepts https and loopback http only", () => {
    expect(assertSafeFeedUrl("https://updates.example.test")).toBe("https://updates.example.test/");
    expect(assertSafeFeedUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(() => assertSafeFeedUrl("http://updates.example.test")).toThrow(/must be https/);
    expect(() => assertSafeFeedUrl("/relative")).toThrow(/not absolute/);
  });

  it("rejects a non-https artifact URL in a manifest", () => {
    const artifact = join(dir, "a.exe");
    writeFileSync(artifact, "installer");
    const { manifest } = makeManifest(artifact);
    manifest.artifacts[0].url = "http://updates.example.test/a.exe";
    expect(() => parseManifest(Buffer.from(JSON.stringify(manifest)))).toThrow(/must be https/);
  });
});

describe("manifest authentication", () => {
  it("accepts the configured key and rejects a tampered byte", () => {
    const artifact = join(dir, "a.exe");
    writeFileSync(artifact, "installer");
    const { bytes, signature } = makeManifest(artifact);
    expect(() => verifyManifestSignature(bytes, signature, PUBLIC_PEM)).not.toThrow();

    const tampered = Buffer.from(bytes.toString("utf8").replace("0.2.0", "0.3.0"));
    expect(() => verifyManifestSignature(tampered, signature, PUBLIC_PEM)).toThrow(
      /signature is invalid/,
    );
  });

  it("rejects a signature from another key and a non-Ed25519 key", () => {
    const artifact = join(dir, "a.exe");
    writeFileSync(artifact, "installer");
    const { bytes, signature } = makeManifest(artifact);
    const other = generateKeyPairSync("ed25519");
    expect(() =>
      verifyManifestSignature(
        bytes,
        signature,
        other.publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
    ).toThrow(/signature is invalid/);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      verifyManifestSignature(
        bytes,
        signature,
        rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
    ).toThrow(/must be Ed25519/);
  });

  it("fetches both feed files and validates the signature before parsing", async () => {
    const artifact = join(dir, "a.exe");
    writeFileSync(artifact, "installer");
    const { bytes, signature } = makeManifest(artifact);
    const fetchImpl = fakeFetch({
      "https://updates.example.test/manifest.json": { body: bytes },
      "https://updates.example.test/manifest.json.sig": {
        body: signature.toString("base64"),
      },
    });
    const { manifest } = await fetchManifest({
      feedUrl: "https://updates.example.test",
      publicKey: PUBLIC_PEM,
      fetchImpl,
    });
    expect(manifest.version).toBe("0.2.0");

    const wrong = fakeFetch({
      "https://updates.example.test/manifest.json": { body: bytes },
      "https://updates.example.test/manifest.json.sig": {
        body: Buffer.alloc(64).toString("base64"),
      },
    });
    await expect(
      fetchManifest({
        feedUrl: "https://updates.example.test",
        publicKey: PUBLIC_PEM,
        fetchImpl: wrong,
      }),
    ).rejects.toThrow(/signature is invalid/);
  });

  it("caps the manifest and signature bodies", async () => {
    const fetchImpl = fakeFetch({
      "https://updates.example.test/manifest.json": {
        body: Buffer.alloc(300 * 1024),
        headers: { "content-length": String(300 * 1024) },
      },
      "https://updates.example.test/manifest.json.sig": { body: "AAAA" },
    });
    await expect(
      fetchManifest({ feedUrl: "https://updates.example.test", publicKey: PUBLIC_PEM, fetchImpl }),
    ).rejects.toThrow(/larger than/);
  });

  it("rejects a malformed manifest after a valid signature", async () => {
    const bytes = Buffer.from(JSON.stringify({ version: "1.0.0", artifacts: [] }));
    const signature = sign(null, bytes, privateKey);
    const fetchImpl = fakeFetch({
      "https://updates.example.test/manifest.json": { body: bytes },
      "https://updates.example.test/manifest.json.sig": { body: signature.toString("base64") },
    });
    await expect(
      fetchManifest({ feedUrl: "https://updates.example.test", publicKey: PUBLIC_PEM, fetchImpl }),
    ).rejects.toThrow(/no artifacts/);
  });
});

describe("download verification", () => {
  it("writes a matching artifact and removes a tampered one", async () => {
    const body = Buffer.from("installer bytes");
    const good = join(dir, "good.exe");
    await downloadVerified({
      artifact: {
        platform: "win32",
        arch: "x64",
        url: "https://updates.example.test/a.exe",
        sha256: createHash("sha256").update(body).digest("hex"),
        size: body.length,
      },
      destPath: good,
      fetchImpl: fakeFetch({ "https://updates.example.test/a.exe": { body } }),
    });
    expect(readFileSync(good).toString()).toBe("installer bytes");

    const bad = join(dir, "bad.exe");
    await expect(
      downloadVerified({
        artifact: {
          platform: "win32",
          arch: "x64",
          url: "https://updates.example.test/a.exe",
          sha256: "0".repeat(64),
          size: body.length,
        },
        destPath: bad,
        fetchImpl: fakeFetch({ "https://updates.example.test/a.exe": { body } }),
      }),
    ).rejects.toThrow(/does not match its sha256/);
    expect(existsSync(bad)).toBe(false);
    expect(existsSync(`${bad}.part`)).toBe(false);
  });

  it("refuses a body over the cap", async () => {
    await expect(
      downloadVerified({
        artifact: {
          platform: "win32",
          arch: "x64",
          url: "https://updates.example.test/a.exe",
          sha256: "a".repeat(64),
          size: 10,
        },
        destPath: join(dir, "big.exe"),
        fetchImpl: fakeFetch({
          "https://updates.example.test/a.exe": {
            body: Buffer.alloc(64),
            headers: { "content-length": "64" },
          },
        }),
        maxBytes: 16,
      }),
    ).rejects.toThrow(/larger than/);
  });
});

describe("install, confirm and roll back", () => {
  function stage(version: string) {
    const artifact = join(dir, "a.exe");
    writeFileSync(artifact, `installer-${version}`);
    const { manifest } = makeManifest(artifact, version);
    return { manifest, artifact };
  }

  it("stages a newer version and applies it on quit", async () => {
    const { manifest, artifact } = stage("0.2.0");
    const dataDir = join(dir, "data");
    const body = readFileSync(artifact);
    const pending = await stageUpdate({
      manifest,
      currentVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      dataDir,
      fetchImpl: fakeFetch({ "https://updates.example.test/Nexus-0.2.0.exe": { body } }),
    });
    expect("skipped" in pending).toBe(false);
    if ("skipped" in pending) return;
    expect(readPending(updatesDir(dataDir))?.version).toBe("0.2.0");

    const calls: string[][] = [];
    installOnQuit({
      dir: updatesDir(dataDir),
      pending,
      spawn: (command, args) => {
        calls.push([command, ...args]);
        return { unref: () => {} };
      },
    });
    expect(calls[0][0]).toBe(pending.artifactPath);
    expect(calls[0]).toContain("/S");
  });

  it("refuses to install a file that changed after staging", async () => {
    const { manifest, artifact } = stage("0.2.0");
    const dataDir = join(dir, "data");
    const pending = await stageUpdate({
      manifest,
      currentVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      dataDir,
      fetchImpl: fakeFetch({
        "https://updates.example.test/Nexus-0.2.0.exe": { body: readFileSync(artifact) },
      }),
    });
    if ("skipped" in pending) throw new Error("expected a staged update");
    writeFileSync(pending.artifactPath, "swapped");
    expect(() =>
      installOnQuit({ dir: updatesDir(dataDir), pending, spawn: () => ({ unref: () => {} }) }),
    ).toThrow(/no longer matches/);
  });

  it("keeps the applied installer as the rollback target", async () => {
    const { manifest, artifact } = stage("0.2.0");
    const dataDir = join(dir, "data");
    await stageUpdate({
      manifest,
      currentVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      dataDir,
      fetchImpl: fakeFetch({
        "https://updates.example.test/Nexus-0.2.0.exe": { body: readFileSync(artifact) },
      }),
    });
    const confirmed = confirmRunningVersion({ dir: updatesDir(dataDir), runningVersion: "0.2.0" });
    expect(confirmed?.version).toBe("0.2.0");
    expect(readPending(updatesDir(dataDir))).toBeUndefined();
    expect(readConfirmed(updatesDir(dataDir))?.sha256).toBe(confirmed?.sha256);
  });

  it("runs the verified previous installer when a boot fails", async () => {
    const dataDir = join(dir, "data");
    const updateDir = updatesDir(dataDir);
    const previous = join(updateDir, "previous.exe");
    writeFileSync(previous, "installer-0.2.0");
    const previousSha = createHash("sha256").update(readFileSync(previous)).digest("hex");
    const current = join(updateDir, "current.exe");
    writeFileSync(current, "installer-0.3.0");
    const pending = {
      version: "0.3.0",
      artifactPath: current,
      sha256: createHash("sha256").update(readFileSync(current)).digest("hex"),
      platform: "win32" as const,
      arch: "x64" as const,
      stagedAt: "2026-11-24T00:00:00.000Z",
      previousInstaller: { path: previous, sha256: previousSha, version: "0.2.0" },
    };

    const calls: string[][] = [];
    const restored = rollbackInstaller({
      dir: updateDir,
      pending,
      spawn: (command, args) => {
        calls.push([command, ...args]);
        return {};
      },
    });
    expect(restored).toBe("0.2.0");
    expect(calls[0][0]).toBe(previous);

    writeFileSync(previous, "tampered");
    expect(rollbackInstaller({ dir: updateDir, pending, spawn: () => ({}) })).toBeUndefined();
  });

  it("cleans partial files but keeps the rollback target", () => {
    const dataDir = join(dir, "data");
    const updateDir = updatesDir(dataDir);
    const keep = join(updateDir, "keep.exe");
    writeFileSync(keep, "keep");
    writeFileSync(join(updateDir, "old.exe"), "old");
    writeFileSync(join(updateDir, "half.exe.part"), "half");
    const pending = {
      version: "0.3.0",
      artifactPath: keep,
      sha256: createHash("sha256").update(readFileSync(keep)).digest("hex"),
      platform: "win32" as const,
      arch: "x64" as const,
      stagedAt: "2026-11-24T00:00:00.000Z",
    };
    cleanupOldUpdates(updateDir, pending);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(join(updateDir, "old.exe"))).toBe(false);
    expect(existsSync(join(updateDir, "half.exe.part"))).toBe(false);
  });

  it("reads the packaged update config and disables on bad input", () => {
    expect(
      parseUpdateConfig(
        JSON.stringify({ feedUrl: "https://u.example.com/feed/", publicKey: PUBLIC_PEM }),
      ),
    ).toEqual({ feedUrl: "https://u.example.com/feed", publicKey: PUBLIC_PEM.trim() });
    expect(parseUpdateConfig("{}")).toEqual({ feedUrl: "", publicKey: "" });
    expect(parseUpdateConfig('{"feedUrl":42,"publicKey":null}')).toEqual({
      feedUrl: "",
      publicKey: "",
    });
    expect(() => parseUpdateConfig("not json")).toThrow();
  });
});

describe("channels and staged rollouts", () => {
  const manifest = (extra: Partial<UpdateManifest> = {}): UpdateManifest => ({
    version: "0.3.0",
    artifacts: [
      {
        platform: "win32",
        arch: "x64",
        url: "https://u.example.test/a.exe",
        sha256: "a".repeat(64),
        size: 1,
      },
    ],
    ...extra,
  });

  it("reads a channel and a rollout percentage from the manifest", () => {
    const bytes = Buffer.from(
      JSON.stringify({
        version: "0.3.0",
        channel: "Beta",
        rollout: { percentage: 40 },
        artifacts: [
          {
            platform: "win32",
            arch: "x64",
            url: "https://u.example.test/a.exe",
            sha256: "a".repeat(64),
            size: 1,
          },
        ],
      }),
    );
    const parsed = parseManifest(bytes);
    expect(parsed.channel).toBe("Beta");
    expect(parsed.rollout).toEqual({ percentage: 40 });
  });

  it("treats a missing rollout as everyone, and clamps a nonsense one", () => {
    expect(
      parseManifest(Buffer.from(JSON.stringify({ ...manifest(), artifacts: manifest().artifacts })))
        .rollout,
    ).toBeUndefined();
    const clamped = parseManifest(
      Buffer.from(
        JSON.stringify({
          version: "0.3.0",
          rollout: { percentage: 500 },
          artifacts: manifest().artifacts,
        }),
      ),
    );
    expect(clamped.rollout).toEqual({ percentage: 100 });
  });

  it("puts the same install in the same wave every time, and spreads the rest", () => {
    const installs = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const included = installs.filter((id) => inRollout(id, "0.3.0", 40));
    // Deterministic per install: asking twice cannot move the machine between waves.
    expect(inRollout(installs[0]!, "0.3.0", 40)).toBe(inRollout(installs[0]!, "0.3.0", 40));
    // Near the requested share, not exact — a hash is not a quota.
    expect(included.length).toBeGreaterThan(150);
    expect(included.length).toBeLessThan(250);
    // A new version is a new wave.
    const nextWave = installs.filter((id) => inRollout(id, "0.4.0", 40));
    expect(nextWave).not.toEqual(included);
  });

  it("never offers a version to nobody, or to everybody regardless", () => {
    expect(inRollout("any", "0.3.0", 0)).toBe(false);
    expect(inRollout("any", "0.3.0", 100)).toBe(true);
  });

  it("names the channel: the manifest's, else the configured one, else stable", () => {
    expect(releaseChannel(manifest({ channel: "Beta" }), "canary")).toBe("beta");
    expect(releaseChannel(manifest(), "Canary")).toBe("canary");
    expect(releaseChannel(manifest())).toBe("stable");
    expect(releaseChannel(manifest({ channel: "  " }), "")).toBe("stable");
  });

  it("says 'up to date' on the channel it checked", () => {
    const check = describeUpdate({
      current: "0.3.0",
      manifest: manifest({ channel: "beta" }),
      installId: "install-1",
    });
    expect(check.eligible).toBe(false);
    expect(check.message).toBe("Up to date: 0.3.0 is the newest release on channel beta.");
  });

  it("tells an install outside the wave that it is not in it, rather than 'up to date'", () => {
    // Find an install that is outside a 1% wave, so the assertion cannot depend on luck.
    const excluded = Array.from({ length: 500 }, (_, i) => `install-${i}`).find(
      (id) => !inRollout(id, "0.3.0", 1),
    )!;
    const check = describeUpdate({
      current: "0.2.0",
      manifest: manifest({ channel: "beta", rollout: { percentage: 1 } }),
      installId: excluded,
    });
    expect(check).toMatchObject({
      eligible: false,
      offered: "0.3.0",
      percentage: 1,
      channel: "beta",
    });
    expect(check.message).toContain("1% of installs");
    expect(check.message).toContain("not in this wave");
  });

  it("offers the version to an install inside the wave, and counts it in", () => {
    const included = Array.from({ length: 500 }, (_, i) => `install-${i}`).find((id) =>
      inRollout(id, "0.3.0", 50),
    )!;
    const check = describeUpdate({
      current: "0.2.0",
      manifest: manifest({ rollout: { percentage: 50 } }),
      installId: included,
    });
    expect(check.eligible).toBe(true);
    expect(check.offered).toBe("0.3.0");
    expect(check.message).toBe(
      "0.3.0 is available on channel stable (50% rollout, this install is included).",
    );
  });

  it("offers an un-staged release to everyone, with no percentage in the sentence", () => {
    const check = describeUpdate({
      current: "0.2.0",
      manifest: manifest(),
      installId: "whatever",
    });
    expect(check).toMatchObject({ eligible: true, channel: "stable", offered: "0.3.0" });
    expect(check.percentage).toBeUndefined();
    expect(check.message).toBe("0.3.0 is available on channel stable.");
  });
});
