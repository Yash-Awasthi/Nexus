// SPDX-License-Identifier: Apache-2.0
/**
 * Extension-to-language mapping and per-language command lookup. An unknown
 * extension has no server; this never guesses from file contents.
 */

import type { LspCommand, LspConfig } from "./config.ts";

export type LspLanguage = "typescript" | "python" | "go" | "rust";

export const LANGUAGE_EXTENSIONS: Readonly<Record<string, LspLanguage>> = Object.freeze({
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
});

/** Language for a path's extension, or `undefined` when no server handles it. */
export function languageForPath(filePath: string): LspLanguage | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (dot < slash) return undefined;
  return LANGUAGE_EXTENSIONS[filePath.slice(dot).toLowerCase()];
}

export function commandForLanguage(config: LspConfig, language: LspLanguage): LspCommand {
  return config.commands[language];
}
