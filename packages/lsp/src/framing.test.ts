// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vite-plus/test";

import {
  FrameDecoder,
  LspFrameError,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  encodeFrame,
} from "./framing.ts";

describe("encodeFrame", () => {
  it("prefixes a Content-Length header and a blank line", () => {
    const frame = encodeFrame({ jsonrpc: "2.0", id: 1, result: "ok" });
    const text = frame.toString("utf8");
    const [header, body] = text.split("\r\n\r\n");
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body ?? "")}`);
    expect(JSON.parse(body ?? "")).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
  });
});

describe("FrameDecoder", () => {
  it("decodes a frame delivered one byte at a time", () => {
    const decoder = new FrameDecoder();
    const message = { jsonrpc: "2.0", id: 7, result: { ok: true } };
    const frame = encodeFrame(message);
    const messages: unknown[] = [];
    for (const byte of frame) messages.push(...decoder.push(Buffer.from([byte])));
    expect(messages).toEqual([message]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("decodes two frames from one chunk", () => {
    const decoder = new FrameDecoder();
    const first = { jsonrpc: "2.0", id: 1, result: "one" };
    const second = { jsonrpc: "2.0", id: 2, result: "two" };
    const chunk = Buffer.concat([encodeFrame(first), encodeFrame(second)]);
    expect(decoder.push(chunk)).toEqual([first, second]);
  });

  it("matches the header name case-insensitively", () => {
    const decoder = new FrameDecoder();
    const body = Buffer.from(JSON.stringify({ ok: true }), "utf8");
    const frame = Buffer.concat([Buffer.from(`content-length: ${body.length}\r\n\r\n`), body]);
    expect(decoder.push(frame)).toEqual([{ ok: true }]);
  });

  it("throws when Content-Length is missing", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.from("X-Test: 1\r\n\r\n{}"))).toThrow(LspFrameError);
    expect(() => new FrameDecoder().push(Buffer.from("X-Test: 1\r\n\r\n{}"))).toThrow(
      /missing Content-Length/,
    );
  });

  it("throws on a body above the 8 MB cap without buffering it", () => {
    const decoder = new FrameDecoder();
    const header = Buffer.from(`Content-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`, "ascii");
    expect(() => decoder.push(header)).toThrow(/exceeds/);
    try {
      decoder.push(header);
    } catch (error) {
      expect((error as LspFrameError).code).toBe("BODY_TOO_LARGE");
    }
  });

  it("throws when the header exceeds the 8 KB cap", () => {
    const decoder = new FrameDecoder();
    const junk = Buffer.from(`X-Pad: ${"a".repeat(MAX_HEADER_BYTES)}\r\n`, "ascii");
    try {
      decoder.push(junk);
      expect.unreachable("expected a header cap error");
    } catch (error) {
      expect((error as LspFrameError).code).toBe("HEADER_TOO_LARGE");
    }
  });

  it("throws on a non-JSON body", () => {
    const decoder = new FrameDecoder();
    const body = Buffer.from("not json");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    try {
      decoder.push(frame);
      expect.unreachable("expected a bad body error");
    } catch (error) {
      expect((error as LspFrameError).code).toBe("BAD_BODY");
    }
  });
});
