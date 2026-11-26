// SPDX-License-Identifier: Apache-2.0
/**
 * Desktop updates: a signed manifest, a verified download, install-on-quit,
 * and a one-restart rollback.
 *
 * The feed is two files beside each other: `manifest.json` (version, platform,
 * arch, URL, sha256, size) and `manifest.json.sig` (a detached Ed25519
 * signature over the exact manifest bytes). Both are required. Without a
 * configured feed or public key updates are off, and a manifest that fails its
 * signature is never parsed for action — this is deliberately fail-closed.
 *
 * Nothing here imports Electron: paths, fetch, spawn and the clock come in as
 * arguments, so the whole flow is testable without a browser process.
 */

import { createHash, createPublicKey, timingSafeEqual, verify as verifyBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type UpdatePlatform = "win32" | "darwin" | "linux";
export type UpdateArch = "x64" | "arm64";

/** One downloadable installer in a signed manifest. */
export interface UpdateArtifact {
  platform: UpdatePlatform;
  arch: UpdateArch;
  url: string;
  sha256: string;
  size: number;
}

/** The feed's manifest; `version` is a dotted numeric version. */
export interface UpdateManifest {
  version: string;
  publishedAt?: string;
  artifacts: UpdateArtifact[];
  /** Which track this release is on: `stable` unless the feed says otherwise. */
  channel?: string;
  /**
   * A staged rollout: `percentage` of installs are offered this version in this wave. Absent
   * means everyone, which is what an un-staged release should look like.
   */
  rollout?: { percentage: number };
}

/** A downloaded, hash-checked installer waiting for the next quit. */
export interface PendingUpdate {
  version: string;
  artifactPath: string;
  sha256: string;
  platform: UpdatePlatform;
  arch: UpdateArch;
  stagedAt: string;
  /** The installer that produced the running version, when one was recorded. */
  previousInstaller?: { path: string; sha256: string; version: string };
}

/** The last installer this app knows it applied, kept to make rollback possible. */
export interface ConfirmedInstaller {
  version: string;
  path: string;
  sha256: string;
}

/** The feed settings that a packaged app ships; empty strings disable updates. */
export interface UpdateConfig {
  feedUrl: string;
  publicKey: string;
}

/** Parse the JSON a build bakes into `dist/update-config.json`; bad input means disabled. */
export function parseUpdateConfig(raw: string): UpdateConfig {
  const parsed = JSON.parse(raw) as { feedUrl?: unknown; publicKey?: unknown };
  return {
    feedUrl: typeof parsed.feedUrl === "string" ? parsed.feedUrl.trim().replace(/\/+$/, "") : "",
    publicKey: typeof parsed.publicKey === "string" ? parsed.publicKey.trim() : "",
  };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; windowsHide: boolean },
) => { unref?: () => void; once?: (event: string, cb: (...args: unknown[]) => void) => void };

/** Caps, so a hostile or broken feed cannot exhaust memory or the disk. */
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_SIGNATURE_BYTES = 4 * 1024;
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
export const MANIFEST_TIMEOUT_MS = 5_000;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const HASH_RE = /^[a-f0-9]{64}$/i;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export const UPDATES_DIR = "updates";
export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.json.sig";
export const PENDING_FILE = "pending.json";
export const CONFIRMED_FILE = "confirmed.json";

function fail(message: string): never {
  throw new Error(message);
}

/** A feed URL must be https, or plain http on loopback for a local test feed. */
export function assertSafeFeedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`update URL is not absolute: ${raw}`);
  }
  if (url.protocol === "https:") return url.toString();
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback) return url.toString();
  fail(`update URL must be https (or http on loopback): ${url.protocol}//${url.host}`);
}

