// SPDX-License-Identifier: Apache-2.0
/**
 * A provider that reports a spent rate-limit window is not called again until the window resets:
 * the next calls get a local 429 naming the wait, which the failover chain benches and skips.
 */
import { afterEach, expect, it, vi } from "vitest";

import { pacedFetch } from "../../src/lib/rate-pace.js";

afterEach(() => vi.useRealTimers());

it("holds off a spent key until its reset, then calls again", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  let calls = 0;
  const inner = (async () => {
    calls++;
    return new Response("{}", {
      headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "30s" },
    });
  }) as unknown as typeof fetch;
  const f = pacedFetch(inner);
  const init = { method: "POST", headers: { authorization: "Bearer k1" } };

  expect((await f("https://api.example.com/v1/chat/completions", init)).status).toBe(200);
  const held = await f("https://api.example.com/v1/chat/completions", init);
  expect(held.status).toBe(429);
  expect(await held.text()).toMatch(/try again in 30s/);
  expect(calls).toBe(1);

  // Another key on the same host is its own quota.
  await f("https://api.example.com/v1/chat/completions", {
    ...init,
    headers: { authorization: "Bearer k2" },
  });
  expect(calls).toBe(2);

  vi.setSystemTime(1_000_000 + 31_000);
  expect((await f("https://api.example.com/v1/chat/completions", init)).status).toBe(200);
  expect(calls).toBe(3);
});
