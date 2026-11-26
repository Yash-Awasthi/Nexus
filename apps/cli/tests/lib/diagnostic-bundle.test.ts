// SPDX-License-Identifier: Apache-2.0
/**
 * The diagnostic bundle: what it redacts, and that it says so.
 *
 * A bundle is only useful if someone dares attach it, so the properties tested here are the
 * redaction ones — a key in a message, a password in a URL, a token in a query string, a
 * secret-named field — plus that the file it writes names the version and the removal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  BUNDLE_FILE,
  BUNDLE_README,
  BUNDLE_SCHEMA,
  buildBundle,
  bundleReadme,
  redact,
  redactDeep,
  writeBundle,
} from "../../src/lib/diagnostic-bundle.ts";

describe("redact", () => {
  it("keeps a recognisable prefix of a provider key, and drops the rest", () => {
    const out = redact("config error: sk-proj-abcdef1234567890 is revocable");
    expect(out.text).toBe("config error: sk-REDACTED is revocable");
    expect(out.removed).toEqual(["openai-style key"]);
    expect(out.text).not.toContain("abcdef1234567890");
  });

  it("removes a password from a database URL but keeps the shape", () => {
    const out = redact("cannot connect to postgresql://nexus:hunter2@db.internal:5432/nexus");
    expect(out.text).toBe("cannot connect to postgresql://nexus:REDACTED@db.internal:5432/nexus");
    expect(out.removed).toEqual(["credentials in a URL"]);
  });

  it("removes a token from a query string and a JWT anywhere", () => {
    expect(redact("failed: GET /x?api_key=abc123def&page=2").text).toBe(
      "failed: GET /x?api_key=REDACTED&page=2",
    );
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJlMTIz";
    expect(redact(`bearer ${jwt}`).text).toBe("bearer jwt-REDACTED");
  });

  it("is stable when the same text is redacted twice, and reports nothing for clean text", () => {
    const once = redact("sk-proj-abcdef1234567890").text;
    expect(redact(once)).toMatchObject({ text: "sk-REDACTED", removed: ["openai-style key"] });
    expect(redact("nothing secret here")).toEqual({ text: "nothing secret here", removed: [] });
  });
});

describe("redactDeep", () => {
  it("drops secret-named fields whole and says which", () => {
    const out = redactDeep({ apiKey: "unused-value", token: "x", nested: { secret: 1, ok: 2 } });
    expect(out.value).toEqual({
      apiKey: "REDACTED",
      token: "REDACTED",
      nested: { secret: "REDACTED", ok: 2 },
    });
    expect(out.removed).toEqual(["field:apiKey", "field:secret", "field:token"]);
  });

  it("walks arrays and leaves numbers and booleans alone", () => {
    const out = redactDeep([{ detail: "gsk_abcdefghijklmnop" }, 7, true]);
    expect(out.value).toEqual([{ detail: "gsk-REDACTED" }, 7, true]);
  });
});

describe("buildBundle", () => {
  const base = {
    version: "0.1.0",
    startedAt: "2026-11-24T10:00:00.000Z",
    generatedAt: "2026-11-24T10:05:00.000Z",
    node: "24.1.0",
    platform: "linux",
    arch: "x64",
    doctor: [{ name: "node", status: "ok", detail: "24.1.0" }],
  };

  it("names the schema and the versions, and carries the API documents", () => {
    const bundle = buildBundle({
      ...base,
      status: { status: "ok", rows: [{ name: "postgres", ok: true }] },
      health: { status: "ok", commit: "fc6ed44" },
    });
    expect(bundle.schema).toBe(BUNDLE_SCHEMA);
    expect(bundle.versions).toMatchObject({ nexus: "0.1.0", node: "24.1.0", platform: "linux" });
    expect(bundle.status).toEqual({ status: "ok", rows: [{ name: "postgres", ok: true }] });
    expect(bundle.health).toEqual({ status: "ok", commit: "fc6ed44" });
    expect(bundle.redacted).toEqual([]);
  });

  it("redacts an unreachable status message, so the bundle records the failure without a key", () => {
    const bundle = buildBundle({
      ...base,
      status: { unreachable: "fetch failed for https://u:sk-proj-abcdef1234567890@example.com" },
    });
    // The URL rule wins over the key rule here, which is the safer of the two: the whole
    // password is gone rather than a recognisable prefix of it.
    expect(JSON.stringify(bundle.status)).toContain(":REDACTED@example.com");
    expect(JSON.stringify(bundle)).not.toContain("abcdef1234567890");
    expect(bundle.redacted).toContain("credentials in a URL");
  });

  it("says in the README what was removed, and that a reader should still read it", () => {
    const bundle = buildBundle({ ...base, notes: { msg: "token ghp_abcdefghijklmnopqrst" } });
    const readme = bundleReadme(bundle);
    expect(readme).toContain("github token");
    expect(readme).toMatch(/Read it before attaching it/);
    expect(readme).toContain("No environment dump");
  });
});

describe("writeBundle", () => {
  it("writes both files, creating the directory", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bundle-")), "out");
    const bundle = buildBundle({
      version: "0.1.0",
      startedAt: "2026-11-24T10:00:00.000Z",
      generatedAt: "2026-11-24T10:05:00.000Z",
      node: "24.1.0",
      platform: "linux",
      arch: "x64",
      doctor: [],
    });
    const written = writeBundle(dir, bundle);
    expect(fs.existsSync(written.jsonPath)).toBe(true);
    expect(path.basename(written.jsonPath)).toBe(BUNDLE_FILE);
    expect(path.basename(written.readmePath)).toBe(BUNDLE_README);
    const parsed = JSON.parse(fs.readFileSync(written.jsonPath, "utf8")) as { schema: string };
    expect(parsed.schema).toBe(BUNDLE_SCHEMA);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
});
