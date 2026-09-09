// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";

import { getDiffRecord, saveDiffRecord } from "../../src/lib/diff-history.js";
import { getSharedKV } from "../../src/lib/shared-kv.js";

// No REDIS_URL / UPSTASH env in tests → getSharedKV() falls back to the
// in-process MemoryKVStore. Clear it before every test so cases are isolated.
beforeEach(async () => {
  await getSharedKV().clear();
});

describe("diff-history", () => {
  it("round-trips a record by id for the same caller", async () => {
    const rec = await saveDiffRecord("u1", { original: "a\nb", modified: "a\nc" });
    const out = await getDiffRecord("u1", rec.id);
    expect(out).toMatchObject({ id: rec.id, original: "a\nb", modified: "a\nc" });
    expect(out?.appliedAt).toBeTypeOf("string");
  });

  it("isolates per user — u2 can never read u1's rollback", async () => {
    const rec = await saveDiffRecord("u1", { original: "secret", modified: "changed" });
    expect(await getDiffRecord("u2", rec.id)).toBeUndefined();
    expect(await getDiffRecord("u1", rec.id)).toBeDefined();
  });

  it("returns undefined for garbage / oversized ids", async () => {
    expect(await getDiffRecord("u1", "")).toBeUndefined();
    expect(await getDiffRecord("u1", "x".repeat(65))).toBeUndefined();
  });

  it("rejects oversized diffs instead of truncating (rollback must be exact)", async () => {
    const big = "x".repeat(201_000);
    await expect(saveDiffRecord("u1", { original: big, modified: "y" })).rejects.toThrow(
      "diff_too_large",
    );
  });

  it("caps the per-user index (oldest ids fall out of the list)", async () => {
    const first = await saveDiffRecord("u1", { original: "o0", modified: "m0" });
    for (let i = 1; i < 52; i++) {
      await saveDiffRecord("u1", { original: `o${i}`, modified: `m${i}` });
    }
    const ids = (await getSharedKV().get<string[]>("diffhist:list:u1")) ?? [];
    expect(ids.length).toBe(50);
    expect(ids).not.toContain(first.id); // oldest pushed out of the index
    expect(await getDiffRecord("u1", first.id)).toBeDefined(); // item still readable until TTL
  });
});
