// SPDX-License-Identifier: Apache-2.0
/** NX-FEAT-001: the security check names each gap a deployment's settings leave open. */
import { describe, expect, it } from "vitest";

import { checkPosture, summarize } from "../../src/lib/security-posture.ts";

const HEX = "a".repeat(64);
const HARDENED = {
  NODE_ENV: "production",
  NEXUS_JWT_SECRET: "j".repeat(48),
  NEXUS_API_KEY: "k".repeat(48),
  NEXUS_AUDIT_KEY: "u".repeat(48),
  NEXUS_SECRETS_KEY: HEX,
  NEXUS_MFA_KEY: HEX,
  ALLOWED_ORIGINS: "https://nexus.example",
  RENDER: "true",
  NEXUS_TRUST_PROXY: "uniquelocal",
  DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/db?sslmode=require",
  RESEND_API_KEY: "re_x",
  NEXUS_MAIL_FROM: "Nexus <no-reply@nexus.example>",
  NEXUS_PUBLIC_URL: "https://nexus.example",
};

const status = (env: Record<string, string>, id: string, sharedKv = "redis" as const) =>
  checkPosture(env, { sharedKv }).find((c) => c.id === id)?.status;

describe("checkPosture", () => {
  it("passes every check on a hardened deployment", () => {
    const checks = checkPosture(HARDENED, { sharedKv: "redis" });
    expect(checks.filter((c) => c.status !== "pass").map((c) => c.id)).toEqual([]);
    expect(summarize(checks).fail).toBe(0);
  });

  it.each([
    ["audit-key", { NEXUS_AUDIT_KEY: "" }],
    ["mfa-key", { NEXUS_MFA_KEY: "" }],
    ["jwt-signing-key", { NEXUS_JWT_SECRET: "short" }],
    ["trust-proxy", { NEXUS_TRUST_PROXY: "" }],
    ["unsandboxed-exec", { ALLOW_UNSANDBOXED_EXEC: "true" }],
    ["pty-force", { NEXUS_LOCAL_PTY_FORCE: "1" }],
    ["queue-dashboard", { NEXUS_QUEUE_DASHBOARD_PASSWORD: "admin" }],
    ["redis-auth", { REDIS_URL: "redis://cache.internal:6379" }],
  ])("fails %s in production when weakened", (id, change) => {
    expect(status({ ...HARDENED, ...change }, id)).toBe("fail");
  });

  it.each([
    ["cors-origins", { ALLOWED_ORIGINS: "" }],
    ["secrets-key", { NEXUS_SECRETS_KEY: "" }],
    ["exec-mode", { NEXUS_EXEC_MODE: "trusted" }],
    ["email-delivery", { RESEND_API_KEY: "" }],
    ["database-tls", { DATABASE_URL: "postgresql://u:p@db.example.com/db" }],
    ["bot-webhooks", { SLACK_BOT_TOKEN: "xoxb-1" }],
    ["sso-provisioning", { NEXUS_SSO_AUTO_PROVISION: "1" }],
    ["public-completions", { GROQ_API_KEY: "g", NEXUS_LIBERTAS_GLOBAL_PER_MIN: "1000" }],
  ])("warns about %s", (id, change) => {
    expect(status({ ...HARDENED, ...change }, id)).toBe("warn");
  });

  it("accepts a local or password-protected Redis", () => {
    for (const REDIS_URL of [
      "redis://localhost:6379",
      "redis://redis:6379",
      "rediss://default:secret@cache.example:6380",
    ])
      expect(status({ ...HARDENED, REDIS_URL }, "redis-auth")).toBe("pass");
  });

  it("fails per-process state only where several replicas run", () => {
    expect(status(HARDENED, "shared-state", "memory")).toBe("warn");
    expect(status({ ...HARDENED, FLY_APP_NAME: "nexus" }, "shared-state", "memory")).toBe("fail");
  });

  it("downgrades production-only gaps to warnings on a development box", () => {
    expect(status({ ...HARDENED, NODE_ENV: "development", NEXUS_AUDIT_KEY: "" }, "audit-key")).toBe(
      "warn",
    );
  });

  it("gives a fix for every check that does not pass", () => {
    const checks = checkPosture({}, { sharedKv: "memory" });
    for (const c of checks.filter((x) => x.status !== "pass")) expect(c.fix, c.id).not.toBe("");
  });
});
