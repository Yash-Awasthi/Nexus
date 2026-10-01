// SPDX-License-Identifier: Apache-2.0
/**
 * NEXUS_TRUST_PROXY as Fastify's `trustProxy`: "true", a hop count, or a comma list of
 * addresses, CIDRs or the names loopback / linklocal / uniquelocal. Unset trusts nothing.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const v = raw?.trim();
  if (!v || v === "false") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
