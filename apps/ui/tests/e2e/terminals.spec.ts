// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("a terminal runs a command on this machine after one approval", async ({ page, api }) => {
  // Terminals exist only where the API runs on this machine (the desktop app, a local install).
  test.skip((await api.call("GET", "/api/local/status")).status !== 200, "hosted server");
  await page.goto("/terminals");
  await page.getByLabel("Command").fill("node --version");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Start" }).click();

  await expect(page.locator(".xterm-rows")).toContainText(/v\d+\.\d+\.\d+/, { timeout: 20_000 });
  await expect(page.locator(".xterm-rows")).toContainText("process exited");
  const session = page.getByRole("listitem").filter({ hasText: "node" });
  await expect(session).toBeVisible();

  await session.getByRole("button", { name: "Close node" }).click();
  await expect(session).toHaveCount(0);
});
