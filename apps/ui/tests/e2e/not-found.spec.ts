// SPDX-License-Identifier: Apache-2.0
/**
 * An unknown URL is a page, not a crash.
 *
 * The splat route exists so a mistyped bookmark renders inside the shell — a root `ErrorBoundary`
 * replaces the whole document and then hydrates against markup that is not there. This test pins
 * both halves: the page says what happened, and the document logged no error while rendering it.
 */
import { expect, test } from "./fixtures";

test("an unknown route renders the not-found page with no page error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 140)));

  await page.goto("/no-such-page");

  await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
  await expect(page.getByText("/no-such-page")).toBeVisible();
  // The shell survived: navigation is still on the page, which is the difference from a boundary.
  await expect(page.getByRole("link", { name: "Search everything" })).toBeVisible();
  expect(errors).toEqual([]);
});
