// SPDX-License-Identifier: Apache-2.0
/**
 * The installable shell: a manifest, a service worker that survives an outage, safe-area
 * padding, and a bottom bar on a phone.
 *
 * These are static files, so there is no component to render in a test — the checks here read
 * the files and assert the properties that break silently in production: a manifest the browser
 * will refuse, a worker that caches API responses (which is how a user sees yesterday's data
 * while the app says it is live), a navigation with no offline fallback, and a bottom bar at a
 * breakpoint where it collides with the sidebar.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { isTabActive, MOBILE_TABS } from "../app/components/mobile-nav.tsx";
import { allNavItems } from "../app/lib/nav.ts";

const UI = path.resolve(__dirname, "..");
const read = (relative: string): string => fs.readFileSync(path.join(UI, relative), "utf8");
const publicFile = (name: string): string => fs.readFileSync(path.join(UI, "public", name), "utf8");

describe("the manifest", () => {
  const manifest = JSON.parse(publicFile("manifest.json")) as Record<string, unknown>;

  it("is installable: name, short name, start url, standalone display, theme", () => {
    expect(manifest["name"], "name").toBeTruthy();
    expect(manifest["short_name"], "short_name").toBeTruthy();
    expect(String(manifest["start_url"])).toMatch(/^\//);
    expect(manifest["display"]).toBe("standalone");
    expect(manifest["theme_color"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest["background_color"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("ships an icon the browser will accept", () => {
    const icons = manifest["icons"] as { src: string; sizes: string; type: string }[];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.src).toMatch(/^\//);
      // Every icon the manifest names must exist, or the install prompt is refused.
      expect(
        fs.existsSync(path.join(UI, "public", icon.src.slice(1))),
        `${icon.src} is missing from public/`,
      ).toBe(true);
    }
  });

  it("offers shortcuts that resolve to real routes", () => {
    const shortcuts = (manifest["shortcuts"] ?? []) as { url: string }[];
    const routes = new Set(allNavItems().map((item) => item.to));
    for (const shortcut of shortcuts) expect(routes.has(shortcut.url), shortcut.url).toBe(true);
  });
});

describe("the service worker", () => {
  const sw = publicFile("sw.js");

  it("never caches an API response", () => {
    // The guard is in the fetch handler: anything under /api/ returns before a cache is opened.
    expect(sw).toContain('url.pathname.startsWith("/api/")');
    const guard = sw.slice(sw.indexOf('url.pathname.startsWith("/api/")'));
    expect(guard.slice(0, 60)).toContain("return");
  });

  it("serves the offline shell for a navigation it cannot fulfil", () => {
    expect(sw).toContain('const OFFLINE_URL = "/offline.html"');
    expect(sw).toContain('request.mode === "navigate"');
    expect(sw).toContain("networkFirstThenOffline");
    // The shell page is precached, so the fallback exists before the network does.
    expect(sw).toContain('"/offline.html"');
  });

  it("still refuses to cache anything in development", () => {
    // The dev guard came from a real bug: stale hashed chunks with two React copies.
    expect(sw).toContain("const IS_DEV =");
    expect(sw).toMatch(/if \(IS_DEV\) return;/);
  });

  it("has an offline page that names where the user can go", () => {
    const offline = publicFile("offline.html");
    expect(offline).toContain("You're offline");
    for (const href of ["/dashboard", "/discussion", "/settings"]) {
      expect(offline, href).toContain(`href="${href}"`);
    }
    // It has to stand alone: no bundler, no fonts, no API.
    expect(offline).not.toContain("<script src");
    expect(offline).toContain("env(safe-area-inset-bottom)");
  });
});

describe("the phone layout", () => {
  it("lets the app paint under the notch and keeps controls out of it", () => {
    const root = read("app/root.tsx");
    expect(root).toContain("viewport-fit=cover");
    // Both edges are handled: the status bar at the top, the home indicator at the bottom.
    expect(root).toContain("env(safe-area-inset-top)");
    expect(read("app/components/mobile-nav.tsx")).toContain("env(safe-area-inset-bottom)");
    expect(read("public/offline.html")).toContain("env(safe-area-inset-top)");
  });

  it("shows the bottom bar on a phone and hides it from md up", () => {
    const nav = read("app/components/mobile-nav.tsx");
    expect(nav).toContain("md:hidden");
    expect(nav).toContain('aria-label="Primary"');
    // The drawer stays reachable from the bar.
    expect(nav).toContain("setOpenMobile(true)");
  });

  it("takes its destinations from the navigation registry", () => {
    const nav = read("app/components/mobile-nav.tsx");
    const routes = new Set(allNavItems().map((item) => item.to));
    expect(MOBILE_TABS).toHaveLength(5);
    for (const tab of MOBILE_TABS) {
      expect(routes.has(tab.to), `${tab.to} is not a nav route`).toBe(true);
      expect(nav).toContain(`to: "${tab.to}"`);
    }
  });

  it("knows which tab a nested page belongs to", () => {
    expect(isTabActive("/chat", "/chat/abc")).toBe(true);
    expect(isTabActive("/dashboard", "/dashboard")).toBe(true);
    // A sibling whose name starts with the same letters is not this tab.
    expect(isTabActive("/chat", "/chatty")).toBe(false);
    expect(isTabActive("/knowledge", "/workflows")).toBe(false);
  });

  it("marks the active tab for assistive technology, not only by colour", () => {
    const nav = read("app/components/mobile-nav.tsx");
    expect(nav).toContain('aria-current={active ? "page" : undefined}');
  });
});
