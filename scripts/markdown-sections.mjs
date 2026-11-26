// SPDX-License-Identifier: Apache-2.0
/**
 * Read a runbook section as data, and pull the names a reader is told to set.
 *
 * Shared by the drill guards (`rotation-drill.test.mjs`, `backup-drill.test.mjs`) so
 * that "the drill has no section" is one implementation rather than one per drill —
 * and so a section whose heading is renamed reads as nothing, loudly, instead of every
 * assertion silently passing against an empty string.
 */

/** The text under a heading, up to the next `##` or `###`, or null when absent. */
export function section(text, heading = /^## 11\. /) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Names written in `code` spans that look like env vars, with or without a value. */
export function envNames(markdown) {
  const found = new Set();
  for (const [, name] of markdown.matchAll(/`([A-Z][A-Z0-9_]{3,})(?:=[^`]*)?`/g)) found.add(name);
  return [...found].sort();
}
