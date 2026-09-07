// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/secret-guardrail — Secret detection and input sanitization.
 *
 * Inspired by Bernstein's guardrail pipeline.
 * Detects API keys, tokens, and other secrets in prompts and tool outputs
 * to prevent accidental leakage.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SecretMatch {
  pattern: string;
  line: number;
  column: number;
  match: string;
  secretType: string;
  severity: "critical" | "high" | "medium";
}

export interface GuardrailResult {
  passed: boolean;
  secrets: SecretMatch[];
  redactedInput: string;
  totalSecrets: number;
}

// ── Default Patterns ─────────────────────────────────────────────────────────

const DEFAULT_PATTERNS: Array<{ pattern: RegExp; type: string; severity: SecretMatch["severity"] }> = [
  // AWS
  { pattern: /AWS_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9/+=]{16,}/g, type: "aws-secret-key", severity: "critical" },
  { pattern: /AKIA[0-9A-Z]{16}/g, type: "aws-access-key", severity: "critical" },
  // GitHub
  { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: "github-token", severity: "critical" },
  { pattern: /github_pat_[a-zA-Z0-9_]{20,}/g, type: "github-pat", severity: "critical" },
  // OpenAI
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, type: "openai-key", severity: "critical" },
  // Anthropic
  { pattern: /sk-ant-[a-zA-Z0-9-]{20,}/g, type: "anthropic-key", severity: "critical" },
  // Google
  { pattern: /AIza[A-Za-z0-9_-]{35}/g, type: "google-api-key", severity: "critical" },
  // Slack
  { pattern: /xox[baprs]-[a-zA-Z0-9-]{10,}/g, type: "slack-token", severity: "high" },
  // Stripe
  { pattern: /sk_live_[a-zA-Z0-9]{20,}/g, type: "stripe-live-key", severity: "critical" },
  { pattern: /rk_live_[a-zA-Z0-9]{20,}/g, type: "stripe-restricted-key", severity: "high" },
  // Generic patterns
  { pattern: /GITHUB_TOKEN\s*=\s*\S{20,}/g, type: "github-token-env", severity: "high" },
  { pattern: /API_KEY\s*=\s*[A-Za-z0-9_-]{20,}/g, type: "generic-api-key", severity: "medium" },
  { pattern: /SECRET\s*=\s*[A-Za-z0-9_-]{20,}/g, type: "generic-secret", severity: "medium" },
  { pattern: /PRIVATE_KEY\s*=\s*[A-Za-z0-9/+=]{20,}/g, type: "private-key", severity: "high" },
  // JWT
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, type: "jwt-token", severity: "high" },
  // Database connection strings
  { pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@/g, type: "mongodb-connection", severity: "critical" },
  { pattern: /postgres(ql)?:\/\/[^:]+:[^@]+@/g, type: "postgresql-connection", severity: "critical" },
  { pattern: /mysql:\/\/[^:]+:[^@]+@/g, type: "mysql-connection", severity: "critical" },
  { pattern: /redis:\/\/[^:]*:[^@]+@/g, type: "redis-connection", severity: "high" },
];

// ── Guardrail ────────────────────────────────────────────────────────────────

export class SecretGuardrail {
  private patterns: Array<{ pattern: RegExp; type: string; severity: SecretMatch["severity"] }>;

  constructor(options?: {
    customPatterns?: Array<{ pattern: RegExp; type: string; severity: SecretMatch["severity"] }>;
    excludePatterns?: string[];
  }) {
    this.patterns = DEFAULT_PATTERNS.filter(
      (p) => !options?.excludePatterns?.includes(p.type),
    );

    if (options?.customPatterns) {
      this.patterns.push(...options.customPatterns);
    }
  }

