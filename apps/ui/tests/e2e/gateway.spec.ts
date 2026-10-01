// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("the gateway page shows the caller's chain and cache", async ({ page }) => {
  await page.goto("/gateway");
  await expect(page.getByRole("heading", { name: "Gateway" })).toBeVisible();
  await expect(page.getByText("Failover chain")).toBeVisible();
  await expect(page.getByText("Free chain")).toBeVisible();
  await expect(page.getByText("Hit rate")).toBeVisible();
});
