// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { smartRead, readLines, estimateChunks } from "../src/index.js";

const SAMPLE = `
Introduction to Nexus
The Nexus platform is a multi-agent AI system.
It provides routing, memory, and retrieval capabilities.

Authentication
Users must authenticate via JWT tokens.
Token expiry is set to 24 hours by default.
Refresh tokens are stored in an HTTPOnly cookie.

Database Layer
Nexus uses PostgreSQL for persistent storage.
Indexes are maintained on frequently queried columns.
Migrations are handled via Drizzle ORM.

Security
All endpoints require authentication.
Rate limiting is applied per API key.
Secrets are stored in environment variables.
`.trim();

describe("smartRead", () => {
  it("returns chunks with scores", () => {
    const r = smartRead(SAMPLE, "authentication token");
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks[0]!.score).toBeGreaterThan(0);
  });

  it("top chunk contains query-relevant content for auth query", () => {
    const r = smartRead(SAMPLE, "authentication JWT token", { topK: 1 });
    expect(r.chunks[0]!.content.toLowerCase()).toContain("authent");
  });

  it("returns durationMs", () => {
    const r = smartRead(SAMPLE, "database");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("respects topK", () => {
    const r = smartRead(SAMPLE, "security", { topK: 2 });
    expect(r.chunks.length).toBeLessThanOrEqual(2);
  });

  it("scoreThreshold filters low-relevance chunks", () => {
    const r = smartRead(SAMPLE, "authentication", { scoreThreshold: 0.5 });
    for (const c of r.chunks) {
      expect(c.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("returns totalChunks and totalLines", () => {
    const r = smartRead(SAMPLE, "nexus");
    expect(r.totalChunks).toBeGreaterThan(0);
    expect(r.totalLines).toBeGreaterThan(0);
  });

  it("chunks are returned in document order", () => {
    const r = smartRead(SAMPLE, "nexus", { topK: 10 });
    for (let i = 1; i < r.chunks.length; i++) {
      expect(r.chunks[i]!.start).toBeGreaterThanOrEqual(r.chunks[i - 1]!.start);
    }
  });

  it("empty query returns chunks with score 0", () => {
    const r = smartRead(SAMPLE, "");
    for (const c of r.chunks) {
      expect(c.score).toBe(0);
    }
  });

  it("empty content returns no chunks", () => {
    const r = smartRead("", "query");
    expect(r.chunks).toHaveLength(0);
    expect(r.totalChunks).toBe(0);
  });

  it("single chunk for short content", () => {
    const r = smartRead("short doc", "short");
    expect(r.totalChunks).toBe(1);
  });

  it("each chunk has lineStart and lineEnd", () => {
    const r = smartRead(SAMPLE, "nexus", { topK: 5 });
    for (const c of r.chunks) {
      expect(c.lineStart).toBeGreaterThan(0);
      expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart);
    }
  });
});

describe("readLines", () => {
  const content = "line1\nline2\nline3\nline4\nline5";

  it("reads a line range", () => {
    expect(readLines(content, 2, 4)).toBe("line2\nline3\nline4");
  });

  it("clamps to content boundaries", () => {
    expect(readLines(content, 1, 100)).toBe(content);
  });

  it("single line", () => {
    expect(readLines(content, 3, 3)).toBe("line3");
  });
});

describe("estimateChunks", () => {
  it("single chunk for content <= chunkSize", () => {
    expect(estimateChunks(1000, 1500, 200)).toBe(1);
  });

  it("zero for empty content", () => {
    expect(estimateChunks(0)).toBe(0);
  });

  it("multiple chunks for large content", () => {
    expect(estimateChunks(10000, 1500, 200)).toBeGreaterThan(1);
  });
});
