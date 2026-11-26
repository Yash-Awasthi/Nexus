// SPDX-License-Identifier: Apache-2.0
/** `nexus doctor` reports each prerequisite with the fix, and never throws. */
import { describe, expect, it } from "vite-plus/test";

import { collectDoctor, formatDoctor, type DoctorDeps } from "../../src/lib/doctor.ts";

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    run: async (command, args) => {
      if (command === "pnpm") return "12.21.0\n";
      if (command === "docker") return args[0] === "--version" ? "Docker version 28.0.0\n" : "[]";
      return undefined;
    },
    tcp: async () => true,
    fetchJson: async () => ({ models: [{ name: "qwen2.5:7b" }] }),
    ...overrides,
  };
}

describe("collectDoctor", () => {
  it("passes with embedded stores and a local model", async () => {
    const rows = await collectDoctor({}, deps());
    const failed = rows.filter((row) => row.status === "fail");
    expect(failed).toEqual([]);
    expect(rows.find((row) => row.name === "postgres")?.detail).toContain("PGlite");
    expect(rows.find((row) => row.name === "model")?.detail).toBe("qwen2.5:7b");
  });

  it("fails Docker and Ollama separately and carries the fix", async () => {
    const rows = await collectDoctor(
      {},
      deps({
        run: async (command) => (command === "pnpm" ? "12.21.0\n" : undefined),
        fetchJson: async () => undefined,
      }),
    );
    const status = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(status.docker?.status).toBe("fail");
    expect(status.docker?.fix).toContain("Docker Desktop");
    expect(status.ollama?.status).toBe("fail");
    expect(status["sandbox image"]?.status).toBe("warn");
  });

  it("checks a server DATABASE_URL over TCP", async () => {
    const rows = await collectDoctor(
      { DATABASE_URL: "postgresql://u:p@db.internal:6543/nexus" },
      deps({ tcp: async (host, port) => host === "db.internal" && port === 6543 }),
    );
    expect(rows.find((row) => row.name === "postgres")?.status).toBe("ok");
  });
});

describe("formatDoctor", () => {
  it("marks ok, warn and fail and appends fixes", () => {
    const text = formatDoctor([
      { name: "node", status: "ok", detail: "v26" },
      { name: "docker", status: "fail", detail: "not found", fix: "install it" },
      { name: "model", status: "warn", detail: "missing", fix: "pull it" },
    ]);
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("✓ node");
    expect(text).toContain("✗ docker");
    expect(text).toContain("fix: install it");
    expect(text).toContain("fix: pull it");
  });
});
