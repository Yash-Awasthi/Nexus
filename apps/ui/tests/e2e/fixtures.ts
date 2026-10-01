// SPDX-License-Identifier: Apache-2.0
/**
 * A signed-in page plus an API client for the same account. Every test fails
 * on an uncaught page error or a 5xx from the API, whatever it asserts itself.
 */
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = "E2e-test-pass!1";

interface Session {
  token: string;
  user: Record<string, unknown>;
}

export async function signIn(request: APIRequestContext, email: string): Promise<Session> {
  let res = await request.post("/api/v1/auth/register", {
    data: { email, password: PASSWORD, name: email },
  });
  if (res.status() === 409)
    res = await request.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
  const body = (await res.json()) as { accessToken?: string; user?: Record<string, unknown> };
  if (!body.accessToken) throw new Error(`sign-in failed for ${email}: ${res.status()}`);
  return { token: body.accessToken, user: body.user ?? {} };
}

export class Api {
  constructor(
    private request: APIRequestContext,
    readonly session: Session,
  ) {}

  async call<T = Record<string, unknown>>(method: string, url: string, data?: unknown) {
    const res = await this.request.fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.session.token}` },
      ...(data !== undefined ? { data } : {}),
    });
    return { status: res.status(), json: (await res.json().catch(() => ({}))) as T };
  }

  async post<T = Record<string, unknown>>(url: string, data: unknown = {}) {
    return (await this.call<T>("POST", url, data)).json;
  }

  async get<T = Record<string, unknown>>(url: string) {
    return (await this.call<T>("GET", url)).json;
  }
}

/** Put the session where the UI looks for it, before any page script runs. */
export async function signInPage(page: Page, session: Session): Promise<void> {
  await page.addInitScript(
    ([token, user]) => {
      localStorage.setItem("nexus_token", token);
      localStorage.setItem("nexus_user", user);
      localStorage.setItem("nexus_setup_done", "1");
    },
    [session.token, JSON.stringify({ ...session.user, username: "Owner" })] as const,
  );
}

export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (u.pathname.startsWith("/api") && res.status() >= 500)
      problems.push(`${res.status()} ${res.request().method()} ${u.pathname}`);
  });
  return problems;
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

const OWNER = "e2e-owner@example.com";

export const test = base.extend<{ api: Api }, { owner: Session }>({
  // Once per worker: sign-in is rate limited.
  owner: [
    async ({ playwright }, use, info) => {
      const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
      await use(await signIn(request, OWNER));
      await request.dispose();
    },
    { scope: "worker" },
  ],
  api: async ({ request, owner }, use) => {
    await use(new Api(request, owner));
  },
  page: async ({ page, api }, use) => {
    await signInPage(page, api.session);
    const problems = watchProblems(page);
    await use(page);
    expect(problems).toEqual([]);
    expect(await noHorizontalScroll(page), "page scrolls sideways at 375px").toBe(true);
  },
});

export { expect };

/** Specs that need a real model call; they skip unless the owner has provider keys. */
export const withModels = !!process.env["E2E_MODELS"];
