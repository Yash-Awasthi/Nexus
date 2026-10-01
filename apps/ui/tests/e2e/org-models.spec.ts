// SPDX-License-Identifier: Apache-2.0
/**
 * Company flows that make real model calls on the owner's provider keys. Run
 * with E2E_MODELS=1 once the e2e owner (fixtures.ts) has keys saved.
 */
import { Api, expect, test, withModels } from "./fixtures";

test.skip(!withModels, "set E2E_MODELS=1 with provider keys saved for the owner");

const unique = (name: string) => `${name} ${Date.now()}`;

// Free-tier TokenHarbor models carry the runs. The budget and scorecard checks need a model
// that costs something, so they make a few short calls on Gemini, billed at the default rate.
// E2E_MODEL / E2E_MODEL_B swap in another provider's models when TokenHarbor is not saved.
const FREE = process.env["E2E_MODEL"] ?? "tokenharbor/qwen3.8-flash:free";
const FREE_B = process.env["E2E_MODEL_B"] ?? "tokenharbor/deepseek-v4.1-flash:free";
const PRICED = "gemini/gemini-flash-latest";
// Budgets and pricing are on hold, so the checks that spend on a priced model are opt-in.
const priced = process.env["E2E_PRICED"] ? test : test.skip;

async function waitForRun(api: Api, id: string): Promise<string> {
  for (let i = 0; i < 90; i++) {
    const run = await api.get<{ status: string }>(`/api/org/runs/${id}`);
    if (!["queued", "running"].includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "timeout";
}

test("a run's answer lands in the task thread and its trace opens", async ({ page, api }) => {
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Runs") }))
    .id;
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Solo",
    heartbeat: { wakeOnAssign: false },
  });
  await api.post(`/api/org/companies/${cid}/tasks`, {
    title: "Name three primary colours",
    assigneeAgentId: ag.id,
    workMode: "ask",
  });
  await page.goto(`/org?c=${cid}&tab=tasks`);
  await page.getByTestId("task-card").filter({ hasText: "primary colours" }).click();
  await page.getByRole("button", { name: "Run this task" }).click();
  await page.getByLabel("Comments").locator("li").first().waitFor({ timeout: 90_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Runs" }).click();
  const row = page.getByTestId("run-row").first();
  await row.getByText("succeeded").waitFor({ timeout: 30_000 });
  await row.click();
  await page.getByLabel("Model calls").waitFor();
  await page
    .getByLabel("Run log")
    .getByText(/Working on/)
    .waitFor();
});

priced("a budget hard stop pauses the agent until the limit is raised", async ({ page, api }) => {
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Budget") }))
    .id;
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Pricey",
    model: PRICED,
  });
  const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "Reply with OK",
    assigneeAgentId: ag.id,
    workMode: "ask",
  });
  const wake = await api.post<{ id: string }>(`/api/org/agents/${ag.id}/wake`, { taskId: t.id });
  expect(await waitForRun(api, wake.id)).toBe("succeeded");
  await page.goto(`/org?c=${cid}&tab=budgets`);
  await page.locator("#budget-scope").selectOption({ label: "Agent: Pricey" });
  await page.locator("#budget-amount").fill("0.00001");
  await page.getByRole("button", { name: "Save limit" }).click();
  await page.getByTestId("incident").waitFor();
  await page.getByLabel("New budget in dollars").fill("1");
  await page.getByRole("button", { name: "Raise and resume" }).click();
  await page.getByTestId("incident").waitFor({ state: "detached" });
  expect((await api.get<{ status: string }>(`/api/org/agents/${ag.id}`)).status).toBe("idle");
  await page.getByTestId("forecast").waitFor();
});

test("the council reviews a hire before the board approves it", async ({ page, api }) => {
  const cid = (
    await api.post<{ id: string }>("/api/org/companies", {
      name: unique("PW Gov"),
      mission: "Run a small bakery website",
      requireHireApproval: true,
    })
  ).id;
  await page.goto(`/org?c=${cid}&tab=org`);
  await page.getByRole("button", { name: "Hire agent" }).click();
  await page.locator("#agent-name").fill("Baker");
  await page.locator("#agent-role").fill("writer");
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await page.locator('[data-agent-name="Baker"]').getByText("pending approval").waitFor();
  await page.getByRole("tab", { name: /Approvals/ }).click();
  const card = page.getByTestId("approval-card").filter({ hasText: "Hire Baker" });
  await card.getByRole("button", { name: "Ask the council" }).click();
  await card.getByTestId("council-verdict").waitFor({ timeout: 120_000 });
  await card.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Nothing needs you right now.").waitFor();
});

