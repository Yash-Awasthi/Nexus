// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import {
  PluginRegistryClient,
  PluginRegistryError,
  PluginManifestError,
  type PluginManifest,
  type RegistryFetchFn,
} from "../src/index.js";

const MANIFEST: PluginManifest = {
  id: "com.acme.summarizer",
  name: "Acme Summarizer",
  version: "1.2.3",
  entry: "./dist/plugin.js",
  capabilities: ["llm.inference", "storage.read"],
};

function fakeFetch(handler: (url: string, init?: unknown) => Promise<unknown>): RegistryFetchFn {
  return vi.fn(async (url: string, init?: unknown) => {
    const body = await handler(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
}

function fakeFetchStatus(status: number, body: unknown): RegistryFetchFn {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

describe("PluginRegistryClient", () => {
  it("defaults baseUrl to the Nexus API's own registry mount and uses /plugins paths", async () => {
    // §16.2 wire contract: `new PluginRegistryClient({ apiKey })` (no baseUrl)
    // must target the server-side registry mounted at /api/v1/registry — and
    // the path template is `/plugins`, not `/v1/plugins` (the server's version
    // prefix lives in the mount, not the route).
    const urls: string[] = [];
    const client = new PluginRegistryClient({
      apiKey: "k",
      fetchFn: vi.fn(async (url: string) => {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({ plugins: [] }),
          text: async () => "{}",
        };
      }),
    });
    await client.list();
    expect(urls[0]).toBe("/api/v1/registry/plugins");
    // A trailing slash on an explicit baseUrl is normalized.
    const explicit = new PluginRegistryClient({
      baseUrl: "https://registry.example.com/",
      fetchFn: vi.fn(async (url: string) => {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({ plugins: [] }),
          text: async () => "{}",
        };
      }),
    });
    await explicit.list();
    expect(urls[1]).toBe("https://registry.example.com/plugins");
  });

  it("lists plugins and validates every manifest from the wire", async () => {
    const fetchFn = fakeFetch(async () => ({
      plugins: [{ manifest: MANIFEST, downloads: 42, publishedAt: "2026-01-01T00:00:00Z" }],
    }));
    const client = new PluginRegistryClient({ baseUrl: "https://registry.example.com", fetchFn });
    const entries = await client.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.manifest.id).toBe("com.acme.summarizer");
    expect(entries[0]!.downloads).toBe(42);
  });

  it("fails closed on a malformed manifest from the wire", async () => {
    const fetchFn = fakeFetch(async () => ({
      plugins: [
        { manifest: { id: "bad id!", name: "", version: "nope", entry: "", capabilities: [] } },
      ],
    }));
    const client = new PluginRegistryClient({ baseUrl: "https://registry.example.com", fetchFn });
    try {
      await client.list();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PluginManifestError);
      expect((e as PluginManifestError).code).toBe("INVALID_MANIFEST");
    }
  });

  it("throws INVALID_RESPONSE when the list shape is wrong", async () => {
    const fetchFn = fakeFetch(async () => ({ items: [] }));
    const client = new PluginRegistryClient({ baseUrl: "https://registry.example.com", fetchFn });
    try {
      await client.list();
      expect.unreachable();
    } catch (e) {
      expect((e as PluginRegistryError).code).toBe("INVALID_RESPONSE");
    }
  });

  it("get() returns a validated entry", async () => {
    const fetchFn = fakeFetch(async () => ({ manifest: MANIFEST, downloads: 7, publishedAt: "x" }));
    const client = new PluginRegistryClient({ baseUrl: "https://registry.example.com", fetchFn });
    const entry = await client.get("com.acme.summarizer");
    expect(entry.manifest.version).toBe("1.2.3");
  });

  it("get() maps 404 to NOT_FOUND", async () => {
    const fetchFn = fakeFetchStatus(404, { error: "not found" });
    const client = new PluginRegistryClient({ baseUrl: "https://registry.example.com", fetchFn });
    try {
      await client.get("com.acme.missing");
      expect.unreachable();
    } catch (e) {
      expect((e as PluginRegistryError).code).toBe("NOT_FOUND");
    }
  });

  it("publish requires an API key", async () => {
    const client = new PluginRegistryClient({
      baseUrl: "https://registry.example.com",
      fetchFn: fakeFetch(async () => ({})),
    });
    try {
      await client.publish(MANIFEST);
      expect.unreachable();
    } catch (e) {
      expect((e as PluginRegistryError).code).toBe("HTTP");
    }
  });

  it("publish sends the validated manifest and returns ok", async () => {
    let sent: unknown;
    const fetchFn = fakeFetch(async (_url, init) => {
      sent = (init as { body?: string }).body;
      return { ok: true };
    });
    const client = new PluginRegistryClient({
      baseUrl: "https://registry.example.com",
      apiKey: "secret",
      fetchFn,
    });
    const res = await client.publish(MANIFEST);
    expect(res.ok).toBe(true);
    expect(JSON.parse(sent as string)).toMatchObject({ id: "com.acme.summarizer" });
  });

  it("publish maps 409 to CONFLICT", async () => {
    const fetchFn = fakeFetchStatus(409, { error: "exists" });
    const client = new PluginRegistryClient({
      baseUrl: "https://registry.example.com",
      apiKey: "secret",
      fetchFn,
    });
    try {
      await client.publish(MANIFEST);
      expect.unreachable();
    } catch (e) {
      expect((e as PluginRegistryError).code).toBe("CONFLICT");
    }
  });

  it("install() fetches + fails closed on ungranted capabilities", async () => {
    const fetchFn = fakeFetch(async () => ({ manifest: MANIFEST, downloads: 0, publishedAt: "" }));
    const client = new PluginRegistryClient({ baseUrl: "https://registry.example.com", fetchFn });
    try {
      await client.install("com.acme.summarizer", ["search.web"]); // llm.inference missing
      expect.unreachable();
    } catch (e) {
      expect((e as PluginManifestError).code).toBe("CAPABILITY_NOT_GRANTED");
    }
  });

  it("install() succeeds when every requested capability is granted", async () => {
    const fetchFn = fakeFetch(async () => ({ manifest: MANIFEST, downloads: 0, publishedAt: "" }));
    const client = new PluginRegistryClient({ baseUrl: "https://registry.example.com", fetchFn });
    const loaded = await client.install("com.acme.summarizer", ["llm.inference", "storage.read"]);
    expect(loaded.grantedCapabilities).toEqual(["llm.inference", "storage.read"]);
  });

  it("maps network failures to NETWORK", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connection refused");
    }) as RegistryFetchFn;
    const client = new PluginRegistryClient({ baseUrl: "https://registry.example.com", fetchFn });
    try {
      await client.list();
      expect.unreachable();
    } catch (e) {
      expect((e as PluginRegistryError).code).toBe("NETWORK");
    }
  });
});
