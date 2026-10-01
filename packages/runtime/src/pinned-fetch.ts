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
 * Scope: method, headers, string or byte body, AbortSignal, and a Response with
 * status, headers and a streamed body. Redirects are returned, never followed, so each hop
 * passes the guard again. Not a general fetch polyfill.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";

import { isPrivateAddress, safeLookup, type SafeLookup } from "./security-utils.js";

function normalizeHeaders(h: RequestInit["headers"]): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return h as Record<string, string>;
}

const DECODERS: Record<string, () => NodeJS.ReadWriteStream & Readable> = {
  gzip: () => zlib.createGunzip(),
  "x-gzip": () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

/**
 * Build a socket-pinned `fetch`. `lookup` is injectable so tests can drive it
 * with a fake resolver (e.g. one that returns a private address to prove the
 * rebinding block fires before any real connection).
 */
export function createPinnedFetch(lookup: SafeLookup = safeLookup): typeof fetch {
  // `lookup` is structurally a Node LookupFunction; the Agent option type is
  // narrower than SafeLookup, so cast at the single construction site.
  // Keep-alive is safe: the pinned lookup validates each new socket, and reuse skips DNS entirely.
  const agentOpts = { lookup, keepAlive: true } as unknown as http.AgentOptions;
  const httpAgent = new http.Agent(agentOpts);
  const httpsAgent = new https.Agent(agentOpts);

  const pinnedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return Promise.reject(new Error(`pinnedFetch: unsupported scheme ${u.protocol}`));
    }
    // Node connects to an IP-literal host without calling `lookup`, so the
    // pinned resolver never sees it; check the literal here instead.
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literal) && isPrivateAddress(literal)) {
      return Promise.reject(
        new Error(`SSRF guard: ${literal} is a private address and cannot be fetched`),
      );
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
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, one);
        const status = res.statusCode ?? 502;
        // A null-body status cannot carry a body in a Response.
        const empty = [101, 204, 205, 304].includes(status);
        if (empty) res.resume();
        // Like fetch, hand back the decoded body; the encoding headers then no longer describe it.
        const decode = DECODERS[(res.headers["content-encoding"] ?? "").toLowerCase()];
        if (decode) {
          out.delete("content-encoding");
          out.delete("content-length");
        }
        const raw: Readable = decode ? res.pipe(decode()) : res;
        const body = empty ? null : (Readable.toWeb(raw) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers: out }));
      });

      req.on("error", reject);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => req.destroy(new DOMException("Aborted", "AbortError")),
          {
            once: true,
          },
        );
      }
      if (body != null)
        req.write(
          typeof body === "string" || body instanceof Uint8Array ? body : String(body as unknown),
        );
      req.end();
    });
  };

  return pinnedFetch as typeof fetch;
}

/** Shared prod instance backed by the default `safeLookup` (dns.lookup). */
export const pinnedFetch = createPinnedFetch();
