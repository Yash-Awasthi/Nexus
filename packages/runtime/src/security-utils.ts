// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import * as path from "path";
import { URL } from "url";

/**
 * SSRF / outbound-URL safety.
 *
 * `isSafeUrl` rejects any URL that targets the local host, a private/reserved IP
 * range, or a cloud metadata service — including the encodings attackers use to
 * smuggle those addresses past naïve string checks (decimal/hex/octal IPv4,
 * IPv6 ULA/link-local, IPv4-mapped IPv6).
 *
 * Limitation (ponytail): this is a *static* check on the URL's host. A hostname
 * that resolves to a private IP at request time (DNS rebinding) is not caught
 * here — defeating that needs resolve-then-pin-the-socket at fetch time. The
 * upgrade path is a custom `lookup`/agent that re-validates the resolved IP.
 */

// Known non-IP hostnames that must never be reachable.
const FORBIDDEN_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

/** Parse an IPv4 literal in any inet_aton encoding to its four octets, or null. */
function parseIPv4ToOctets(host: string): [number, number, number, number] | null {
  const parsePart = (p: string): number | null => {
    if (p === "") return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8); // leading-zero octal
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    return Number.isFinite(n) ? n : null;
  };

  const parts = host.split(".");
  const nums = parts.map(parsePart);
  if (nums.some((n) => n === null)) return null;
  const vals = nums as number[];

  // inet_aton: 1–4 parts. The final part fills the remaining low-order bytes.
  let packed: number;
  switch (vals.length) {
    case 1:
      if (vals[0]! > 0xffffffff) return null;
      packed = vals[0]!;
      break;
    case 2: // a.b → a.(24-bit b)
      if (vals[0]! > 0xff || vals[1]! > 0xffffff) return null;
      packed = (vals[0]! << 24) | vals[1]!;
      break;
    case 3: // a.b.c → a.b.(16-bit c)
      if (vals[0]! > 0xff || vals[1]! > 0xff || vals[2]! > 0xffff) return null;
      packed = (vals[0]! << 24) | (vals[1]! << 16) | vals[2]!;
      break;
    case 4:
      if (vals.some((v) => v > 0xff)) return null;
      packed = (vals[0]! << 24) | (vals[1]! << 16) | (vals[2]! << 8) | vals[3]!;
      break;
    default:
      return null;
  }
  packed >>>= 0; // force unsigned
  return [(packed >>> 24) & 0xff, (packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff];
}

/** True if the octets fall in a private, loopback, link-local or reserved range. */
function isPrivateIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/** True if an IPv6 literal (brackets stripped) is loopback/unspecified/ULA/link-local/mapped. */
function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  // Unique-local fc00::/7 (fc.. / fd..) and link-local fe80::/10 (fe8.–feb.).
  if (/^f[cd]/.test(h)) return true;
  if (/^fe[89ab]/.test(h)) return true;
  // IPv4-mapped (::ffff:a.b.c.d). Node normalises the dotted tail to two hex
  // hextets (::ffff:a00:1), so accept both the dotted and the hex-group forms.
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1]!;
    let octets: [number, number, number, number] | null = null;
    if (tail.includes(".")) {
      octets = parseIPv4ToOctets(tail);
    } else {
      const groups = tail.split(":");
      if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
        const hi = parseInt(groups[0]!, 16);
        const lo = parseInt(groups[1]!, 16);
        octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
      }
    }
    if (octets && isPrivateIPv4(octets)) return true;
  }
  return false;
}

/**
 * Checks if a URL is safe to fetch — http(s) only, and not pointing at the local
 * host, a private/reserved network, or a metadata service.
 */
export function isSafeUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return false;

  // URL keeps IPv6 hosts bracketed; strip for inspection.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") return false;
  if (FORBIDDEN_HOSTS.has(host)) return false;

  const ipVersion = isIP(host);
  if (ipVersion === 6) return !isPrivateIPv6(host);

  // IPv4 in any encoding (dotted, decimal, hex, octal). isIP only matches the
  // canonical dotted form, so parse explicitly to catch the smuggled encodings.
  const octets = parseIPv4ToOctets(host);
  if (octets) return !isPrivateIPv4(octets);

  // A real hostname — allow (DNS-rebinding caveat documented above).
  return true;
}

/** Throwing variant of {@link isSafeUrl} for call sites that should hard-fail. */
export function assertSafeUrl(urlStr: string): void {
  if (!isSafeUrl(urlStr)) {
    throw new Error(`Unsafe URL blocked (SSRF guard): ${urlStr}`);
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
