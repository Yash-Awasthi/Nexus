// SPDX-License-Identifier: Apache-2.0
import crypto from "node:crypto";

import { expect, test } from "@playwright/test";

import { signIn } from "./fixtures";

/** RFC 6238 code for a base32 secret, as an authenticator app would show it. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = crypto.createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("two-factor sign-in: set it up from the profile, then sign in with a code", async ({
  page,
  request,
}) => {
  const email = `e2e-mfa-${Date.now()}@example.com`;
  await signIn(request, email);
  await page.addInitScript(() => localStorage.setItem("nexus_setup_done", "1"));

  const passwordStep = async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("E2e-test-pass!1");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  };

  await passwordStep();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/profile");
  await page.getByRole("button", { name: "Set up two-factor sign-in" }).click();
  await expect(page.getByRole("img", { name: "Authenticator QR code" })).toBeVisible();
  const secret = (await page.getByTestId("mfa-secret").textContent())!.replace(/\s/g, "");
  await page.getByLabel("Code from your app").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Two-factor sign-in is on")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.context().clearCookies();
  await passwordStep();
  const code = page.getByLabel("Authenticator code");
  await expect(code).toBeVisible();
  await code.fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That authenticator code is not valid")).toBeVisible();
  await code.fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
});
