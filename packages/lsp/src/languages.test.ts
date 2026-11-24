// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LSP_CONFIG } from "./config.ts";
import { commandForLanguage, languageForPath } from "./languages.ts";

describe("languageForPath", () => {
  const table: Array<[string, string]> = [
    ["a.ts", "typescript"],
    ["a.tsx", "typescript"],
    ["a.js", "typescript"],
    ["a.jsx", "typescript"],
    ["a.mjs", "typescript"],
    ["a.cjs", "typescript"],
    ["a.py", "python"],
    ["a.pyi", "python"],
    ["a.go", "go"],
    ["a.rs", "rust"],
    ["A.TS", "typescript"],
    ["src/deep/file.py", "python"],
  ];

  it.each(table)("maps %s to %s", (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it("returns no server for unknown extensions", () => {
    expect(languageForPath("a.md")).toBeUndefined();
    expect(languageForPath("Makefile")).toBeUndefined();
    expect(languageForPath("dir.ts/file")).toBeUndefined();
  });
});

describe("commandForLanguage", () => {
  it("reads the per-language command from config", () => {
    const config = {
      ...DEFAULT_LSP_CONFIG,
      commands: {
        typescript: { command: "ts-ls", args: ["--stdio"] },
        python: { command: "pyright", args: ["--stdio"] },
        go: { command: "gopls", args: [] },
        rust: { command: "rust-analyzer", args: [] },
      },
    };
    expect(commandForLanguage(config, "typescript")).toEqual({
      command: "ts-ls",
      args: ["--stdio"],
    });
    expect(commandForLanguage(config, "go")).toEqual({ command: "gopls", args: [] });
  });
});
