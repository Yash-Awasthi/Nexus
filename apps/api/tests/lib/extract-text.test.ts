// SPDX-License-Identifier: Apache-2.0
/**
 * Uploaded files become knowledge-base text. The paths tested here are the ones that run
 * without a heavy parser: the plain-text passthrough (which is what most uploads take) and
 * the HTML stripper. The stripper is hand-written rather than a regex on purpose — a lazy
 * `<script[\s\S]*?</script>` is quadratic on an upload full of unclosed tags — so it was
 * worth checking that it terminates and keeps the words around the tags.
 */
import { describe, expect, it } from "vite-plus/test";

import { extractText, isImageType } from "../../src/lib/extract-text.ts";

describe("isImageType", () => {
  it("recognises the image uploads the OCR path handles", () => {
    for (const type of ["image", "png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"])
      expect(isImageType(type), type).toBe(true);
  });

  it("leaves everything else to the text parsers", () => {
    for (const type of ["pdf", "docx", "html", "text", "md", ""])
      expect(isImageType(type)).toBe(false);
  });
});

describe("extractText", () => {
  it("passes plain text through unchanged", async () => {
    const body = "line one\nline two — unicode kept";
    expect(await extractText("text", Buffer.from(body, "utf8"))).toBe(body);
  });

  it("strips html tags and keeps the words", async () => {
    const html = "<h1>Title</h1><p>Body <b>bold</b></p>";
    expect(await extractText("html", Buffer.from(html, "utf8"))).toBe("Title Body bold");
  });

  it("drops script and style bodies rather than indexing them", async () => {
    const html = "<style>p{color:red}</style><p>kept</p><script>alert('x')</script>";
    expect(await extractText("html", Buffer.from(html, "utf8"))).toBe("kept");
  });

  it("terminates on an unclosed script tag and keeps the text before it", async () => {
    const html = `<p>kept</p><script>${"a".repeat(20_000)}`;
    expect(await extractText("html", Buffer.from(html, "utf8"))).toBe("kept");
  });

  it("is case-insensitive about the tags it removes", async () => {
    const html = "<SCRIPT>gone()</SCRIPT><p>kept</p>";
    expect(await extractText("html", Buffer.from(html, "utf8"))).toBe("kept");
  });
});
