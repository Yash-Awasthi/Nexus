// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("memory remembers, recalls and forgets from the page", async ({ page }) => {
  const fact = `My build machine is called Heron-${Date.now()}`;
  await page.goto("/memory");
  await expect(page.getByRole("combobox")).toHaveCount(0);

  await page.getByLabel("New memory").fill(fact);
  await page.getByRole("button", { name: "Remember" }).click();
  await expect(page.getByText("Remembered.")).toBeVisible();
  await expect(page.getByText(fact)).toBeVisible();

  await page.getByLabel("Recall memories").fill("what is my build machine called");
  await page.getByRole("button", { name: "Recall", exact: true }).click();
  await expect(page.getByText(/Recalled for/)).toBeVisible();
  await expect(page.getByText(fact)).toBeVisible();

  await page.getByText(fact).locator("xpath=../..").getByLabel("Forget this memory").click();
  await expect(page.getByText(fact)).toHaveCount(0);
});

test("recall names the knowledge-graph entities the question mentions", async ({ page, api }) => {
  const org = `Kestrel Works ${Date.now()}`;
  await api.post("/api/kg/sync", {
    nodes: [
      {
        id: `kestrel-${Date.now()}`,
        name: org,
        type: "ORG",
        confidence: 1,
        properties: {},
        sources: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    edges: [],
  });
  await page.goto("/memory");
  await page.getByLabel("Recall memories").fill(`What do I know about ${org}?`);
  await page.getByRole("button", { name: "Recall", exact: true }).click();
  await expect(page.getByText("Related entities:")).toBeVisible();
  await expect(page.getByText(org, { exact: true })).toBeVisible();
});
