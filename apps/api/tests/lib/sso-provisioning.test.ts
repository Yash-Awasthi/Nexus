// SPDX-License-Identifier: Apache-2.0
/**
 * Who a federated assertion is allowed to become.
 *
 * Both SSO paths used to create an account for any address the identity
 * provider asserted, which at a provider where anyone can sign up — or one
 * where a user edits their own profile email — means a stranger mints Nexus
 * accounts, and where the address matches an existing user, takes that account
 * over. These pin the refusal.
 */
import { describe, it, expect } from "vitest";

import {
  SsoPolicyError,
  assertMayProvision,
  mayProvision,
} from "../../src/lib/sso-provisioning.js";

const ON = {
  NEXUS_SSO_AUTO_PROVISION: "1",
  NEXUS_SSO_ALLOWED_DOMAINS: "example.com,other.org",
} as NodeJS.ProcessEnv;

describe("mayProvision", () => {
  it("refuses by default, with nothing configured", () => {
    expect(mayProvision("someone@example.com", {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("refuses when the domain list is set but provisioning is off", () => {
    const env = { NEXUS_SSO_ALLOWED_DOMAINS: "example.com" } as NodeJS.ProcessEnv;

    expect(mayProvision("someone@example.com", env)).toBe(false);
  });

  it("refuses when provisioning is on but no domain is allowed", () => {
    const env = { NEXUS_SSO_AUTO_PROVISION: "1" } as NodeJS.ProcessEnv;

    expect(mayProvision("someone@example.com", env)).toBe(false);
  });

  it("allows only an address in an allowed domain", () => {
    expect(mayProvision("someone@example.com", ON)).toBe(true);
    expect(mayProvision("someone@other.org", ON)).toBe(true);
    expect(mayProvision("someone@attacker.example", ON)).toBe(false);
  });

  it("is not fooled by a lookalike address", () => {
    // Merely ending with an allowed domain is a different domain.
    expect(mayProvision("someone@notexample.com", ON)).toBe(false);
    expect(mayProvision("someone@example.com.attacker.example", ON)).toBe(false);
    // An allowed domain in the local part is not the domain.
    expect(mayProvision("example.com@attacker.example", ON)).toBe(false);
    expect(mayProvision("no-at-sign", ON)).toBe(false);
    expect(mayProvision("trailing@", ON)).toBe(false);
  });

  it("matches case-insensitively, as email domains are", () => {
    expect(mayProvision("Someone@EXAMPLE.com", ON)).toBe(true);
  });

  it("treats any value other than 1 as off", () => {
    const env = { ...ON, NEXUS_SSO_AUTO_PROVISION: "true" } as NodeJS.ProcessEnv;

    expect(mayProvision("someone@example.com", env)).toBe(false);
  });

  it("still honours the older OIDC-specific names", () => {
    const env = {
      NEXUS_OIDC_AUTO_PROVISION: "1",
      NEXUS_OIDC_ALLOWED_DOMAINS: "example.com",
    } as NodeJS.ProcessEnv;

    expect(mayProvision("someone@example.com", env)).toBe(true);
  });
});

describe("assertMayProvision", () => {
  it("passes an allowed address through", () => {
    expect(() => assertMayProvision("someone@example.com", ON)).not.toThrow();
  });

  it("refuses with 403 and says what an administrator can do", () => {
    try {
      assertMayProvision("someone@attacker.example", ON);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SsoPolicyError);
      expect((err as SsoPolicyError).statusCode).toBe(403);
      expect((err as SsoPolicyError).code).toBe("no_account");
      expect((err as SsoPolicyError).message).toContain("NEXUS_SSO_ALLOWED_DOMAINS");
    }
  });
});
