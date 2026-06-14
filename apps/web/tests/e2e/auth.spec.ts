// SPDX-License-Identifier: Apache-2.0
/**
 * Auth boundary tests — verify that API calls without credentials return 401
 * and that the UI handles authentication errors gracefully (no crash, no leaked
 * stack traces in the rendered output).
 *
 * These tests hit the real API if PLAYWRIGHT_BASE_URL points to a live stack,
 * or stub network calls in isolation mode.
 *
 * Run: pnpm --filter @nexus/web test:e2e
 */
import { test, expect } from "@playwright/test";

const API_BASE = process.env["API_BASE_URL"] ?? "http://localhost:3000";

test.describe("API auth guard", () => {
  test("GET /api/v1/runtime/tasks without token returns 401 or 403", async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/v1/runtime/tasks`);
    expect([401, 403]).toContain(response.status());
  });

  test("GET /api/v1/audit/log without token returns 401 or 403", async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/v1/audit/log`);
    expect([401, 403]).toContain(response.status());
  });

  test("GET /health is publicly accessible", async ({ request }) => {
    const response = await request.get(`${API_BASE}/health`);
    // Health endpoint must be reachable without auth
    expect([200, 503]).toContain(response.status()); // 503 = degraded but accessible
  });
});

test.describe("UI auth error handling", () => {
  test("Dashboard renders without crashing when API returns 401", async ({ page }) => {
    // Intercept all API calls and return 401
    await page.route("**/api/v1/**", (route) => {
      void route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unauthorized" }),
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Page should still render (not blank / crashed)
    await expect(page.locator("body")).not.toBeEmpty();

    // No unhandled error overlays (Vite dev error overlay or React error boundary)
    const viteError = page.locator("vite-error-overlay");
    await expect(viteError).not.toBeVisible();
  });

  test("Council page renders without crashing when API returns 401", async ({ page }) => {
    await page.route("**/api/v1/**", (route) => {
      void route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unauthorized" }),
      });
    });

    await page.goto("/council");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("Error response bodies do not expose stack traces in rendered HTML", async ({ page }) => {
    await page.route("**/api/v1/**", (route) => {
      void route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }), // sanitised message
      });
    });

    await page.goto("/tasks");
    await page.waitForLoadState("networkidle");

    const bodyText = await page.locator("body").innerText();
    // Stack traces must not reach the rendered DOM
    expect(bodyText).not.toContain("at Object.<anonymous>");
    expect(bodyText).not.toContain("at Module._compile");
  });
});
