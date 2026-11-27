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

/**
 * Wait until the page has actually painted, instead of sleeping a guessed number of milliseconds.
 *
 * A fixed sleep is a bet on how fast the runner is, and the bet loses on the slowest machine in CI. What the audits
 * in `craft.spec.ts` and `states.spec.ts` need before measuring is that layout has settled: web fonts resolved
 * (they change widths), two animation frames delivered (the route paints after the shell), and no request still in
 * flight. Each of those is a condition, so each is awaited.
 *
 * "No request in flight" is *not* `networkidle`. The signed-in shell opens `/api/notifications/stream` and holds
 * it for the life of the tab, so `networkidle` never fires and every call waited out the 30 s navigation timeout
 * — the craft audit spent its whole 15-minute budget on eight awaits and failed without naming a page. The
 * condition is the same one minus the streams: wait for load, then for the route's own requests to drain.
 */

/** The shell's server-sent notification stream: open on purpose, so never counted as in-flight. */
const LONG_LIVED = /\/api\/notifications\/stream(?:\?|$)/;

interface Activity {
  inFlight: Set<import("@playwright/test").Request>;
  lastRequestAt: number;
}

const activity = new WeakMap<Page, Activity>();

function watch(page: Page): Activity {
  const existing = activity.get(page);
  if (existing) return existing;
  const state: Activity = { inFlight: new Set(), lastRequestAt: 0 };
  activity.set(page, state);
  page.on("request", (request) => {
    state.lastRequestAt = Date.now();
    if (!LONG_LIVED.test(request.url())) state.inFlight.add(request);
  });
  const settle = (request: import("@playwright/test").Request) => {
    state.inFlight.delete(request);
    state.lastRequestAt = Date.now();
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  // A navigation abandons whatever the previous document had in flight, and an abandoned request does not
  // always report itself. Forgetting them keeps a stale entry from making every later wait time out.
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) state.inFlight.clear();
  });
  return state;
}

export async function waitForPaint(page: Page): Promise<void> {
  const state = watch(page);
  await page.waitForLoadState("load");
  // Loaded assets are not a rendered app: the shell mounts after hydration, and a measurement taken before
  // that reads the bootstrap document (its inline `window.__reactRouterContext` script and nothing else).
  await page.locator("main, nav").first().waitFor({ state: "attached", timeout: 20_000 });
  // Quiet for 250 ms, not merely empty for an instant: a route that has not started fetching yet would
  // otherwise pass the instant after `load` and be measured mid-render.
  try {
    await expect
      .poll(
        () =>
          state.inFlight.size === 0 && Date.now() - state.lastRequestAt > 250 ? "quiet" : "busy",
        { timeout: 20_000 },
      )
      .toBe("quiet");
  } catch {
    // A timeout that says only "the page kept requesting" sends the reader to the network tab; naming the
    // requests that never settled turns it into a one-line diagnosis.
    const pending = [...state.inFlight].map((request) => request.url());
    throw new Error(
      `waitForPaint: still requesting after 20s — ${pending.length === 0 ? "no request open, last one " + (Date.now() - state.lastRequestAt) + "ms ago" : pending.join(", ")}`,
    );
  }
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        document.fonts.ready.then(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
      ),
  );
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
      const session = await signIn(request, OWNER);
      // Each run starts on empty storage, so a key for the model specs is saved here.
      const groq = process.env["E2E_GROQ_KEY"];
      if (groq)
        await request.post("/api/user/provider-keys", {
          headers: { authorization: `Bearer ${session.token}` },
          data: { provider: "groq", apiKey: groq },
        });
      await use(session);
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
