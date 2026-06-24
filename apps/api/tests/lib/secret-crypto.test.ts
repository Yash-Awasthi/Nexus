// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  getSecretKey,
  isSecretCryptoAvailable,
  SecretCryptoUnavailableError,
} from "../../src/lib/secret-crypto.js";

const KEY = "a".repeat(64); // 32 bytes hex
const ENV_VARS = [
  "NEXUS_SECRETS_KEY",
  "NEXUS_ENCRYPTION_KEY",
  "NEXUS_MFA_KEY",
  "OAUTH_ENCRYPTION_KEY",
];

describe("secret-crypto", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("round-trips a secret with a configured key", () => {
    process.env.NEXUS_SECRETS_KEY = KEY;
    const secret = "sk-test-1234567890";
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    process.env.NEXUS_SECRETS_KEY = KEY;
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("fails closed when no key is configured", () => {
    expect(isSecretCryptoAvailable()).toBe(false);
    expect(getSecretKey()).toBeNull();
    expect(() => encryptSecret("x")).toThrow(SecretCryptoUnavailableError);
    expect(() => decryptSecret("x")).toThrow(SecretCryptoUnavailableError);
  });

  it("rejects a malformed (non-64-hex) key", () => {
    process.env.NEXUS_SECRETS_KEY = "too-short";
    expect(isSecretCryptoAvailable()).toBe(false);
  });

  it("only uses NEXUS_SECRETS_KEY (no implicit fallback chain)", () => {
    // NEXUS_SECRETS_KEY is the only key source
    process.env.NEXUS_SECRETS_KEY = KEY;
    expect(isSecretCryptoAvailable()).toBe(true);
    const enc = encryptSecret("hello");
    expect(decryptSecret(enc)).toBe("hello");
    // OAUTH_ENCRYPTION_KEY alone does NOT enable secret crypto
    delete process.env.NEXUS_SECRETS_KEY;
    process.env.OAUTH_ENCRYPTION_KEY = KEY;
    expect(isSecretCryptoAvailable()).toBe(false);
    expect(() => encryptSecret("hello")).toThrow();
  });

  it("throws on tampered ciphertext (GCM auth tag)", () => {
    process.env.NEXUS_SECRETS_KEY = KEY;
    const enc = encryptSecret("secret");
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });
});
