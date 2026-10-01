// SPDX-License-Identifier: Apache-2.0
/**
 * Single owner of "may this federated identity have a Nexus account".
 *
 * Used by the two enterprise SSO paths — `routes/oidc.ts` and `routes/saml.ts`
 * — because they share one risk: an assertion proves the identity provider
 * *believes* a claim, and nothing more. Creating an account on any address the
 * provider is willing to assert means that at a provider where anyone can sign
 * up, or one where a user edits their own profile email, a stranger mints Nexus
 * accounts; and if the address they assert matches an existing user, they take
 * that account over instead of creating one.
 *
 * So the default is to link only to an account that already exists. Creation
 * needs the operator to turn it on *and* to name the domains the IdP is
 * actually authoritative for — both, never either, since auto-provisioning with
 * no domain list is the same unconditional trust with an extra step.
 *
 * Not used by `routes/oauth.ts` (consumer Google/GitHub sign-in is the public
 * sign-up path, where creating an account is the point) or by `routes/scim.ts`
 * (an administrator provisioning deliberately).
 */

/** Refusal carrying the status the route should answer with. */
export class SsoPolicyError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SsoPolicyError";
  }
}

/** Whether `email` may have an account created for it. */
export function mayProvision(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NEXUS_SSO_AUTO_PROVISION !== "1" && env.NEXUS_OIDC_AUTO_PROVISION !== "1") return false;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return false;
  const allowed = (env.NEXUS_SSO_ALLOWED_DOMAINS ?? env.NEXUS_OIDC_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(domain);
}

/** Throw the standard refusal when `email` has no account and may not get one. */
export function assertMayProvision(email: string, env: NodeJS.ProcessEnv = process.env): void {
  if (mayProvision(email, env)) return;
  throw new SsoPolicyError(
    403,
    "no_account",
    `No Nexus account for ${email}. Ask an administrator to create one, or allow this ` +
      `domain with NEXUS_SSO_AUTO_PROVISION=1 and NEXUS_SSO_ALLOWED_DOMAINS.`,
  );
}
