// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("a project is handed to a company and asks it for work", async ({ page, api }) => {
  const stamp = Date.now();
  const project = `Revamp ${stamp}`;
  const company = `Proj Co ${stamp}`;
  await api.post("/api/v1/projects", { name: project });
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: company })).id;
  await api.post(`/api/org/companies/${cid}/agents`, {
    name: "Lead",
    heartbeat: { wakeOnAssign: false },
  });
  await page.goto("/projects");
  await page.getByText(project).first().click();
  await page.getByRole("button", { name: "Company" }).click();
  await page.getByLabel("Company to hand the project to").selectOption({ label: company });
  await page.getByRole("button", { name: "Hand over" }).click();
  await page.getByTestId("project-link").getByText(company).waitFor();
  await page.getByLabel(`Ask ${company} for work`).fill("Audit the homepage");
  await page.getByRole("button", { name: "File task" }).click();
  await page.getByTestId("project-link").getByText("Audit the homepage").waitFor();
  const tasks = await api.get<{ tasks: { title: string; goalId: string | null }[] }>(
    `/api/org/companies/${cid}/tasks`,
  );
  expect(tasks.tasks[0]).toMatchObject({ title: "Audit the homepage" });
  expect(tasks.tasks[0]!.goalId).not.toBeNull();
});