test("asking the org gets an answer from the right agent", async ({ page, api }) => {
  const cid = (
    await api.post<{ id: string }>("/api/org/templates/research-desk", { name: unique("PW Ask") })
  ).id;
  await page.goto(`/org?c=${cid}`);
  await page
    .getByLabel("Ask the org")
    .fill("In one sentence: what is the main risk of a notes app?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const ask = page.getByTestId("ask").first();
  await ask.locator("p.whitespace-pre-wrap").waitFor({ timeout: 120_000 });
});

test("a finished run replays on another model and shows the answer diff", async ({ page, api }) => {
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Replay") }))
    .id;
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Solo",
    model: FREE,
    heartbeat: { wakeOnAssign: false },
  });
  const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "List three primary colours, one per line",
    assigneeAgentId: ag.id,
    workMode: "ask",
  });
  const wake = await api.post<{ id: string }>(`/api/org/agents/${ag.id}/wake`, { taskId: t.id });
  expect(await waitForRun(api, wake.id)).toBe("succeeded");
  await page.goto(`/org?c=${cid}&tab=runs`);
  await page.getByTestId("run-row").first().click();
  await page.getByLabel("Model to replay on").fill(FREE_B);
  await page.getByRole("button", { name: "Replay" }).click();
  await page.getByLabel("Answer diff").waitFor({ timeout: 90_000 });
  await expect(page.getByText(new RegExp(`vs ${FREE_B}`))).toBeVisible();
});

test("two agents discuss a task in its thread until the discussion ends", async ({ page, api }) => {
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Talk") }))
    .id;
  for (const [name, model] of [
    ["Arch", FREE],
    ["Ops", FREE_B],
  ])
    await api.post(`/api/org/companies/${cid}/agents`, {
      name,
      model,
      heartbeat: { wakeOnAssign: false },
    });
  await api.post(`/api/org/companies/${cid}/tasks`, {
    title: "SQLite or Postgres for a single-user notes app",
  });
  await page.goto(`/org?c=${cid}&tab=tasks`);
  await page.getByTestId("task-card").filter({ hasText: "single-user notes" }).click();
  await page.getByLabel("Arch").check();
  await page.getByLabel("Ops").check();
  await page.getByRole("button", { name: "Start discussion" }).click();
  await page
    .getByLabel("Comments")
    .getByText(/^Discussion (settled|ended)/)
    .waitFor({ timeout: 150_000 });
  await expect(
    page
      .getByLabel("Comments")
      .getByText(/^Arch ·/)
      .first(),
  ).toBeVisible();
  // A settled discussion files its decision as a subtask for the most senior agent.
  if (
    await page
      .getByLabel("Comments")
      .getByText(/^Discussion settled/)
      .count()
  )
    await page
      .getByLabel("Comments")
      .getByText(/^Filed \S+ for /)
      .waitFor();
});

test("a filed decision reports back in its discussion when it is done", async ({ page, api }) => {
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Follow") }))
    .id;
  const ids: string[] = [];
  for (const name of ["Lead", "Dev"])
    ids.push(
      (
        await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
          name,
          model: FREE,
          heartbeat: { wakeOnAssign: false },
        })
      ).id,
    );
  const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "Agree on the word ship. Each of you: reply with only the line FINAL: ship",
  });
  await api.post(`/api/org/tasks/${t.id}/discuss`, { agentIds: ids, rounds: 2, fileOutcome: true });
  let filed: { id: string; identifier: string } | undefined;
  for (let i = 0; i < 60 && !filed; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const d = await api.get<{
      comments: { body: string }[];
      subtasks: { id: string; identifier: string }[];
    }>(`/api/org/tasks/${t.id}`);
    if (/^Filed /.test(d.comments.at(-1)?.body ?? "")) filed = d.subtasks.at(-1);
  }
  expect(filed, "the agents did not settle on the decision").toBeTruthy();
  await api.post(`/api/org/tasks/${filed!.id}/status`, { status: "in_progress" });
  await api.post(`/api/org/tasks/${filed!.id}/status`, { status: "done" });
  await page.goto(`/org?c=${cid}&tab=tasks`);
  await page.getByTestId("task-card").filter({ hasText: "Agree on the word ship" }).click();
  await page.getByLabel("Comments").getByText(`${filed!.identifier} is done`).waitFor();
});

test("an agent's sheet scores the model it ran on against a replayed one", async ({
  page,
  api,
}) => {
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Score") }))
    .id;
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Solo",
    model: FREE,
    heartbeat: { wakeOnAssign: false },
  });
  const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "Name one primary colour",
    assigneeAgentId: ag.id,
    workMode: "ask",
  });
  const wake = await api.post<{ id: string }>(`/api/org/agents/${ag.id}/wake`, { taskId: t.id });
  expect(await waitForRun(api, wake.id)).toBe("succeeded");
  await api.post(`/api/org/tasks/${t.id}/replay`, { model: FREE_B });
  await page.goto(`/org?c=${cid}&tab=org`);
  await page.locator('[data-agent-name="Solo"]').getByRole("button").first().click();
  const card = page.getByTestId("model-scorecard");
  await card.getByText(FREE_B).waitFor();
  await expect(card.getByText(FREE)).toBeVisible();
});

