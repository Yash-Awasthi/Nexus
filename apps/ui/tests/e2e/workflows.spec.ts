// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("a Company Task node files its data as a task for the chosen agent", async ({ page, api }) => {
  const company = `WF Co ${Date.now()}`;
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: company })).id;
  await api.post(`/api/org/companies/${cid}/agents`, {
    name: "Analyst",
    heartbeat: { wakeOnAssign: false },
  });
  await page.goto("/workflows");
  await page.getByRole("button", { name: "New Workflow" }).first().click();
  await page.locator("#wf-name").fill(`Hand off ${Date.now()}`);
  await page.getByRole("button", { name: "Create Workflow" }).click();
  await page.getByRole("button", { name: /Company Task/ }).click();
  await page.locator("#wf-org-company").selectOption({ label: company });
  await page.locator("#wf-org-agent").selectOption({ label: "Analyst" });
  await page.getByRole("button", { name: "Run" }).click();
  await page.getByText(/"identifier": "WC\d*-1"/).waitFor();
  const tasks = await api.get<{ tasks: { title: string; assigneeAgentId: string | null }[] }>(
    `/api/org/companies/${cid}/tasks`,
  );
  expect(tasks.tasks).toHaveLength(1);
  expect(tasks.tasks[0]!.title).toBe("Company Task");
});
