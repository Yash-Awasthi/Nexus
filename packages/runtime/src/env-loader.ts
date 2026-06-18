// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal .env file loader — no external dependencies.
 *
 * Reads KEY=VALUE pairs from a `.env` file and populates `process.env` with any
 * keys that are not already set. Existing environment variables always win.
 *
 * Supported syntax:
 *   KEY=value                     basic assignment
 *   KEY="value with spaces"       double-quoted value
 *   KEY='value with spaces'       single-quoted value
 *   KEY=value  # inline comment   trailing hash comment stripped
 *   # comment                     full-line comment (skipped)
 *   KEY=                          empty value (allowed)
 *   export KEY=value              optional `export` prefix
 */

import * as fs from "fs";
import * as path from "path";

interface EnvLoaderResult {
  /** Path that was read (or null if not found). */
  filePath: string | null;
  /** Keys successfully loaded into process.env. */
  loaded: string[];
  /** Keys skipped because they were already in process.env. */
  skipped: string[];
}

/**
 * Parse a single line of a `.env` file.
 * Returns `{ key, value }` or `null` if the line should be ignored.
 */
function parseLine(line: string): { key: string; value: string } | null {
  // Strip leading/trailing whitespace
  const trimmed = line.trim();

  // Skip blank lines and full-line comments
  if (!trimmed || trimmed.startsWith("#")) return null;

  // Strip optional `export ` prefix
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;

  // Must contain `=` to be a valid assignment
  const eqIdx = withoutExport.indexOf("=");
  if (eqIdx === -1) return null;

  const key = withoutExport.slice(0, eqIdx).trim();
  if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let raw = withoutExport.slice(eqIdx + 1);

  // Handle quoted values (double or single quotes)
  if (
    (raw.startsWith('"') && raw.includes('"', 1)) ||
    (raw.startsWith("'") && raw.includes("'", 1))
  ) {
    const quote = raw[0] ?? '"';
    const closeIdx = raw.indexOf(quote, 1);
    raw = raw.slice(1, closeIdx);
  } else {
    // Strip inline comment (# preceded by whitespace)
    const commentMatch = /\s+#.*/.exec(raw);
    if (commentMatch) {
      raw = raw.slice(0, commentMatch.index).trim();
    } else {
      raw = raw.trim();
    }
  }

  return { key, value: raw };
}

/**
 * Load a `.env` file from `envFilePath`, populating `process.env` with any
 * variables not already defined.
 *
 * @param envFilePath  Absolute path to the `.env` file. Defaults to `<cwd>/.env`.
 * @param override     When true, existing env vars are overwritten (default: false).
 */
export function loadEnvFile(envFilePath?: string, override = false): EnvLoaderResult {
  const resolvedPath = envFilePath ?? path.resolve(process.cwd(), ".env");

  const result: EnvLoaderResult = {
    filePath: null,
    loaded: [],
    skipped: [],
  };

  if (!fs.existsSync(resolvedPath)) {
    return result;
  }

  result.filePath = resolvedPath;

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    // Unreadable — silently skip
    return result;
  }

  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    const { key, value } = parsed;
    if (!override && process.env[key] !== undefined) {
      result.skipped.push(key);
    } else {
      process.env[key] = value;
      result.loaded.push(key);
    }
  }

  return result;
}

/**
 * Convenience wrapper: load `.env` from `repoRoot/.env` and optionally log the result.
 */
export function loadEnvFromRoot(repoRoot: string, verbose = false): EnvLoaderResult {
  const envPath = path.join(repoRoot, ".env");
  const result = loadEnvFile(envPath);

  if (verbose) {
    if (result.filePath) {
      if (result.loaded.length > 0) {
        process.stderr.write(
          `[env] Loaded ${result.loaded.length} variable(s) from ${result.filePath}\n`,
        );
      }
      if (result.skipped.length > 0) {
        process.stderr.write(
          `[env] Skipped ${result.skipped.length} variable(s) already in environment\n`,
        );
      }
    } else {
      process.stderr.write(
        `[env] No .env file found at ${envPath} — using process environment only\n`,
      );
    }
  }

  return result;
}
