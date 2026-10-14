// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";

import { appLink, mailConfigured, sendMail } from "../../src/lib/mailer.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("builds links only from configuration", () => {
  expect(appLink("/x", {})).toBeNull();
  expect(appLink("/x", { OAUTH_REDIRECT_BASE: "https://a.test/api" })).toBe("https://a.test/x");
  expect(
    appLink("/x", { NEXUS_PUBLIC_URL: "https://b.test/", OAUTH_REDIRECT_BASE: "https://a.test" }),
  ).toBe("https://b.test/x");
  expect(appLink("/x", { NEXUS_PUBLIC_URL: "not a url" })).toBeNull();
});

it("needs a key, a sender and a public origin", () => {
  expect(mailConfigured({ RESEND_API_KEY: "k", NEXUS_MAIL_FROM: "f" })).toBe(false);
  expect(
    mailConfigured({
      RESEND_API_KEY: "k",
      NEXUS_MAIL_FROM: "f",
      NEXUS_PUBLIC_URL: "https://n.test",
    }),
  ).toBe(true);
});

it("sends nothing when unconfigured and reports a refusal without throwing", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  const fetchSpy = vi.fn(async () => new Response("", { status: 422 }));
  vi.stubGlobal("fetch", fetchSpy);
  expect(await sendMail({ to: "a@b.test", subject: "s", text: "t" })).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();

  vi.stubEnv("RESEND_API_KEY", "re_k");
  vi.stubEnv("NEXUS_MAIL_FROM", "Nexus <n@n.test>");
  vi.stubEnv("NEXUS_PUBLIC_URL", "https://n.test");
  expect(await sendMail({ to: "a@b.test", subject: "s", text: "t" })).toBe(false);
  expect(fetchSpy).toHaveBeenCalledWith(
    "https://api.resend.com/emails",
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer re_k" }) }),
  );

  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });
  expect(await sendMail({ to: "a@b.test", subject: "s", text: "t" })).toBe(false);
});
