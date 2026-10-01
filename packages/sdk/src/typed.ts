// SPDX-License-Identifier: Apache-2.0
/**
 * Typed access to the whole HTTP surface.
 *
 * `NexusClient` in this package is a hand-written ergonomic client over a
 * handful of endpoints. This is the other half: a thin client whose paths and
 * methods come from `@nexus/contracts`, generated from the same `openapi.yaml`
 * the API writes from its own route table. A path that does not exist, or a
 * method the API does not serve on it, is a type error rather than a 404 found
 * in production.
 *
 * It stays thin on purpose. Anything clever belongs in the ergonomic layer,
 * because this file's contract is "whatever the API actually serves".
 */

import type { paths } from "@nexus/contracts";

/** Paths that serve `M`, e.g. `PathsWith<"get">`. */
type PathsWith<M extends string> = {
  [P in keyof paths]: paths[P] extends Record<M, Record<string, unknown>> ? P : never;
}[keyof paths];

export type GetPath = PathsWith<"get">;
export type PostPath = PathsWith<"post">;
export type PutPath = PathsWith<"put">;
export type PatchPath = PathsWith<"patch">;
export type DeletePath = PathsWith<"delete">;

/** The 200 response body an operation declares, or `unknown` when it declares none. */
type JsonOf<Operation> = Operation extends {
  responses: { 200: { content: { "application/json": infer Body } } };
}
  ? Body
  : unknown;

export interface RequestOptions {
  /** Values for `{name}` segments in the path. */
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export interface TypedClientOptions {
  /** Origin the API is served from. No trailing slash. */
  baseUrl?: string;
  /** Bearer token. Omitted on a server that runs without auth. */
  token?: string;
  /** Injected for tests, or to drive an in-process server. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class TypedRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${path} responded ${status}`);
    this.name = "TypedRequestError";
  }
}

/** Fills `{name}` segments and appends the query string. */
export function buildUrl(baseUrl: string, path: string, options: RequestOptions = {}): string {
  const filled = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = options.params?.[name];
    if (value === undefined) throw new Error(`${path} needs a value for "${name}"`);
    return encodeURIComponent(String(value));
  });

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return `${baseUrl}${filled}${suffix ? `?${suffix}` : ""}`;
}

export class TypedNexusClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TypedClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3000").replace(/\/$/, "");
    if (options.token !== undefined) this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get<P extends GetPath>(path: P, options?: RequestOptions): Promise<JsonOf<paths[P]["get"]>> {
    return this.send("GET", path as string, options) as Promise<JsonOf<paths[P]["get"]>>;
  }

  post<P extends PostPath>(
    path: P,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<JsonOf<paths[P]["post"]>> {
    return this.send("POST", path as string, options, body) as Promise<JsonOf<paths[P]["post"]>>;
  }

  put<P extends PutPath>(
    path: P,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<JsonOf<paths[P]["put"]>> {
    return this.send("PUT", path as string, options, body) as Promise<JsonOf<paths[P]["put"]>>;
  }

  patch<P extends PatchPath>(
    path: P,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<JsonOf<paths[P]["patch"]>> {
    return this.send("PATCH", path as string, options, body) as Promise<JsonOf<paths[P]["patch"]>>;
  }

  delete<P extends DeletePath>(
    path: P,
    options?: RequestOptions,
  ): Promise<JsonOf<paths[P]["delete"]>> {
    return this.send("DELETE", path as string, options) as Promise<JsonOf<paths[P]["delete"]>>;
  }

  private async send(
    method: string,
    path: string,
    options: RequestOptions = {},
    body?: unknown,
  ): Promise<unknown> {
    const url = buildUrl(this.baseUrl, path, options);
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) throw new TypedRequestError(response.status, path, text);
    // A 204, or any endpoint that answers with an empty body, is not an error.
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
