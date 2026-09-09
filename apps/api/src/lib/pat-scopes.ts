// SPDX-License-Identifier: Apache-2.0
/**
 * PAT scope semantics OWNER (playtest round 7).
 *
 * History: scopes flowed mint → DB → list since round 4 but gated NOTHING —
 * requireAuth treated every valid nxk_ token identically, so the feature
 * advertised a capability that didn't exist. This module defines the minimal
 * coherent semantics and is the ONLY place that knows them:
 *
 *   - A scope names an AREA of the product (chat, memory, council, sandbox,
 *     research, ab, godmode, threads, tokens, auth).
 *   - Sub-scopes are informational: the first dot-separated segment selects
 *     the area ("memory.read" unlocks the same memory endpoints as "memory").
 *   - The default for tokens minted WITHOUT a scopes field is ["*"] (full
 *     access) — the exact behavior before enforcement, so existing tokens
 *     keep working. "*" or an empty list unlocks everything.
 *   - A restricted token may only reach endpoints whose path contains a
 *     segment from one of its areas.
 *   - Scopes from the old UI vocabulary (read:conversations, admin:system,
 *     …) were never enforced and now match no area: such tokens are
 *     rejected at mint (UNKNOWN_SCOPE) and any already-minted ones grant
 *     nothing.
 *
 * Consumers: middleware/auth.ts (enforcement) and routes/tokens.ts (mint
 * validation). The UI offers exactly these areas on the tokens page.
 */

/** Area → path segments that unlock it (must match real registered routes). */
export const PAT_SCOPE_PATHS: Record<string, string[]> = {
  chat: ["/chat"],
  memory: ["/memory"],
  council: ["/council", "/council-checkpoints"],
  sandbox: ["/sandbox"],
  research: ["/research"],
  ab: ["/ab"],
  godmode: ["/godmode"],
  threads: ["/threads"],
  tokens: ["/tokens"],
  auth: ["/auth"],
};

export const PAT_SCOPE_GROUPS = Object.keys(PAT_SCOPE_PATHS);

/** True when the scope's area is known (or it's the full-access wildcard). */
export function isValidPatScope(scope: string): boolean {
  if (scope === "*") return true;
  return Object.hasOwn(PAT_SCOPE_PATHS, scope.split(".")[0]!);
}

/**
 * Enforcement predicate: may a token carrying `scopes` reach `url`?
 * undefined/empty/"*" → everything (back-compat). Otherwise the first
 * dot-segment of each scope selects an area; the path must equal or descend
 * from one of the area's segments. Query strings and case are ignored, and
 * segment boundaries are respected (/council never unlocks
 * /council-checkpoints).
 */
export function patScopesAllow(scopes: string[] | undefined, url: string): boolean {
  if (!scopes || scopes.length === 0 || scopes.includes("*")) return true;
  // Whole-segment matching: routes live under prefixes (/api, /api/v1), so an
  // area segment ("memory") must appear as a complete path segment — never as
  // a prefix of another segment (/chat must not unlock /chatgpt, /council must
  // not unlock /council-checkpoints). Query strings and case are ignored.
  const path = (url.split("?")[0] ?? "").toLowerCase();
  const segments = new Set(path.split("/").filter(Boolean));
  return scopes.some((scope) => {
    const area = PAT_SCOPE_PATHS[scope.split(".")[0]!];
    if (!area) return false;
    return area.some((seg) => segments.has(seg.replace(/^\//, "")));
  });
}
