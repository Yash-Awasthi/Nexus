// SPDX-License-Identifier: Apache-2.0
/** The company page at 375px, on flows that need no model call. */
import fs from "node:fs";

import { Api, expect, signIn, signInPage, test, watchProblems } from "./fixtures";

const unique = (name: string) => `${name} ${Date.now()}`;

async function newCompany(api: Api, body: Record<string, unknown>): Promise<string> {
  return (await api.post<{ id: string }>("/api/org/companies", body)).id;
}

test("creates a company and nests a report under its manager", async ({ page }) => {
  const name = unique("PW Co");
  await page.goto("/org");
  await page.getByRole("heading", { name: "Companies" }).waitFor();
  await page
    .getByRole("button", { name: /New company|Create your first company/ })
    .first()
    .click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Mission").fill("Make playwright happy");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("company-name").filter({ hasText: name }).waitFor();
  for (const [n, role, boss] of [
    ["Ceo", "ceo", null],
    ["Dev", "engineer", "Ceo"],
  ] as const) {
    await page.getByRole("button", { name: "Hire agent" }).click();
    await page.locator("#agent-name").fill(n);
    await page.locator("#agent-role").fill(role);
    if (boss) await page.locator("#agent-reports").selectOption({ label: `${boss} · ceo` });
    else await page.locator("#agent-reports").selectOption("");
    await page.getByRole("button", { name: "Hire", exact: true }).click();
    await page.locator(`[data-agent-name="${n}"]`).waitFor();
  }
  const ceo = page.locator('[data-agent-name="Ceo"]').locator("xpath=..");
  await expect(ceo.locator('[data-agent-name="Dev"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Pause Dev" }).click();
  await page.getByRole("button", { name: "Resume Dev" }).waitFor();
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("list", { name: "Activity" }).getByText("agent paused").waitFor();
});

test("works a task through the board with its why chain", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("Board Co"), mission: "Test the board" });
  await api.post(`/api/org/companies/${cid}/agents`, {
    name: "Runner",
    heartbeat: { wakeOnAssign: false },
  });
  await page.goto(`/org?c=${cid}&tab=goals`);
  await page.getByLabel("Goal title").fill("Win the market");
  await page.getByRole("button", { name: "Add goal" }).click();
  await page.getByTestId("goal-row").filter({ hasText: "Win the market" }).waitFor();
  await page.getByRole("tab", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator("#task-title").fill("Draft launch post");
  await page.locator("#task-assignee").selectOption({ label: "Runner" });
  await page.locator("#task-goal").selectOption({ label: "Win the market" });
  await page.getByRole("button", { name: "Create task" }).click();
  const card = page
    .getByTestId("column-todo")
    .getByTestId("task-card")
    .filter({ hasText: "Draft launch post" });
  await card.click();
  await page.getByLabel("Why this task exists").getByText("Win the market").waitFor();
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("button", { name: "Mark done" }).click();
  await page.getByLabel("New comment").fill("Shipped, **nice** work");
  await page.getByRole("button", { name: "Post" }).click();
  await page.getByLabel("Comments").getByText("Shipped, nice work").waitFor();
  // Replies are Markdown; the thread shows the emphasis, not the asterisks.
  await page.getByLabel("Comments").locator("strong", { hasText: "nice" }).waitFor();
  await page.keyboard.press("Escape");
  await page
    .getByTestId("column-done")
    .getByTestId("task-card")
    .filter({ hasText: "Draft launch post" })
    .waitFor();
});

test("schedules a heartbeat and fires a routine", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Sched") });
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, { name: "Clock" });
  await page.goto(`/org?c=${cid}&tab=org`);
  await page.getByRole("button", { name: "Edit Clock" }).click();
  await page.getByLabel("Scheduled heartbeat").click();
  await page.getByLabel("Minutes between heartbeats").fill("15");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const agent = await api.get<{ heartbeat: { enabled: boolean; intervalSec: number } }>(
    `/api/org/agents/${ag.id}`,
  );
  expect([agent.heartbeat.enabled, agent.heartbeat.intervalSec]).toEqual([true, 900]);
  await page.getByRole("tab", { name: "Routines" }).click();
  await page.getByRole("button", { name: "New routine" }).click();
  await page.locator("#routine-title").fill("Morning standup");
  await page.locator("#routine-agent").selectOption({ label: "Clock" });
  await page.getByRole("button", { name: "Create routine" }).click();
  const row = page.getByTestId("routine-row").filter({ hasText: "Morning standup" });
  await row.getByText("0 9 * * 1-5").waitFor();
  await row.getByRole("button", { name: "Add webhook" }).click();
  await page.getByTestId("webhook-secret").waitFor();
  await page.getByRole("button", { name: "Done" }).click();
  await row.getByRole("button", { name: "Run now" }).click();
  await row.getByText(/filed/).waitFor();
  await page.getByRole("tab", { name: "Tasks" }).click();
  await page.getByTestId("task-card").filter({ hasText: "Morning standup" }).first().waitFor();
});

