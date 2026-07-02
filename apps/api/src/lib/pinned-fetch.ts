// SPDX-License-Identifier: Apache-2.0
/**
 * A `fetch`-shaped function whose socket is PINNED to a DNS result validated as
 * public at connect time — closing the DNS-rebinding window a static URL check
 * (`isSafeUrl`) cannot. `isSafeUrl` runs once, up front; between that check and
 * the actual connect an attacker-controlled hostname can re-resolve to a private
 * / IMDS address. `@nexus/runtime`'s `safeLookup` validates the RESOLVED address
 * and hands the socket exactly those addresses, so there is no second resolution
 * to rebind.
 *
 * Implementation note (see PROGRESS §10 decision): built on `node:http`/`https`
 * with an `Agent { lookup: safeLookup }`. Global `fetch` won't accept an
 * `http.Agent`, and we deliberately avoid adding `undici` as an apps/api dep just
 * to pass a `connect.lookup` dispatcher. `Response` is the Node global (no dep).
 *
 * Scope: enough of the `fetch`/`Response` contract for outbound JSON callers
 * (method, headers, string body, AbortSignal, `res.ok`/`status`/`json()`/
 * `text()`). Not a general fetch polyfill.
 */
import http from "node:http";
import https from "node:https";

import { safeLookup, type SafeLookup } from "@nexus/runtime";

function normalizeHeaders(h: RequestInit["headers"]): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return h as Record<string, string>;
}

/**
 * Build a socket-pinned `fetch`. `lookup` is injectable so tests can drive it
 * with a fake resolver (e.g. one that returns a private address to prove the
 * rebinding block fires before any real connection).
 */
export function createPinnedFetch(lookup: SafeLookup = safeLookup): typeof fetch {
  // `lookup` is structurally a Node LookupFunction; the Agent option type is
  // narrower than SafeLookup, so cast at the single construction site.
  const agentOpts = { lookup } as unknown as http.AgentOptions;
  const httpAgent = new http.Agent(agentOpts);
  const httpsAgent = new https.Agent(agentOpts);

  const pinnedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return Promise.reject(new Error(`pinnedFetch: unsupported scheme ${u.protocol}`));
    }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const headers = normalizeHeaders(init?.headers);
    const body = init?.body;
    const signal = init?.signal ?? undefined;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));

      const req = mod.request(u, { method: init?.method ?? "GET", headers, agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          // Only the status + body are consumed downstream; response headers are
          // dropped (IncomingHttpHeaders can be array-valued, incompatible with
          // the Response headers init) — add a normaliser here if ever needed.
          resolve(new Response(buf.length ? buf : null, { status: res.statusCode ?? 502 }));
        });
        res.on("error", reject);
      });

      req.on("error", reject);
      if (signal) {
        signal.addEventListener("abort", () => req.destroy(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }
      if (body != null) req.write(typeof body === "string" ? body : String(body));
      req.end();
    });
  };

  return pinnedFetch as typeof fetch;
}

/** Shared prod instance backed by the default `safeLookup` (dns.lookup). */
export const pinnedFetch = createPinnedFetch();
