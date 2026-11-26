// SPDX-License-Identifier: Apache-2.0
/**
 * The sandbox's declared matrix, and the resource report attached to a run.
 *
 * The matrix's whole value is that it is *true*, so the first test reads the Dockerfile and
 * compares the pinned build args with the versions this file declares. A drift there means a
 * user pinning `ruby 3.4.13` gets 3.5 and never finds out, which is worse than no matrix.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  IMAGE_VERSIONS,
  languageMatrix,
  pyodideVersion,
  resourceReport,
  sampleMemory,
} from "../../src/lib/sandbox-matrix.ts";

const DOCKERFILE = path.resolve(__dirname, "../../../../infra/sandbox/Dockerfile");

const BASE = {
  nodeVersion: "26.1.0",
  pyodideVersion: "0.28.3",
  pistonAvailable: false,
  dockerAvailable: true,
  languages: ["javascript", "typescript", "python", "bash", "go", "rust", "ruby"],
} as const;

describe("the matrix agrees with the image", () => {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
  const arg = (name: string): string | undefined =>
    dockerfile.match(new RegExp(`ARG ${name}=([^\\s]+)`))?.[1];

  it("pins the same Go, Rust and Ruby versions the Dockerfile builds", () => {
    expect(arg("GO_VERSION")).toBe(IMAGE_VERSIONS.go);
    expect(arg("RUST_VERSION")).toBe(IMAGE_VERSIONS.rust);
    expect(arg("RUBY_VERSION")).toBe(IMAGE_VERSIONS.ruby);
  });

  it("pins the same Node major as the image's base", () => {
    const node = dockerfile.match(/FROM node:(\d+)/)?.[1];
    expect(node).toBe(IMAGE_VERSIONS.node);
  });
});

describe("the matrix, per language", () => {
  it("names the running interpreter for JavaScript", () => {
    const [js] = languageMatrix({ ...BASE, languages: ["javascript"] });
    expect(js).toMatchObject({
      language: "javascript",
      version: "26.1.0",
      via: "vm",
      serverRuns: true,
      pin: "node 26.1.0",
    });
  });

  it("names the Pyodide version for Python, and admits when it cannot", () => {
    const [python] = languageMatrix({ ...BASE, languages: ["python"] });
    expect(python).toMatchObject({ via: "pyodide", serverRuns: true, version: "0.28.3" });
    expect(python!.pin).toBe("pyodide 0.28.3");

    const [unknown] = languageMatrix({ ...BASE, pyodideVersion: null, languages: ["python"] });
    expect(unknown!.version).toBeNull();
    expect(unknown!.pin).toContain("unreadable");
  });

  it("reports Piston as the runtime when it is configured, without inventing a version", () => {
    const pins = languageMatrix({ ...BASE, pistonAvailable: true });
    for (const pin of pins) {
      if (pin.language === "javascript") continue;
      expect(pin.via, pin.language).toBe("piston");
      expect(pin.serverRuns, pin.language).toBe(true);
      expect(pin.pin, pin.language).toBe("piston");
      expect(pin.version, pin.language).toBeNull();
    }
  });

  it("distinguishes a language the server runs from one the browser's helper runs", () => {
    const pins = languageMatrix(BASE);
    const byLanguage = new Map(pins.map((pin) => [pin.language, pin]));
    // The image languages run on the viewer's machine, so the server must not claim them.
    expect(byLanguage.get("go")).toMatchObject({ via: "sandbox-helper", serverRuns: false });
    expect(byLanguage.get("rust")!.pin).toBe(`rust ${IMAGE_VERSIONS.rust} in the sandbox image`);
    expect(byLanguage.get("bash")!.serverRuns).toBe(false);
    // Python is the exception: Pyodide runs in this process.
    expect(byLanguage.get("python")!.serverRuns).toBe(true);
  });

  it("says 'unpinned' for a language it has not been taught, rather than guessing", () => {
    const [odd] = languageMatrix({ ...BASE, languages: ["cobol"] });
    expect(odd).toMatchObject({ language: "cobol", version: null, pin: "unpinned" });
  });

  it("reads the installed Pyodide version, or null when it is not installed", () => {
    const version = pyodideVersion();
    // Installed in this workspace, so it is a string — and a string that looks like a version.
    expect(version === null || /^\d+\.\d+/.test(version)).toBe(true);
  });
});

describe("the resource report", () => {
  it("sums user and system CPU, and measures the wall clock", () => {
    const report = resourceReport({
      startedAt: 1_000,
      cpu: { user: 12_000, system: 3_000 },
      peakRssBytes: 4_500_000,
      now: 1_250,
    });
    expect(report).toEqual({
      cpuMs: 15,
      peakRssBytes: 4_500_000,
      wallMs: 250,
      method: "sampled",
    });
  });

  it("never reports a negative wall time or memory, even if the clock moves", () => {
    const report = resourceReport({
      startedAt: 2_000,
      cpu: { user: 0, system: 0 },
      peakRssBytes: -1,
      now: 1_000,
    });
    expect(report.wallMs).toBe(0);
    expect(report.peakRssBytes).toBe(0);
  });

  it("samples memory without holding the process open", () => {
    const sampler = sampleMemory(5);
    const measured = sampler.stop();
    // Stopping twice is safe, and the figure is a non-negative number of bytes.
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(typeof sampler.stop()).toBe("number");
  });
});