test("keeps notes in the company memory and recalls them", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Memory") });
  await page.goto(`/org?c=${cid}&tab=memory`);
  await page.getByLabel("New note").fill("Our customers are veterinary clinics.");
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByTestId("lesson").filter({ hasText: "veterinary" }).waitFor();
  await page.getByLabel("Search memory").fill("clinics customers");
  await page.getByTestId("lesson").filter({ hasText: "veterinary" }).waitFor();
  await page.getByLabel("Search memory").fill("spaceships");
  await page.getByText("Nothing relevant yet.").waitFor();
});

test("the overview sends you to a waiting hire and clears after approval", async ({
  page,
  api,
}) => {
  const cid = await newCompany(api, { name: unique("PW Overview"), requireHireApproval: true });
  await api.post(`/api/org/companies/${cid}/agents`, { name: "Newbie" });
  await page.goto(`/org?c=${cid}`);
  await page.getByLabel("Your companies").waitFor();
  await page.getByTestId("need-card").filter({ hasText: "Decisions waiting" }).click();
  await page
    .getByTestId("approval-card")
    .filter({ hasText: "Hire Newbie" })
    .getByRole("button", { name: "Approve" })
    .click();
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByTestId("all-clear").waitFor();
});

test("starts from a template, exports it and imports the copy", async ({ page }) => {
  await page.goto("/org");
  await page.getByRole("heading", { name: "Companies" }).waitFor();
  await page
    .getByRole("button", { name: /New company|Create your first company/ })
    .first()
    .click();
  await page.locator("#company-from").selectOption({ label: "Template: Software team" });
  const name = unique("PW Template");
  await page.locator("#company-name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("company-name").filter({ hasText: name }).waitFor();
  await page.getByRole("tab", { name: "Org chart" }).click();
  await page.locator('[data-agent-name="Tara"]').waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  const file = await download.path();
  const bundle = JSON.parse(fs.readFileSync(file, "utf8")) as { format: string; agents: unknown[] };
  expect(bundle.format).toBe("nexus-company/1");
  expect(bundle.agents).toHaveLength(3);
  await page.getByRole("button", { name: "New company" }).click();
  await page.locator("#company-name").fill(`${name} copy`);
  await page.getByLabel("Import company file").setInputFiles(file);
  await page
    .getByTestId("company-name")
    .filter({ hasText: `${name} copy` })
    .waitFor();
});

const ECHO_AGENT =
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log('read '+d.length);console.log('```json');console.log(JSON.stringify({status:'done',summary:'echoed'}));console.log('```')})";

