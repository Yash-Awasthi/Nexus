// SPDX-License-Identifier: Apache-2.0
/**
 * Credential sealing against the OS keychain.
 *
 * Electron's `safeStorage` encrypts with a key the operating system holds —
 * Keychain on macOS, DPAPI on Windows, libsecret on Linux — so a sealed blob on
 * disk is useless to anything running as another user.
 *
 * There is no plaintext fallback. When the OS refuses to provide encryption the
 * only safe answer is to fail the write: a session token written unencrypted to
 * a file is worse than a user who has to sign in again.
 */

/** The slice of Electron's `safeStorage` this needs, injected so it can be tested. */
interface OsEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class KeychainUnavailableError extends Error {
  constructor() {
    super(
      "The OS keychain is unavailable, so the session cannot be stored. " +
        "Sign-in is refused rather than writing the token unencrypted.",
    );
    this.name = "KeychainUnavailableError";
  }
}

/** Seals to base64 and opens back, both through the OS key. */
export class OsKeychainVault {
  constructor(private readonly os: OsEncryption) {}

  get available(): boolean {
    return this.os.isEncryptionAvailable();
  }

  seal(plaintext: string): string {
    if (!this.os.isEncryptionAvailable()) throw new KeychainUnavailableError();
    return this.os.encryptString(plaintext).toString("base64");
  }

  open(sealed: string): string {
    if (!this.os.isEncryptionAvailable()) throw new KeychainUnavailableError();
    return this.os.decryptString(Buffer.from(sealed, "base64"));
  }
}
