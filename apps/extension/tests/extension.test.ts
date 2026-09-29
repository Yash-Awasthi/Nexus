// SPDX-License-Identifier: Apache-2.0
/** The browser extension ships the server's widget unchanged and asks for no standing host access. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const dir = resolve(__dirname, "..");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("browser extension", () => {
  it("carries the same widget the server hosts", () => {
    expect(read(join(dir, "widget.js"))).toBe(read(resolve(dir, "../ui/public/widget.js")));
  });

  it("is a Manifest V3 popup that asks for a host only when one is configured", () => {
    const manifest = JSON.parse(read(join(dir, "manifest.json"))) as {
      manifest_version: number;
      action: { default_popup: string };
      permissions: string[];
      host_permissions?: string[];
      optional_host_permissions: string[];
    };
    expect(manifest.manifest_version).toBe(3);
    expect(existsSync(join(dir, manifest.action.default_popup))).toBe(true);
    expect(manifest.permissions.sort()).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    const popup = read(join(dir, manifest.action.default_popup));
    for (const src of popup.matchAll(/src="([^"]+)"/g)) {
      expect(src[1]).not.toMatch(/^https?:/);
      expect(existsSync(join(dir, src[1]!))).toBe(true);
    }
  });
});
