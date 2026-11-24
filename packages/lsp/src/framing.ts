// SPDX-License-Identifier: Apache-2.0
/**
 * LSP `Content-Length` framing.
 *
 * The MCP stdio client (`packages/mcp-client/src/stdio.ts`) frames newline
 * delimited JSON; LSP mandates a `Content-Length` header followed by
 * `\r\n\r\n`, so bodies may contain newlines and the decoder has to buffer
 * bytes until a whole frame arrives.
 */

export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const HEADER_END = Buffer.from("\r\n\r\n", "ascii");

export type LspFrameErrorCode =
  | "HEADER_TOO_LARGE"
  | "MISSING_CONTENT_LENGTH"
  | "BAD_CONTENT_LENGTH"
  | "BODY_TOO_LARGE"
  | "BAD_BODY";

export class LspFrameError extends Error {
  readonly code: LspFrameErrorCode;

  constructor(message: string, code: LspFrameErrorCode) {
    super(message);
    this.name = "LspFrameError";
    this.code = code;
  }
}

/** Encode one JSON-RPC message as an LSP frame. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

function contentLength(header: string): number {
  for (const line of header.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = line.slice(colon + 1).trim();
    if (!/^\d+$/.test(value)) {
      throw new LspFrameError(`invalid Content-Length: ${value}`, "BAD_CONTENT_LENGTH");
    }
    return Number(value);
  }
  throw new LspFrameError("missing Content-Length header", "MISSING_CONTENT_LENGTH");
}

/**
 * Incremental decoder. `push` accepts arbitrary chunk boundaries, including a
 * single byte, and returns every complete message now available. A malformed
 * frame throws `LspFrameError`; callers are expected to close the child.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, Buffer.from(chunk)]);

    const messages: unknown[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          throw new LspFrameError(
            `header exceeded ${MAX_HEADER_BYTES} bytes without a separator`,
            "HEADER_TOO_LARGE",
          );
        }
        break;
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        throw new LspFrameError(`header exceeded ${MAX_HEADER_BYTES} bytes`, "HEADER_TOO_LARGE");
      }

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = contentLength(header);
      if (length > MAX_BODY_BYTES) {
        throw new LspFrameError(
          `body of ${length} bytes exceeds ${MAX_BODY_BYTES}`,
          "BODY_TOO_LARGE",
        );
      }

      const bodyStart = headerEnd + HEADER_END.length;
      if (this.buffer.length - bodyStart < length) break;

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        messages.push(JSON.parse(body) as unknown);
      } catch (error) {
        throw new LspFrameError(
          `body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
          "BAD_BODY",
        );
      }
    }
    return messages;
  }

  /** Bytes held for the next frame. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }
}
