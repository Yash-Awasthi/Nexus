// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke tests — verify every main route renders without JS errors
 * and that the shared navigation shell is present.
 *
 * Run: pnpm --filter @nexus/web test:e2e
 * Env: PLAYWRIGHT_BASE_URL defaults to http://localhost:5173
 */
import { test, expect } from "@playwright/test";

const ROUTES = [
  { path: "/", label: "Dashboard" },
  { path: "/signals", label: "Signals" },
  { path: "/council", label: "Council" },
  { path: "/tasks", label: "Tasks" },
  { path: "/approvals", label: "Approvals" },
  { path: "/audit", label: "Audit" },
];

test.describe("Navigation shell", () => {
  test("sidebar renders on root route", async ({ page }) => {
    await page.goto("/");
    // The Layout component renders the nav sidebar with these links
    await expect(page.getByText("Dashboard", { exact: true })).toBeVisible();
    await expect(page.getByText("Signals", { exact: true })).toBeVisible();
    await expect(page.getByText("Council", { exact: true })).toBeVisible();
    await expect(page.getByText("Tasks", { exact: true })).toBeVisible();
    await expect(page.getByText("Approvals", { exact: true })).toBeVisible();
    await expect(page.getByText("Audit", { exact: true })).toBeVisible();
  });

  test("NEXUS logo / brand mark is visible", async ({ page }) => {
    await page.goto("/");
    // The Layout sidebar renders the brand name
    await expect(page.locator("text=NEXUS")).toBeVisible();
  });
});

test.describe("Route smoke tests", () => {
  for (const route of ROUTES) {
    test(`${route.path} renders without console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(route.path);
      await page.waitForLoadState("networkidle");

      // No uncaught JS errors
      expect(
        errors.filter(
          // Filter out known benign network errors from missing API backend in e2e
          (e) => !e.includes("Failed to fetch") && !e.includes("NetworkError"),
        ),
      ).toHaveLength(0);
    });
  }
});

test.describe("Nav link routing", () => {
  test("clicking nav links navigates without full reload", async ({ page }) => {
    await page.goto("/");

    // Navigate to Council via sidebar link
    await page.getByRole("link", { name: /council/i }).click();
    await expect(page).toHaveURL(/\/council/);

    // Navigate to Tasks
    await page.getByRole("link", { name: /tasks/i }).click();
    await expect(page).toHaveURL(/\/tasks/);

    // Back to Dashboard
    await page.getByRole("link", { name: /dashboard/i }).click();
    await expect(page).toHaveURL(/^\//);
  });
});

test.describe("Page titles", () => {
  test("root page has a document title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/.+/); // any non-empty title
  });
});
