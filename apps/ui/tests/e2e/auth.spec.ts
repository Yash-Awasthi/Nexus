// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures";

test("a browser session keeps no token in storage and survives a reload on its cookie", async ({
  page,
  request,
}) => {
  const email = "e2e-cookie@example.com";
  await signIn(request, email);
  await page.addInitScript(() => localStorage.setItem("nexus_setup_done", "1"));

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("E2e-test-pass!1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  const stored = await page.evaluate(() => Object.keys(localStorage));
  expect(stored).not.toContain("nexus_token");
  expect(stored).not.toContain("nexus_refresh_token");
  const cookie = (await page.context().cookies()).find((c) => c.name === "nexus_refresh");
  expect(cookie?.httpOnly).toBe(true);

  await page.reload();
  // The notification stream stays open, so the network never goes idle.
  await page.getByRole("heading", { level: 1, name: email }).waitFor();
  expect(new URL(page.url()).pathname).not.toBe("/login");
  const me = await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status);
  expect(me).toBe(200);
});