  /**
   * Scan text for secrets.
   */
  scan(text: string): GuardrailResult {
    const secrets: SecretMatch[] = [];
    const lines = text.split("\n");

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]!;
      for (const { pattern, type, severity } of this.patterns) {
        // Reset regex state
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          secrets.push({
            pattern: pattern.source,
            line: lineIdx + 1,
            column: match.index + 1,
            match: match[0]!.slice(0, 20) + "...",
            secretType: type,
            severity,
          });
        }
      }
    }

    return {
      passed: secrets.filter((s) => s.severity === "critical").length === 0,
      secrets,
      redactedInput: this.redact(text, secrets),
      totalSecrets: secrets.length,
    };
  }

  /**
   * Redact secrets from text.
   */
  private redact(text: string, secrets: SecretMatch[]): string {
    let result = text;
    // Sort by position (reverse) to maintain indices
    const sorted = [...secrets].sort((a, b) => b.line - a.line || b.column - a.column);

    for (const secret of sorted) {
      const lines = result.split("\n");
      const line = lines[secret.line - 1];
      if (line) {
        const before = line.slice(0, secret.column - 1);
        const after = line.slice(secret.column - 1 + secret.match.length);
        lines[secret.line - 1] = `${before}[REDACTED:${secret.secretType}]${after}`;
        result = lines.join("\n");
      }
    }

    return result;
  }

  /**
   * Check if text passes the guardrail (no critical secrets).
   */
  check(text: string): boolean {
    const result = this.scan(text);
    return result.passed;
  }

  /**
   * Get available pattern types.
   */
  getPatternTypes(): string[] {
    return [...new Set(this.patterns.map((p) => p.type))];
  }
}

export default SecretGuardrail;

// ── Fernet-style encryption for API keys ────────────────────────────────────

/**
 * EncryptionManager — Fernet-style symmetric encryption for API keys.
 * Inspired by SmarterRouter's encryption.py.
 * Uses AES-128-CBC with HMAC-SHA256 for authenticated encryption.
 * In production, wire this to the Web Crypto API or a crypto library.
 */

export interface EncryptionConfig {
  /** Master key for deriving encryption keys. */
  masterKey: string;
  /** Algorithm. Default: AES-GCM. */
  algorithm?: string;
}

export class EncryptionManager {
  private readonly prefix = "enc:";
  private keyDerived = false;
  private derivedKey: CryptoKey | null = null;
  private readonly algorithm: string;

  constructor(private readonly config: EncryptionConfig) {
    this.algorithm = config.algorithm ?? "AES-GCM";
  }

  /** Derive an AES-GCM key from the master key using PBKDF2. */
  private async deriveKey(): Promise<CryptoKey> {
    if (this.derivedKey) return this.derivedKey;

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.config.masterKey),
      "PBKDF2",
      false,
      ["deriveKey"],
    );

    this.derivedKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: encoder.encode("nexus-secret-guardrail-salt"),
        iterations: 100_000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: this.algorithm, length: 256 },
      false,
      ["encrypt", "decrypt"],
    );

    this.keyDerived = true;
    return this.derivedKey;
  }

  /** Encrypt a plaintext string. Returns "enc:<base64>". */
  async encrypt(plaintext: string): Promise<string> {
    const key = await this.deriveKey();
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await crypto.subtle.encrypt(
      { name: this.algorithm, iv },
      key,
      encoder.encode(plaintext),
    );

    // Pack IV + ciphertext together
    const combined = new Uint8Array(iv.length + new Uint8Array(encrypted).length);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);

    return this.prefix + btoa(String.fromCharCode(...combined));
  }

  /** Decrypt an "enc:<base64>" string. */
  async decrypt(ciphertext: string): Promise<string> {
    const key = await this.deriveKey();
    const decoder = new TextDecoder();

    const raw = ciphertext.startsWith(this.prefix)
      ? ciphertext.slice(this.prefix.length)
      : ciphertext;

    const combined = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: this.algorithm, iv },
      key,
      data,
    );

    return decoder.decode(decrypted);
  }

  /** Check if a value is encrypted (has the prefix). */
  isEncrypted(value: string): boolean {
    return value.startsWith(this.prefix);
  }
}

export default EncryptionManager;
