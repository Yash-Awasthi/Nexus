// SPDX-License-Identifier: Apache-2.0
/**
 * `secret-crypto` is the module every stored credential goes through, and until this file existed its only
 * exercise was indirect, from an API test that rotated a key. The root coverage run showed it at 4% and dragged
 * the `packages/db` floor down, which is the useful thing a coverage floor does: it notices that a module was
 * added without a test that names it.
 *
 * Each test here is about a way to lose data rather than a way to pass:
 *   - fail closed when no key is configured, instead of writing plaintext;
 *   - read a row written before the `v1:` prefix existed;
 *   - read a row with the previous key during a rotation, and say which key answered;
 *   - refuse a tampered ciphertext instead of decrypting garbage;
 *   - treat the old bare-base64 form and the envelope as the same value.
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  SECRET_ENVELOPE,
  SecretCryptoUnavailableError,
  decryptSecret,
  decryptSecretAnyKey,
  decryptWithKey,
  encryptSecret,
  encryptWithKey,
  getPreviousSecretKey,
  getSecretKey,
  isCurrentEnvelope,
  isSecretCryptoAvailable,
  unwrap,
} from "../src/secret-crypto.ts";

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");

const saved = {
  key: process.env.NEXUS_SECRETS_KEY,
  previous: process.env.NEXUS_SECRETS_KEY_PREVIOUS,
};

function setKeys(key?: string, previous?: string) {
  if (key === undefined) delete process.env.NEXUS_SECRETS_KEY;
  else process.env.NEXUS_SECRETS_KEY = key;
  if (previous === undefined) delete process.env.NEXUS_SECRETS_KEY_PREVIOUS;
  else process.env.NEXUS_SECRETS_KEY_PREVIOUS = previous;
}

beforeEach(() => setKeys(KEY_A, undefined));
afterEach(() => {
  if (saved.key === undefined) delete process.env.NEXUS_SECRETS_KEY;
  else process.env.NEXUS_SECRETS_KEY = saved.key;
  if (saved.previous === undefined) delete process.env.NEXUS_SECRETS_KEY_PREVIOUS;
  else process.env.NEXUS_SECRETS_KEY_PREVIOUS = saved.previous;
});

describe("key material", () => {
  it("accepts only a 64-character hex key, and says so instead of guessing", () => {
    setKeys(KEY_A);
    expect(getSecretKey()).toHaveLength(32);
    expect(isSecretCryptoAvailable()).toBe(true);

    for (const bad of ["", "not-hex", KEY_A.slice(1), KEY_A + "aa", "z".repeat(64)]) {
      setKeys(bad);
      expect(getSecretKey(), JSON.stringify(bad)).toBeNull();
      expect(isSecretCryptoAvailable()).toBe(false);
    }
  });

  it("reads the previous key from its own variable and never from the current one", () => {
    setKeys(KEY_A, KEY_B);
    expect(getPreviousSecretKey()?.toString("hex")).toBe(KEY_B);
    setKeys(KEY_A, KEY_A);
    expect(getPreviousSecretKey()?.toString("hex")).toBe(KEY_A);
    setKeys(KEY_A, undefined);
    expect(getPreviousSecretKey()).toBeNull();
  });
});

describe("fail closed", () => {
  it("throws SecretCryptoUnavailableError rather than writing plaintext when there is no key", () => {
    setKeys(undefined);
    expect(() => encryptSecret("sk-live-123")).toThrow(SecretCryptoUnavailableError);
    // The error is catchable by code and named for a log line, and it never contains the plaintext.
    try {
      encryptSecret("sk-live-123");
    } catch (err) {
      expect((err as SecretCryptoUnavailableError).code).toBe("encryption_unavailable");
      expect((err as Error).message).not.toContain("sk-live-123");
    }
  });

  it("refuses to decrypt when the key has been removed", () => {
    const stored = encryptSecret("value");
    setKeys(undefined);
    expect(() => decryptSecret(stored)).toThrow(SecretCryptoUnavailableError);
    expect(() => decryptSecretAnyKey(stored)).toThrow(SecretCryptoUnavailableError);
  });
});

describe("round trip and envelope", () => {
  it("encrypts to a v1 envelope and reads it back", () => {
    const stored = encryptSecret("sk-live-abc\nsecond line ünïcode");
    expect(stored.startsWith(SECRET_ENVELOPE)).toBe(true);
    expect(isCurrentEnvelope(stored)).toBe(true);
    expect(stored).not.toContain("sk-live-abc");
    expect(decryptSecret(stored)).toBe("sk-live-abc\nsecond line ünïcode");
  });

  it("uses a fresh IV per call, so the same plaintext has two different ciphertexts", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("reads a row written before the prefix existed", () => {
    const legacy = encryptWithKey(getSecretKey()!, "written by an older release");
    expect(isCurrentEnvelope(legacy)).toBe(false);
    expect(unwrap(legacy)).toBe(legacy);
    expect(decryptSecret(legacy)).toBe("written by an older release");
  });

  it("decrypts a bare-base64 value from a stored key directly", () => {
    const key = getSecretKey()!;
    expect(decryptWithKey(key, encryptWithKey(key, "low level"))).toBe("low level");
  });
});

describe("tampering", () => {
  it("refuses a modified ciphertext instead of returning garbage", () => {
    const stored = unwrap(encryptSecret("amount=100"));
    const bytes = Buffer.from(stored, "base64");
    bytes[bytes.length - 1] ^= 0xff;
    expect(() => decryptSecret(bytes.toString("base64"))).toThrow();
  });

  it("refuses a truncated value rather than reading a short buffer", () => {
    const stored = unwrap(encryptSecret("short"));
    expect(() => decryptSecret(stored.slice(0, 12))).toThrow();
    expect(() => decryptSecret("")).toThrow();
  });

  it("refuses a value encrypted with a different key", () => {
    const other = encryptWithKey(Buffer.from(KEY_B, "hex"), "belongs to key B");
    expect(() => decryptSecret(other)).toThrow();
  });
});

describe("rotation", () => {
  it("reads with the current key first and reports which key answered", () => {
    setKeys(KEY_B, KEY_A);
    const writtenByA = encryptWithKey(Buffer.from(KEY_A, "hex"), "written before the rotation");
    expect(decryptSecretAnyKey(writtenByA)).toEqual({
      plaintext: "written before the rotation",
      key: "previous",
    });

    const writtenByB = encryptSecret("written after the rotation");
    expect(decryptSecretAnyKey(writtenByB)).toEqual({
      plaintext: "written after the rotation",
      key: "current",
    });
  });

  it("says which rows still need re-writing, and only those", () => {
    setKeys(KEY_B, KEY_A);
    const rotated = encryptSecret("new");
    const pending = encryptWithKey(Buffer.from(KEY_A, "hex"), "old");
    // The rule the rotation script uses: no envelope on disk means version 1 on disk.
    expect(isCurrentEnvelope(rotated)).toBe(true);
    expect(isCurrentEnvelope(pending)).toBe(false);
  });

  it("names the failure when neither key fits, instead of returning undefined", () => {
    setKeys(KEY_B, KEY_A);
    const stranger = encryptWithKey(Buffer.from(randomBytes(32)), "neither key");
    expect(() => decryptSecretAnyKey(stranger)).toThrow(/current or the previous key/);
  });
});
