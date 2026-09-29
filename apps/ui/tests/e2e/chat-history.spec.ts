// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("the sidebar finds a past deliberation by what was said in it", async ({ page, api }) => {
  const tag = Date.now();
  const id = crypto.randomUUID();
  await api.post("/api/threads", { id, title: "Untitled" });
  await api.post(`/api/threads/${id}/messages`, {
    messages: [
      {
        id: `m-${tag}`,
        role: "user",
        content: `Should the launch wait for the quokka${tag} audit?`,
      },
    ],
  });

  await page.goto("/chat");
  await page.getByRole("button", { name: "Past deliberations" }).click();
  const box = page.getByLabel("Search deliberations").last();
  await box.fill(`quokka${tag}`);

  const hit = page.getByRole("button").filter({ hasText: `quokka${tag} audit` });
  await expect(hit.last()).toBeVisible();

  await page
    .getByRole("button", { name: /^Delete / })
    .last()
    .click({ force: true });
  await expect(hit).toHaveCount(0);

  await box.fill(`nothing-${tag}-matches`);
  await expect(page.getByText("No deliberation matches.").last()).toBeVisible();
});
