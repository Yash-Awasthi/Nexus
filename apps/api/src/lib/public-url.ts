// SPDX-License-Identifier: Apache-2.0
/**
 * Refusal for server-side fetches of a caller-supplied URL. On a shared server
 * a private or metadata address is an SSRF target; on the desktop app the
 * server is the user's own machine, so local addresses are theirs to reach.
 */

import { isSafeUrl, pinnedFetch } from "@nexus/runtime";

/** An error message when `url` must not be fetched, otherwise null. */
export function unsafeUrlReason(url: unknown): string | null {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    return "URL must start with http:// or https://";
  }
  if (process.env.NEXUS_DESKTOP === "1") return null;
  return isSafeUrl(url.trim()) ? null : "URL points at a private or reserved address";
}

/** Fetch for a URL that already passed {@link unsafeUrlReason}: pinned off the desktop. */
export const callerFetch: typeof fetch = (input, init) =>
  (process.env.NEXUS_DESKTOP === "1" ? fetch : pinnedFetch)(input, init);

const MAX_REDIRECTS = 5;

/**
 * Fetch a caller-supplied URL: every hop must pass {@link unsafeUrlReason}, and off the desktop
 * the socket is pinned to the checked address, so neither DNS nor a redirect can reach inside.
 */
export async function fetchPublic(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const why = unsafeUrlReason(current);
    if (why) throw new Error(why);
    const res = await callerFetch(current, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location) return res;
    current = new URL(location, current).href;
  }
  throw new Error("Too many redirects");
}