/** `1.2.3`, optionally prefixed with `v`; anything else is not a version. */
export function parseVersion(value: string): [number, number, number] {
  const match = VERSION_RE.exec(value.trim());
  if (!match) fail(`not a dotted numeric version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True only when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** A rollout percentage from a manifest: an integer 0–100, or everyone when it is unusable. */
function parseRollout(raw: Record<string, unknown>): number {
  const value = Number(raw.percentage);
  if (!Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Whether this install is in this wave.
 *
 * The answer is a function of the install and the version only, never of the moment: a check that
 * flipped between waves on each poll would install on the third try, which is not a rollout, it
 * is an outage with extra steps. FNV-1a over `installId:version`, so the same machine lands in
 * the same bucket for the life of that release.
 */
export function inRollout(installId: string, version: string, percentage: number): boolean {
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  let hash = 0x811c9dc5;
  const input = `${installId}:${version}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100 < percentage;
}

/** The channel a build follows: the manifest's, else the configured one, else `stable`. */
export function releaseChannel(manifest: UpdateManifest, configured?: string): string {
  const channel = (manifest.channel ?? configured ?? "stable").trim().toLowerCase();
  return channel || "stable";
}

/** What a manual "check now" found, in terms a person can act on. */
export interface UpdateCheck {
  current: string;
  channel: string;
  /** The version the feed offers, when there is one newer than what is running. */
  offered?: string;
  /** Present when the release is staged: how many installs are in this wave. */
  percentage?: number;
  /** True when the feed offers a newer version to everybody, including this install. */
  eligible: boolean;
  /** One sentence for the UI; it names the channel, because that is the thing people misread. */
  message: string;
}

/** Turn a manifest and this install into the answer a person sees. */
export function describeUpdate(input: {
  current: string;
  manifest: UpdateManifest;
  installId: string;
  configuredChannel?: string;
}): UpdateCheck {
  const channel = releaseChannel(input.manifest, input.configuredChannel);
  const percentage = input.manifest.rollout?.percentage;

  if (!isNewerVersion(input.manifest.version, input.current)) {
    return {
      current: input.current,
      channel,
      eligible: false,
      message: `Up to date: ${input.current} is the newest release on channel ${channel}.`,
    };
  }

  if (percentage !== undefined && !inRollout(input.installId, input.manifest.version, percentage)) {
    return {
      current: input.current,
      channel,
      offered: input.manifest.version,
      percentage,
      eligible: false,
      message:
        `${input.manifest.version} is rolling out on channel ${channel} to ${percentage}% of ` +
        `installs; this one is not in this wave yet. It will install when it is, or run the ` +
        `check again later.`,
    };
  }

  return {
    current: input.current,
    channel,
    offered: input.manifest.version,
    ...(percentage === undefined ? {} : { percentage }),
    eligible: true,
    message:
      `${input.manifest.version} is available on channel ${channel}` +
      (percentage === undefined ? "." : ` (${percentage}% rollout, this install is included).`),
  };
}

function normalizeHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) fail("manifest has a malformed sha256");
  return value.toLowerCase();
}

/** Public key as PEM or base64 DER (SPKI); anything else is a configuration error. */
export function loadPublicKey(value: string) {
  const text = value.trim();
  if (!text) fail("no update public key configured");
  return text.includes("BEGIN PUBLIC KEY")
    ? createPublicKey(text)
    : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
}

/**
 * Verify a detached Ed25519 signature over the exact manifest bytes. RSA and EC
 * keys are refused: the signature algorithm is fixed, not negotiated by the feed.
 */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signature: Buffer,
  publicKey: string,
): void {
  const key = loadPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") fail("update public key must be Ed25519");
  if (signature.length !== 64) fail("update signature must be 64 bytes");
  if (!verifyBytes(null, manifestBytes, key, signature))
    fail("update manifest signature is invalid");
}

/** Parse and validate the signed manifest, after its signature has been checked. */
export function parseManifest(manifestBytes: Buffer): UpdateManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("update manifest is not JSON");
  }
  if (!raw || typeof raw !== "object") fail("update manifest is not an object");
  const input = raw as Record<string, unknown>;
  const version = typeof input.version === "string" ? input.version.trim() : "";
  parseVersion(version);
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0)
    fail("update manifest has no artifacts");
  if (input.artifacts.length > 32) fail("update manifest has too many artifacts");

  const artifacts: UpdateArtifact[] = input.artifacts.map((entry) => {
    if (!entry || typeof entry !== "object") fail("update artifact is not an object");
    const item = entry as Record<string, unknown>;
    const platform = item.platform;
    const arch = item.arch;
    if (platform !== "win32" && platform !== "darwin" && platform !== "linux")
      fail("update artifact has an unsupported platform");
    if (arch !== "x64" && arch !== "arm64") fail("update artifact has an unsupported arch");
    const url = assertSafeFeedUrl(String(item.url ?? ""));
    const size = Number(item.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES)
      fail("update artifact has an unusable size");
    return { platform, arch, url, sha256: normalizeHash(item.sha256), size };
  });

  return {
    version,
    publishedAt: input.publishedAt as string | undefined,
    artifacts,
    ...(typeof input.channel === "string" ? { channel: input.channel.trim().slice(0, 40) } : {}),
    ...(input.rollout && typeof input.rollout === "object"
      ? { rollout: { percentage: parseRollout(input.rollout as Record<string, unknown>) } }
      : {}),
  };
}

/** The artifact for this platform and arch, or a reason there is none. */
export function selectArtifact(
  manifest: UpdateManifest,
  platform: string,
  arch: string,
): UpdateArtifact {
  const match = manifest.artifacts.find((a) => a.platform === platform && a.arch === arch);
  if (!match) fail(`update manifest has no artifact for ${platform}/${arch}`);
  return match;
}

