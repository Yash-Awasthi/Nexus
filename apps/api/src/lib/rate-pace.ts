// SPDX-License-Identifier: Apache-2.0
/**
 * Header-learned pacing (after OmniRoute, github.com/diegosouzapw/OmniRoute, MIT License,
 * Copyright (c) 2026 diegosouzapw): once a provider's x-ratelimit-* headers say a window is
 * spent, calls with that key answer locally with a 429 until the reset instead of spending a
 * round trip on a certain refusal. The failover chain reads the wait and benches the provider.
 */
import { createHash } from "node:crypto";

import { rateLimitWaitMs } from "@nexus/gateway";

import { IdleMap } from "./idle-map.js";

// Keyed per host and API key, so one account's spent quota never holds back another's.
const _until = new IdleMap<string, number>(24 * 60 * 60 * 1000);

function paceKey(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  return `${url.host}:${createHash("sha256").update(auth).digest("hex").slice(0, 16)}`;
}

export function pacedFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const key = paceKey(input, init);
    const wait = (_until.get(key) ?? 0) - Date.now();
    if (wait > 0) {
      const message = `Rate limit window spent, try again in ${Math.ceil(wait / 1000)}s`;
      return new Response(JSON.stringify({ error: { message } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    const res = await inner(input, init);
    const ms = rateLimitWaitMs(res.headers);
    if (ms) _until.set(key, Date.now() + ms);
    return res;
  };
}
