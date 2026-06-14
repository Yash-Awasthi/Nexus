// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MemoryFileStore,
  LocalFileStore,
  S3FileStore,
  FileStoreError,
  type IFileStore,
  type FsLike,
  type S3Config,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(u: Uint8Array): string {
  return new TextDecoder().decode(u);
}

let _time = 1_000_000;
function makeNow() {
  _time = 1_000_000;
  return () => _time;
}
function advanceTime(ms: number) {
  _time += ms;
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryFileStore
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryFileStore", () => {
  let store: MemoryFileStore;
  let now: () => number;

  beforeEach(() => {
    now = makeNow();
    store = new MemoryFileStore({ now });
  });

  // put / get
  it("stores and retrieves a file", async () => {
    const data = enc("hello world");
    const meta = await store.put("docs/readme.txt", data, {
      contentType: "text/plain",
      metadata: { author: "yash" },
    });

    expect(meta.key).toBe("docs/readme.txt");
    expect(meta.contentType).toBe("text/plain");
    expect(meta.size).toBe(data.byteLength);
    expect(meta.metadata?.author).toBe("yash");
    expect(meta.createdAt).toBe(1_000_000);
    expect(meta.updatedAt).toBe(1_000_000);

    const result = await store.get("docs/readme.txt");
    expect(result).toBeDefined();
    expect(dec(result!.data)).toBe("hello world");
    expect(result!.meta.key).toBe("docs/readme.txt");
  });

  it("returns undefined for missing key", async () => {
    expect(await store.get("missing.txt")).toBeUndefined();
  });

  it("returns a copy of meta on get (no mutation leaks)", async () => {
    await store.put("a.txt", enc("data"));
    const r1 = await store.get("a.txt");
    r1!.meta.key = "mutated";
    const r2 = await store.get("a.txt");
    expect(r2!.meta.key).toBe("a.txt");
  });

  // overwrite
  it("overwrites an existing file, preserving createdAt", async () => {
    await store.put("f.txt", enc("v1"), { contentType: "text/plain" });
    advanceTime(5000);
    const meta2 = await store.put("f.txt", enc("v2"), { contentType: "text/html" });

    expect(meta2.createdAt).toBe(1_000_000); // unchanged
    expect(meta2.updatedAt).toBe(1_005_000);
    expect(meta2.contentType).toBe("text/html");
    expect(meta2.size).toBe(enc("v2").byteLength);

    const result = await store.get("f.txt");
    expect(dec(result!.data)).toBe("v2");
  });

  // delete
  it("deletes a file and returns true", async () => {
    await store.put("del.txt", enc("bye"));
    expect(await store.delete("del.txt")).toBe(true);
    expect(await store.get("del.txt")).toBeUndefined();
  });

  it("delete returns false for absent key", async () => {
    expect(await store.delete("ghost.txt")).toBe(false);
  });

  // exists
  it("exists returns true for stored file", async () => {
    await store.put("check.txt", enc("yes"));
    expect(await store.exists("check.txt")).toBe(true);
  });

  it("exists returns false after delete", async () => {
    await store.put("check.txt", enc("yes"));
    await store.delete("check.txt");
    expect(await store.exists("check.txt")).toBe(false);
  });

  it("exists returns false for missing key", async () => {
    expect(await store.exists("nope.txt")).toBe(false);
  });

  // list
  it("lists all files when no prefix given", async () => {
    await store.put("a/1.txt", enc("1"));
    await store.put("a/2.txt", enc("2"));
    await store.put("b/3.txt", enc("3"));

    const all = await store.list();
    expect(all).toHaveLength(3);
    expect(all.map((m) => m.key).sort()).toEqual(["a/1.txt", "a/2.txt", "b/3.txt"]);
  });

  it("list filters by prefix", async () => {
    await store.put("images/a.png", enc("png"));
    await store.put("images/b.jpg", enc("jpg"));
    await store.put("docs/c.txt", enc("txt"));

    const imgs = await store.list("images/");
    expect(imgs).toHaveLength(2);
    expect(imgs.every((m) => m.key.startsWith("images/"))).toBe(true);
  });

  it("list returns empty array when no files match prefix", async () => {
    await store.put("docs/x.txt", enc("x"));
    expect(await store.list("images/")).toHaveLength(0);
  });

  // url
  it("url returns memory:// scheme for existing key", async () => {
    await store.put("img/logo.png", enc("png data"));
    const u = await store.url("img/logo.png");
    expect(u).toBe("memory://img/logo.png");
  });

  it("url returns undefined for missing key", async () => {
    expect(await store.url("ghost.png")).toBeUndefined();
  });

  // size
  it("size tracks stored file count", async () => {
    expect(store.size).toBe(0);
    await store.put("a.txt", enc("a"));
    await store.put("b.txt", enc("b"));
    expect(store.size).toBe(2);
    await store.delete("a.txt");
    expect(store.size).toBe(1);
  });

  // Buffer input
  it("accepts Buffer as input (Node.js compat)", async () => {
    const buf = Buffer.from("node buffer content");
    const meta = await store.put("buf.txt", buf);
    expect(meta.size).toBe(buf.byteLength);
    const result = await store.get("buf.txt");
    expect(dec(result!.data)).toBe("node buffer content");
  });

  // Empty file
  it("stores zero-byte file", async () => {
    const meta = await store.put("empty.bin", new Uint8Array(0));
    expect(meta.size).toBe(0);
    const result = await store.get("empty.bin");
    expect(result!.data.byteLength).toBe(0);
  });

  // IFileStore interface compliance
  it("implements IFileStore interface", () => {
    const s: IFileStore = store;
    expect(typeof s.put).toBe("function");
    expect(typeof s.get).toBe("function");
    expect(typeof s.delete).toBe("function");
    expect(typeof s.exists).toBe("function");
    expect(typeof s.list).toBe("function");
    expect(typeof s.url).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LocalFileStore — using an in-memory FsLike mock
// ─────────────────────────────────────────────────────────────────────────────

function makeFsMock(): FsLike & { _files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();

  return {
    _files: files,

    async readFile(path) {
      const data = files.get(path);
      if (!data) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return data;
    },

    async writeFile(path, data) {
      files.set(path, data);
    },

    async unlink(path) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      files.delete(path);
    },

    async mkdir(_path, _opts) {
      // no-op — flat virtual fs
    },

    async readdir(path) {
      // If this exact path exists as a file, throw ENOTDIR (it's not a directory)
      if (files.has(path)) {
        throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      }
      // Return direct child entries whose path starts with `path/`
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.split("/")[0];
          if (segment) entries.add(segment);
        }
      }
      return [...entries];
    },

    async stat(path) {
      const data = files.get(path);
      if (!data) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return { size: data.byteLength, mtimeMs: 1_000_000, birthtimeMs: 1_000_000 };
    },

    async access(path) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
  };
}

