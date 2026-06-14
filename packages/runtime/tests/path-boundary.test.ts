// SPDX-License-Identifier: Apache-2.0
import * as os from "os";
import * as path from "path";

import { describe, it, expect } from "vitest";

import { assertPathDescendsFrom, resolvePathInRoot } from "../src/path-boundary.js";

const TMP = os.tmpdir();

describe("assertPathDescendsFrom", () => {
  describe("valid containment", () => {
    it("allows exact match of ancestor and descendant", () => {
      const result = assertPathDescendsFrom(TMP, TMP);
      expect(result).toBe(path.resolve(TMP));
    });

    it("allows direct child", () => {
      const child = path.join(TMP, "child.txt");
      expect(() => assertPathDescendsFrom(TMP, child)).not.toThrow();
    });

    it("allows deeply nested path", () => {
      const nested = path.join(TMP, "a", "b", "c", "file.ts");
      expect(() => assertPathDescendsFrom(TMP, nested)).not.toThrow();
    });

    it("returns resolved descendant path", () => {
      const child = path.join(TMP, "output.json");
      const result = assertPathDescendsFrom(TMP, child);
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe("path traversal rejection", () => {
    it("throws on ../escape sequence", () => {
      const escape = path.join(TMP, "..", "etc", "passwd");
      expect(() => assertPathDescendsFrom(TMP, escape)).toThrow(/boundary violation/i);
    });

    it("throws on sibling directory with shared prefix", () => {
      // e.g. ancestor=/tmp/sandbox, descendant=/tmp/sandbox-escape
      const sandbox = path.join(TMP, "sandbox");
      const escape = path.join(TMP, "sandbox-escape", "secret");
      expect(() => assertPathDescendsFrom(sandbox, escape)).toThrow(/boundary violation/i);
    });

    it("throws on absolute path outside ancestor", () => {
      const ancestor = path.join(TMP, "project");
      expect(() => assertPathDescendsFrom(ancestor, "/etc/shadow")).toThrow(/boundary violation/i);
    });

    it("throws on Windows-style upward traversal (simulated)", () => {
      const ancestor = path.join(TMP, "workdir");
      const traversal = ancestor + path.sep + ".." + path.sep + "other";
      expect(() => assertPathDescendsFrom(ancestor, traversal)).toThrow(/boundary violation/i);
    });
  });

  describe("invalid inputs", () => {
    it("throws on empty ancestor", () => {
      expect(() => assertPathDescendsFrom("", "/some/path")).toThrow(
        /ancestor root cannot be empty/i,
      );
    });

    it("throws on whitespace-only ancestor", () => {
      expect(() => assertPathDescendsFrom("   ", "/some/path")).toThrow(
        /ancestor root cannot be empty/i,
      );
    });

    it("throws on empty descendant", () => {
      expect(() => assertPathDescendsFrom(TMP, "")).toThrow(/descendant path cannot be empty/i);
    });
  });
});

describe("resolvePathInRoot", () => {
  it("resolves single segment inside root", () => {
    const root = TMP;
    const result = resolvePathInRoot(root, "output.txt");
    expect(result).toBe(path.resolve(root, "output.txt"));
  });

  it("resolves multiple segments inside root", () => {
    const root = TMP;
    const result = resolvePathInRoot(root, "a", "b", "c.ts");
    expect(result).toBe(path.resolve(root, "a", "b", "c.ts"));
  });

  it("throws when resolved path escapes root", () => {
    const root = path.join(TMP, "sandbox");
    expect(() => resolvePathInRoot(root, "..", "..", "etc", "passwd")).toThrow(
      /boundary violation/i,
    );
  });
});
