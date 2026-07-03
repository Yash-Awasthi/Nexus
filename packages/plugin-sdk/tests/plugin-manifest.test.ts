// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  validatePluginManifest,
  loadPlugin,
  PluginManifestError,
  KNOWN_CAPABILITIES,
  type PluginManifest,
} from "../src/index.js";

const VALID: PluginManifest = {
  id: "com.acme.summarizer",
  name: "Acme Summarizer",
  version: "1.2.3",
  entry: "./dist/plugin.js",
  capabilities: ["llm.inference", "storage.read"],
  description: "Summarizes documents",
  author: "Acme",
  license: "Apache-2.0",
  config: [{ key: "apiKey", secret: true, required: true }],
  minHostVersion: "0.1.0",
};

// ── validatePluginManifest ────────────────────────────────────────────────────

describe("validatePluginManifest", () => {
  it("accepts a well-formed manifest and returns a typed copy", () => {
    const m = validatePluginManifest(VALID);
    expect(m.id).toBe("com.acme.summarizer");
    expect(m.capabilities).toEqual(["llm.inference", "storage.read"]);
    expect(m.config?.[0]?.key).toBe("apiKey");
  });

  it("accepts a minimal manifest (no optional fields)", () => {
    const m = validatePluginManifest({
      id: "acme-tool",
      name: "Tool",
      version: "0.0.1",
      entry: "index.js",
      capabilities: [],
    });
    expect(m.description).toBeUndefined();
    expect(m.capabilities).toEqual([]);
  });

  it("collects ALL issues, not just the first", () => {
    try {
      validatePluginManifest({ id: "", name: "", version: "nope", entry: "", capabilities: "x" });
      expect.unreachable();
    } catch (e) {
      const err = e as PluginManifestError;
      expect(err.code).toBe("INVALID_MANIFEST");
      expect(err.issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("rejects a non-SemVer version", () => {
    expect(() => validatePluginManifest({ ...VALID, version: "1.2" })).toThrow(PluginManifestError);
  });

  it("rejects an invalid plugin id", () => {
    expect(() => validatePluginManifest({ ...VALID, id: "Bad Id!" })).toThrow(PluginManifestError);
  });

  it("rejects an unknown capability", () => {
    try {
      validatePluginManifest({ ...VALID, capabilities: ["llm.inference", "root.access"] });
      expect.unreachable();
    } catch (e) {
      expect((e as PluginManifestError).issues.some((i) => i.includes("root.access"))).toBe(true);
    }
  });

  it("rejects duplicate capabilities", () => {
    expect(() =>
      validatePluginManifest({ ...VALID, capabilities: ["storage.read", "storage.read"] }),
    ).toThrow(PluginManifestError);
  });

  it("rejects a config entry without a key", () => {
    expect(() =>
      validatePluginManifest({ ...VALID, config: [{ description: "no key" }] }),
    ).toThrow(PluginManifestError);
  });

  it("every KNOWN_CAPABILITIES value validates", () => {
    const m = validatePluginManifest({
      id: "cap-probe",
      name: "Cap Probe",
      version: "1.0.0",
      entry: "e.js",
      capabilities: [...KNOWN_CAPABILITIES],
    });
    expect(m.capabilities).toHaveLength(KNOWN_CAPABILITIES.length);
  });
});

// ── loadPlugin ────────────────────────────────────────────────────────────────

describe("loadPlugin", () => {
  it("loads when every requested capability is granted", () => {
    const loaded = loadPlugin(VALID, {
      grantedCapabilities: ["llm.inference", "storage.read", "search.web"],
    });
    expect(loaded.manifest.id).toBe("com.acme.summarizer");
    expect(loaded.grantedCapabilities).toEqual(["llm.inference", "storage.read"]);
  });

  it("fails closed when a requested capability is not granted", () => {
    try {
      loadPlugin(VALID, { grantedCapabilities: ["llm.inference"] }); // storage.read missing
      expect.unreachable();
    } catch (e) {
      const err = e as PluginManifestError;
      expect(err.code).toBe("CAPABILITY_NOT_GRANTED");
      expect(err.issues).toEqual(["storage.read"]);
    }
  });

  it("grants nothing by default — only zero-capability plugins load", () => {
    expect(() => loadPlugin(VALID)).toThrow(PluginManifestError);
    const zeroCap = loadPlugin({
      id: "noop",
      name: "Noop",
      version: "1.0.0",
      entry: "n.js",
      capabilities: [],
    });
    expect(zeroCap.grantedCapabilities).toEqual([]);
  });

  it("validates before checking grants (bad manifest → INVALID_MANIFEST)", () => {
    try {
      loadPlugin({ id: "x", name: "X", version: "bad", entry: "e", capabilities: [] });
      expect.unreachable();
    } catch (e) {
      expect((e as PluginManifestError).code).toBe("INVALID_MANIFEST");
    }
  });
});