priced(
  "the scorecard switches an agent to the cheaper model its replays agree with",
  async ({ page, api }) => {
    const [big, small] = [PRICED, FREE];
    const cid = (
      await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Switch") })
    ).id;
    const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
      name: "Thrifty",
      model: big,
      heartbeat: { wakeOnAssign: false },
    });
    for (const colour of ["red", "green", "blue"]) {
      const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
        title: `Reply with the single word ${colour}`,
        assigneeAgentId: ag.id,
        workMode: "ask",
      });
      const wake = await api.post<{ id: string }>(`/api/org/agents/${ag.id}/wake`, {
        taskId: t.id,
      });
      expect(await waitForRun(api, wake.id)).toBe("succeeded");
      await api.post(`/api/org/runs/${wake.id}/replay`, { model: small });
    }

    await page.goto(`/org?c=${cid}&tab=org`);
    await page.locator('[data-agent-name="Thrifty"]').getByRole("button").first().click();
    await page.getByRole("button", { name: `Switch to ${small}` }).click();
    await expect
      .poll(async () => (await api.get<{ model: string }>(`/api/org/agents/${ag.id}`)).model)
      .toBe(small);
    // The sheet reloads for the new model, which is now the one it measures against.
    await expect(page.getByRole("button", { name: `Switch to ${small}` })).toHaveCount(0);

    const next = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
      title: "Reply with the single word done",
      assigneeAgentId: ag.id,
      workMode: "ask",
    });
    const wake = await api.post<{ id: string }>(`/api/org/agents/${ag.id}/wake`, {
      taskId: next.id,
    });
    expect(await waitForRun(api, wake.id)).toBe("succeeded");
    const run = await api.get<{ log: { text: string }[] }>(`/api/org/runs/${wake.id}`);
    expect(run.log.map((l) => l.text).join("\n")).toContain(`Model: ${small}`);
  },
);

test("a decision the agents filed is remembered with how it ended", async ({ page, api }) => {
  const cid = (await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Decide") }))
    .id;
  const hire = (name: string, reportsTo?: string) =>
    api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
      name,
      model: FREE,
      heartbeat: { wakeOnAssign: false },
      ...(reportsTo ? { reportsTo } : {}),
    });
  const lead = await hire("Lead");
  const dev = await hire("Dev", lead.id);
  const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "Pick tabs or spaces for the style guide",
  });
  // Agreement is scored on the agents' own words, so the prompt asks for the exact line.
  await api.post(`/api/org/tasks/${t.id}/discuss`, {
    agentIds: [dev.id, lead.id],
    rounds: 3,
    fileOutcome: true,
    topic: "Answer only with the line FINAL: use spaces",
  });
  let filed: string | undefined;
  await expect
    .poll(
      async () => {
        const d = await api.get<{ task: { children?: { id: string }[] } }>(
          `/api/org/tasks/${t.id}`,
        );
        filed = (
          await api.get<{ tasks: { id: string; parentId: string | null }[] }>(
            `/api/org/companies/${cid}/tasks`,
          )
        ).tasks.find((x) => x.parentId === t.id)?.id;
        return filed ?? d.task.children?.[0]?.id;
      },
      { timeout: 180_000 },
    )
    .toBeTruthy();
  await api.post(`/api/org/tasks/${filed}/status`, { status: "cancelled" });
  await page.goto(`/org?c=${cid}&tab=memory`);
  await page
    .getByTestId("lesson")
    .filter({ hasText: "Pick tabs or spaces" })
    .filter({ hasText: "dropped" })
    .waitFor();
});

priced(
  "a company that follows its scorecard moves the agent, and the owner can move it back",
  async ({ page, api }) => {
    const [big, small] = [PRICED, FREE];
    const cid = (await api.post<{ id: string }>("/api/org/companies", { name: unique("PW Auto") }))
      .id;
    await page.goto(`/org?c=${cid}&tab=approvals`);
    await page.getByLabel("Follow the model scorecard").click();
    await expect(page.getByLabel("Follow the model scorecard")).toBeChecked();
    const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
      name: "Frugal",
      model: big,
      heartbeat: { wakeOnAssign: false },
    });
    for (const colour of ["red", "green", "blue"]) {
      const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
        title: `Reply with the single word ${colour}`,
        assigneeAgentId: ag.id,
        workMode: "ask",
      });
      const wake = await api.post<{ id: string }>(`/api/org/agents/${ag.id}/wake`, {
        taskId: t.id,
      });
      expect(await waitForRun(api, wake.id)).toBe("succeeded");
      await api.post(`/api/org/runs/${wake.id}/replay`, { model: small });
    }
    expect((await api.get<{ model: string }>(`/api/org/agents/${ag.id}`)).model).toBe(small);

    await page.goto(`/org?c=${cid}&tab=org`);
    await page.locator('[data-agent-name="Frugal"]').getByRole("button").first().click();
    await page
      .getByTestId("auto-switch")
      .getByRole("button", { name: `Switch back to ${big}` })
      .click();
    await expect
      .poll(async () => (await api.get<{ model: string }>(`/api/org/agents/${ag.id}`)).model)
      .toBe(big);
  },
);
