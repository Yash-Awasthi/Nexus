// SPDX-License-Identifier: Apache-2.0
/**
 * plugin-manifest — the marketplace layer of the plugin SDK (§15.1).
 *
 * Where `AdapterDefinition` (in ./index.ts) describes an *in-process* execution
 * adapter, a {@link PluginManifest} describes a *distributable* plugin as it
 * would appear in a hosted registry: identity, entry point, the capabilities it
 * requests, and its declared config. This module is the first, self-contained
 * slice — schema + validator + a capability-enforcing load seam — with no
 * registry transport and no sandbox runtime yet (both come later).
 *
 * Trust model: a plugin can only ever use capabilities it DECLARES in its
 * manifest AND that the host GRANTS at load time. {@link loadPlugin} computes the
 * intersection and refuses to load a plugin that requests a capability the host
 * has not granted — so an over-broad manifest fails closed rather than silently
 * gaining access. The actual sandbox (Deno-isolate) that enforces this at
 * runtime is a later slice; this seam defines the contract it will honour.
 */

import type { AdapterCapability } from "./index.js";

/** SemVer-ish `MAJOR.MINOR.PATCH` with an optional pre-release/build suffix. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** Reverse-DNS-ish plugin id, e.g. `com.acme.summarizer` or `acme-summarizer`. */
const PLUGIN_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** A single declared config field a plugin reads from its execution context. */
export interface PluginConfigField {
  key: string;
  description?: string;
  required?: boolean;
  /** Marks a value as a secret so the host masks it in logs/UI. */
  secret?: boolean;
}

/** A distributable plugin's self-description — the registry record. */
export interface PluginManifest {
  /** Reverse-DNS-style unique id, e.g. `com.acme.summarizer`. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** SemVer version. */
  version: string;
  /** Module path / URL the host loads to obtain the plugin's entry point. */
  entry: string;
  /** Capabilities the plugin requests — a subset of {@link AdapterCapability}. */
  capabilities: AdapterCapability[];
  description?: string;
  author?: string;
  /** SPDX license id, e.g. `Apache-2.0`. */
  license?: string;
  /** Config fields the plugin expects at runtime. */
  config?: PluginConfigField[];
  /** Minimum host API version the plugin targets (SemVer). */
  minHostVersion?: string;
}

/** The full set of capabilities the marketplace understands (mirrors AdapterCapability). */
export const KNOWN_CAPABILITIES: readonly AdapterCapability[] = [
  "llm.inference",
  "storage.read",
  "storage.write",
  "search.web",
  "communication.email",
  "communication.chat",
  "database.query",
  "database.execute",
  "secrets.read",
  "monitoring.log",
  "monitoring.alert",
  "deploy.trigger",
  "scraping.financial",
  "deliberation.council",
  "auth.verify",
];

const KNOWN_CAPABILITY_SET = new Set<string>(KNOWN_CAPABILITIES);

/** Error raised when a manifest fails validation or a load-time capability check. */
export class PluginManifestError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_MANIFEST" | "UNKNOWN_CAPABILITY" | "CAPABILITY_NOT_GRANTED",
    /** Field-level problems, when the failure is a schema violation. */
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "PluginManifestError";
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate an untrusted value as a {@link PluginManifest}. Returns the typed
 * manifest on success; throws {@link PluginManifestError} (`INVALID_MANIFEST`)
 * with a list of every problem found on failure. Pure — no I/O.
 */
export function validatePluginManifest(input: unknown): PluginManifest {
  const issues: string[] = [];
  const m = (input ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(m["id"])) issues.push("id: required non-empty string");
  else if (!PLUGIN_ID_RE.test(m["id"])) issues.push(`id: "${m["id"]}" is not a valid plugin id`);

  if (!isNonEmptyString(m["name"])) issues.push("name: required non-empty string");

  if (!isNonEmptyString(m["version"])) issues.push("version: required non-empty string");
  else if (!SEMVER_RE.test(m["version"])) issues.push(`version: "${m["version"]}" is not SemVer`);

  if (!isNonEmptyString(m["entry"])) issues.push("entry: required non-empty string");

  if (m["minHostVersion"] !== undefined && !SEMVER_RE.test(String(m["minHostVersion"]))) {
    issues.push(`minHostVersion: "${String(m["minHostVersion"])}" is not SemVer`);
  }

  const caps = m["capabilities"];
  if (!Array.isArray(caps)) {
    issues.push("capabilities: required array");
  } else {
    caps.forEach((c, i) => {
      if (typeof c !== "string") issues.push(`capabilities[${i}]: must be a string`);
      else if (!KNOWN_CAPABILITY_SET.has(c))
        issues.push(`capabilities[${i}]: unknown capability "${c}"`);
    });
    if (new Set(caps).size !== caps.length) issues.push("capabilities: duplicate entries");
  }

  if (m["config"] !== undefined) {
    if (!Array.isArray(m["config"])) {
      issues.push("config: must be an array when present");
    } else {
      (m["config"] as unknown[]).forEach((f, i) => {
        const field = (f ?? {}) as Record<string, unknown>;
        if (!isNonEmptyString(field["key"]))
          issues.push(`config[${i}].key: required non-empty string`);
      });
    }
  }

  if (issues.length > 0) {
    throw new PluginManifestError(
      `Invalid plugin manifest (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
      "INVALID_MANIFEST",
      issues,
    );
  }

  return {
    id: m["id"] as string,
    name: m["name"] as string,
    version: m["version"] as string,
    entry: m["entry"] as string,
    capabilities: caps as AdapterCapability[],
    description: isNonEmptyString(m["description"]) ? m["description"] : undefined,
    author: isNonEmptyString(m["author"]) ? m["author"] : undefined,
    license: isNonEmptyString(m["license"]) ? m["license"] : undefined,
    config: m["config"] as PluginConfigField[] | undefined,
    minHostVersion: isNonEmptyString(m["minHostVersion"]) ? m["minHostVersion"] : undefined,
  };
}

/** A loaded, capability-scoped plugin ready for the (future) sandbox runtime. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Capabilities effectively available = requested ∩ granted. */
  grantedCapabilities: AdapterCapability[];
}

/** Options for {@link loadPlugin}. */
export interface LoadPluginOptions {
  /**
   * Capabilities the host is willing to grant. Every capability the manifest
   * requests must appear here, or the load fails closed. Omit to grant nothing
   * (only zero-capability plugins load).
   */
  grantedCapabilities?: AdapterCapability[];
}

/**
 * Validate a manifest and resolve it against the host's granted capabilities.
 * Fails closed: if the plugin requests any capability the host did not grant,
 * throws {@link PluginManifestError} (`CAPABILITY_NOT_GRANTED`) listing the
 * missing grants — the plugin never loads with partial access. Does NOT execute
 * the plugin; wiring the entry point into the Deno-isolate sandbox is a later
 * slice.
 */
export function loadPlugin(input: unknown, opts: LoadPluginOptions = {}): LoadedPlugin {
  const manifest = validatePluginManifest(input);
  const granted = new Set<string>(opts.grantedCapabilities ?? []);
  const missing = manifest.capabilities.filter((c) => !granted.has(c));
  if (missing.length > 0) {
    throw new PluginManifestError(
      `Plugin "${manifest.id}" requests ungranted capabilities: ${missing.join(", ")}`,
      "CAPABILITY_NOT_GRANTED",
      missing,
    );
  }
  return { manifest, grantedCapabilities: [...manifest.capabilities] };
}
