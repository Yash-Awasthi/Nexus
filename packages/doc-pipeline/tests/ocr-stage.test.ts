// SPDX-License-Identifier: Apache-2.0
/** An image goes through the OCR stage; its recognised text is chunked like any other document. */
import { describe, expect, it } from "vitest";

import { runDocPipeline } from "../src/index.js";

describe("OCR stage", () => {
  it("recognises an image's text before chunking", async () => {
    const seen: string[] = [];
    const result = await runDocPipeline(
      { format: "image", content: "aGVsbG8=" },
      {
        ocr: async (base64) => {
          seen.push(base64);
          return "Invoice 42: amount due 100 USD";
        },
      },
    );
    expect(seen).toEqual(["aGVsbG8="]);
    expect(result.rawTextLength).toBe("Invoice 42: amount due 100 USD".length);
    expect(result.chunks).toBe(1);
  });

  it("says OCR is needed when an image arrives without one", async () => {
    await expect(runDocPipeline({ format: "image", content: "aGVsbG8=" })).rejects.toThrow(/OCR/);
  });
});