test("a shell agent runs once its command is allowed", async ({ page, api }) => {
  // The agent's command is this machine's node binary, so the API must run here too.
  test.skip((await api.call("GET", "/api/local/status")).status !== 200, "hosted server");
  const cid = await newCompany(api, { name: unique("PW CLI") });
  await page.goto(`/org?c=${cid}&tab=org`);
  await page.getByRole("button", { name: "Hire agent" }).click();
  await page.locator("#agent-name").fill("Echo");
  await page.getByLabel("Runtime").selectOption({ label: "Shell command" });
  await page.getByLabel("Command").fill(process.execPath);
  await page.getByLabel("Arguments, one per line").fill(`-e\n${ECHO_AGENT}`);
  await page.getByRole("button", { name: "Hire", exact: true }).click();
  await page.locator('[data-agent-name="Echo"]').getByText("Shell command").waitFor();
  await page.getByRole("tab", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator("#task-title").fill("Echo the prompt");
  await page.locator("#task-assignee").selectOption({ label: "Echo" });
  await page.getByRole("button", { name: "Create task" }).click();
  await page.getByRole("tab", { name: /Approvals/ }).click();
  const cmd = page.getByTestId("exec-approval").first();
  await cmd.waitFor({ timeout: 20_000 });
  await cmd.getByRole("button", { name: "Allow once" }).click();
  await page.getByRole("tab", { name: "Tasks" }).click();
  await page
    .getByTestId("column-done")
    .getByTestId("task-card")
    .filter({ hasText: "Echo the prompt" })
    .waitFor({ timeout: 90_000 });
});

test("a workspace member reads a shared company, comments and reassigns", async ({
  page,
  api,
  browser,
  request,
}) => {
  const cid = await newCompany(api, { name: unique("PW Shared") });
  await api.post(`/api/org/companies/${cid}/agents`, { name: "Ceo" });
  const dev = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Dev",
    heartbeat: { wakeOnAssign: false },
  });
  const task = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "Shared task",
  });
  const ws = await api.post<{ workspace?: { id: string }; id?: string }>("/api/v1/workspaces", {
    name: unique("Team"),
  });
  const wsId = ws.workspace?.id ?? ws.id ?? "";
  const email = `member-${Date.now()}@example.com`;
  const member = await signIn(request, email);
  const invite = await api.post<{ invitationToken: string }>(
    `/api/v1/workspaces/${wsId}/invitations`,
    { email },
  );
  await new Api(request, member).get(`/api/v1/workspaces/invitations/${invite.invitationToken}`);

  await page.goto(`/org?c=${cid}&tab=approvals`);
  await page.getByLabel("Share with workspace").selectOption(wsId);
  await expect
    .poll(
      async () =>
        (await api.get<{ workspaceId?: string }>(`/api/org/companies/${cid}`)).workspaceId,
    )
    .toBe(wsId);

  const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const memberPage = await context.newPage();
  await signInPage(memberPage, member);
  const problems = watchProblems(memberPage);
  await memberPage.goto(`/org?c=${cid}&tab=org`);
  await memberPage.getByText("Shared with you · comments and assignments").waitFor();
  await memberPage.locator('[data-agent-name="Ceo"]').waitFor();
  await expect(memberPage.getByRole("button", { name: "Hire agent" })).toHaveCount(0);
  await expect(memberPage.getByRole("button", { name: /^Pause/ })).toHaveCount(0);
  await expect(memberPage.getByRole("button", { name: "Export" })).toHaveCount(0);

  await memberPage.goto(`/org?c=${cid}&tab=tasks`);
  await memberPage.getByTestId("task-card").filter({ hasText: "Shared task" }).click();
  await memberPage.getByLabel("New comment").fill("Looks good from here");
  await memberPage.getByRole("button", { name: "Post" }).click();
  await memberPage.getByRole("list", { name: "Comments" }).getByText("Workspace member").waitFor();
  await expect(memberPage.getByRole("button", { name: "Start discussion" })).toHaveCount(0);
  await expect(memberPage.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await memberPage.getByRole("dialog").getByLabel("Assignee").selectOption({ label: "Dev" });
  await expect
    .poll(
      async () =>
        (await api.get<{ task: { assigneeAgentId: string | null } }>(`/api/org/tasks/${task.id}`))
          .task.assigneeAgentId,
    )
    .toBe(dev.id);

  await memberPage.keyboard.press("Escape");
  await memberPage.goto(`/org?c=${cid}&tab=budgets`);
  await memberPage.getByText("Spend", { exact: false }).first().waitFor();
  await expect(memberPage.getByRole("button", { name: "Save limit" })).toHaveCount(0);

  // As a viewer the same account only reads: no new task, no comment box, no reassigning.
  const memberId = String(member.user.id);
  await api.call("PATCH", `/api/v1/workspaces/${wsId}/members/${memberId}`, { role: "viewer" });
  await memberPage.goto(`/org?c=${cid}&tab=tasks`);
  await memberPage.getByText("Shared with you · read only").waitFor();
  await expect(memberPage.getByRole("button", { name: "New task" })).toHaveCount(0);
  await memberPage.getByTestId("task-card").filter({ hasText: "Shared task" }).click();
  await memberPage.getByRole("list", { name: "Comments" }).waitFor();
  await expect(memberPage.getByLabel("New comment")).toHaveCount(0);
  await expect(memberPage.getByRole("dialog").getByLabel("Assignee")).toBeDisabled();
  expect(problems).toEqual([]);
  await context.close();
});

