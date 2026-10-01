// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";

/**
 * Throws if `childPath` resolves to a location outside `rootPath`.
 * Prevents path-traversal attacks.
 */
export function assertPathDescendsFrom(rootPath: string, childPath: string): void {
  const resolvedRoot = resolve(rootPath);
  const resolvedChild = resolve(childPath);
  if (!resolvedChild.startsWith(resolvedRoot + "/") && resolvedChild !== resolvedRoot) {
    throw new Error(`Path traversal denied: '${childPath}' is outside '${rootPath}'`);
  }
}
