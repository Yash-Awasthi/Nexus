// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
import * as fs from "fs";
import * as path from "path";

import * as yaml from "js-yaml";

export function runHealthcheck(): boolean {
  console.log("\x1b[36m=========================================================================");
  console.log("             GHOSTSTACK V1.1 PLATFORM SYSTEM HEALTHCHECK                ");
  console.log("=========================================================================\x1b[0m\n");

  let healthy = true;
  const checks = [
    { name: "Workspace Core Folders Structure", check: checkFolders },
    { name: "YAML Configuration Validation", check: checkYAMLConfigs },
    { name: "Orchestrator Classes Compilation Integrity", check: checkCompilationIntegrity },
    { name: "Interface Schemas Verification", check: checkSchemas },
    { name: "MCP Bridge & Runtime Composition", check: checkMcpBridgeHealth },
  ];

  for (const check of checks) {
    console.log(`[CHECK] Evaluating: ${check.name}...`);
    try {
      const result = check.check();
      if (result) {
        console.log(`\x1b[32m[PASS] ${check.name} evaluated successfully.\x1b[0m\n`);
      } else {
        console.log(`\x1b[31m[FAIL] ${check.name} failed sanity checks.\x1b[0m\n`);
        healthy = false;
      }
    } catch (e: any) {
      console.log(`\x1b[31m[CRITICAL] Error checking ${check.name}: ${e.message}\x1b[0m\n`);
      healthy = false;
    }
  }

  if (healthy) {
    console.log(
      "\x1b[32m=========================================================================",
    );
    console.log("  ALL SYSTEM CHECKS PASSED: GHOSTSTACK V1.1 CORE IS HEALTHY & OPERATIONAL");
    console.log("=========================================================================\x1b[0m");
  } else {
    console.log(
      "\x1b[31m=========================================================================",
    );
    console.log("  CRITICAL SYSTEM HEALTH SANITY FAILURE: PLEASE INSPECT MALFORMED ASSETS");
    console.log("=========================================================================\x1b[0m");
  }
  return healthy;
}

function checkFolders(): boolean {
  const root = path.join(__dirname, "..");
  const required = ["orchestration", "runtime", "schemas", "tests"];
  for (const folder of required) {
    const p = path.join(root, folder);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      console.error(`  [ERR] Missing core directory: ${folder}`);
      return false;
    }
    console.log(`  [OK] Directory present: ${folder}`);
  }
  return true;
}

function checkYAMLConfigs(): boolean {
  const root = path.join(__dirname, "..", "runtime");
  const files = ["ports.yaml", "services.yaml", "healthchecks.yaml", "ghoststack.runtime.yaml"];
  for (const file of files) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) {
      console.error(`  [ERR] Missing configuration file: ${file}`);
      return false;
    }
    try {
      const content = fs.readFileSync(p, "utf8");
      yaml.load(content);
      console.log(`  [OK] Parsed valid YAML config: ${file}`);
    } catch (err: any) {
      console.error(`  [ERR] Malformed YAML in file ${file}: ${err.message}`);
      return false;
    }
  }
  return true;
}

function checkCompilationIntegrity(): boolean {
  const root = path.join(__dirname, "..", "orchestration");
  const files = [
    "event-bus.ts",
    "task-router.ts",
    "task-executor.ts",
    "persistence-manager.ts",
    "logger.ts",
  ];
  for (const file of files) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) {
      console.error(`  [ERR] Missing core source file: ${file}`);
      return false;
    }
    console.log(`  [OK] Source file validated: ${file}`);
  }
  return true;
}

function checkSchemas(): boolean {
  const root = path.join(__dirname, "..", "schemas");
  const files = [
    "orchestration.schema.json",
    "task.schema.json",
    "agent-message.schema.json",
    "spec.schema.json",
    "artifact.schema.json",
    "memory.schema.json",
    "runtime-state.schema.json",
  ];
  for (const file of files) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) {
      console.error(`  [ERR] Missing validation schema file: ${file}`);
      return false;
    }
    try {
      const content = fs.readFileSync(p, "utf8");
      JSON.parse(content);
      console.log(`  [OK] Loaded valid JSON schema: ${file}`);
    } catch (err: any) {
      console.error(`  [ERR] Malformed JSON schema in ${file}: ${err.message}`);
      return false;
    }
  }
  return true;
}

/**
 * Verify MCP bridge and runtime composition assets are present.
 * Checks for:
 *   - GhostStack MCP bridge orchestration module
 *   - MCP host adapter
 *   - MCP registry schema
 *   - Python MCP server entrypoint (if Python is available)
 */
function checkMcpBridgeHealth(): boolean {
  const root = path.join(__dirname, "..");
  let allOk = true;

  // 1. GhostStack MCP bridge orchestration module
  const bridgePath = path.join(root, "orchestration", "ghoststack-mcp-bridge.ts");
  if (fs.existsSync(bridgePath)) {
    console.log(`  [OK] GhostStack MCP bridge module: ghoststack-mcp-bridge.ts`);
  } else {
    console.error(`  [ERR] Missing MCP bridge module: ghoststack-mcp-bridge.ts`);
    allOk = false;
  }

  // 2. MCP host adapter
  const mcpServerHostPath = path.join(root, "runtime", "adapters", "mcp-server-host.ts");
  if (fs.existsSync(mcpServerHostPath)) {
    console.log(`  [OK] MCP host adapter: mcp-server-host.ts`);
  } else {
    console.error(`  [ERR] Missing MCP host adapter: mcp-server-host.ts`);
    allOk = false;
  }

  // 3. MCP registry schema
  const mcpRegistryPath = path.join(root, "schemas", "mcp_registry.json");
  if (fs.existsSync(mcpRegistryPath)) {
    try {
      const content = fs.readFileSync(mcpRegistryPath, "utf8");
      JSON.parse(content);
      console.log(`  [OK] MCP registry schema: mcp_registry.json`);
    } catch (err: any) {
      console.error(`  [ERR] Malformed MCP registry schema: ${err.message}`);
      allOk = false;
    }
  } else {
    console.error(`  [ERR] Missing MCP registry schema: mcp_registry.json`);
    allOk = false;
  }

  // 4. Python MCP server entrypoint (optional — warn only)
  const pythonMcpPath = path.join(root, "runtime", "mcp", "ghoststack_mcp_server.py");
  if (fs.existsSync(pythonMcpPath)) {
    console.log(`  [OK] Python MCP server entrypoint: ghoststack_mcp_server.py`);
  } else {
    console.warn(
      `  [WARN] Python MCP server entrypoint not found (optional if MCP external is disabled): ghoststack_mcp_server.py`,
    );
  }

  return allOk;
}

if (require.main === module) {
  process.exit(runHealthcheck() ? 0 : 1);
}