test("a council verdict in chat goes to a company as a task", async ({ page, api }) => {
  const name = unique("PW Verdict");
  const cid = await newCompany(api, { name });
  await api.post(`/api/org/companies/${cid}/agents`, {
    name: "Ceo",
    heartbeat: { wakeOnAssign: false },
  });
  // The council's own models are not under test here; a canned stream stands in for them.
  await page.route("**/api/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body:
        'data: {"type":"verdict","text":"Post three times a week."}\n\n' +
        'data: {"type":"done"}\n\n',
    }),
  );
  await page.goto("/chat");
  await page.getByLabel("Message the council").fill("How often should a bakery post?");
  await page.getByLabel("Message the council").press("Enter");
  // The chat runs a second debate round, which remounts the button; retry until the picker holds.
  await expect(async () => {
    await page.getByRole("button", { name: "Send to a company" }).click({ timeout: 2_000 });
    await page
      .getByLabel("Send the verdict to a company")
      .selectOption({ label: name }, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId("verdict-filed").waitFor();
  const tasks = await api.get<{ tasks: { title: string; description: string }[] }>(
    `/api/org/companies/${cid}/tasks`,
  );
  expect(tasks.tasks[0]?.title).toContain("How often should a bakery post?");
  expect(tasks.tasks[0]?.description).toContain("Post three times a week.");
});

test("an agent can be given knowledge bases to read", async ({ page, api }) => {
  const kbName = unique("Handbook");
  const kb = await api.post<{ id?: string; kb?: { id: string } }>("/api/kb", { name: kbName });
  const kbId = kb.id ?? kb.kb?.id;
  const cid = await newCompany(api, { name: unique("PW Know") });
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, { name: "Reader" });
  await page.goto(`/org?c=${cid}&tab=org`);
  await page.getByRole("button", { name: "Edit Reader" }).click();
  await page.getByRole("checkbox", { name: kbName }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const saved = await api.get<{ knowledgeBaseIds: string[] }>(`/api/org/agents/${ag.id}`);
  expect(saved.knowledgeBaseIds).toEqual([kbId]);
});

test("an agent's earlier config can be restored from its history", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW History") });
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Scribe",
    instructions: "Write plainly.",
  });
  await api.call("PATCH", `/api/org/agents/${ag.id}`, { instructions: "Write in riddles." });
  await page.goto(`/org?c=${cid}&tab=org`);
  await page.locator('[data-agent-name="Scribe"]').getByRole("button").first().click();
  const history = page.getByTestId("config-history");
  await history.getByText("differs in instructions").waitFor();
  await history.getByRole("button", { name: "Restore" }).click();
  await expect
    .poll(
      async () =>
        (await api.get<{ instructions: string }>(`/api/org/agents/${ag.id}`)).instructions,
    )
    .toBe("Write plainly.");
});

test("a skill attached to an agent asks once, then runs before its turn", async ({ page, api }) => {
  const skillName = unique("Echo skill");
  await api.post("/api/skills", {
    name: skillName,
    description: "Prints a marker",
    language: "javascript",
    code: "console.log('skill-marker')",
  });
  const cid = await newCompany(api, { name: unique("PW Skills") });
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Worker",
    heartbeat: { wakeOnAssign: false },
  });
  await page.goto(`/org?c=${cid}&tab=org`);
  await page.getByRole("button", { name: "Edit Worker" }).click();
  await page.getByRole("checkbox", { name: skillName }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "Use your skill",
    assigneeAgentId: ag.id,
  });
  await api.post(`/api/org/agents/${ag.id}/wake`, { taskId: t.id });
  await page.getByRole("tab", { name: /Approvals/ }).click();
  const ask = page.getByTestId("exec-approval").filter({ hasText: "javascript" }).first();
  await ask.waitFor({ timeout: 20_000 });
  await ask.getByRole("button", { name: "Allow once" }).click();
  await expect
    .poll(
      async () => {
        const runs = await api.get<{ runs: { id: string; source: string }[] }>(
          `/api/org/companies/${cid}/runs`,
        );
        const woke = runs.runs.find((r) => r.source === "approval");
        if (!woke) return "";
        const run = await api.get<{ log: { text: string }[] }>(`/api/org/runs/${woke.id}`);
        return run.log.map((l) => l.text).join("\n");
      },
      { timeout: 60_000 },
    )
    .toContain("Skill " + skillName + ": ran");
});

