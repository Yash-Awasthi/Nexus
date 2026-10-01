// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("search finds a document in a chosen knowledge base and marks the words", async ({
  page,
  api,
}) => {
  const tag = Date.now();
  const kb = await api.post<{ id: string }>("/api/kb", { name: `Ops ${tag}` });
  await api.post(`/api/kb/${kb.id}/documents`, {
    name: "schedule.txt",
    content: `Nightly backups run at 02:00 UTC on cluster heron${tag}.`,
  });

  await page.goto("/search");
  await page.getByRole("button", { name: `Ops ${tag}` }).click();
  await page.getByLabel("Write an answer").click();
  await page.getByLabel("Search", { exact: true }).fill(`when do backups run on heron${tag}`);
  await page.getByRole("button", { name: "Search", exact: true }).click();

  const hit = page.getByRole("listitem").filter({ hasText: "schedule.txt" });
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark").first()).toContainText(/backups/i);
  await expect(hit).toContainText(`Ops ${tag}`);
});

test("search says so when nothing matches", async ({ page }) => {
  await page.goto("/search");
  await page.getByLabel("Write an answer").click();
  await page.getByRole("button", { name: "Graph" }).click();
  await page.getByLabel("Search", { exact: true }).fill(`zzqx-${Date.now()}-nothing`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Nothing matched that.").first()).toBeVisible();
});
