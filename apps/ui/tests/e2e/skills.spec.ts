// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("a skill run with shell asks once, then starts the mission it named", async ({
  page,
  api,
}) => {
  const name = `PW Shell ${Date.now()}`;
  await api.post("/api/skills", {
    name,
    description: "Prints a greeting",
    language: "python",
    code: 'print("hi")',
  });
  await page.goto("/skills");
  const runTitle = "Execute this skill end-to-end as a mission";
  await page
    .locator("div", { has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByTitle(runTitle) })
    .last()
    .getByTitle(runTitle)
    .click();
  await page
    .getByLabel("Allow shell commands for this mission (asks once before it starts)")
    .check();

  const sent: { missionId?: string; approvalId?: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/missions")
      sent.push(r.postDataJSON() as { missionId?: string; approvalId?: string });
  });
  page.once("dialog", (d) => void d.accept());
  const started = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/missions" &&
      !!(r.request().postDataJSON() as { approvalId?: string }).approvalId,
  );
  await page.getByRole("button", { name: "Run Skill" }).click();
  const res = await started;
  expect(res.status()).toBe(202);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.missionId).toMatch(/^mission-/);
  expect(sent[1]!.missionId).toBe(sent[0]!.missionId);
  expect(((await res.json()) as { id: string }).id).toBe(sent[0]!.missionId);
});
