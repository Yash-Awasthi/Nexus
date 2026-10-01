// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("home lists your companies and what waits on you", async ({ page, api }) => {
  const name = `Dash Co ${Date.now()}`;
  const cid = (
    await api.post<{ id: string }>("/api/org/companies", { name, requireHireApproval: true })
  ).id;
  await api.post(`/api/org/companies/${cid}/agents`, { name: "Newbie" });
  await page.goto("/dashboard");
  // The company is listed, and "Needs you" links to its inbox.
  await page.getByRole("link", { name: name, exact: true }).waitFor();
  const company = page
    .getByRole("link", { name: new RegExp(name) })
    .filter({ hasText: "1 to approve" });
  await company.click();
  await page.getByTestId("approval-card").filter({ hasText: "Hire Newbie" }).waitFor();
});

test("home hands a question to the council", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByLabel("Ask the council").fill("Is this handed over?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByLabel("Message the council")).toHaveValue("Is this handed over?");
});