test("an agent can name a cheaper model for quick work", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Quick") });
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, { name: "Swift" });
  await page.goto(`/org?c=${cid}&tab=org`);
  await page.getByRole("button", { name: "Edit Swift" }).click();
  await page.locator("#agent-quick-model").fill("groq/llama-3.1-8b-instant");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const saved = await api.get<{ adapterConfig: { quickModel?: string } }>(
    `/api/org/agents/${ag.id}`,
  );
  expect(saved.adapterConfig.quickModel).toBe("groq/llama-3.1-8b-instant");
});

test("a company can have the council check finished work", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Gate") });
  await page.goto(`/org?c=${cid}&tab=approvals`);
  await page.getByRole("switch", { name: "Council checks finished work" }).click();
  await expect
    .poll(
      async () =>
        (await api.get<{ councilGatesDone?: boolean }>(`/api/org/companies/${cid}`))
          .councilGatesDone,
    )
    .toBe(true);
});

test("the inbox gathers blocked work and sends it to notifications", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Inbox") });
  const ag = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Busy",
    heartbeat: { wakeOnAssign: false },
  });
  const t = await api.post<{ id: string; identifier: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "Stuck on credentials",
    assigneeAgentId: ag.id,
  });
  await api.post(`/api/org/tasks/${t.id}/status`, { status: "blocked" });
  await page.goto(`/org?c=${cid}&tab=org`);
  const inbox = page.getByTestId("org-inbox");
  await inbox.locator("summary").click();
  await expect(inbox.getByText(`${t.identifier} is blocked`)).toBeVisible();
  await inbox.getByRole("button", { name: "Send to my notifications" }).click();
  await expect(inbox.getByRole("button", { name: "Sent to your notifications" })).toBeVisible();
  const notes = await api.get<{ notifications: { title: string; message?: string }[] }>(
    "/api/notifications",
  );
  expect(notes.notifications.some((n) => n.message?.includes(t.identifier))).toBe(true);
});

test("a task can be replayed whole on another model", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Task Replay") });
  await api.post(`/api/org/companies/${cid}/tasks`, { title: "Replay me" });
  let asked: { model?: string } | null = null;
  // The models are not under test here; a canned sweep stands in for them.
  await page.route("**/api/org/tasks/*/replay", async (route) => {
    asked = route.request().postDataJSON() as typeof asked;
    await route.fulfill({
      json: {
        rows: [
          {
            runId: "r1",
            originalModel: "a",
            originalCostUsd: 0.01,
            originalStatus: "done",
            replayModel: "b",
            replayCostUsd: 0.002,
            replayStatus: "in_review",
            changedLines: 3,
          },
        ],
        stopped: null,
        totals: { originalCostUsd: 0.01, replayCostUsd: 0.002 },
      },
    });
  });
  await page.goto(`/org?c=${cid}&tab=tasks`);
  await page.getByTestId("task-card").filter({ hasText: "Replay me" }).click();
  const box = page.getByTestId("task-replay");
  await box.getByLabel("Model to replay the task on").fill("groq/openai/gpt-oss-20b");
  await box.getByRole("button", { name: "Replay all runs" }).click();
  await expect(box.getByRole("table", { name: "Task replay" })).toContainText("(differs)");
  expect(asked!.model).toBe("groq/openai/gpt-oss-20b");
});

test("a discussion can take turns in order", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Order") });
  for (const name of ["Ann", "Ben"])
    await api.post(`/api/org/companies/${cid}/agents`, {
      name,
      heartbeat: { wakeOnAssign: false },
    });
  await api.post(`/api/org/companies/${cid}/tasks`, { title: "Pick a name" });
  let sent: { inOrder?: boolean; fileOutcome?: boolean; agentIds?: string[] } | null = null;
  await page.route("**/api/org/tasks/*/discuss", async (route) => {
    sent = route.request().postDataJSON() as typeof sent;
    await route.fulfill({
      status: 202,
      json: { taskId: "t", agents: [], rounds: 3, inOrder: true },
    });
  });
  await page.goto(`/org?c=${cid}&tab=tasks`);
  await page.getByTestId("task-card").filter({ hasText: "Pick a name" }).click();
  const box = page.getByRole("group", { name: "Discuss" });
  await box.getByLabel("Ann").check();
  await box.getByLabel("Ben").check();
  await box.getByLabel(/Take turns in order/).check();
  await box.getByRole("button", { name: "Start discussion" }).click();
  await expect.poll(() => sent?.inOrder).toBe(true);
  expect(sent!.fileOutcome).toBe(true);
  expect(sent!.agentIds).toHaveLength(2);
});

