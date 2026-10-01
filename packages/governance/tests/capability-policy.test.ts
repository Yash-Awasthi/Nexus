// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { CapabilityPolicy, ExecutionEnvironment } from "../src/capability-policy.js";
import type { IEnvironmentTelemetry } from "../src/interfaces/environment.interface.js";

const TELEMETRY: IEnvironmentTelemetry = { successRate: 1, avgLatencyMs: 50, requestCount: 0 };

function makeEnv(name: string, capabilities: string[]): ExecutionEnvironment {
  return new ExecutionEnvironment(name, capabilities, TELEMETRY);
}

describe("ExecutionEnvironment", () => {
  it("stores name, capabilities, and telemetry", () => {
    const env = makeEnv("test-env", ["BROWSER_INTERACT", "NETWORK_ACCESS"]);
    expect(env.name).toBe("test-env");
    expect(env.capabilities).toContain("BROWSER_INTERACT");
    expect(env.telemetry).toBe(TELEMETRY);
  });
});

describe("CapabilityPolicy", () => {
  let policy: CapabilityPolicy;

  beforeEach(() => {
    policy = new CapabilityPolicy();
  });

  describe("browser task type", () => {
    it("allows browser task when BROWSER_INTERACT is present", async () => {
      const env = makeEnv("browser-env", ["BROWSER_INTERACT"]);
      const result = await policy.evaluateCapability("browser", env);
      expect(result.allowed).toBe(true);
    });

    it("denies browser task when BROWSER_INTERACT is missing", async () => {
      const env = makeEnv("no-browser-env", ["NETWORK_ACCESS"]);
      const result = await policy.evaluateCapability("browser", env);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/BROWSER_INTERACT/);
      expect(result.reason).toMatch(/no-browser-env/);
    });
  });

  describe("scraping task type", () => {
    it("allows scraping task when NETWORK_ACCESS is present", async () => {
      const env = makeEnv("net-env", ["NETWORK_ACCESS"]);
      const result = await policy.evaluateCapability("scraping", env);
      expect(result.allowed).toBe(true);
    });

    it("denies scraping task when NETWORK_ACCESS is missing", async () => {
      const env = makeEnv("isolated-env", ["FILESYSTEM_WRITE"]);
      const result = await policy.evaluateCapability("scraping", env);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/NETWORK_ACCESS/);
    });
  });

  describe("sandbox task type", () => {
    it("allows sandbox task when FILESYSTEM_WRITE is present", async () => {
      const env = makeEnv("fs-env", ["FILESYSTEM_WRITE"]);
      const result = await policy.evaluateCapability("sandbox", env);
      expect(result.allowed).toBe(true);
    });

    it("denies sandbox task when FILESYSTEM_WRITE is missing", async () => {
      const env = makeEnv("readonly-env", ["NETWORK_ACCESS"]);
      const result = await policy.evaluateCapability("sandbox", env);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/FILESYSTEM_WRITE/);
    });
  });

  describe("unconstrained task types", () => {
    it("allows unknown task types by default (no constraint defined)", async () => {
      const env = makeEnv("any-env", []);
      const result = await policy.evaluateCapability("llm.inference", env);
      expect(result.allowed).toBe(true);
    });

    it("allows task when all capabilities present", async () => {
      const env = makeEnv("full-env", ["BROWSER_INTERACT", "NETWORK_ACCESS", "FILESYSTEM_WRITE"]);
      const r1 = await policy.evaluateCapability("browser", env);
      const r2 = await policy.evaluateCapability("scraping", env);
      const r3 = await policy.evaluateCapability("sandbox", env);
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(true);
    });
  });
});
