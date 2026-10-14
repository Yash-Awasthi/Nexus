// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures";

// A passkey's relying party is a domain, so this spec talks to the server by name.
test.use({ baseURL: "http://localhost:3999" });

test("add a passkey on the profile, then sign in with it and no password", async ({
  page,
  request,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const email = `e2e-passkey-${Date.now()}@example.com`;
  await signIn(request, email);
  await page.addInitScript(() => localStorage.setItem("nexus_setup_done", "1"));
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("E2e-test-pass!1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  await page.goto("/profile");
  await page.getByLabel("Name for this passkey").fill("Test laptop");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByTestId("passkeys-list")).toContainText("Test laptop");

  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await page.getByRole("button", { name: new RegExp(email) }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/login"));

  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const me = await page.evaluate(async () => (await fetch("/api/v1/auth/me")).status);
  expect(me).toBe(200);
});
