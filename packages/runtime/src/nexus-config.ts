// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as path from "path";

import { loadEnvFile } from "./env-loader.js";

export interface GhostStackConfig {
  apiPort: number;
  flociUrl: string;
  mcpPort: number;
  dataDir: string;
  features: {
    flociAutostart: boolean;
    flociStrict: boolean;
    offlineMode: boolean;
    mcpBridge: boolean;
    mcpExternal: boolean;
  };
}

const DEFAULTS: GhostStackConfig = {
  apiPort: 3000,
  flociUrl: "http://localhost:4566",
  mcpPort: 8100,
  dataDir: "./data-runtime",
  features: {
    flociAutostart: true,
    flociStrict: false,
    offlineMode: true,
    mcpBridge: true,
    mcpExternal: true,
  },
};

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function parseCliArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  const args = process.argv;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("-")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function validateConfig(config: GhostStackConfig): void {
  const errors: string[] = [];

  if (isNaN(config.apiPort) || config.apiPort < 1 || config.apiPort > 65535) {
    errors.push(
      `- apiPort: "${config.apiPort}" is invalid. Must be an integer between 1 and 65535.`,
    );
  }

  if (isNaN(config.mcpPort) || config.mcpPort < 1 || config.mcpPort > 65535) {
    errors.push(
      `- mcpPort: "${config.mcpPort}" is invalid. Must be an integer between 1 and 65535.`,
    );
  }

  if (!config.flociUrl.startsWith("http://") && !config.flociUrl.startsWith("https://")) {
    errors.push(`- flociUrl: "${config.flociUrl}" is invalid. Must start with http:// or https://`);
  }

  if (!config.dataDir || typeof config.dataDir !== "string") {
    errors.push(`- dataDir: Path "${config.dataDir}" is invalid.`);
  }

  if (errors.length > 0) {
    console.error("\n=======================================================");
    console.error("  GHOSTSTACK CONFIGURATION VALIDATION FAILED");
    console.error("=======================================================");
    errors.forEach((err) => {
      console.error(err);
    });
    console.error("=======================================================\n");
    throw new Error("Configuration validation failed. Check printed logs above.");
  }
}

/** Load `.env`, optional `ghoststack.config.json`, apply env overrides and command line flags. */
export function loadGhostStackConfig(repoRoot: string): GhostStackConfig {
  loadEnvFile(path.join(repoRoot, ".env"));

  const configPath = path.join(repoRoot, "ghoststack.config.json");
  let fileConfig: Partial<GhostStackConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(`Invalid ghoststack.config.json: ${(err as Error).message}`);
    }
  }

  const merged: GhostStackConfig = {
    apiPort: fileConfig.apiPort ?? DEFAULTS.apiPort,
    flociUrl: fileConfig.flociUrl ?? DEFAULTS.flociUrl,
    mcpPort: fileConfig.mcpPort ?? DEFAULTS.mcpPort,
    dataDir: fileConfig.dataDir ?? DEFAULTS.dataDir,
    features: {
      ...DEFAULTS.features,
      ...(fileConfig.features ?? {}),
    },
  };

  if (process.env.GHOSTSTACK_API_PORT) merged.apiPort = Number(process.env.GHOSTSTACK_API_PORT);
  if (process.env.GHOSTSTACK_FLOCI_URL) merged.flociUrl = process.env.GHOSTSTACK_FLOCI_URL;
  if (process.env.GHOSTSTACK_MCP_PORT) merged.mcpPort = Number(process.env.GHOSTSTACK_MCP_PORT);
  if (process.env.GHOSTSTACK_DATA_DIR) merged.dataDir = process.env.GHOSTSTACK_DATA_DIR;

  merged.features.flociAutostart = envBool(
    "GHOSTSTACK_FLOCI_AUTOSTART",
    merged.features.flociAutostart,
  );
  merged.features.flociStrict = envBool("GHOSTSTACK_FLOCI_STRICT", merged.features.flociStrict);
  merged.features.offlineMode = envBool("GHOSTSTACK_OFFLINE_MODE", merged.features.offlineMode);
  merged.features.mcpBridge = envBool("GHOSTSTACK_MCP_BRIDGE", merged.features.mcpBridge);
  merged.features.mcpExternal = envBool("GHOSTSTACK_MCP_EXTERNAL", merged.features.mcpExternal);

  // Command-line flag overrides
  const cliArgs = parseCliArgs();
  if (cliArgs["api-port"]) merged.apiPort = Number(cliArgs["api-port"]);
  if (cliArgs["floci-url"]) merged.flociUrl = cliArgs["floci-url"];
  if (cliArgs["mcp-port"]) merged.mcpPort = Number(cliArgs["mcp-port"]);
  if (cliArgs["data-dir"]) merged.dataDir = cliArgs["data-dir"];

  if (cliArgs["floci-autostart"] !== undefined) {
    merged.features.flociAutostart = cliArgs["floci-autostart"] === "true";
  }
  if (cliArgs["floci-strict"] !== undefined) {
    merged.features.flociStrict = cliArgs["floci-strict"] === "true";
  }
  if (cliArgs.offline !== undefined) {
    merged.features.offlineMode = cliArgs.offline === "true";
  }
  if (cliArgs["mcp-bridge"] !== undefined) {
    merged.features.mcpBridge = cliArgs["mcp-bridge"] === "true";
  }
  if (cliArgs["mcp-external"] !== undefined) {
    merged.features.mcpExternal = cliArgs["mcp-external"] === "true";
  }

  // Validate the final config
  validateConfig(merged);

  process.env.GHOSTSTACK_API_PORT = String(merged.apiPort);
  process.env.GHOSTSTACK_FLOCI_URL = merged.flociUrl;
  process.env.GHOSTSTACK_MCP_PORT = String(merged.mcpPort);
  process.env.GHOSTSTACK_DATA_DIR = merged.dataDir;
  process.env.GHOSTSTACK_API_URL = `http://127.0.0.1:${merged.apiPort}`;

  return merged;
}
