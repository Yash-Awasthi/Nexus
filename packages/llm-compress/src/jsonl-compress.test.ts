// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { jsonlCompress, ENGINES } from "./index.js";

const row = (id: string): string => `{"id":"${id}","name":"pkg ${id}","status":"ok"}`;
const fenced =
  "```jsonl\n" + Array.from({ length: 10 }, (_, i) => row(`r${i}`)).join("\n") + "\n```";
const bare = Array.from({ length: 10 }, (_, i) => row(`b${i}`)).join("\n");

describe("jsonlCompress (JSONL/NDJSON lossless codec)", () => {
  it("re-encodes a fenced ```jsonl stream as ```toon when smaller", () => {
    const out = jsonlCompress(fenced);
    expect(out).toContain("```toon\n");
    expect(out).not.toContain("```jsonl");
    expect(out.length).toBeLessThan(fenced.length);
  });

  it("re-encodes a whole-text bare NDJSON stream", () => {
    const out = jsonlCompress(bare);
    expect(out.startsWith("```toon\n")).toBe(true);
    expect(out.length).toBeLessThan(bare.length);
  });

  it("leaves heterogeneous key sets untouched", () => {
    const mixed = ['{"id":"a","name":"x"}', '{"id":"b","other":1}', '{"id":"c","name":"z"}'].join(
      "\n",
    );
    expect(jsonlCompress(mixed)).toBe(mixed);
  });

  it("respects the minRows floor", () => {
    const few = [1, 2, 3, 4, 5].map((i) => row(`f${i}`)).join("\n");
    expect(jsonlCompress(few)).toBe(few);
  });

  it("leaves unparseable streams untouched", () => {
    const bad = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => row(`e${i}`));
    bad[5] = "this is not json";
    const src = bad.join("\n");
    expect(jsonlCompress(src)).toBe(src);
  });

  it("leaves prose untouched", () => {
    const prose = "The quick brown fox\njumps over the lazy dog\nrepeatedly and loudly.\n";
    expect(jsonlCompress(prose)).toBe(prose);
  });

  it("composes into the headroom engine (lossless pipeline)", () => {
    const out = ENGINES.headroom.apply(fenced);
    expect(out).toContain("```toon");
    expect(ENGINES.headroom.lossless).toBe(true);
    const short = [1, 2, 3].map((i) => row(`m${i}`)).join("\n");
    expect(ENGINES.headroom.apply(short, { minRows: 2 })).toContain("```toon");
  });
});
