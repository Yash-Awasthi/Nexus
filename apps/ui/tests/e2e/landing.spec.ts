// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test("the home page runs its 3D scene under the CSP and fits a phone", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("One question");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // Headless runs without a GPU fall back to the CSS backdrop, so only insist on the canvas with WebGL.
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  if (webgl) await expect(page.locator("canvas")).toHaveCount(1, { timeout: 15_000 });
  expect(problems).toEqual([]);
});

test("the example deliberation plays out and switches question", async ({ page }) => {
  await page.goto("/");
  const demo = page.locator("#demo");
  await demo.scrollIntoViewIfNeeded();
  await expect(
    demo.getByText("Not yet. Use a managed platform and write down the trigger for moving.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 45_000 });

  await demo.getByRole("button", { name: "Rewrite in Rust?" }).click();
  await expect(
    demo.getByText("No. Profile and add tests; rewrite only if a measured limit forces it.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 45_000 });
});

test("the call to action leads to sign-up", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Start a council/ }).click();
  await expect(page).toHaveURL(/\/register/);
});
