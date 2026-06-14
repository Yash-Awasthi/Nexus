// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { loadEnvFile } from "../src/env-loader.js";

let tmpDir: string;
let envPath: string;
const LOADED_KEYS: string[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-env-test-"));
  envPath = path.join(tmpDir, ".env");
});

afterEach(() => {
  // Clean up any keys loaded into process.env during tests
  for (const key of LOADED_KEYS) {
    delete process.env[key];
  }
  LOADED_KEYS.length = 0;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEnv(content: string): void {
  fs.writeFileSync(envPath, content, "utf8");
}

function track(...keys: string[]): void {
  LOADED_KEYS.push(...keys);
}

describe("loadEnvFile", () => {
  describe("file not found", () => {
    it("returns filePath: null when file does not exist", () => {
      const result = loadEnvFile("/nonexistent/.env");
      expect(result.filePath).toBeNull();
      expect(result.loaded).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });
  });

  describe("basic parsing", () => {
    it("loads a simple KEY=value pair", () => {
      track("TEST_SIMPLE_KEY");
      delete process.env["TEST_SIMPLE_KEY"];
      writeEnv("TEST_SIMPLE_KEY=hello\n");
      const result = loadEnvFile(envPath);
      expect(result.loaded).toContain("TEST_SIMPLE_KEY");
      expect(process.env["TEST_SIMPLE_KEY"]).toBe("hello");
    });

    it("loads double-quoted values with spaces", () => {
      track("TEST_QUOTED_KEY");
      delete process.env["TEST_QUOTED_KEY"];
      writeEnv('TEST_QUOTED_KEY="hello world"\n');
      loadEnvFile(envPath);
      expect(process.env["TEST_QUOTED_KEY"]).toBe("hello world");
    });

    it("loads single-quoted values", () => {
      track("TEST_SINGLE_QUOTED");
      delete process.env["TEST_SINGLE_QUOTED"];
      writeEnv("TEST_SINGLE_QUOTED='single quotes'\n");
      loadEnvFile(envPath);
      expect(process.env["TEST_SINGLE_QUOTED"]).toBe("single quotes");
    });

    it("strips inline comments", () => {
      track("TEST_INLINE_COMMENT");
      delete process.env["TEST_INLINE_COMMENT"];
      writeEnv("TEST_INLINE_COMMENT=value  # this is a comment\n");
      loadEnvFile(envPath);
      expect(process.env["TEST_INLINE_COMMENT"]).toBe("value");
    });

    it("loads empty value", () => {
      track("TEST_EMPTY_VAL");
      delete process.env["TEST_EMPTY_VAL"];
      writeEnv("TEST_EMPTY_VAL=\n");
      loadEnvFile(envPath);
      expect(process.env["TEST_EMPTY_VAL"]).toBe("");
    });

    it("strips optional export prefix", () => {
      track("TEST_EXPORT_KEY");
      delete process.env["TEST_EXPORT_KEY"];
      writeEnv("export TEST_EXPORT_KEY=exported\n");
      loadEnvFile(envPath);
      expect(process.env["TEST_EXPORT_KEY"]).toBe("exported");
    });
  });

  describe("skipping logic", () => {
    it("skips full-line comments starting with #", () => {
      track("TEST_AFTER_COMMENT");
      delete process.env["TEST_AFTER_COMMENT"];
      writeEnv("# comment\nTEST_AFTER_COMMENT=visible\n");
      const result = loadEnvFile(envPath);
      expect(result.loaded).toContain("TEST_AFTER_COMMENT");
      expect(result.loaded).not.toContain("#");
    });

    it("skips blank lines", () => {
      track("TEST_BLANK_LINES");
      delete process.env["TEST_BLANK_LINES"];
      writeEnv("\n\nTEST_BLANK_LINES=ok\n\n");
      const result = loadEnvFile(envPath);
      expect(result.loaded).toContain("TEST_BLANK_LINES");
    });

    it("does not overwrite existing process.env variables by default", () => {
      process.env["TEST_EXISTING_VAR"] = "original";
      track("TEST_EXISTING_VAR");
      writeEnv("TEST_EXISTING_VAR=override\n");
      const result = loadEnvFile(envPath);
      expect(result.skipped).toContain("TEST_EXISTING_VAR");
      expect(process.env["TEST_EXISTING_VAR"]).toBe("original");
    });

    it("overwrites existing variables when override=true", () => {
      process.env["TEST_OVERRIDE_VAR"] = "original";
      track("TEST_OVERRIDE_VAR");
      writeEnv("TEST_OVERRIDE_VAR=new-value\n");
      loadEnvFile(envPath, true);
      expect(process.env["TEST_OVERRIDE_VAR"]).toBe("new-value");
    });
  });

  describe("multiple keys", () => {
    it("loads multiple KEY=VALUE pairs", () => {
      track("TEST_MULTI_A", "TEST_MULTI_B", "TEST_MULTI_C");
      delete process.env["TEST_MULTI_A"];
      delete process.env["TEST_MULTI_B"];
      delete process.env["TEST_MULTI_C"];
      writeEnv("TEST_MULTI_A=a\nTEST_MULTI_B=b\nTEST_MULTI_C=c\n");
      const result = loadEnvFile(envPath);
      expect(result.loaded).toHaveLength(3);
      expect(process.env["TEST_MULTI_A"]).toBe("a");
      expect(process.env["TEST_MULTI_B"]).toBe("b");
      expect(process.env["TEST_MULTI_C"]).toBe("c");
    });
  });

  describe("result shape", () => {
    it("returns the resolved filePath on success", () => {
      track("TEST_FILE_PATH_KEY");
      delete process.env["TEST_FILE_PATH_KEY"];
      writeEnv("TEST_FILE_PATH_KEY=1\n");
      const result = loadEnvFile(envPath);
      expect(result.filePath).toBe(envPath);
    });

    it("loaded array contains all successfully loaded keys", () => {
      track("TEST_RESULT_A", "TEST_RESULT_B");
      delete process.env["TEST_RESULT_A"];
      delete process.env["TEST_RESULT_B"];
      writeEnv("TEST_RESULT_A=1\nTEST_RESULT_B=2\n");
      const result = loadEnvFile(envPath);
      expect(result.loaded).toEqual(expect.arrayContaining(["TEST_RESULT_A", "TEST_RESULT_B"]));
    });
  });
});
