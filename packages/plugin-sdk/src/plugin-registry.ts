// SPDX-License-Identifier: Apache-2.0
/**
 * plugin-registry — hosted registry transport for the plugin marketplace (§15.1).
 *
 * Client for a hosted plugin registry: list / read / publish / install plugin
 * manifests over HTTP. Every manifest that comes back from the wire is passed
 * through {@link validatePluginManifest} — malformed registry data fails closed
 * (a `PluginManifestError`) rather than reaching plugin code. `install` runs
 * the same fail-closed capability check as `loadPlugin`, so a registry entry
 * whose grants the host cannot honour never becomes a LoadedPlugin.
 *
 * No SDK code executes the plugin entry point; that is the sandbox runtime's
 * job (see ./sandbox.ts).
 */

import {
  loadPlugin,
  validatePluginManifest,
  PluginManifestError,
  type LoadedPlugin,
  type PluginManifest,
} from "./plugin-manifest.js";

/** Injectable fetch seam (tests mock this; production uses global fetch). */
export type RegistryFetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Error raised by registry transport failures (network, HTTP, shape). */
export class PluginRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: "NETWORK" | "HTTP" | "NOT_FOUND" | "CONFLICT" | "INVALID_RESPONSE",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

/** Options for {@link PluginRegistryClient}. */
export interface PluginRegistryClientOptions {
  /**
   * Base URL of the hosted registry, e.g. `https://registry.nexus.dev`.
   * Defaults to `/api/v1/registry` — the Nexus API's own registry mount
   * (same-origin), so `new PluginRegistryClient({ apiKey })` talks to the
   * server-side registry out of the box.
   */
  baseUrl?: string;
  /** Bearer token for publish (and private reads). Optional for public reads. */
  apiKey?: string;
  /** Injectable fetch (test seam). Defaults to global `fetch`. */
  fetchFn?: RegistryFetchFn;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
}

/** A registry listing entry: the manifest plus registry-side metadata. */
export interface RegistryEntry {
  manifest: PluginManifest;
  downloads: number;
  publishedAt: string;
}

/** Payload accepted by {@link PluginRegistryClient.publish}. */
export interface PublishRequest {
  manifest: PluginManifest;
}

export class PluginRegistryClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: RegistryFetchFn;
  private readonly timeoutMs: number;

  constructor(opts: PluginRegistryClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "/api/v1/registry").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as RegistryFetchFn);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** List published plugins, optionally filtered by search query. */
  async list(query?: string): Promise<RegistryEntry[]> {
    const url = `${this.baseUrl}/plugins${query ? `?q=${encodeURIComponent(query)}` : ""}`;
    const body = await this.request(url, "GET");
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { plugins?: unknown }).plugins)
    ) {
      throw new PluginRegistryError(
        "registry list response missing `plugins` array",
        "INVALID_RESPONSE",
      );
    }
    return ((body as { plugins: unknown }).plugins as unknown[]).map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      return {
        manifest: validatePluginManifest(e["manifest"]),
        downloads: typeof e["downloads"] === "number" ? e["downloads"] : 0,
        publishedAt: typeof e["publishedAt"] === "string" ? e["publishedAt"] : "",
      };
    });
  }

  /** Fetch one plugin's manifest by id. Throws `NOT_FOUND` on 404. */
  async get(id: string): Promise<RegistryEntry> {
    const body = await this.request(`${this.baseUrl}/plugins/${encodeURIComponent(id)}`, "GET");
    if (!body || typeof body !== "object") {
      throw new PluginRegistryError("registry get response is not an object", "INVALID_RESPONSE");
    }
    const e = body as Record<string, unknown>;
    return {
      manifest: validatePluginManifest(e["manifest"]),
      downloads: typeof e["downloads"] === "number" ? e["downloads"] : 0,
      publishedAt: typeof e["publishedAt"] === "string" ? e["publishedAt"] : "",
    };
  }

  /** Publish a manifest. Requires an API key; 409 on an existing id+version. */
  async publish(manifest: PluginManifest): Promise<{ ok: true; id: string; version: string }> {
    if (!this.apiKey) {
      throw new PluginRegistryError("publish requires an API key", "HTTP", 401);
    }
    // Client-side validation first — a bad manifest never leaves the host.
    validatePluginManifest(manifest);
    const res = await this.raw(`${this.baseUrl}/plugins`, "POST", manifest);
    if (res.status === 409) {
      throw new PluginRegistryError(
        `plugin ${manifest.id}@${manifest.version} already exists`,
        "CONFLICT",
        409,
      );
    }
    if (!res.ok) {
      throw new PluginRegistryError(`publish failed with HTTP ${res.status}`, "HTTP", res.status);
    }
    return { ok: true, id: manifest.id, version: manifest.version };
  }

  /**
   * Install a plugin by id: fetch its manifest from the registry and resolve
   * it against the host's granted capabilities (fail-closed, same contract as
   * `loadPlugin`). Returns the LoadedPlugin ready for the sandbox runtime.
   */
  async install(id: string, grantedCapabilities: string[] = []): Promise<LoadedPlugin> {
    const entry = await this.get(id);
    return loadPlugin(entry.manifest, { grantedCapabilities: grantedCapabilities as never });
  }

  private async request(url: string, method: "GET" | "POST", payload?: unknown): Promise<unknown> {
    const res = await this.raw(url, method, payload);
    if (res.status === 404) {
      throw new PluginRegistryError(`not found: ${url}`, "NOT_FOUND", 404);
    }
    if (!res.ok) {
      throw new PluginRegistryError(`registry HTTP ${res.status}`, "HTTP", res.status);
    }
    return res.json();
  }

  private async raw(
    url: string,
    method: "GET" | "POST",
    payload?: unknown,
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await this.fetchFn(url, {
        method,
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      });
    } catch (e) {
      throw new PluginRegistryError(
        `registry request failed: ${e instanceof Error ? e.message : String(e)}`,
        "NETWORK",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export { PluginManifestError };