async function readCapped(res: Response, maxBytes: number, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) fail(`${what} is larger than ${maxBytes} bytes`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) fail(`${what} is larger than ${maxBytes} bytes`);
  return bytes;
}

async function get(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  accept: string,
): Promise<Response> {
  const res = await fetchImpl(url, {
    headers: { accept },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) fail(`${url} answered HTTP ${res.status}`);
  return res;
}

/** Fetch, verify and parse the feed's manifest. Any failure throws. */
export async function fetchManifest(options: {
  feedUrl: string;
  publicKey: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<{ manifest: UpdateManifest; bytes: Buffer }> {
  const base = assertSafeFeedUrl(options.feedUrl).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? MANIFEST_TIMEOUT_MS;
  const [manifestRes, signatureRes] = await Promise.all([
    get(`${base}/${MANIFEST_FILE}`, options.fetchImpl, timeoutMs, "application/json"),
    get(`${base}/${SIGNATURE_FILE}`, options.fetchImpl, timeoutMs, "application/octet-stream"),
  ]);
  const bytes = await readCapped(manifestRes, MAX_MANIFEST_BYTES, "update manifest");
  const signature = (await readCapped(signatureRes, MAX_SIGNATURE_BYTES, "update signature"))
    .toString("ascii")
    .trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail("update signature is not base64");
  verifyManifestSignature(bytes, Buffer.from(signature, "base64"), options.publicKey);
  return { manifest: parseManifest(bytes), bytes };
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Stream one artifact to `destPath`, hashing as it goes. A mismatch or an
 * over-size body removes the partial file and throws; nothing partial is ever
 * left where the installer could run it.
 */
export async function downloadVerified(options: {
  artifact: UpdateArtifact;
  destPath: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<{ path: string; bytes: number }> {
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  const url = assertSafeFeedUrl(options.artifact.url);
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const partPath = `${options.destPath}.part`;
  const res = await get(url, options.fetchImpl, timeoutMs, "application/octet-stream");
  if (!res.body) fail("update artifact has no body");

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) fail("update artifact is larger than the cap");

  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(new Error("update artifact is larger than the cap"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(partPath, { mode: 0o600 }),
    );
    if (!sameHash(hash.digest("hex"), options.artifact.sha256)) {
      fail("update artifact does not match its sha256");
    }
    if (declared > 0 && declared !== bytes) fail("update artifact was truncated");
    // Windows refuses to rename over an existing file; a re-stage replaces it.
    rmSync(options.destPath, { force: true });
    renameSync(partPath, options.destPath);
    return { path: options.destPath, bytes };
  } catch (err) {
    rmSync(partPath, { force: true });
    throw err;
  }
}

/** Updates live under the app's data directory, never beside the running binary. */
export function updatesDir(dataDir: string): string {
  const dir = join(dataDir, UPDATES_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function readPending(dir: string): PendingUpdate | undefined {
  const pending = readJson<PendingUpdate>(join(dir, PENDING_FILE));
  return pending && typeof pending.version === "string" ? pending : undefined;
}

export function readConfirmed(dir: string): ConfirmedInstaller | undefined {
  return readJson<ConfirmedInstaller>(join(dir, CONFIRMED_FILE));
}

function extension(platform: UpdatePlatform): string {
  return platform === "win32" ? ".exe" : platform === "darwin" ? ".dmg" : ".AppImage";
}

/**
 * Download the newer artifact and leave a pending marker. The caller applies it
 * on quit; a failure here leaves no marker and no partial file.
 */
export async function stageUpdate(options: {
  manifest: UpdateManifest;
  currentVersion: string;
  platform: UpdatePlatform;
  arch: UpdateArch;
  dataDir: string;
  fetchImpl: FetchLike;
  now?: () => Date;
}): Promise<PendingUpdate | { skipped: string }> {
  if (!isNewerVersion(options.manifest.version, options.currentVersion))
    return { skipped: `already on ${options.currentVersion}` };
  const artifact = selectArtifact(options.manifest, options.platform, options.arch);
  const dir = updatesDir(options.dataDir);
  const destPath = join(dir, `nexus-${options.manifest.version}${extension(options.platform)}`);
  await downloadVerified({ artifact, destPath, fetchImpl: options.fetchImpl });

  const previous = readConfirmed(dir);
  const pending: PendingUpdate = {
    version: options.manifest.version,
    artifactPath: destPath,
    sha256: artifact.sha256,
    platform: options.platform,
    arch: options.arch,
    stagedAt: (options.now?.() ?? new Date()).toISOString(),
    ...(previous && previous.version !== options.manifest.version
      ? {
          previousInstaller: {
            path: previous.path,
            sha256: previous.sha256,
            version: previous.version,
          },
        }
      : {}),
  };
  writeJson(join(dir, PENDING_FILE), pending);
  return pending;
}

/**
 * The real path of a file inside the update directory, or a refusal. `realpath`
 * collapses symlinks, so a link planted in the staging directory cannot become
 * a file outside it that this process would later execute.
 */
function verifiedFileWithin(dir: string, path: string, sha256: string): string {
  if (!existsSync(path)) fail("update artifact is gone");
  const dirReal = realpathSync(dir);
  const real = realpathSync(path);
  if (!real.startsWith(`${dirReal}${sep}`)) fail("update artifact is outside the update directory");
  if (!lstatSync(real).isFile()) fail("update artifact is not a regular file");
  if (statSync(real).size > MAX_ARTIFACT_BYTES) fail("update artifact is larger than the cap");
  if (!sameHash(hashFile(real), sha256)) fail("update artifact no longer matches its sha256");
  return real;
}

/** The pending installer, but only when it is still the bytes that were verified. */
export function verifiedPending(dir: string, pending: PendingUpdate): string {
  return verifiedFileWithin(dir, pending.artifactPath, pending.sha256);
}

/**
 * Start the silent install. Called on quit, after re-checking the hash, with the
 * installer detached from this process so the app can exit.
 */
export function installOnQuit(options: {
  dir: string;
  pending: PendingUpdate;
  spawn: SpawnLike;
}): void {
  const artifact = verifiedPending(options.dir, options.pending);
  if (options.pending.platform === "win32") {
    const child = options.spawn(artifact, ["/S", "--force-run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref?.();
    return;
  }
  if (options.pending.platform === "darwin") {
    const child = options.spawn("open", [artifact], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref?.();
    return;
  }
  fail(`no unattended installer for ${options.pending.platform}`);
}

/**
 * After a successful boot: if the pending version is the one now running, keep
 * its installer as the rollback target and clear the marker. If the pending
 * version is not running yet, leave it alone for the next quit.
 */
export function confirmRunningVersion(options: {
  dir: string;
  runningVersion: string;
}): ConfirmedInstaller | undefined {
  const pending = readPending(options.dir);
  if (!pending || pending.version !== options.runningVersion) return undefined;
  const artifact = verifiedPending(options.dir, pending);
  const confirmed: ConfirmedInstaller = {
    version: pending.version,
    path: artifact,
    sha256: pending.sha256,
  };
  writeJson(join(options.dir, CONFIRMED_FILE), confirmed);
  rmSync(join(options.dir, PENDING_FILE), { force: true });
  return confirmed;
}

/**
 * Rollback path: the new build did not reach `/health/ready`. When the pending
 * marker names a verified previous installer, run it silently. Returns the
 * version being restored, or undefined when there is nothing safe to restore.
 */
export function rollbackInstaller(options: {
  dir: string;
  pending: PendingUpdate;
  spawn: SpawnLike;
}): string | undefined {
  const previous = options.pending.previousInstaller;
  if (!previous) return undefined;
  if (previous.version === options.pending.version) return undefined;
  let artifact: string;
  try {
    artifact = verifiedFileWithin(options.dir, previous.path, previous.sha256);
  } catch {
    return undefined;
  }
  if (options.pending.platform === "win32") {
    const child = options.spawn(artifact, ["/S", "--force-run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref?.();
    return previous.version;
  }
  return undefined;
}

/** A second launch of a broken update should not keep reinstalling it. */
export function markRolledBack(dir: string, pending: PendingUpdate): void {
  writeJson(join(dir, "rolled-back.json"), {
    version: pending.version,
    at: new Date().toISOString(),
  });
  rmSync(join(dir, PENDING_FILE), { force: true });
}

/** Remove partial downloads and every installer except the rollback target. */
export function cleanupOldUpdates(dir: string, keep: PendingUpdate | undefined): void {
  const keepPaths = new Set<string>();
  if (keep) keepPaths.add(resolve(keep.artifactPath));
  const confirmed = readConfirmed(dir);
  if (confirmed) keepPaths.add(resolve(confirmed.path));
  const previous = keep?.previousInstaller;
  if (previous) keepPaths.add(resolve(previous.path));
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".part") || name.endsWith(".tmp")) {
      rmSync(join(dir, name), { force: true });
      continue;
    }
    if (!/\.(exe|dmg|AppImage)$/i.test(name)) continue;
    const candidate = resolve(join(dir, name));
    if (!keepPaths.has(candidate)) rmSync(candidate, { force: true });
  }
}
