// SPDX-License-Identifier: Apache-2.0
/**
 * Baseline screenshots: every page in the navigation, at phone, tablet and desktop widths, written
 * to `docs/screenshots/before/`.
 *
 * This is the "before" half of the interface-craft method — you cannot say a page improved without a
 * picture of what it looked like, and you cannot review forty pages by remembering them. The "after"
 * half is the same list shot again after a change, and the pair is the review.
 *
 * It is off by default (`NEXUS_CAPTURE_BASELINE=1` enables it) because a test that overwrites the
 * baseline on every run cannot detect a regression: the thing it compares against moves with it.
 *
 *   pnpm --filter @nexus/ui build
 *   NEXUS_CAPTURE_BASELINE=1 pnpm test:e2e baseline-screenshots
 *
 * Output is JPEG at quality 55 with a 1x device scale, because the point is layout and density, not
 * retina detail, and a hundred PNGs would be a repository nobody wants to clone.
 *
 * The capture also records every page error per route and fails on one: a page that logs a hydration
 * mismatch looks fine in a screenshot and re-renders the whole tree in front of the user.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { allNavItems } from "../../app/lib/nav";
import { waitForPaint } from "./fixtures";

const CAPTURE = process.env["NEXUS_CAPTURE_BASELINE"] === "1";
const OUT = path.resolve(process.cwd(), "docs/screenshots/before");
const PASSWORD = "E2e-test-pass!1";
const OWNER = "e2e-shots@example.com";

export const VIEWPORTS = [
  { name: "360", width: 360, height: 800 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const;

/** A page's file name: `/admin/feature-flags` → `admin-feature-flags`. */
export function shotName(route: string): string {
  const trimmed = route.replace(/^\//, "").replace(/\/$/, "");
  return trimmed === "" ? "home" : trimmed.replace(/\//g, "-");
}

/**
 * Pages reached before sign-in, which are not in the navigation for that reason, plus a URL that
 * matches nothing: the not-found page is a page too, and it is the one a mistyped link lands on.
 */
export const PUBLIC_ROUTES = ["/", "/login", "/no-such-page"];

/** Every page the navigation offers, in the order the sidebar shows them. */
export function captureRoutes(): string[] {
  return [...PUBLIC_ROUTES, ...allNavItems().map((item) => item.to)];
}

/** Sign in once per run and put the session where the UI looks for it before any script runs. */
async function session(request: APIRequestContext): Promise<{ token: string; user: unknown }> {
  const base = process.env["NEXUS_E2E_URL"] ?? "http://127.0.0.1:3999";
  let res = await request.post(`${base}/api/v1/auth/register`, {
    data: { email: OWNER, password: PASSWORD, name: "Owner" },
  });
  if (res.status() === 409)
    res = await request.post(`${base}/api/v1/auth/login`, {
      data: { email: OWNER, password: PASSWORD },
    });
  const body = (await res.json()) as { accessToken?: string; user?: unknown };
  if (!body.accessToken) throw new Error(`sign-in failed: ${res.status()}`);
  return { token: body.accessToken, user: body.user ?? {} };
}

async function prepare(page: Page, s: { token: string; user: unknown }): Promise<void> {
  await page.addInitScript(
    ([token, user]) => {
      localStorage.setItem("nexus_token", token);
      localStorage.setItem("nexus_user", user);
      localStorage.setItem("nexus_setup_done", "1");
    },
    [s.token, JSON.stringify({ ...(s.user as object), username: "Owner" })] as const,
  );
}

test.describe("baseline screenshots", () => {
  test.skip(!CAPTURE, "set NEXUS_CAPTURE_BASELINE=1 to capture the baseline");

  const routes = captureRoutes();
  let s: { token: string; user: unknown };

  test.beforeAll(async ({ request }) => {
    s = await session(request);
  });

  for (const viewport of VIEWPORTS) {
    test(`captures ${captureRoutes().length} pages at ${viewport.name}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await prepare(page, s);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      const dir = path.join(OUT, viewport.name);
      await fs.mkdir(dir, { recursive: true });
      const written: string[] = [];
      const problems: string[] = [];

      for (const route of routes) {
        const seen: string[] = [];
        const onError = (error: Error) =>
          seen.push(`pageerror: ${error.message.slice(0, 160)} (${route})`);
        page.on("pageerror", onError);
        await page.goto(route);
        // The same wait the audits use: a signed-in shell holds the notification stream open, so
        // `networkidle` never fires and the capture used to sit out its 30 s timeout on every page.
        await waitForPaint(page);
        const file = path.join(dir, `${shotName(route)}.jpg`);
        await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 55 });
        written.push(path.relative(OUT, file).split(path.sep).join("/"));
        const overflowing = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        if (overflowing > 1) problems.push(`scrolls ${overflowing}px sideways (${route})`);
        page.off("pageerror", onError);
        problems.push(...seen);
      }

      await fs.writeFile(
        path.join(dir, "index.txt"),
        [
          `# Baseline screenshots at ${viewport.width}x${viewport.height}`,
          "# Regenerate: NEXUS_CAPTURE_BASELINE=1 pnpm test:e2e baseline-screenshots",
          ...written,
          "",
        ].join("\n"),
      );
      expect(written.length).toBe(routes.length);
      expect(problems).toEqual([]);
    });
  }
});

test.describe("the capture list itself", () => {
  test("names every page unambiguously and is not empty", () => {
    const names = captureRoutes().map(shotName);
    expect(names.length).toBeGreaterThan(25);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});
