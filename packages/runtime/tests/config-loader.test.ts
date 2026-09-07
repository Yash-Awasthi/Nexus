// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { YAMLConfigLoader } from "../src/config-loader.js";

let dir: string;
let paths: Record<string, string>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-"));
  paths = {
    ports: path.join(dir, "ports.yaml"),
    services: path.join(dir, "services.yaml"),
    healthchecks: path.join(dir, "healthchecks.yaml"),
    runtime: path.join(dir, "runtime.yaml"),
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("YAMLConfigLoader", () => {
  it("loads each YAML document typed as its config shape", async () => {
    fs.writeFileSync(paths.ports, "floci: 4566\nfcc: 3000\nmcp: 8100\nollama: 11434\n");
    fs.writeFileSync(
      paths.services,
      "services:\n  api:\n    type: process\n    port: 3000\n",
    );
    fs.writeFileSync(paths.healthchecks, "healthchecks:\n  api:\n    path: /health\n    interval: 30\n");
    fs.writeFileSync(
      paths.runtime,
      "version: '1.1'\nenvironment: dev\nprimary_llm: groq\nlocal_backup: ''\nstorage:\n  mode: file\n  interval_sec: 60\n",
    );

    const loader = new YAMLConfigLoader({
      portsPath: paths.ports,
      servicesPath: paths.services,
      healthchecksPath: paths.healthchecks,
      runtimePath: paths.runtime,
    });
    expect(await loader.loadPorts()).toMatchObject({ floci: 4566, mcp: 8100 });
    expect(await loader.loadServices()).toMatchObject({
      services: { api: { type: "process", port: 3000 } },
    });
    expect(await loader.loadHealthchecks()).toMatchObject({
      healthchecks: { api: { interval: 30 } },
    });
    expect(await loader.loadRuntime()).toMatchObject({ environment: "dev", primary_llm: "groq" });
  });

  it("throws a descriptive error for a missing or malformed file", async () => {
    const loader = new YAMLConfigLoader({
      portsPath: path.join(dir, "missing.yaml"),
      servicesPath: paths.services,
      healthchecksPath: paths.healthchecks,
      runtimePath: paths.runtime,
    });
    await expect(loader.loadPorts()).rejects.toThrow(/Failed to load or parse YAML/);
  });
});
