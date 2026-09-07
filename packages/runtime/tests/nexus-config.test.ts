// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { loadConductorConfig } from "../src/nexus-config.js";

const ENV_KEYS = [
  "GHOSTSTACK_API_PORT",
  "GHOSTSTACK_FLOCI_URL",
  "GHOSTSTACK_MCP_PORT",
  "GHOSTSTACK_DATA_DIR",
  "GHOSTSTACK_FLOCI_AUTOSTART",
  "GHOSTSTACK_FLOCI_STRICT",
  "GHOSTSTACK_OFFLINE_MODE",
  "GHOSTSTACK_MCP_BRIDGE",
  "GHOSTSTACK_MCP_EXTERNAL",
];

let root: string;
let originalEnv: Record<string, string | undefined>;
let originalArgv: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  originalEnv = {};
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  originalArgv = [...process.argv];
  fs.writeFileSync(path.join(root, ".env"), "", "utf8");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  process.argv = originalArgv;
});

describe("loadConductorConfig", () => {
  it("returns defaults when nothing is configured", () => {
    const cfg = loadConductorConfig(root);
    expect(cfg.apiPort).toBe(3000);
    expect(cfg.flociUrl).toBe("http://localhost:4566");
    expect(cfg.features.offlineMode).toBe(true);
    expect(process.env.GHOSTSTACK_API_URL).toBe("http://127.0.0.1:3000");
  });

  it("loads values from conductor.config.json", () => {
    fs.writeFileSync(
      path.join(root, "conductor.config.json"),
      JSON.stringify({ apiPort: 8080, flociUrl: "http://floci.local:5000", features: { mcpBridge: false } }),
      "utf8",
    );
    const cfg = loadConductorConfig(root);
    expect(cfg.apiPort).toBe(8080);
    expect(cfg.flociUrl).toBe("http://floci.local:5000");
    expect(cfg.features.mcpBridge).toBe(false);
    expect(cfg.features.mcpExternal).toBe(true); // default preserved
  });

  it("applies env var overrides on top of file config", () => {
    fs.writeFileSync(
      path.join(root, "conductor.config.json"),
      JSON.stringify({ apiPort: 8080, dataDir: "./from-file" }),
      "utf8",
    );
    process.env.GHOSTSTACK_API_PORT = "9090";
    process.env.GHOSTSTACK_DATA_DIR = "./from-env";
    process.env.GHOSTSTACK_OFFLINE_MODE = "false";
    const cfg = loadConductorConfig(root);
    expect(cfg.apiPort).toBe(9090);
    expect(cfg.dataDir).toBe("./from-env");
    expect(cfg.features.offlineMode).toBe(false);
  });

  it("parses boolean env vars in both 1 and true forms", () => {
    process.env.GHOSTSTACK_FLOCI_STRICT = "1";
    process.env.GHOSTSTACK_MCP_EXTERNAL = "true";
    const cfg = loadConductorConfig(root);
    expect(cfg.features.flociStrict).toBe(true);
    expect(cfg.features.mcpExternal).toBe(true);
  });

  it("honors command-line flags last", () => {
    process.argv = ["node", "x", "--api-port", "7777", "--floci-url", "http://cli:4566", "--offline", "true", "--noop"];
    const cfg = loadConductorConfig(root);
    expect(cfg.apiPort).toBe(7777);
    expect(cfg.flociUrl).toBe("http://cli:4566");
    expect(cfg.features.offlineMode).toBe(true);
  });

  it("supports boolean-style CLI flags with a trailing value", () => {
    process.argv = ["node", "x", "--mcp-bridge", "false"];
    const cfg = loadConductorConfig(root);
    expect(cfg.features.mcpBridge).toBe(false);
  });

  it("rejects an invalid conductor.config.json", () => {
    fs.writeFileSync(path.join(root, "conductor.config.json"), "{not json", "utf8");
    expect(() => loadConductorConfig(root)).toThrow(/Invalid conductor.config.json/);
  });

  it("throws with a formatted error list for invalid ports/urls", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(
      path.join(root, "conductor.config.json"),
      JSON.stringify({ apiPort: 99999, flociUrl: "nope" }),
      "utf8",
    );
    expect(() => loadConductorConfig(root)).toThrow(/Configuration validation failed/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("apiPort"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("flociUrl"));
    errSpy.mockRestore();
  });
});
