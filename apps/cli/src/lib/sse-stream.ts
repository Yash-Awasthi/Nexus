// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal SSE client for the CLI — enough to consume the API's
 * `/sse/agent/:stream` endpoint over `fetch`. No dependency: parses raw
 * `event:`/`data:`/`id:` frames and ignores `:` comment pings.
 */

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
}

/** Parse a single raw frame (text between blank lines). Null if it carries nothing. */
function parseFrame(raw: string): SseFrame | null {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let seen = false;
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // blank or comment/ping
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
      seen = true;
    } else if (field === "data") {
      dataLines.push(value);
      seen = true;
    } else if (field === "id") {
      id = value;
      seen = true;
    }
  }
  if (!seen) return null;
  return { ...(event !== undefined ? { event } : {}), ...(id !== undefined ? { id } : {}), data: dataLines.join("\n") };
}

/**
 * Split a buffer into complete SSE frames, returning the parsed frames and the
 * unterminated remainder to carry into the next chunk. Frames are delimited by
 * a blank line (`\n\n`).
 */
export function parseSseBuffer(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    const frame = parseFrame(rest.slice(0, idx));
    if (frame) frames.push(frame);
    rest = rest.slice(idx + 2);
  }
  return { frames, rest };
}

/**
 * Open an SSE connection and yield frames as they arrive. Caller aborts via
 * `signal` (e.g. when a terminal event is seen).
 */
export async function* streamSse(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const res = await fetch(url, {
    headers: { ...headers, Accept: "text/event-stream" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) throw new Error(`SSE connection failed (HTTP ${res.status})`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { frames, rest } = parseSseBuffer(buf);
    buf = rest;
    for (const frame of frames) yield frame;
  }
}
