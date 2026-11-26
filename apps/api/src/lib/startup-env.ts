// SPDX-License-Identifier: Apache-2.0
/**
 * Startup secret checks, collected rather than exiting on the first one.
 *
 * A deploy that is missing three variables should say so once, not reveal them
 * one restart at a time. Development keeps the permissive defaults; production
 * refuses placeholder or short secrets.
 */
export interface SecretProblems {
  errors: string[];
  warnings: string[];
}

const INSECURE_DEFAULTS = new Set([
  "changeme",
  "change-me",
  "secret",
  "test",
  "dev",
  "development",
  "password",
  "nexus",
  "nexus-api-key",
  "your-api-key",
]);

function unsafe(value: string): boolean {
  return INSECURE_DEFAULTS.has(value.toLowerCase()) || value.length < 16;
}

export function collectSecretProblems(env: NodeJS.ProcessEnv): SecretProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const apiKey = env.NEXUS_API_KEY?.trim();
  if (!apiKey) errors.push("NEXUS_API_KEY is not set");

  if (env.NODE_ENV === "production") {
    if (apiKey && unsafe(apiKey)) {
      errors.push("NEXUS_API_KEY is a placeholder or shorter than 16 characters");
    }
    for (const name of ["NEXUS_JWT_SECRET", "NEXUS_AUDIT_KEY"] as const) {
      const value = env[name]?.trim();
      if (!value) errors.push(`${name} is not set (sign-in and the audit chain need it)`);
      else if (unsafe(value)) errors.push(`${name} is a placeholder or shorter than 16 characters`);
    }
    if (!env.NEXUS_SECRETS_KEY?.trim()) {
      warnings.push("NEXUS_SECRETS_KEY is not set — saved provider keys will not persist");
    }
  }
  return { errors, warnings };
}