test("a company can let replays run while paused", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Replay") });
  await page.goto(`/org?c=${cid}&tab=approvals`);
  await page.getByRole("switch", { name: "Replays run while paused" }).click();
  await expect
    .poll(
      async () =>
        (await api.get<{ replaysWhilePaused?: boolean }>(`/api/org/companies/${cid}`))
          .replaysWhilePaused,
    )
    .toBe(true);
});

test("a manager's heartbeat files a review when its team is blocked", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Review") });
  const ceo = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Ceo",
    heartbeat: { enabled: true, intervalSec: 60, wakeOnAssign: false },
  });
  const dev = await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
    name: "Dev",
    reportsTo: ceo.id,
    heartbeat: { wakeOnAssign: false },
  });
  const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title: "Migrate db",
    assigneeAgentId: dev.id,
  });
  await api.post(`/api/org/tasks/${t.id}/status`, { status: "blocked" });

  await page.goto(`/org?c=${cid}&tab=tasks`);
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByTestId("task-card").filter({ hasText: "Review: 1 item waiting on your team" }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 150_000, intervals: [10_000] });
});

test("the inbox reassigns and unblocks waiting work in place", async ({ page, api }) => {
  const cid = await newCompany(api, { name: unique("PW Inbox") });
  const hire = (name: string) =>
    api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, {
      name,
      heartbeat: { wakeOnAssign: false },
    });
  const dev = await hire("Dev");
  const lead = await hire("Lead");
  const title = unique("Needs creds");
  const t = await api.post<{ id: string }>(`/api/org/companies/${cid}/tasks`, {
    title,
    assigneeAgentId: dev.id,
  });
  await api.post(`/api/org/tasks/${t.id}/status`, { status: "blocked" });

  // The notification's deep link opens the inbox.
  await page.goto(`/org?c=${cid}&inbox=open`);
  const item = page.getByTestId("inbox-item").filter({ hasText: title });
  await item.waitFor();
  await item.getByRole("combobox").selectOption({ label: "Lead" });
  await expect
    .poll(
      async () =>
        (await api.get<{ task: { assigneeAgentId: string } }>(`/api/org/tasks/${t.id}`)).task
          .assigneeAgentId,
    )
    .toBe(lead.id);
  await item.getByRole("button", { name: "Unblock" }).click();
  await item.waitFor({ state: "detached" });
  expect((await api.get<{ task: { status: string } }>(`/api/org/tasks/${t.id}`)).task.status).toBe(
    "todo",
  );
});

test("the inbox approves and rejects in place, and says when one was decided meanwhile", async ({
  page,
  api,
}) => {
  const cid = await newCompany(api, { name: unique("PW Approvals"), requireHireApproval: true });
  const names = { yes: unique("Yes"), no: unique("No"), late: unique("Late") };
  const ids: Record<string, string> = {};
  for (const [k, name] of Object.entries(names))
    ids[k] = (await api.post<{ id: string }>(`/api/org/companies/${cid}/agents`, { name })).id;
  const status = async (k: string) =>
    (
      await api.get<{ agents: { id: string; status: string }[] }>(
        `/api/org/companies/${cid}/agents`,
      )
    ).agents.find((a) => a.id === ids[k])?.status;
  const item = (name: string) => page.getByTestId("inbox-item").filter({ hasText: name });

  await page.goto(`/org?c=${cid}&inbox=open`);
  await item(names.yes).getByRole("button", { name: "Approve" }).click();
  await item(names.yes).waitFor({ state: "detached" });
  await expect.poll(() => status("yes")).toBe("idle");
  await item(names.no).getByRole("button", { name: "Reject" }).click();
  await item(names.no).waitFor({ state: "detached" });
  await expect.poll(() => status("no")).toBe("terminated");

  // Someone else decides while the inbox is open; acting on the stale item says so and refreshes.
  const { approvals } = await api.get<{ approvals: { id: string; title: string }[] }>(
    `/api/org/companies/${cid}/approvals?status=pending`,
  );
  await api.post(
    `/api/org/approvals/${approvals.find((a) => a.title.includes(names.late))!.id}/approve`,
  );
  await item(names.late).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("org-inbox").getByRole("alert")).toBeVisible();
  await item(names.late).waitFor({ state: "detached" });
  expect(await status("late")).toBe("idle");
});
