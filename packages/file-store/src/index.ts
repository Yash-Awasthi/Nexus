// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/file-store — File storage abstraction.
 *
 * IFileStore interface with three implementations:
 *
 * MemoryFileStore   — in-process Map-backed store; ideal for tests.
 * LocalFileStore    — writes to local disk via an injectable fs-like interface.
 * S3FileStore       — S3-compatible object storage via an injectable fetch function
 *                     and presigned-URL support.
 *
 * Injectable dependencies
 * ───────────────────────
 * LocalFileStore accepts a `FsLike` interface so you can swap in `node:fs/promises`
 * at your app entry point without a hard dependency in this package:
 *
 * ```ts
 * import * as nodefs from "node:fs/promises";
 * const store = new LocalFileStore("/tmp/uploads", nodefs);
 * ```
 *
 * S3FileStore accepts a `FetchFn = typeof fetch` so you can use the global fetch,
 * `node-fetch`, or any compatible implementation:
 *
 * ```ts
 * const store = new S3FileStore({ bucket, region, accessKeyId, secretAccessKey });
 * ```
 */

// ── Error ──────────────────────────────────────────────────────────────────────

export class FileStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FileStoreError";
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileMeta {
  /** Storage key (path-like string, e.g. "uploads/avatar.png"). */
  key: string;
  /** MIME type, e.g. "image/png". */
  contentType?: string;
  /** Size in bytes. */
  size: number;
  /** Unix timestamp (ms) when the file was first stored. */
  createdAt: number;
  /** Unix timestamp (ms) of last update; equals createdAt if never updated. */
  updatedAt: number;
  /** Arbitrary user-defined metadata. */
  metadata?: Record<string, string>;
}

/** File content interface definition. */
export interface FileContent {
  data: Uint8Array;
  meta: FileMeta;
}

// ── IFileStore ─────────────────────────────────────────────────────────────────

export interface IFileStore {
  /**
   * Store data under `key`. Overwrites any existing content.
   * Returns the stored file's metadata.
   */
  put(
    key: string,
    data: Uint8Array | Buffer,
    meta?: Partial<Pick<FileMeta, "contentType" | "metadata">>,
  ): Promise<FileMeta>;

  /**
   * Retrieve file content and metadata for `key`.
   * Returns undefined if the key does not exist.
   */
  get(key: string): Promise<FileContent | undefined>;

  /**
   * Delete the file at `key`.
   * Returns true if the file existed and was deleted, false if it was absent.
   */
  delete(key: string): Promise<boolean>;

  /**
   * Returns true if a file exists at `key`.
   */
  exists(key: string): Promise<boolean>;

  /**
   * List files whose keys start with `prefix`.
   * If prefix is omitted or empty, all files are returned.
   */
  list(prefix?: string): Promise<FileMeta[]>;

  /**
   * Generate a URL to access the file at `key`.
   * For local/memory stores this may return a synthetic `file://` or `memory://` URL.
   * For S3 stores this generates a presigned URL valid for `ttlMs` milliseconds.
   * Returns undefined if the key does not exist.
   */
  url(key: string, ttlMs?: number): Promise<string | undefined>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryFileStore
// ─────────────────────────────────────────────────────────────────────────────

interface MemoryEntry {
  data: Uint8Array;
  meta: FileMeta;
}

/**
 * In-memory file store.  Holds all data in a Map.
 * Uses an injectable `now` function for deterministic timestamps in tests.
 */
export class MemoryFileStore implements IFileStore {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async put(
    key: string,
    data: Uint8Array | Buffer,
    meta?: Partial<Pick<FileMeta, "contentType" | "metadata">>,
  ): Promise<FileMeta> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const existing = this.store.get(key);
    const now = this.now();
    const fileMeta: FileMeta = {
      key,
      contentType: meta?.contentType,
      size: bytes.byteLength,
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
      metadata: meta?.metadata,
    };
    this.store.set(key, { data: bytes, meta: fileMeta });
    return fileMeta;
  }

  async get(key: string): Promise<FileContent | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return { data: entry.data, meta: { ...entry.meta } };
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async list(prefix?: string): Promise<FileMeta[]> {
    const result: FileMeta[] = [];
    for (const [k, entry] of this.store) {
      if (!prefix || k.startsWith(prefix)) {
        result.push({ ...entry.meta });
      }
    }
    return result;
  }

  async url(key: string): Promise<string | undefined> {
    if (!this.store.has(key)) return undefined;
    return `memory://${key}`;
  }

