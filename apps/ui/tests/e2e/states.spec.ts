// SPDX-License-Identifier: Apache-2.0
/**
 * Every page, in every state (plan M5.4.2).
 *
 * The gate this file enforces: no page may go blank, throw, or answer a failed request with a bare
 * sentence that a person cannot act on. It walks every route in the navigation three times — with the
 * API returning nothing, with the network gone, and with the API failing — and requires a shared state
 * component from `~/components/states` (or the root error boundary) in each of them.
 *
 * A page that hand-rolls `<p className="text-destructive">Could not load…</p>` fails here, which is the
 * point: those lines are silent to assistive technology and offer no retry.
 */
import { test, expect, type Page } from "@playwright/test";

import { signInPage, signIn, waitForPaint } from "./fixtures";

const ROUTES = [
  "/dashboard",
  "/chat",
  "/discussion",
  "/archetypes",
  "/org",
  "/projects",
  "/workspaces",
  "/workflows",
  "/templates",
  "/skills",
  "/knowledge",
  "/search",
  "/sandbox",
  "/terminals",
  "/knowledge-graph",
  "/costs",
  "/settings",
  "/provider-keys",
  "/mcp-servers",
  "/api-tokens",
  "/admin/users",
  "/admin/analytics",
  "/admin/traces",
  "/gateway",
  "/admin/audit",
  "/moderation",
  "/admin/feedback",
  "/admin/feature-flags",
  "/admin/system",
] as const;

const EMPTY = JSON.stringify({
  items: [],
  data: [],
  results: [],
  total: 0,
  memories: [],
  sessions: [],
  projects: [],
  nodes: [],
  edges: [],
  threads: [],
  entries: [],
});

/** Stub every non-auth API call. Auth bootstrap must still succeed or the page redirects to login. */
async function stubApi(page: Page, mode: "empty" | "error") {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/auth/")) return route.continue();
    if (mode === "error") {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "unavailable", message: "The service is restarting." }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: EMPTY });
  });
}

async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    return (main.textContent ?? "").replace(/\s+/g, " ").trim();
  });
}

const CRASH = /unexpected application error|application error|something went very wrong/i;

test("every route renders with an empty backend and says something", async ({ page, request }) => {
  test.setTimeout(600_000);
  await signInPage(page, await signIn(request, `e2e-empty-${Date.now()}@example.com`));
  await stubApi(page, "empty");
  const failures: string[] = [];

  for (const route of ROUTES) {
    await page.goto(route);
    await waitForPaint(page);
    const body = await pageText(page);
    if (body.length < 20) failures.push(`${route}: blank page`);
    const crash = CRASH.exec(body);
    if (crash) failures.push(`${route}: ${crash[0]}`);
    const states = await page
      .locator('[data-state="empty"], [data-state="error"], [data-state="loading"]')
      .count();
    if (states === 0 && (await page.locator("h1, h2").count()) === 0) {
      failures.push(`${route}: no heading and no state — “${body.slice(0, 80)}”`);
    }
  }

  expect(failures, failures.join("\n")).toEqual([]);
});

test("every route shows one offline bar when the network disappears", async ({ page, request }) => {
  test.setTimeout(600_000);
  await signInPage(page, await signIn(request, `e2e-offline-${Date.now()}@example.com`));
  const failures: string[] = [];

  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForLoadState("domcontentloaded");
    // Let the app hydrate before the network goes: a document that loses its socket mid-hydration never
    // mounts the shell, which is a different failure from the one this walks. "Hydrated" is observable — the
    // shell is mounted and no request is still in flight — so it is awaited rather than guessed at.
    await waitForPaint(page);
    await page.getByRole("navigation").first().waitFor({ state: "visible", timeout: 15_000 });
    await page.context().setOffline(true);
    const visible = await page
      .locator('[data-state="offline"]')
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) failures.push(`${route}: no offline bar`);
    await page.context().setOffline(false);
    await page.reload();
  }

  expect(failures, failures.join("\n")).toEqual([]);
});

test("every route answers a failing API with a state that offers a way forward", async ({
  page,
  request,
}) => {
  test.setTimeout(600_000);
  await signInPage(page, await signIn(request, `e2e-failing-${Date.now()}@example.com`));
  await stubApi(page, "error");
  const failures: string[] = [];

  for (const route of ROUTES) {
    await page.goto(route);
    await waitForPaint(page);
    const body = await pageText(page);
    // Announced counts: a shared PageError, an empty state, or a live region. A bare red sentence does not,
    // because a screen reader never hears it and nothing offers a way forward.
    const shared = await page
      .locator(
        '[data-state="error"], [data-state="empty"], [role="alert"], [aria-live="assertive"]',
      )
      .count();
    const boundary = await page.getByText("Oops!").count();
    if (shared === 0 && boundary === 0)
      failures.push(`${route}: no error state — “${body.slice(0, 100)}”`);
    if (CRASH.test(body)) failures.push(`${route}: crash page`);
  }

  expect(failures, failures.join("\n")).toEqual([]);
});
