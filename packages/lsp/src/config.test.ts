// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LSP_CONFIG, parseLspConfig, splitCommand } from "./config.ts";

describe("splitCommand", () => {
  it("keeps a quoted executable path with spaces as one argv", () => {
    expect(
      splitCommand(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\srv\\server.js" --stdio',
      ),
    ).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files\\srv\\server.js",
      "--stdio",
    ]);
  });

  it("does not interpret shell metacharacters", () => {
    expect(splitCommand("node server.js; rm -rf / && echo pwned")).toEqual([
      "node",
      "server.js;",
      "rm",
      "-rf",
      "/",
      "&&",
      "echo",
      "pwned",
    ]);
  });

  it("collapses runs of whitespace and rejects an unterminated quote", () => {
    expect(splitCommand("  gopls   --logfile  x  ")).toEqual(["gopls", "--logfile", "x"]);
    expect(() => splitCommand('"C:\\Program Files\\gopls')).toThrow(/unterminated/);
  });
});

describe("parseLspConfig", () => {
  it("uses the Appendix A.1 defaults for an empty environment", () => {
    expect(parseLspConfig({})).toEqual(DEFAULT_LSP_CONFIG);
  });

  it("reads commands, roots and limits from NEXUS_LSP_*", () => {
    const config = parseLspConfig({
      NEXUS_LSP_TYPESCRIPT_CMD: '"C:\\Program Files\\nodejs\\node.exe" server.js --stdio',
      NEXUS_LSP_PYTHON_CMD: "pyright-langserver --stdio --verbose",
      NEXUS_LSP_ROOTS: "C:\\work;C:\\other, /srv/repo",
      NEXUS_LSP_MAX_SERVERS: "3",
      NEXUS_LSP_IDLE_MS: "1000",
      NEXUS_LSP_START_TIMEOUT_MS: "250",
      NEXUS_LSP_REQUEST_TIMEOUT_MS: "125",
      NEXUS_LSP_DIAGNOSTICS_WAIT_MS: "50",
      NEXUS_LSP_MAX_MEMORY_MB: "512",
      NEXUS_LSP_MAX_DOCUMENTS: "7",
      NEXUS_LSP_MAX_FILE_BYTES: "2048",
      NEXUS_LSP_LOG: "debug",
    });

    expect(config.commands.typescript).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["server.js", "--stdio"],
    });
    expect(config.commands.python.args).toEqual(["--stdio", "--verbose"]);
    expect(config.roots).toEqual(["C:\\work", "C:\\other", "/srv/repo"]);
    expect(config).toMatchObject({
      maxServers: 3,
      idleMs: 1_000,
      startTimeoutMs: 250,
      requestTimeoutMs: 125,
      diagnosticsWaitMs: 50,
      maxMemoryMb: 512,
      maxDocuments: 7,
      maxFileBytes: 2_048,
      log: "debug",
    });
  });

  it("falls back on invalid numbers and unknown log levels", () => {
    const config = parseLspConfig({
      NEXUS_LSP_MAX_SERVERS: "zero",
      NEXUS_LSP_IDLE_MS: "-5",
      NEXUS_LSP_LOG: "verbose",
    });
    expect(config.maxServers).toBe(DEFAULT_LSP_CONFIG.maxServers);
    expect(config.idleMs).toBe(DEFAULT_LSP_CONFIG.idleMs);
    expect(config.log).toBe("off");
  });
});