  /** Number of stored files (for test inspection). */
  get size(): number {
    return this.store.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LocalFileStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal injectable fs interface — matches the subset of `node:fs/promises` we need.
 */
export interface FsLike {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; birthtimeMs: number }>;
  access(path: string): Promise<void>;
  /** Read a JSON sidecar file — returns null if not found. */
  readJson?(path: string): Promise<Record<string, unknown> | null>;
  writeJson?(path: string, data: unknown): Promise<void>;
}

/**
 * Disk-backed file store.  Files are written under `rootDir`.
 * Metadata is stored in a `.meta.json` sidecar file beside each data file.
 *
 * Requires an injectable `fs` implementation (e.g. `node:fs/promises`).
 */
export class LocalFileStore implements IFileStore {
  private readonly now: () => number;

  constructor(
    private readonly rootDir: string,
    private readonly fs: FsLike,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  private _dataPath(key: string): string {
    return `${this.rootDir}/${key}`;
  }

  private _metaPath(key: string): string {
    return `${this.rootDir}/${key}.meta.json`;
  }

  private async _ensureDir(filePath: string): Promise<void> {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) await this.fs.mkdir(dir, { recursive: true });
  }

  private async _readMeta(key: string): Promise<FileMeta | undefined> {
    try {
      if (this.fs.readJson) {
        const raw = await this.fs.readJson(this._metaPath(key));
        if (!raw) return undefined;
        return raw as unknown as FileMeta;
      }
      const raw = await this.fs.readFile(this._metaPath(key));
      return JSON.parse(new TextDecoder().decode(raw)) as FileMeta;
    } catch {
      return undefined;
    }
  }

  private async _writeMeta(meta: FileMeta): Promise<void> {
    const encoded = new TextEncoder().encode(JSON.stringify(meta));
    await this._ensureDir(this._metaPath(meta.key));
    await this.fs.writeFile(this._metaPath(meta.key), encoded);
  }

  async put(
    key: string,
    data: Uint8Array | Buffer,
    metaInput?: Partial<Pick<FileMeta, "contentType" | "metadata">>,
  ): Promise<FileMeta> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const dataPath = this._dataPath(key);
    await this._ensureDir(dataPath);

    const existing = await this._readMeta(key);
    const now = this.now();
    const meta: FileMeta = {
      key,
      contentType: metaInput?.contentType,
      size: bytes.byteLength,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata: metaInput?.metadata,
    };

    await this.fs.writeFile(dataPath, bytes);
    await this._writeMeta(meta);
    return meta;
  }

