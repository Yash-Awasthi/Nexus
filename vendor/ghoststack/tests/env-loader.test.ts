import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadEnvFile, loadEnvFromRoot } from "../runtime/env-loader";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gs-env-test-"));
}

function writeEnvFile(dir: string, content: string): string {
  const p = path.join(dir, ".env");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function cleanEnvKeys(...keys: string[]): void {
  for (const k of keys) {
    delete process.env[k];
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EnvLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("basic parsing", () => {
    it("loads simple KEY=VALUE pairs", () => {
      cleanEnvKeys("GS_TEST_FOO", "GS_TEST_BAR");
      const p = writeEnvFile(tmpDir, "GS_TEST_FOO=hello\nGS_TEST_BAR=world\n");
      const result = loadEnvFile(p);
      expect(process.env.GS_TEST_FOO).toBe("hello");
      expect(process.env.GS_TEST_BAR).toBe("world");
      expect(result.loaded).toContain("GS_TEST_FOO");
      expect(result.loaded).toContain("GS_TEST_BAR");
      cleanEnvKeys("GS_TEST_FOO", "GS_TEST_BAR");
    });

    it("strips full-line comments", () => {
      cleanEnvKeys("GS_TEST_COMMENT_A");
      const p = writeEnvFile(tmpDir, "# This is a comment\nGS_TEST_COMMENT_A=visible\n");
      loadEnvFile(p);
      expect(process.env.GS_TEST_COMMENT_A).toBe("visible");
      cleanEnvKeys("GS_TEST_COMMENT_A");
    });

    it("strips inline trailing comments", () => {
      cleanEnvKeys("GS_TEST_INLINE");
      const p = writeEnvFile(tmpDir, "GS_TEST_INLINE=value  # inline comment\n");
      loadEnvFile(p);
      expect(process.env.GS_TEST_INLINE).toBe("value");
      cleanEnvKeys("GS_TEST_INLINE");
    });

    it("handles double-quoted values with spaces", () => {
      cleanEnvKeys("GS_TEST_QUOTED");
      const p = writeEnvFile(tmpDir, 'GS_TEST_QUOTED="hello world"\n');
      loadEnvFile(p);
      expect(process.env.GS_TEST_QUOTED).toBe("hello world");
      cleanEnvKeys("GS_TEST_QUOTED");
    });

    it("handles single-quoted values", () => {
      cleanEnvKeys("GS_TEST_SINGLE");
      const p = writeEnvFile(tmpDir, "GS_TEST_SINGLE='quoted value'\n");
      loadEnvFile(p);
      expect(process.env.GS_TEST_SINGLE).toBe("quoted value");
      cleanEnvKeys("GS_TEST_SINGLE");
    });

    it("handles empty values", () => {
      cleanEnvKeys("GS_TEST_EMPTY");
      const p = writeEnvFile(tmpDir, "GS_TEST_EMPTY=\n");
      loadEnvFile(p);
      expect(process.env.GS_TEST_EMPTY).toBe("");
      cleanEnvKeys("GS_TEST_EMPTY");
    });

    it("strips optional export prefix", () => {
      cleanEnvKeys("GS_TEST_EXPORT");
      const p = writeEnvFile(tmpDir, "export GS_TEST_EXPORT=exported\n");
      loadEnvFile(p);
      expect(process.env.GS_TEST_EXPORT).toBe("exported");
      cleanEnvKeys("GS_TEST_EXPORT");
    });

    it("skips blank lines", () => {
      cleanEnvKeys("GS_TEST_BLANK_A", "GS_TEST_BLANK_B");
      const p = writeEnvFile(tmpDir, "\nGS_TEST_BLANK_A=1\n\nGS_TEST_BLANK_B=2\n\n");
      const result = loadEnvFile(p);
      expect(result.loaded).toHaveLength(2);
      cleanEnvKeys("GS_TEST_BLANK_A", "GS_TEST_BLANK_B");
    });

    it("skips lines without equals sign", () => {
      cleanEnvKeys("GS_TEST_NOEQ");
      const p = writeEnvFile(tmpDir, "NOTANASSIGNMENT\nGS_TEST_NOEQ=ok\n");
      loadEnvFile(p);
      expect(process.env.GS_TEST_NOEQ).toBe("ok");
      cleanEnvKeys("GS_TEST_NOEQ");
    });
  });

  describe("override behaviour", () => {
    it("does NOT override already-set env vars by default", () => {
      process.env.GS_TEST_NOOVERRIDE = "original";
      const p = writeEnvFile(tmpDir, "GS_TEST_NOOVERRIDE=new\n");
      loadEnvFile(p);
      expect(process.env.GS_TEST_NOOVERRIDE).toBe("original");
      cleanEnvKeys("GS_TEST_NOOVERRIDE");
    });

    it("skips key is reported in result.skipped", () => {
      process.env.GS_TEST_SKIP_REPORT = "original";
      const p = writeEnvFile(tmpDir, "GS_TEST_SKIP_REPORT=new\n");
      const result = loadEnvFile(p);
      expect(result.skipped).toContain("GS_TEST_SKIP_REPORT");
      cleanEnvKeys("GS_TEST_SKIP_REPORT");
    });

    it("overrides when override=true is passed", () => {
      process.env.GS_TEST_OVERRIDE_FORCED = "old";
      const p = writeEnvFile(tmpDir, "GS_TEST_OVERRIDE_FORCED=new\n");
      loadEnvFile(p, true);
      expect(process.env.GS_TEST_OVERRIDE_FORCED).toBe("new");
      cleanEnvKeys("GS_TEST_OVERRIDE_FORCED");
    });
  });

  describe("file handling", () => {
    it("returns filePath=null when file does not exist", () => {
      const result = loadEnvFile(path.join(tmpDir, "does-not-exist.env"));
      expect(result.filePath).toBeNull();
      expect(result.loaded).toHaveLength(0);
    });

    it("returns correct filePath when file exists", () => {
      cleanEnvKeys("GS_TEST_PATH_CHECK");
      const p = writeEnvFile(tmpDir, "GS_TEST_PATH_CHECK=1\n");
      const result = loadEnvFile(p);
      expect(result.filePath).toBe(p);
      cleanEnvKeys("GS_TEST_PATH_CHECK");
    });
  });

  describe("loadEnvFromRoot", () => {
    it("loads .env from the repo root directory", () => {
      cleanEnvKeys("GS_TEST_ROOT_KEY");
      fs.writeFileSync(path.join(tmpDir, ".env"), "GS_TEST_ROOT_KEY=rootval\n", "utf8");
      loadEnvFromRoot(tmpDir);
      expect(process.env.GS_TEST_ROOT_KEY).toBe("rootval");
      cleanEnvKeys("GS_TEST_ROOT_KEY");
    });

    it("returns loaded=0 when no .env exists in root", () => {
      const result = loadEnvFromRoot(tmpDir);
      expect(result.filePath).toBeNull();
      expect(result.loaded).toHaveLength(0);
    });
  });

  describe("runtime propagation", () => {
    it("variables written to .env propagate into process.env for runtime-context consumption", () => {
      // Simulates the pattern used in createRuntimeContext():
      //   loadEnvFromRoot(repoRoot) → process.env.GHOSTSTACK_OFFLINE_MODE etc.
      cleanEnvKeys("GHOSTSTACK_OFFLINE_MODE", "GHOSTSTACK_API_PORT", "GS_TEST_CUSTOM_VAR");

      fs.writeFileSync(
        path.join(tmpDir, ".env"),
        [
          "GHOSTSTACK_OFFLINE_MODE=1",
          "GHOSTSTACK_API_PORT=9999",
          "GS_TEST_CUSTOM_VAR=propagated"
        ].join("\n") + "\n",
        "utf8"
      );

      const result = loadEnvFromRoot(tmpDir);

      // All three vars must be in process.env after loading
      expect(process.env.GHOSTSTACK_OFFLINE_MODE).toBe("1");
      expect(process.env.GHOSTSTACK_API_PORT).toBe("9999");
      expect(process.env.GS_TEST_CUSTOM_VAR).toBe("propagated");

      // Result metadata should list all loaded keys
      expect(result.loaded).toContain("GHOSTSTACK_OFFLINE_MODE");
      expect(result.loaded).toContain("GHOSTSTACK_API_PORT");
      expect(result.loaded).toContain("GS_TEST_CUSTOM_VAR");
      expect(result.filePath).not.toBeNull();

      cleanEnvKeys("GHOSTSTACK_OFFLINE_MODE", "GHOSTSTACK_API_PORT", "GS_TEST_CUSTOM_VAR");
    });

    it("pre-existing process.env values are not overwritten by .env (existing vars always win)", () => {
      // runtime-context calls loadEnvFromRoot which calls loadEnvFile — existing env vars win
      process.env.GS_TEST_PRIORITY = "original";
      fs.writeFileSync(path.join(tmpDir, ".env"), "GS_TEST_PRIORITY=from-file\n", "utf8");

      loadEnvFromRoot(tmpDir);

      expect(process.env.GS_TEST_PRIORITY).toBe("original");
      cleanEnvKeys("GS_TEST_PRIORITY");
    });
  });
});
