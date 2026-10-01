// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
/**
 * The drive browser addresses files by a path relative to the drive root, with
 * no leading slash — the shape /drive/ls and /drive/read accept. A stray slash
 * reaches the API as an absolute path and is refused as escaping the drive.
 */
import { describe, it, expect } from "vitest";

import { formatBytes, joinPath, parentPath } from "./drive";

describe("joinPath", () => {
  it("leaves no leading slash at the drive root", () => {
    expect(joinPath("", "notes.txt")).toBe("notes.txt");
  });

  it("nests below the current directory", () => {
    expect(joinPath("src/lib", "api.ts")).toBe("src/lib/api.ts");
  });
});

describe("parentPath", () => {
  it("climbs one level", () => {
    expect(parentPath("src/lib")).toBe("src");
  });

  it("stops at the root rather than climbing past it", () => {
    expect(parentPath("src")).toBe("");
    expect(parentPath("")).toBe("");
  });
});

describe("formatBytes", () => {
  it("scales through the units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MB");
  });
});
