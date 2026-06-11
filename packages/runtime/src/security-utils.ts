// SPDX-License-Identifier: Apache-2.0
import * as path from "path";
import { URL } from "url";

/**
 * Checks if a URL is safe to load, preventing path traversal, loopback access,
 * and cloud metadata service (IMDS) SSRF attacks.
 */
export function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const protocol = parsed.protocol.toLowerCase();

    // 1. Strict Protocol Allowlist
    if (protocol !== "http:" && protocol !== "https:") {
      return false;
    }

    const host = parsed.hostname.toLowerCase();

    // 2. Block Localhost, Loopbacks, Metadata services, and DNS Rebinding targets
    const forbiddenHosts = new Set([
      "localhost",
      "127.0.0.1",
      "[::1]",
      "169.254.169.254",
      "metadata.google.internal",
      "metadata",
      "instance-data",
    ]);

    if (forbiddenHosts.has(host)) {
      return false;
    }

    // Block subnet ranges, internal mappings
    if (
      host.includes("169.254.169.254") ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.")
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Prevents string prefix subdirectory bypasses in sandbox path traversal checks.
 */
export function isSafeSandboxPath(parentDir: string, targetFile: string): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedTarget = path.resolve(targetFile);

  // Exact match or matches with path separator
  return resolvedTarget === resolvedParent || resolvedTarget.startsWith(resolvedParent + path.sep);
}
