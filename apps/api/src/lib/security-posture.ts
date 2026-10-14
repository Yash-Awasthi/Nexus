// SPDX-License-Identifier: Apache-2.0
// The security check (NX-FEAT-001): what this deployment's settings leave open, and the setting
// that closes each gap. Pure over env and a few runtime facts so every rule is tested directly.

import { mailConfigured } from "./mailer.ts";

export type PostureStatus = "pass" | "warn" | "fail";

export interface PostureCheck {
  id: string;
  title: string;
  status: PostureStatus;
  detail: string;
  /** What to change; empty when the check passes. */
  fix: string;
}

export interface PostureFacts {
  /** Which store backs the shared KV: memory means per-process limits and state. */
  sharedKv: "redis" | "upstash" | "postgres" | "memory" | "cloudflare";
}

type Env = Record<string, string | undefined>;

const isHex64 = (v: string | undefined) => !!v && /^[0-9a-f]{64}$/i.test(v);

export function checkPosture(env: Env, facts: PostureFacts): PostureCheck[] {
  const prod = env.NODE_ENV === "production";
  const desktop = env.NEXUS_DESKTOP === "1";
  // A real gap in production is a failure; the same gap on a development box is a warning.
  const gap = (): PostureStatus => (prod ? "fail" : "warn");
  const checks: PostureCheck[] = [];
  const add = (
    id: string,
    title: string,
    ok: boolean,
    bad: PostureStatus,
    detail: string,
    fix: string,
  ) => checks.push({ id, title, status: ok ? "pass" : bad, detail, fix: ok ? "" : fix });

  add(
    "production-mode",
    "Running in production mode",
    prod || desktop,
    "warn",
    prod
      ? "NODE_ENV=production."
      : "Outside production, password-reset and verification tokens are returned in responses.",
    "Set NODE_ENV=production on any server other people can reach.",
  );

  const rs256 = env.NEXUS_JWT_ALG === "RS256";
  const jwtOk = rs256
    ? !!env.NEXUS_JWT_PRIVATE_KEY && !!env.NEXUS_JWT_PUBLIC_KEY
    : (env.NEXUS_JWT_SECRET?.length ?? 0) >= 32;
  add(
    "jwt-signing-key",
    "Session tokens are signed with a strong key",
    jwtOk,
    "fail",
    rs256
      ? "RS256 needs both NEXUS_JWT_PRIVATE_KEY and NEXUS_JWT_PUBLIC_KEY."
      : `NEXUS_JWT_SECRET is ${env.NEXUS_JWT_SECRET ? `${env.NEXUS_JWT_SECRET.length} characters` : "unset"}.`,
    rs256
      ? "Set both RS256 keys."
      : "Set NEXUS_JWT_SECRET to at least 32 random characters (openssl rand -hex 32).",
  );

  add(
    "api-key",
    "The master API key is long",
    (env.NEXUS_API_KEY?.length ?? 0) >= 32,
    (env.NEXUS_API_KEY?.length ?? 0) >= 16 ? "warn" : "fail",
    "NEXUS_API_KEY grants admin-level API access.",
    "Use at least 32 random characters (openssl rand -hex 32).",
  );

  add(
    "audit-key",
    "The audit chain has its own HMAC key",
    (env.NEXUS_AUDIT_KEY?.length ?? 0) >= 32,
    gap(),
    "Without NEXUS_AUDIT_KEY the chain is signed with a key published in the source, so someone " +
      "with database access can rebuild it after editing entries.",
    "Set NEXUS_AUDIT_KEY (openssl rand -hex 32) before the first audit entry; changing it later " +
      "makes earlier entries fail verification.",
  );

  add(
    "secrets-key",
    "The secret store can encrypt",
    isHex64(env.NEXUS_SECRETS_KEY),
    "warn",
    "Without NEXUS_SECRETS_KEY the per-user secret store refuses every write.",
    "Set NEXUS_SECRETS_KEY to 64 hex characters (openssl rand -hex 32).",
  );

  add(
    "mfa-key",
    "Authenticator secrets are encrypted at rest",
    isHex64(env.NEXUS_MFA_KEY) || isHex64(env.OAUTH_ENCRYPTION_KEY),
    gap(),
    "Without NEXUS_MFA_KEY, TOTP secrets are stored in plain text in the users table.",
    "Set NEXUS_MFA_KEY to 64 hex characters, then have users re-enrol MFA.",
  );

  add(
    "cors-origins",
    "Cross-origin requests are limited to known origins",
    !!env.ALLOWED_ORIGINS || desktop,
    prod ? "warn" : "pass",
    "Without ALLOWED_ORIGINS every origin may call the API from a browser.",
    "Set ALLOWED_ORIGINS to the UI's origin(s), comma-separated.",
  );

  const behindProxy = !!(env.RENDER || env.FLY_APP_NAME || env.KUBERNETES_SERVICE_HOST);
  add(
    "trust-proxy",
    "Client addresses come through the proxy correctly",
    !behindProxy || !!env.NEXUS_TRUST_PROXY,
    "fail",
    "Behind a proxy, without NEXUS_TRUST_PROXY every request appears to come from the proxy, so " +
      "per-address limits throttle everyone together.",
    "Set NEXUS_TRUST_PROXY to the proxy's network (Render: uniquelocal).",
  );

  const replicas = !!(env.FLY_APP_NAME || env.KUBERNETES_SERVICE_HOST);
  add(
    "shared-state",
    "Rate limits and sign-in state are shared",
    facts.sharedKv !== "memory" || desktop,
    replicas ? "fail" : "warn",
    "The shared KV is process memory: rate limits and OAuth state are per process and reset on " +
      "restart (revocations and lockouts still persist in Postgres).",
    "Set REDIS_URL, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
  );

  add(
    "unsandboxed-exec",
    "Drive commands run only in the sandbox",
    env.ALLOW_UNSANDBOXED_EXEC !== "true",
    gap(),
    "ALLOW_UNSANDBOXED_EXEC=true runs drive commands as host shells.",
    "Unset ALLOW_UNSANDBOXED_EXEC and provide Docker (optionally gVisor or Kata).",
  );

  add(
    "pty-force",
    "Host terminals stay loopback-only",
    env.NEXUS_LOCAL_PTY_FORCE !== "1" || desktop,
    "fail",
    "NEXUS_LOCAL_PTY_FORCE=1 serves host terminals to remote callers.",
    "Unset NEXUS_LOCAL_PTY_FORCE.",
  );

  add(
    "exec-mode",
    "Executions ask before running on a shared server",
    env.NEXUS_EXEC_MODE !== "trusted" || desktop,
    "warn",
    "NEXUS_EXEC_MODE=trusted runs allowlisted commands for every member without asking.",
    "Use NEXUS_EXEC_MODE=ask (the default) on servers with more than one account.",
  );

  const provisioning =
    env.NEXUS_SSO_AUTO_PROVISION === "1" || env.NEXUS_OIDC_AUTO_PROVISION === "1";
  add(
    "sso-provisioning",
    "Single sign-on account creation is limited to named domains",
    !provisioning || !!(env.NEXUS_SSO_ALLOWED_DOMAINS || env.NEXUS_OIDC_ALLOWED_DOMAINS),
    "warn",
    "Auto-provisioning is on but no domain is allowed, so it creates no accounts.",
    "Set NEXUS_SSO_ALLOWED_DOMAINS, or turn NEXUS_SSO_AUTO_PROVISION off.",
  );

  add(
    "email-delivery",
    "Account email can be delivered",
    !prod || desktop || mailConfigured(env),
    "warn",
    "Without mail, password reset and email verification cannot reach users, and security " +
      "notices stay in the app where someone who took over the account can dismiss them.",
    "Set RESEND_API_KEY, NEXUS_MAIL_FROM and NEXUS_PUBLIC_URL (the address users open Nexus at).",
  );

  const unverifiedBots = [
    env.SLACK_BOT_TOKEN && !env.SLACK_SIGNING_SECRET ? "Slack (SLACK_SIGNING_SECRET)" : "",
    env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_WEBHOOK_SECRET
      ? "Telegram (TELEGRAM_WEBHOOK_SECRET)"
      : "",
    env.TEAMS_BOT_APP_PASSWORD && !env.TEAMS_BOT_APP_ID ? "Teams (TEAMS_BOT_APP_ID)" : "",
  ].filter(Boolean);
  add(
    "bot-webhooks",
    "Bot webhooks can verify their sender",
    unverifiedBots.length === 0,
    "warn",
    unverifiedBots.length
      ? `These webhooks answer 503 until configured: ${unverifiedBots.join(", ")}.`
      : "Every configured bot can verify its webhook.",
    "Set the named secrets, or remove the bot token.",
  );

  add(
    "public-completions",
    "The public completion endpoint is bounded",
    !env.GROQ_API_KEY || Number(env.NEXUS_LIBERTAS_GLOBAL_PER_MIN ?? 30) <= 60,
    "warn",
    `POST /api/v1/libertas/complete spends GROQ_API_KEY for anyone, up to ` +
      `${env.NEXUS_LIBERTAS_GLOBAL_PER_MIN ?? 30} calls a minute in total.`,
    "Lower NEXUS_LIBERTAS_GLOBAL_PER_MIN, or remove GROQ_API_KEY.",
  );

  const dbUrl = env.DATABASE_URL ?? "";
  const remoteDb =
    /^postgres(ql)?:\/\//.test(dbUrl) && !/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(dbUrl);
  add(
    "database-tls",
    "The database connection is encrypted",
    !remoteDb || /sslmode=(require|verify-ca|verify-full)/.test(dbUrl),
    "warn",
    "A remote DATABASE_URL without sslmode can connect in plain text.",
    "Add ?sslmode=require (or verify-full) to DATABASE_URL.",
  );

  const redisUrl = env.REDIS_URL ?? "";
  const redisHost = /^rediss?:\/\/(?:[^@/]*@)?([^:/?]+)/.exec(redisUrl)?.[1] ?? "";
  const remoteRedis = !!redisUrl && !["localhost", "127.0.0.1", "redis"].includes(redisHost);
  add(
    "redis-auth",
    "The job queue needs a password",
    !remoteRedis || /^rediss?:\/\/[^@/]*:[^@/]+@/.test(redisUrl),
    gap(),
    "Workers run whatever jobs are in Redis as the user named in the job, so an open Redis is a " +
      "way to act as any account.",
    "Put a password in REDIS_URL (redis://:password@host:6379), and prefer rediss:// for TLS.",
  );

  add(
    "queue-dashboard",
    "The queue dashboard has a strong password",
    !env.NEXUS_QUEUE_DASHBOARD_PASSWORD || env.NEXUS_QUEUE_DASHBOARD_PASSWORD.length >= 16,
    "fail",
    "/admin/queues can retry, promote and delete jobs.",
    "Use at least 16 random characters for NEXUS_QUEUE_DASHBOARD_PASSWORD.",
  );

  return checks;
}

export function summarize(checks: PostureCheck[]): Record<PostureStatus, number> {
  const out: Record<PostureStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) out[c.status]++;
  return out;
}
