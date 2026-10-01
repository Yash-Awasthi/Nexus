// SPDX-License-Identifier: Apache-2.0
/** Better Stack, Cloudflare, Salesforce and Google Calendar verify their credentials with one call. */
import { describe, expect, it } from "vitest";

import {
  betterStackConnector,
  cloudflareConnector,
  googleCalendarConnector,
  salesforceConnector,
} from "../src/index.js";

function fake(status: number, body: unknown, seen: { url: string; auth: string | null }[]) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
}

describe("credential-checking connectors", () => {
  it("Cloudflare accepts an active token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const c = cloudflareConnector({
      apiToken: "cf-t",
      fetch: fake(200, { success: true, result: { status: "active" } }, seen),
    });
    expect((await c.connect()).ok).toBe(true);
    expect(seen[0]).toEqual({
      url: "https://api.cloudflare.com/client/v4/user/tokens/verify",
      auth: "Bearer cf-t",
    });
  });

  it("Cloudflare refuses an inactive token", async () => {
    const c = cloudflareConnector({
      apiToken: "cf-t",
      fetch: fake(200, { success: true, result: { status: "disabled" } }, []),
    });
    expect(await c.connect()).toMatchObject({ ok: false });
  });

  it("Better Stack, Salesforce and Google Calendar call their own endpoints", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    await betterStackConnector({ apiToken: "bs", fetch: fake(200, { data: [] }, seen) }).connect();
    await salesforceConnector({
      instanceUrl: "https://acme.my.salesforce.com/",
      accessToken: "sf",
      fetch: fake(200, { user_id: "005" }, seen),
    }).connect();
    await googleCalendarConnector({
      accessToken: "g",
      fetch: fake(200, { items: [] }, seen),
    }).connect();
    expect(seen.map((s) => s.url)).toEqual([
      "https://uptime.betterstack.com/api/v2/monitors?per_page=1",
      "https://acme.my.salesforce.com/services/oauth2/userinfo",
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
    ]);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer bs", "Bearer sf", "Bearer g"]);
  });

  it("names a rejected credential", async () => {
    const r = await betterStackConnector({ apiToken: "x", fetch: fake(401, {}, []) }).connect();
    expect(r).toEqual({ ok: false, error: "Better Stack credentials are invalid" });
  });
});