describe("LocalFileStore", () => {
  let fs: ReturnType<typeof makeFsMock>;
  let store: LocalFileStore;
  let now: () => number;

  beforeEach(() => {
    fs = makeFsMock();
    now = makeNow();
    store = new LocalFileStore("/root", fs, { now });
  });

  it("writes a file and reads it back", async () => {
    const meta = await store.put("hello.txt", enc("hello"), { contentType: "text/plain" });
    expect(meta.key).toBe("hello.txt");
    expect(meta.contentType).toBe("text/plain");
    expect(meta.size).toBe(enc("hello").byteLength);

    const result = await store.get("hello.txt");
    expect(result).toBeDefined();
    expect(dec(result!.data)).toBe("hello");
    expect(result!.meta.contentType).toBe("text/plain");
  });

  it("returns undefined for missing key", async () => {
    expect(await store.get("ghost.txt")).toBeUndefined();
  });

  it("preserves createdAt on overwrite", async () => {
    await store.put("f.txt", enc("v1"));
    advanceTime(3000);
    const meta2 = await store.put("f.txt", enc("v2"));
    expect(meta2.createdAt).toBe(1_000_000);
    expect(meta2.updatedAt).toBe(1_003_000);
  });

  it("delete removes data and meta files", async () => {
    await store.put("del.txt", enc("bye"));
    expect(await store.delete("del.txt")).toBe(true);
    expect(await store.get("del.txt")).toBeUndefined();
  });

  it("delete returns false for missing file", async () => {
    expect(await store.delete("ghost.txt")).toBe(false);
  });

  it("exists returns true/false correctly", async () => {
    expect(await store.exists("no.txt")).toBe(false);
    await store.put("yes.txt", enc("yes"));
    expect(await store.exists("yes.txt")).toBe(true);
    await store.delete("yes.txt");
    expect(await store.exists("yes.txt")).toBe(false);
  });

  it("url returns file:// for existing key", async () => {
    await store.put("img.png", enc("png"));
    const u = await store.url("img.png");
    expect(u).toBe("file:///root/img.png");
  });

  it("url returns undefined for missing key", async () => {
    expect(await store.url("missing.png")).toBeUndefined();
  });

  it("list returns all files when no prefix", async () => {
    await store.put("a.txt", enc("a"));
    await store.put("b.txt", enc("b"));
    const all = await store.list();
    expect(all.map((m) => m.key).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("list filters by prefix", async () => {
    await store.put("imgs/a.png", enc("a"));
    await store.put("imgs/b.png", enc("b"));
    await store.put("docs/c.txt", enc("c"));

    const imgs = await store.list("imgs/");
    expect(imgs).toHaveLength(2);
    expect(imgs.every((m) => m.key.startsWith("imgs/"))).toBe(true);
  });

  it("stores metadata in sidecar JSON", async () => {
    await store.put("data.bin", enc("bytes"), { metadata: { version: "2" } });
    // Sidecar should exist
    const sidecarExists = fs._files.has("/root/data.bin.meta.json");
    expect(sidecarExists).toBe(true);
    const raw = fs._files.get("/root/data.bin.meta.json")!;
    const parsed = JSON.parse(dec(raw));
    expect(parsed.metadata?.version).toBe("2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3FileStore — using a fetch mock
// ─────────────────────────────────────────────────────────────────────────────

type RequestHandler = (url: string, init: RequestInit) => Response;

function makeS3Config(override?: Partial<S3Config>): S3Config {
  return {
    bucket: "my-bucket",
    region: "us-east-1",
    endpoint: "https://my-bucket.s3.us-east-1.amazonaws.com",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ...override,
  };
}

function makeFetchMock(handler: RequestHandler): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    return handler(url, init ?? {});
  };
}

function makeOkResponse(body = "", status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("S3FileStore", () => {
  let now: () => number;

  beforeEach(() => {
    now = makeNow();
  });

  // put
  it("put sends a signed PUT request and returns FileMeta", async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

    const fetchMock = makeFetchMock((url, init) => {
      requests.push({ url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers as HeadersInit).entries()) });
      return makeOkResponse("", 200);
    });

    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    const data = enc("file content");
    const meta = await store.put("uploads/file.txt", data, { contentType: "text/plain" });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].url).toContain("file.txt");
    expect(meta.key).toBe("uploads/file.txt");
    expect(meta.size).toBe(data.byteLength);
    expect(meta.contentType).toBe("text/plain");
  });

  it("put throws FileStoreError on non-ok response", async () => {
    const fetchMock = makeFetchMock(() => makeOkResponse("", 403));
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    await expect(store.put("f.txt", enc("data"))).rejects.toThrow(FileStoreError);
  });

  // get
  it("get sends a signed GET request and returns FileContent", async () => {
    const fetchMock = makeFetchMock((_url, _init) =>
      new Response(enc("retrieved content"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    const result = await store.get("docs/file.txt");

    expect(result).toBeDefined();
    expect(dec(result!.data)).toBe("retrieved content");
    expect(result!.meta.contentType).toBe("text/plain");
    expect(result!.meta.key).toBe("docs/file.txt");
  });

  it("get returns undefined on 404", async () => {
    const fetchMock = makeFetchMock(() => makeOkResponse("", 404));
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    expect(await store.get("missing.txt")).toBeUndefined();
  });

  it("get throws FileStoreError on 500", async () => {
    const fetchMock = makeFetchMock(() => makeOkResponse("", 500));
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    await expect(store.get("f.txt")).rejects.toThrow(FileStoreError);
  });

  // delete
  it("delete sends signed DELETE and returns true on 200", async () => {
    const requests: Array<{ method: string }> = [];
    const fetchMock = makeFetchMock((_url, init) => {
      requests.push({ method: init.method ?? "GET" });
      return makeOkResponse("", 200);
    });
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    const result = await store.delete("old/file.txt");
    expect(result).toBe(true);
    expect(requests[0].method).toBe("DELETE");
  });

  it("delete returns false on 404", async () => {
    const fetchMock = makeFetchMock(() => makeOkResponse("", 404));
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    expect(await store.delete("ghost.txt")).toBe(false);
  });

  // exists
  it("exists sends HEAD request and returns true for 200", async () => {
    const requests: Array<{ method: string }> = [];
    const fetchMock = makeFetchMock((_url, init) => {
      requests.push({ method: init.method ?? "GET" });
      return makeOkResponse("", 200);
    });
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    expect(await store.exists("exists.txt")).toBe(true);
    expect(requests[0].method).toBe("HEAD");
  });

  it("exists returns false for 404", async () => {
    const fetchMock = makeFetchMock(() => makeOkResponse("", 404));
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    expect(await store.exists("nope.txt")).toBe(false);
  });

  // list
  it("list parses S3 XML response", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>uploads/a.txt</Key>
    <Size>100</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>uploads/b.txt</Key>
    <Size>200</Size>
    <LastModified>2024-01-02T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

    const fetchMock = makeFetchMock(() => makeOkResponse(xml, 200));
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    const files = await store.list("uploads/");
    expect(files).toHaveLength(2);
    expect(files[0].key).toBe("uploads/a.txt");
    expect(files[0].size).toBe(100);
    expect(files[1].key).toBe("uploads/b.txt");
    expect(files[1].size).toBe(200);
  });

  it("list throws FileStoreError on failure", async () => {
    const fetchMock = makeFetchMock(() => makeOkResponse("", 403));
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    await expect(store.list()).rejects.toThrow(FileStoreError);
  });

  // url
  it("url returns publicUrlBase when configured", async () => {
    const store = new S3FileStore(
      makeS3Config({ publicUrlBase: "https://cdn.example.com" }),
      { fetch: makeFetchMock(() => makeOkResponse()), now },
    );
    const u = await store.url("images/logo.png");
    expect(u).toBe("https://cdn.example.com/images%2Flogo.png");
  });

  it("url generates a presigned URL with required query params", async () => {
    const store = new S3FileStore(makeS3Config(), { fetch: makeFetchMock(() => makeOkResponse()), now });
    const u = await store.url("secure/file.pdf", 7200_000);
    expect(u).toBeDefined();
    expect(u).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(u).toContain("X-Amz-Credential=");
    expect(u).toContain("X-Amz-Signature=");
    expect(u).toContain("X-Amz-Expires=7200");
  });

  // Signed request structure
  it("signed request includes Authorization header", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const fetchMock = makeFetchMock((_url, init) => {
      capturedHeaders.push(Object.fromEntries(new Headers(init.headers as HeadersInit).entries()));
      return makeOkResponse("", 200);
    });
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    await store.put("test.txt", enc("data"));
    expect(capturedHeaders[0]["authorization"]).toMatch(/^AWS4-HMAC-SHA256/);
    expect(capturedHeaders[0]["x-amz-date"]).toBeDefined();
    expect(capturedHeaders[0]["x-amz-content-sha256"]).toBeDefined();
  });

  it("metadata is sent as x-amz-meta- headers", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const fetchMock = makeFetchMock((_url, init) => {
      capturedHeaders.push(Object.fromEntries(new Headers(init.headers as HeadersInit).entries()));
      return makeOkResponse("", 200);
    });
    const store = new S3FileStore(makeS3Config(), { fetch: fetchMock, now });
    await store.put("f.txt", enc("data"), { metadata: { owner: "yash", env: "prod" } });
    expect(capturedHeaders[0]["x-amz-meta-owner"]).toBe("yash");
    expect(capturedHeaders[0]["x-amz-meta-env"]).toBe("prod");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FileStoreError
// ─────────────────────────────────────────────────────────────────────────────

describe("FileStoreError", () => {
  it("has correct name and code", () => {
    const err = new FileStoreError("not found", "NOT_FOUND", { key: "x" });
    expect(err.name).toBe("FileStoreError");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.context?.key).toBe("x");
    expect(err instanceof Error).toBe(true);
  });
});
