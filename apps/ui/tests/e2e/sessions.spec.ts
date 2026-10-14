// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures";

test("signed-in devices: sign one out from the profile, then sign out everywhere", async ({
  page,
  request,
}) => {
  const email = `e2e-sessions-${Date.now()}@example.com`;
  await signIn(request, email);
  await page.addInitScript(() => localStorage.setItem("nexus_setup_done", "1"));

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("E2e-test-pass!1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/profile");

  const rows = page.getByTestId("sessions-list").getByRole("listitem");
  await expect(rows.filter({ hasText: "This device" })).toHaveCount(1);
  const before = await rows.count();
  expect(before).toBeGreaterThan(1);

  await rows
    .filter({ hasNotText: "This device" })
    .first()
    .getByRole("button", { name: "Sign out" })
    .click();
  await expect(rows).toHaveCount(before - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/login"));
});
