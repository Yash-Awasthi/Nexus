// SPDX-License-Identifier: Apache-2.0
/**
 * NEXUS_TRUST_PROXY as Fastify's `trustProxy`: "true" or a comma list of addresses, CIDRs
 * or the names loopback / linklocal / uniquelocal. Unset trusts nothing.
 */
export function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const v = raw?.trim();
  if (!v || v === "false") return false;
  if (v === "true") return true;
  // Fastify 5.12 treats a hop count as "trust nothing": it cannot tell a proxy from a client.
  if (/^\d+$/.test(v))
    throw new Error(
      `NEXUS_TRUST_PROXY=${v}: hop counts are not supported; name the proxy addresses instead (e.g. uniquelocal)`,
    );
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
