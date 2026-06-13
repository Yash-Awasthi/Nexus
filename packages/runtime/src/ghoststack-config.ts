// SPDX-License-Identifier: Apache-2.0
/**
 * GhostStack configuration loader.
 *
 * Reads `ghoststack.runtime.yaml` from the repo root and exposes a typed
 * configuration object used by FederationSupervisor and the bootstrap path.
 */

import * as fs from "fs";
import * as path from "path";

import * as yaml from "js-yaml";

export interface GhostStackFeatures {
  mcpExternal: boolean;
  flociStrict: boolean;
  offlineMode: boolean;
  flociAutostart: boolean;
}

export interface GhostStackConfig {
  /** Runtime mode: "standalone" (no Floci) or "federation" (full stack). */
  mode: "standalone" | "federation";
  /** API server port (default: 3000). */
  apiPort: number;
  /** MCP bridge port (default: 3001). */
  mcpPort: number;
  /** Floci endpoint override — defaults to http://localhost:4566. */
  flociEndpoint?: string;
  /** Feature flags for optional runtime capabilities. */
  features: GhostStackFeatures;
  /** Raw configuration from the YAML file. */
  raw?: Record<string, unknown>;
}

const DEFAULT_FEATURES: GhostStackFeatures = {
  mcpExternal: false,
  flociStrict: false,
  offlineMode: false,
  flociAutostart: false,
};

const DEFAULTS: GhostStackConfig = {
  mode: "standalone",
  apiPort: 3000,
  mcpPort: 3001,
  features: { ...DEFAULT_FEATURES },
};

/**
 * Load GhostStack configuration from the repo root.
 * Falls back to defaults if the config file is missing or unparseable.
 */
export function loadGhostStackConfig(repoRoot: string): GhostStackConfig {
  const configPath = path.join(repoRoot, "runtime", "ghoststack.runtime.yaml");
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  try {
    const raw = yaml.load(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const rawFeatures = (raw.features ?? {}) as Record<string, unknown>;
    return {
      mode: (raw.mode as "standalone" | "federation") ?? DEFAULTS.mode,
      apiPort: (raw.api_port as number) ?? DEFAULTS.apiPort,
      mcpPort: (raw.mcp_port as number) ?? DEFAULTS.mcpPort,
      flociEndpoint: raw.floci_endpoint as string | undefined,
      features: {
        mcpExternal: (rawFeatures.mcp_external as boolean) ?? DEFAULT_FEATURES.mcpExternal,
        flociStrict: (rawFeatures.floci_strict as boolean) ?? DEFAULT_FEATURES.flociStrict,
        offlineMode: (rawFeatures.offline_mode as boolean) ?? DEFAULT_FEATURES.offlineMode,
        flociAutostart: (rawFeatures.floci_autostart as boolean) ?? DEFAULT_FEATURES.flociAutostart,
      },
      raw,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