  async get(key: string): Promise<FileContent | undefined> {
    try {
      const [data, meta] = await Promise.all([
        this.fs.readFile(this._dataPath(key)),
        this._readMeta(key),
      ]);
      if (!meta) return undefined;
      return { data: data instanceof Uint8Array ? data : new Uint8Array(data), meta };
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.fs.unlink(this._dataPath(key));
      try {
        await this.fs.unlink(this._metaPath(key));
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.fs.access(this._dataPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix?: string): Promise<FileMeta[]> {
    // List all non-.meta.json files under rootDir and filter by prefix
    const allKeys = await this._collectKeys(this.rootDir, "");
    const filtered = prefix ? allKeys.filter((k) => k.startsWith(prefix)) : allKeys;
    const metas = await Promise.all(filtered.map((k) => this._readMeta(k)));
    return metas.filter((m): m is FileMeta => m !== undefined);
  }

  private async _collectKeys(dir: string, rel: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(dir);
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (entry.endsWith(".meta.json")) continue;
      const relPath = rel ? `${rel}/${entry}` : entry;
      // Try to stat — if it errors, skip
      try {
        // Check if it's a directory by trying to readdir
        const sub = await this.fs.readdir(`${dir}/${entry}`).catch(() => null);
        if (sub !== null) {
          const nested = await this._collectKeys(`${dir}/${entry}`, relPath);
          keys.push(...nested);
        } else {
          keys.push(relPath);
        }
      } catch {
        keys.push(relPath);
      }
    }
    return keys;
  }

  async url(key: string): Promise<string | undefined> {
    const exists = await this.exists(key);
    if (!exists) return undefined;
    return `file://${this._dataPath(key)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// S3FileStore
// ─────────────────────────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

/** S3 config interface definition. */
export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string; // Custom endpoint for MinIO/R2/etc.
  accessKeyId: string;
  secretAccessKey: string;
  /** URL prefix for generating public (non-presigned) URLs — optional. */
  publicUrlBase?: string;
}

/**
 * Minimal S3-compatible file store using AWS Signature Version 4.
 *
 * Injectable `fetch` keeps this package free of HTTP client dependencies.
 * Works with AWS S3, Cloudflare R2, MinIO, and any S3-compatible service.
 *
 * Presigned URLs are generated client-side without an additional request.
 */
export class S3FileStore implements IFileStore {
  private readonly fetch: FetchFn;
  private readonly now: () => number;
  private readonly endpoint: string;

  constructor(
    private readonly config: S3Config,
    opts: { fetch?: FetchFn; now?: () => number } = {},
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
    this.endpoint = config.endpoint ?? `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  }

  // ── AWS Sig V4 helpers ────────────────────────────────────────────────────

  private async _hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  }

  private async _sha256(data: Uint8Array | string): Promise<string> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private _isoDate(ts: number): string {
    return new Date(ts)
      .toISOString()
      .replace(/[:-]/g, "")
      .replace(/\.\d{3}/, "");
  }

  private _shortDate(ts: number): string {
    return this._isoDate(ts).slice(0, 8);
  }

  private async _signingKey(ts: number): Promise<ArrayBuffer> {
    const date = this._shortDate(ts);
    const kDate = await this._hmac(
      new TextEncoder().encode(`AWS4${this.config.secretAccessKey}`),
      date,
    );
    const kRegion = await this._hmac(kDate, this.config.region);
    const kService = await this._hmac(kRegion, "s3");
    return this._hmac(kService, "aws4_request");
  }

  private async _sign(
    method: string,
    key: string,
    headers: Record<string, string>,
    body: Uint8Array | string = "",
    ts: number = this.now(),
  ): Promise<{ headers: Record<string, string> }> {
    const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const payloadHash = await this._sha256(bodyBytes);
    const isoDate = this._isoDate(ts);
    const shortDate = this._shortDate(ts);

    const allHeaders: Record<string, string> = {
      ...headers,
      "x-amz-date": isoDate,
      "x-amz-content-sha256": payloadHash,
    };

    const sortedHeaderNames = Object.keys(allHeaders).sort();
    const canonicalHeaders = sortedHeaderNames
      .map((h) => `${h.toLowerCase()}:${(allHeaders[h] ?? "").trim()}`)
      .join("\n");
    const signedHeaders = sortedHeaderNames.map((h) => h.toLowerCase()).join(";");

    const encodedKey = key
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");

    const canonicalRequest = [
      method,
      `/${encodedKey}`,
      "",
      canonicalHeaders + "\n",
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${shortDate}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      isoDate,
      credentialScope,
      await this._sha256(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");

    const signingKey = await this._signingKey(ts);
    const sigBytes = await this._hmac(signingKey, stringToSign);
    const signature = Array.from(new Uint8Array(sigBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return {
      headers: {
        ...allHeaders,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`,
      },
    };
  }

  // ── IFileStore implementation ─────────────────────────────────────────────

  async put(
    key: string,
    data: Uint8Array | Buffer,
    metaInput?: Partial<Pick<FileMeta, "contentType" | "metadata">>,
  ): Promise<FileMeta> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ts = this.now();
    const host = new URL(this.endpoint).host;

    const headers: Record<string, string> = { host };
    if (metaInput?.contentType) headers["content-type"] = metaInput.contentType;
    if (metaInput?.metadata) {
      for (const [k, v] of Object.entries(metaInput.metadata)) {
        headers[`x-amz-meta-${k}`] = v;
      }
    }

    const { headers: signedHeaders } = await this._sign("PUT", key, headers, bytes, ts);
    const url = `${this.endpoint}/${encodeURIComponent(key)}`;
    const res = await this.fetch(url, { method: "PUT", headers: signedHeaders, body: bytes });

    if (!res.ok) {
      throw new FileStoreError(`S3 PUT failed: ${res.status} ${res.statusText}`, "S3_PUT_FAILED", {
        key,
        status: res.status,
      });
    }

    return {
      key,
      contentType: metaInput?.contentType,
      size: bytes.byteLength,
      createdAt: ts,
      updatedAt: ts,
      metadata: metaInput?.metadata,
    };
  }

  async get(key: string): Promise<FileContent | undefined> {
    const ts = this.now();
    const host = new URL(this.endpoint).host;
    const { headers: signedHeaders } = await this._sign("GET", key, { host }, "", ts);
    const url = `${this.endpoint}/${encodeURIComponent(key)}`;
    const res = await this.fetch(url, { method: "GET", headers: signedHeaders });

    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new FileStoreError(`S3 GET failed: ${res.status} ${res.statusText}`, "S3_GET_FAILED", {
        key,
        status: res.status,
      });
    }

    const arrayBuf = await res.arrayBuffer();
    const data = new Uint8Array(arrayBuf);
    const meta: FileMeta = {
      key,
      contentType: res.headers.get("content-type") ?? undefined,
      size: data.byteLength,
      createdAt: ts,
      updatedAt: ts,
    };
    return { data, meta };
  }

  async delete(key: string): Promise<boolean> {
    const ts = this.now();
    const host = new URL(this.endpoint).host;
    const { headers: signedHeaders } = await this._sign("DELETE", key, { host }, "", ts);
    const url = `${this.endpoint}/${encodeURIComponent(key)}`;
    const res = await this.fetch(url, { method: "DELETE", headers: signedHeaders });

    if (res.status === 404) return false;
    if (!res.ok) {
      throw new FileStoreError(
        `S3 DELETE failed: ${res.status} ${res.statusText}`,
        "S3_DELETE_FAILED",
        { key, status: res.status },
      );
    }
    return true;
  }

  async exists(key: string): Promise<boolean> {
    const ts = this.now();
    const host = new URL(this.endpoint).host;
    const { headers: signedHeaders } = await this._sign("HEAD", key, { host }, "", ts);
    const url = `${this.endpoint}/${encodeURIComponent(key)}`;
    const res = await this.fetch(url, { method: "HEAD", headers: signedHeaders });
    return res.ok;
  }

  async list(prefix?: string): Promise<FileMeta[]> {
    const ts = this.now();
    const host = new URL(this.endpoint).host;
    const qs = prefix ? `?list-type=2&prefix=${encodeURIComponent(prefix)}` : "?list-type=2";
    const { headers: signedHeaders } = await this._sign("GET", "", { host }, "", ts);
    const url = `${this.endpoint}/${qs}`;
    const res = await this.fetch(url, { method: "GET", headers: signedHeaders });

    if (!res.ok) {
      throw new FileStoreError(
        `S3 LIST failed: ${res.status} ${res.statusText}`,
        "S3_LIST_FAILED",
        { prefix, status: res.status },
      );
    }

    const text = await res.text();
    // Parse minimal XML: extract <Key> and <Size> from <Contents> blocks
    const contents = [...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
    return contents.map((match) => {
      const block = match[1] ?? "";
      const key = (/<Key>(.*?)<\/Key>/.exec(block)?.[1] ?? "").trim();
      const size = parseInt(/<Size>(.*?)<\/Size>/.exec(block)?.[1] ?? "0", 10);
      const lastMod = (/<LastModified>(.*?)<\/LastModified>/.exec(block)?.[1] ?? "").trim();
      const ts2 = lastMod ? new Date(lastMod).getTime() : ts;
      return { key, size, createdAt: ts2, updatedAt: ts2 };
    });
  }

  async url(key: string, ttlMs = 3600_000): Promise<string | undefined> {
    if (this.config.publicUrlBase) {
      return `${this.config.publicUrlBase}/${encodeURIComponent(key)}`;
    }

    // Generate presigned URL
    const ts = this.now();
    const isoDate = this._isoDate(ts);
    const shortDate = this._shortDate(ts);
    const expiresSeconds = Math.floor(ttlMs / 1000);
    const credentialScope = `${shortDate}/${this.config.region}/s3/aws4_request`;
    const credential = `${this.config.accessKeyId}/${credentialScope}`;
    const host = new URL(this.endpoint).host;

    const queryParams = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": credential,
      "X-Amz-Date": isoDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": "host",
    });

    const canonicalQueryString = queryParams.toString();
    const canonicalRequest = [
      "GET",
      `/${encodeURIComponent(key)}`,
      canonicalQueryString,
      `host:${host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      isoDate,
      credentialScope,
      await this._sha256(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");

    const signingKey = await this._signingKey(ts);
    const sigBytes = await this._hmac(signingKey, stringToSign);
    const signature = Array.from(new Uint8Array(sigBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    queryParams.set("X-Amz-Signature", signature);
    return `${this.endpoint}/${encodeURIComponent(key)}?${queryParams.toString()}`;
  }
}
