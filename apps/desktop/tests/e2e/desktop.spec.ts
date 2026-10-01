// SPDX-License-Identifier: Apache-2.0
/**
 * A fresh install, as a user meets it: sign up, answer the first-run questions, save a key,
 * run a company and code, discuss, clear the inbox, then restart and find everything where it was.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

const MAIN = join(__dirname, "..", "..", "dist", "main.js");
const GROQ = process.env["NEXUS_E2E_GROQ_KEY"];
const EMAIL = "desktop-e2e@example.com";
const PASSWORD = "Desktop-e2e-pass!1";

async function launch(dataDir: string) {
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: dataDir } as Record<string, string>;
  delete env["NEXUS_DESKTOP_URL"];
  delete env["NEXUS_API_URL"];
  const app = await electron.launch({ args: [MAIN], env, timeout: 120_000 });
  const page = await app.firstWindow({ timeout: 120_000 });
  return { app, page };
}

async function go(page: Page, path: string) {
  await page.evaluate((p) => window.history.pushState({}, "", p), path);
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")));
}

test("a fresh install signs up, works, and keeps it all across a restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "nexus-desktop-e2e-"));
  let { app, page } = await launch(dataDir);

  // First launch: no account yet, so the app asks for one instead of showing a guest.
  await expect(page).toHaveURL(/\/login$/, { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Create an account" }).click();
  // The register chunk loads before the route changes; the login form has #email too.
  await page.getByRole("heading", { name: "Create your account" }).waitFor();
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#confirmPassword").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  // A new account answers the first-run questions once.
  await expect(page).toHaveURL(/\/setup$/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Enter Nexus" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });

  if (GROQ) {
    await go(page, "/provider-keys");
    await page.getByRole("button", { name: "Add key" }).first().click();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Groq", exact: true }).click();
    await page.getByLabel("API key").fill(GROQ);
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved groq key.").waitFor();
  }

  // A company with two agents.
  await go(page, "/org");
  await page
    .getByRole("button", { name: /New company|Create your first company/ })
    .first()
    .click();
  await page.getByLabel("Name").fill("Desktop Co");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("company-name").filter({ hasText: "Desktop Co" }).waitFor();
  for (const name of ["Ada", "Bob"]) {
    await page.getByRole("button", { name: "Hire agent" }).click();
    await page.locator("#agent-name").fill(name);
    if (GROQ) await page.locator("#agent-model").fill("groq/openai/gpt-oss-120b");
    await page.getByRole("button", { name: "Hire", exact: true }).click();
    await page.locator(`[data-agent-name="${name}"]`).waitFor();
  }

  // A task, blocked so the inbox has something, then unblocked from there.
  await page.getByRole("tab", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator("#task-title").fill("Name three primary colours");
  await page.locator("#task-assignee").selectOption({ label: "Ada" });
  await page.getByRole("button", { name: "Create task" }).click();
  const card = page.getByTestId("task-card").filter({ hasText: "primary colours" });
  await card.click();

  if (GROQ) {
    // Assigning woke Ada, so her answer arrives in the thread.
    await page.getByLabel("Comments").locator("li").first().waitFor({ timeout: 120_000 });
    await page.getByRole("checkbox", { name: "Ada" }).check();
    await page.getByRole("checkbox", { name: "Bob" }).check();
    await page.getByRole("button", { name: "Start discussion" }).click();
    await page
      .getByLabel("Comments")
      .getByText(/^Discussion (settled|ended|stopped)/)
      .waitFor({ timeout: 240_000 });
  }
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Overview" }).click();
  const title = "Blocked on credentials";
  await page.getByRole("tab", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator("#task-title").fill(title);
  await page.locator("#task-assignee").selectOption({ label: "Bob" });
  await page.getByRole("button", { name: "Create task" }).click();
  await page.getByTestId("task-card").filter({ hasText: title }).click();
  await page.getByRole("button", { name: "Mark blocked" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Overview" }).click();
  const inbox = page.getByTestId("org-inbox");
  await inbox.locator("summary").click();
  const item = page.getByTestId("inbox-item").filter({ hasText: title });
  await item.getByRole("button", { name: "Unblock" }).click();
  await item.waitFor({ state: "detached" });

  // Code runs on this machine.
  await go(page, "/sandbox");
  await page.getByPlaceholder("// Write your code here…").fill("console.log(6 * 7)");
  await page.getByRole("button", { name: /^(Run|Running…)$/ }).click();
  await expect(page.locator("pre").filter({ hasText: /^\s*42\s*$/ })).toBeVisible({
    timeout: 60_000,
  });

  // A Python kernel keeps its variables between runs.
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "python" }).click();
  await page.getByLabel("Keep variables between runs").check();
  const editor = page.getByPlaceholder("// Write your code here…");
  const run = page.getByRole("button", { name: /^(Run|Running…)$/ });
  await editor.fill("n = 41");
  await run.click();
  await page.getByRole("button", { name: "Reset kernel" }).waitFor({ timeout: 120_000 });
  await expect(run).toBeEnabled({ timeout: 120_000 });
  await editor.fill("print(n + 1)");
  await run.click();
  await expect(page.locator("pre").filter({ hasText: /^\s*42\s*$/ })).toBeVisible({
    timeout: 120_000,
  });

  // Closing the window leaves the app, and its companies, running in the tray.
  const origin = new URL(page.url()).origin;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  const shown = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  expect(await shown()).toEqual([false]);
  expect((await fetch(`${origin}/health/ready`)).status).toBe(200);
  await app.evaluate(({ app: electronApp }) => electronApp.emit("second-instance"));
  expect(await shown()).toEqual([true]);

  // Restart: the session comes back from the keychain and the company from the local database.
  await app.close();
  ({ app, page } = await launch(dataDir));
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });
  await go(page, "/org");
  await page.getByTestId("company-name").filter({ hasText: "Desktop Co" }).waitFor();
  await page.getByRole("tab", { name: "Org chart" }).click();
  await expect(page.locator('[data-agent-name="Bob"]')).toBeVisible();
  // A cold load asks for data before the keychain token arrives; those calls must wait for it.
  const refused: string[] = [];
  page.on("response", (res) => {
    if (res.status() === 401 && new URL(res.url()).pathname.startsWith("/api/"))
      refused.push(res.url());
  });
  await page.reload();
  await page.getByTestId("company-name").filter({ hasText: "Desktop Co" }).waitFor();
  expect(refused).toEqual([]);
  await app.close();
});
