// SPDX-License-Identifier: Apache-2.0
/**
 * Pairing for the loopback helper.
 *
 * The helper listens on 127.0.0.1, which every page in the browser can reach, so a
 * token cannot be handed out on request: the person running the helper reads a
 * one-time code from its console and types it into the app. Redeeming the code
 * mints a token bound to the calling page's origin, so a token stolen by another
 * origin is useless to it.
 *
 * Codes and tokens live in memory only. Restarting the helper ends every pairing,
 * which is the behaviour a person expects from a process they just started.
 */

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export interface PairingOptions {
  /** Clock, injectable for tests. */
  now?: () => number;
  /** How long a code stays valid. Default 5 minutes. */
  codeTtlMs?: number;
  /** How long a minted token stays valid. Default 12 hours. */
  tokenTtlMs?: number;
  /** Failed redemptions allowed per code before it stops working. Default 5. */
  maxAttempts?: number;
}

export interface Code {
  code: string;
  expiresAt: number;
}

export interface Token {
  token: string;
  expiresAt: number;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Pairing {
  private readonly now: () => number;
  private readonly codeTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly maxAttempts: number;

  private code: string | null = null;
  private codeExpiresAt = 0;
  private failures = 0;
  private readonly tokens = new Map<string, { origin: string; expiresAt: number }>();

  constructor(options: PairingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.codeTtlMs = options.codeTtlMs ?? 5 * 60_000;
    this.tokenTtlMs = options.tokenTtlMs ?? 12 * 60 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  /** Mint a code, replacing any live one. */
  start(): Code {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.codeExpiresAt = this.now() + this.codeTtlMs;
    this.failures = 0;
    return { code: this.code, expiresAt: this.codeExpiresAt };
  }

  /** The live code, minting one when none is valid. */
  current(): Code {
    if (this.code !== null && this.now() < this.codeExpiresAt) {
      return { code: this.code, expiresAt: this.codeExpiresAt };
    }
    return this.start();
  }

  /** Exchange a code for a token bound to `origin`. A code works once. */
  redeem(code: string, origin: string): Token | null {
    this.prune();
    if (this.code === null || this.now() >= this.codeExpiresAt) return null;
    if (this.failures >= this.maxAttempts) return null;
    if (!sameSecret(code, this.code)) {
      this.failures += 1;
      return null;
    }
    this.code = null;
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.now() + this.tokenTtlMs;
    this.tokens.set(token, { origin, expiresAt });
    return { token, expiresAt };
  }

  /** Whether `token` is live and was minted for `origin`. */
  verify(token: string, origin: string): boolean {
    this.prune();
    const found = this.tokens.get(token);
    return found !== undefined && found.origin === origin;
  }

  /** Number of live tokens, for /health. */
  paired(): number {
    this.prune();
    return this.tokens.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (now >= entry.expiresAt) this.tokens.delete(token);
    }
  }
}
