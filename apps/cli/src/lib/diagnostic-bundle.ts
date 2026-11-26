// SPDX-License-Identifier: Apache-2.0
/**
 * `nexus doctor --bundle` — one file a person can attach to a bug report.
 *
 * The hard part is not collecting the data, it is that the data is the kind of thing people
 * paste without reading: an error message with a key in it, a `DATABASE_URL` with a password, a
 * token in a URL. So redaction runs on the way *in*, and the bundle records what it redacted, so
 * a reader can see that a value was removed rather than think the field was empty.
 *
 * The bundle is deliberately small: versions, the doctor's rows, the API's own `/status` and
 * `/health` documents. No environment dump, no logs by default, no file bodies.
 */
import fs from "node:fs";
import path from "node:path";

export const BUNDLE_SCHEMA = "nexus.bundle/1";
export const BUNDLE_FILE = "nexus-bundle.json";
export const BUNDLE_README = "nexus-bundle-README.txt";

/** Field names whose values are never copied, whatever they hold. */
const SECRET_FIELD = /(secret|token|password|passwd|apikey|api_key|authorization|bearer|cookie)/i;

/**
 * Value shapes that are a credential wherever they appear, including inside a message or a URL
 * query string. Each pattern keeps a short prefix so a reader can tell *which* credential leaked
 * without being able to use it.
 */
const SECRET_SHAPES: { name: string; pattern: RegExp; replace: string }[] = [
  {
    name: "openai-style key",
    // Both separators: OpenAI and Anthropic use `sk-`, Groq uses `gsk_`, and a rule that only
    // knows the hyphen passes a Groq key straight through.
    pattern: /\b(sk|gsk|r8|xai|pplx)[-_][A-Za-z0-9._-]{8,}/g,
    replace: "$1-REDACTED",
  },
  { name: "github token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: "gh-REDACTED" },
  { name: "slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: "xox-REDACTED" },
  { name: "json web token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: "jwt-REDACTED" },
  { name: "aws access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "AKIA-REDACTED" },
  { name: "webhook signature", pattern: /\bt=\d+,v1=[a-f0-9]{32,}/g, replace: "t=REDACTED,v1=REDACTED" },
  {
    name: "credentials in a URL",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
    replace: "$1$2:REDACTED@",
  },
  {
    name: "secret in a query string",
    pattern: /([?&](?:key|token|api_key|apikey|access_token|secret)=)[^&\s"'#]+/gi,
    replace: "$1REDACTED",
  },
];

export interface Redaction {
  /** The redacted text. */
  text: string;
  /** The names of the shapes that were removed, so the bundle can say what it took out. */
  removed: string[];
}

/** Remove credentials from a string, and say which shapes were found. */
export function redact(text: string): Redaction {
  let out = text;
  const removed = new Set<string>();
  for (const shape of SECRET_SHAPES) {
    if (!shape.pattern.test(out)) {
      // `test` on a /g/ regex advances lastIndex; reset so the replace below sees every match.
      shape.pattern.lastIndex = 0;
      continue;
    }
    shape.pattern.lastIndex = 0;
    out = out.replace(shape.pattern, shape.replace);
    removed.add(shape.name);
  }
  return { text: out, removed: [...removed].sort() };
}

/** Redact every string in a JSON-shaped value, dropping secret-named fields entirely. */
export function redactDeep(value: unknown, removed = new Set<string>()): { value: unknown; removed: string[] } {
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      const result = redact(input);
      for (const name of result.removed) removed.add(name);
      return result.text;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        if (SECRET_FIELD.test(key)) {
          out[key] = "REDACTED";
          removed.add(`field:${key}`);
          continue;
        }
        out[key] = walk(item);
      }
      return out;
    }
    return input;
  };
  const redacted = walk(value);
  return { value: redacted, removed: [...removed].sort() };
}

export interface BundleInput {
  version: string;
  startedAt: string;
  generatedAt?: string;
  node: string;
  platform: string;
  arch: string;
  doctor: readonly unknown[];
  status?: unknown;
  health?: unknown;
  /** Anything the caller adds; it is redacted like the rest. */
  notes?: Record<string, unknown>;
}

export interface Bundle {
  schema: typeof BUNDLE_SCHEMA;
  generatedAt: string;
  versions: { nexus: string; node: string; platform: string; arch: string; startedAt: string };
  doctor: unknown;
  status: unknown;
  health: unknown;
  notes?: unknown;
  /** What redaction removed, by name. Empty means nothing matched. */
  redacted: string[];
}

/** Assemble and redact a bundle. Pure: writing is a separate step so it can be tested alone. */
export function buildBundle(input: BundleInput): Bundle {
  const { value, removed } = redactDeep({
    doctor: input.doctor,
    status: input.status ?? null,
    health: input.health ?? null,
    ...(input.notes ? { notes: input.notes } : {}),
  });
  const shaped = value as { doctor: unknown; status: unknown; health: unknown; notes?: unknown };
  return {
    schema: BUNDLE_SCHEMA,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    versions: {
      nexus: input.version,
      node: input.node,
      platform: input.platform,
      arch: input.arch,
      startedAt: input.startedAt,
    },
    doctor: shaped.doctor,
    status: shaped.status,
    health: shaped.health,
    ...(shaped.notes === undefined ? {} : { notes: shaped.notes }),
    redacted: removed,
  };
}

/** What the bundle is, and what it does not contain. Not redacted — it is written by the tool. */
export function bundleReadme(bundle: Bundle): string {
  const lines = [
    "Nexus diagnostic bundle",
    "",
    `Generated: ${bundle.generatedAt}`,
    `Nexus:     ${bundle.versions.nexus}`,
    `Node:      ${bundle.versions.node} on ${bundle.versions.platform}/${bundle.versions.arch}`,
    "",
    "Contents: the `nexus doctor` rows, and the API's own /status and /health documents if the",
    "API was reachable. No environment dump, no log files, no session contents, no file bodies.",
    "",
    bundle.redacted.length === 0
      ? "Redaction matched nothing in this bundle. Read it before attaching it anyway: a"
      : `Redaction removed: ${bundle.redacted.join(", ")}. Read it before attaching it anyway: a`,
    "credential in a shape the tool does not know is still a credential.",
    "",
    "Attach nexus-bundle.json to your report. Do not attach ~/.nexus or a .env file.",
    "",
  ];
  return lines.join("\n");
}

export interface WrittenBundle {
  jsonPath: string;
  readmePath: string;
  bundle: Bundle;
}

/** Write both files into `dir`, creating it if needed. */
export function writeBundle(dir: string, bundle: Bundle): WrittenBundle {
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, BUNDLE_FILE);
  const readmePath = path.join(dir, BUNDLE_README);
  fs.writeFileSync(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  fs.writeFileSync(readmePath, bundleReadme(bundle), "utf8");
  return { jsonPath, readmePath, bundle };
}
