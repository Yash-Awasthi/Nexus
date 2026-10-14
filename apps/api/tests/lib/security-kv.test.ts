// SPDX-License-Identifier: Apache-2.0
/** Security state must survive a restart even where the shared KV is only process memory (Neon, no Redis). */
import { MemoryKVStore } from "@nexus/kv";
import { expect, it } from "vitest";

import { getSecurityKV, getSharedKV, PgKVStore } from "../../src/lib/shared-kv.ts";

it("falls back to Postgres when the shared KV lives in process memory", () => {
  delete process.env.REDIS_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  expect(getSharedKV()).toBeInstanceOf(MemoryKVStore);
  expect(getSecurityKV()).toBeInstanceOf(PgKVStore);
});
