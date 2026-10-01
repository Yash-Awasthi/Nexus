// SPDX-License-Identifier: Apache-2.0

/**
 * Returns true if the URL uses http or https and has no credentials
 * embedded in the authority component.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
