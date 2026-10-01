// SPDX-License-Identifier: Apache-2.0
import { expect, signIn, signInPage, test } from "./fixtures";

test("a workspace is created, a teammate invited, and the invite joins only them", async ({
  page,
  browser,
  playwright,
}, info) => {
  const stamp = Date.now();
  const name = `Crew ${stamp}`;
  await page.goto("/workspaces");
  await page.getByLabel("New workspace name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("combobox", { name: "Workspace" })).toContainText(name);

  await page.getByLabel("Invite by email").fill("e2e-invitee@example.com");
  await page.getByRole("button", { name: "Invite" }).click();
  const link = await page.getByRole("link", { name: /\/invitations\// }).textContent();

  const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  const guest = async (email: string) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await signInPage(p, await signIn(request, email));
    await p.goto(link!);
    return p;
  };
  const stranger = await guest("e2e-stranger@example.com");
  await expect(stranger.getByRole("status")).toContainText("different email");
  const invitee = await guest("e2e-invitee@example.com");
  await expect(invitee.getByRole("status")).toHaveText("You joined the workspace.");
  await request.dispose();

  await page.reload();
  await page
    .getByRole("combobox", { name: "Workspace" })
    .selectOption({ label: `${name} (owner)` });
  await expect(page.getByText("e2e-invitee@example.com")).toBeVisible();

  await page.getByLabel("Role for e2e-invitee@example.com").selectOption("viewer");
  await expect(page.getByLabel("Role for e2e-invitee@example.com")).toHaveValue("viewer");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Remove e2e-invitee@example.com" }).click();
  await expect(page.getByText("e2e-invitee@example.com")).toHaveCount(0);

  await page.getByLabel("Invite by email").fill("e2e-later@example.com");
  await page.getByRole("button", { name: "Invite" }).click();
  const pending = page.getByRole("list", { name: "Pending invitations" });
  await expect(pending.getByText("e2e-later@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Revoke invitation for e2e-later@example.com" }).click();
  await expect(page.getByText("e2e-later@example.com")).toHaveCount(0);
});
