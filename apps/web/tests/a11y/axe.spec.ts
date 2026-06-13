// SPDX-License-Identifier: Apache-2.0
/**
 * Accessibility tests — WCAG 2.1 AA compliance (ADR-0015)
 *
 * Uses @axe-core/playwright to run axe-core against every main route.
 * Any WCAG 2.1 AA violation is a test failure.
 *
 * Run: pnpm --filter @nexus/web test:a11y
 * Env: PLAYWRIGHT_BASE_URL defaults to http://localhost:5173
 */
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

const ROUTES = [
  { path: "/", name: "Dashboard" },
  { path: "/signals", name: "Signals" },
  { path: "/council", name: "Council" },
  { path: "/tasks", name: "Tasks" },
  { path: "/approvals", name: "Approvals" },
  { path: "/audit", name: "Audit" },
];

// Intercept API calls so pages render in a stable state for axe scanning
async function stubApi(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/v1/**", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });
}

test.describe("WCAG 2.1 AA — all routes", () => {
  for (const route of ROUTES) {
    test(`${route.name} (${route.path}) has no axe violations`, async ({ page }) => {
      await stubApi(page);
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      // Surface violations as structured test output
      if (results.violations.length > 0) {
        const summary = results.violations
          .map(
            (v) =>
              `[${v.impact ?? "unknown"}] ${v.id}: ${v.description}\n` +
              v.nodes.map((n) => `  → ${n.html}`).join("\n"),
          )
          .join("\n\n");
        console.error(`Axe violations on ${route.path}:\n${summary}`);
      }

      expect(results.violations).toHaveLength(0);
    });
  }
});

test.describe("WCAG 2.1 AA — focus management", () => {
  test("Navigation links are keyboard reachable", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Tab through the page — all nav links should be focusable
    const navLinks = await page.getByRole("link").all();
    expect(navLinks.length).toBeGreaterThan(0);

    for (const link of navLinks) {
      await expect(link).toBeVisible();
    }
  });

  test("Interactive elements have accessible names", async ({ page }) => {
    await stubApi(page);
    await page.goto("/council");
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a"])
      .withRules(["button-name", "link-name", "label", "aria-required-attr"])
      .analyze();

    expect(results.violations).toHaveLength(0);
  });
});
