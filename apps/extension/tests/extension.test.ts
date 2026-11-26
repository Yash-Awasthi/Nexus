// SPDX-License-Identifier: Apache-2.0
/** The browser extension ships the server's widget unchanged and asks for no standing host access. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

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

  it("loads the attachment code before the popup that uses it", () => {
    const popup = read(join(dir, "popup.html"));
    const scripts = [...popup.matchAll(/src="([^"]+)"/g)].map((m) => m[1]!);
    expect(scripts.indexOf("context.js")).toBeGreaterThanOrEqual(0);
    expect(scripts.indexOf("context.js")).toBeLessThan(scripts.indexOf("popup.js"));
    // An element the popup addresses must exist, or the popup fails on the first click.
    for (const id of ["attach", "chip", "chip-label", "chip-url", "remove"]) {
      expect(popup).toContain(`id="${id}"`);
    }
  });
});

describe("attaching the current page", () => {
  /** context.js is a classic script: it publishes itself on the global object. */
  const load = async () => {
    await import(pathToFileURL(join(dir, "context.js")).href);
    return (globalThis as unknown as { NexusContext: Record<string, (...args: never[]) => unknown> })
      .NexusContext as unknown as {
      LIMITS: { title: number; url: number; selection: number };
      acceptableUrl: (url: unknown) => string | null;
      attachPage: (chrome: unknown, tabId: unknown) => Promise<{
        title: string;
        url: string;
        selection: string;
      } | null>;
      attachmentLabel: (page: { title?: string; url: string; selection?: string } | null) => string;
      canAttach: (url: string) => boolean;
      captureFunc: () => { title: string; url: string; selection: string };
      pageFrom: (raw: unknown) => { title: string; url: string; selection: string } | null;
    };
  };

  it("nothing is read until a click asks for it", async () => {
    const api = await load();
    let calls = 0;
    const chrome = {
      scripting: {
        executeScript: async () => {
          calls += 1;
          return [{ result: { title: "T", url: "https://example.com/a", selection: "" } }];
        },
      },
    };
    // Loading the module performed no capture: the cost of the permission is paid on demand.
    expect(calls).toBe(0);

    const page = await api.attachPage(chrome, 7);
    expect(calls).toBe(1);
    expect(page).toEqual({ title: "T", url: "https://example.com/a", selection: "" });
  });

  it("reads the title, the URL and the selection from the page", async () => {
    const api = await load();
    const globals = globalThis as unknown as {
      window?: unknown;
      document: { title: string };
      location: { href: string };
      getSelection: () => string;
    };
    const saved = {
      window: globals.window,
      document: globals.document,
      location: globals.location,
      getSelection: globals.getSelection,
    };
    try {
      globals.window = { getSelection: () => "selected words" };
      globals.document = { title: "Status page" };
      globals.location = { href: "https://example.com/status" };
      globals.getSelection = () => "selected words";
      expect(api.captureFunc()).toEqual({
        title: "Status page",
        url: "https://example.com/status",
        selection: "selected words",
      });
    } finally {
      Object.assign(globals, saved);
    }
  });

  it("refuses a page that is not a page", async () => {
    const api = await load();
    for (const url of [
      "chrome://settings",
      "edge://flags",
      "about:blank",
      "devtools://devtools/bundled/x.html",
      "file:///C:/secret.txt",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "",
    ]) {
      expect(api.canAttach(url), url).toBe(false);
      expect(api.pageFrom({ title: "t", url, selection: "" }), url).toBeNull();
    }
    expect(api.canAttach("https://example.com")).toBe(true);
    expect(api.canAttach("http://localhost:3000/x")).toBe(true);
  });

  it("bounds what it sends, so a long page cannot flood a prompt", async () => {
    const api = await load();
    const page = api.pageFrom({
      title: "t".repeat(1_000),
      url: "https://example.com",
      selection: "word ".repeat(5_000),
    })!;
    expect(page.title.length).toBeLessThanOrEqual(api.LIMITS.title + 20);
    expect(page.selection.length).toBeLessThanOrEqual(api.LIMITS.selection + 20);
    expect(page.selection.endsWith("[truncated]")).toBe(true);
  });

  it("describes the attachment in words, and says how much of it there is", async () => {
    const api = await load();
    expect(api.attachmentLabel({ title: "Status page", url: "https://example.com/s", selection: "" })).toBe(
      "Status page",
    );
    expect(
      api.attachmentLabel({ title: "Status page", url: "https://example.com/s", selection: "two words" }),
    ).toBe("Status page — 2 words selected");
    expect(
      api.attachmentLabel({ title: "", url: "https://example.com/s", selection: "one" }),
    ).toBe("example.com — 1 word selected");
    expect(api.attachmentLabel(null)).toBe("");
  });

  it("sends the page with the question only when one was attached", () => {
    const widget = read(join(dir, "widget.js"));
    // The body carries `page` behind a condition, and the transcript shows it beside the question.
    expect(widget).toContain("...(page ? { page } : {})");
    expect(widget).toContain('add("ctx"');
    // And the URL it accepts is the same one the server accepts.
    expect(widget).toContain("/^https?:\\/\\//i.test(String(page.url || \"\"))");
  });
});
