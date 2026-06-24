// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { parseSseBuffer } from "../../src/lib/sse-stream.js";

describe("parseSseBuffer", () => {
  it("parses a complete event/data/id frame", () => {
    const { frames, rest } = parseSseBuffer(
      'event: agent.step\nid: a-1\ndata: {"stepIndex":0}\n\n',
    );
    expect(rest).toBe("");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: "agent.step", id: "a-1", data: '{"stepIndex":0}' });
  });

  it("keeps an unterminated frame in rest for the next chunk", () => {
    const { frames, rest } = parseSseBuffer("event: agent.step\ndata: {");
    expect(frames).toHaveLength(0);
    expect(rest).toBe("event: agent.step\ndata: {");
  });

  it("stitches a frame split across two buffers", () => {
    const a = parseSseBuffer('event: agent.status\ndata: {"sta');
    const b = parseSseBuffer(a.rest + 'tus":"completed"}\n\n');
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0]?.event).toBe("agent.status");
    expect(b.frames[0]?.data).toBe('{"status":"completed"}');
  });

  it("ignores comment/ping lines and blank frames", () => {
    const { frames } = parseSseBuffer(":ping\n\n:\n\n");
    expect(frames).toHaveLength(0);
  });

  it("joins multi-line data fields", () => {
    const { frames } = parseSseBuffer("data: line1\ndata: line2\n\n");
    expect(frames[0]?.data).toBe("line1\nline2");
  });

  it("handles CRLF line endings", () => {
    const { frames } = parseSseBuffer("event: agent.step\r\ndata: {}\r\n\r\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("agent.step");
  });

  it("parses multiple frames in one buffer", () => {
    const { frames } = parseSseBuffer("data: 1\n\ndata: 2\n\n");
    expect(frames.map((f) => f.data)).toEqual(["1", "2"]);
  });
});
