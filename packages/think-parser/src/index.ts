// SPDX-License-Identifier: Apache-2.0
/**
 * think-parser — Streaming <think>…</think> tag parser with chunk-boundary buffering.
 *
 * Supports reasoning models: DeepSeek-R1, Qwen-QwQ, Kimi, and any model that
 * wraps chain-of-thought in <think> blocks.
 *
 * Provides:
 *   • ChunkType          — TEXT | THINKING
 *   • ContentChunk       — typed output unit
 *   • ThinkTagParser     — streaming parser; call feed() per chunk, flush() at end
 *   • collectChunks()    — async iterable adapter
 *   • splitThinking()    — one-shot parse of a complete string
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChunkType = "TEXT" | "THINKING";

/** Content chunk interface definition. */
export interface ContentChunk {
  type: ChunkType;
  text: string;
}

// ── ThinkTagParser ────────────────────────────────────────────────────────────

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/** Think tag parser. */
export class ThinkTagParser {
  private buffer = "";
  private insideThink = false;

  /**
   * Feed a streaming chunk. Returns zero or more ContentChunks that are now
   * complete (i.e. not still waiting for the closing tag or a partial tag).
   */
  feed(chunk: string): ContentChunk[] {
    this.buffer += chunk;
    return this.drain();
  }

  /**
   * Call at end-of-stream to flush any remaining buffer content.
   * If we are still inside a think block at EOS, treats the remainder as THINKING.
   */
  flush(): ContentChunk[] {
    const chunks: ContentChunk[] = [];
    if (this.buffer.length === 0) return chunks;

    if (this.insideThink) {
      // Incomplete think block — still emit as THINKING
      chunks.push({ type: "THINKING", text: this.buffer });
    } else {
      chunks.push({ type: "TEXT", text: this.buffer });
    }

    this.buffer = "";
    return chunks;
  }

  /** Reset to initial state (re-use across requests). */
  reset(): void {
    this.buffer = "";
    this.insideThink = false;
  }

  isInsideThink(): boolean {
    return this.insideThink;
  }
  getBuffer(): string {
    return this.buffer;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private drain(): ContentChunk[] {
    const chunks: ContentChunk[] = [];

    while (this.buffer.length > 0) {
      if (this.insideThink) {
        const closeIdx = this.buffer.indexOf(CLOSE_TAG);

        if (closeIdx === -1) {
          // Only hold back if a partial </think> could be lurking at the tail.
          // Find the last '<' — if it's within CLOSE_TAG.length-1 chars of the
          // end, we must wait. Otherwise emit everything.
          const ltIdx = this.buffer.lastIndexOf("<");
          if (ltIdx !== -1 && ltIdx >= this.buffer.length - (CLOSE_TAG.length - 1)) {
            // Potential partial close tag
            const emit = this.buffer.slice(0, ltIdx);
            this.buffer = this.buffer.slice(ltIdx);
            if (emit) chunks.push({ type: "THINKING", text: emit });
            break; // wait for more data
          } else {
            // No partial tag possible — emit everything
            chunks.push({ type: "THINKING", text: this.buffer });
            this.buffer = "";
          }
        } else {
          const thinking = this.buffer.slice(0, closeIdx);
          this.buffer = this.buffer.slice(closeIdx + CLOSE_TAG.length);
          this.insideThink = false;
          if (thinking) chunks.push({ type: "THINKING", text: thinking });
        }
      } else {
        const openIdx = this.buffer.indexOf(OPEN_TAG);

        if (openIdx === -1) {
          // Only hold back if a partial <think> could be lurking at the tail.
          const ltIdx = this.buffer.lastIndexOf("<");
          if (ltIdx !== -1 && ltIdx >= this.buffer.length - (OPEN_TAG.length - 1)) {
            // Potential partial open tag
            const emit = this.buffer.slice(0, ltIdx);
            this.buffer = this.buffer.slice(ltIdx);
            if (emit) chunks.push({ type: "TEXT", text: emit });
            break; // wait for more data
          } else {
            // No partial tag possible — emit everything
            chunks.push({ type: "TEXT", text: this.buffer });
            this.buffer = "";
          }
        } else {
          const before = this.buffer.slice(0, openIdx);
          this.buffer = this.buffer.slice(openIdx + OPEN_TAG.length);
          this.insideThink = true;
          if (before) chunks.push({ type: "TEXT", text: before });
        }
      }
    }

    return chunks;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * One-shot parse of a complete string.
 * Returns all chunks in order (TEXT → THINKING interleaved).
 */
export function splitThinking(text: string): ContentChunk[] {
  const parser = new ThinkTagParser();
  const chunks = parser.feed(text);
  chunks.push(...parser.flush());
  return chunks;
}

/**
 * Async-iterable adapter: wraps an existing AsyncIterable<string> and emits
 * ContentChunks with type annotations.
 */
export async function* collectChunks(source: AsyncIterable<string>): AsyncIterable<ContentChunk> {
  const parser = new ThinkTagParser();
  for await (const chunk of source) {
    for (const c of parser.feed(chunk)) yield c;
  }
  for (const c of parser.flush()) yield c;
}

/**
 * Extract only the thinking text from a complete string.
 */
export function extractThinking(text: string): string {
  return splitThinking(text)
    .filter((c) => c.type === "THINKING")
    .map((c) => c.text)
    .join("");
}

/**
 * Extract only the non-thinking text from a complete string.
 */
export function extractText(text: string): string {
  return splitThinking(text)
    .filter((c) => c.type === "TEXT")
    .map((c) => c.text)
    .join("");
}
