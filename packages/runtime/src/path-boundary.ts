// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as path from "path";

/**
 * Ensures {@link descendant} resolves to a path inside {@link ancestor} (inclusive).
 * Uses {@link path.relative} so containment works on Windows and POSIX.
 * When paths exist, compares real paths to reduce symlink/junction escape.
 */
export function assertPathDescendsFrom(ancestorRaw: string, descendantRaw: string): string {
  if (!ancestorRaw?.trim()) {
    throw new Error("Path boundary: ancestor root cannot be empty");
  }
  if (!descendantRaw?.trim()) {
    throw new Error("Path boundary: descendant path cannot be empty");
  }

  let ancestor = path.resolve(ancestorRaw);
  let descendant = path.resolve(descendantRaw);

  try {
    if (fs.existsSync(ancestor)) {
      ancestor = fs.realpathSync.native(ancestor);
    }
    if (fs.existsSync(descendant)) {
      descendant = fs.realpathSync.native(descendant);
    }
  } catch {
    // If resolution fails, fall back to normalized resolved strings
  }

  const rel = path.relative(ancestor, descendant);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path boundary violation: "${descendantRaw}" is not contained within root "${ancestorRaw}" (resolved: ${descendant} vs ${ancestor})`,
    );
  }
  return descendant;
}

/** Resolve a path segment under {@link root} and enforce containment. */
export function resolvePathInRoot(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments);
  return assertPathDescendsFrom(root, target);
}
