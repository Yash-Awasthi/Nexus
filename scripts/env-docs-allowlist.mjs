// SPDX-License-Identifier: Apache-2.0
/**
 * Variables documented in `.env.example` that the literal `process.env.NAME` /
 * `import.meta.env.NAME` scan in scripts/check-env-docs.mjs cannot see.
 *
 * Every entry needs a reader behind it: another language, a helper that takes the
 * name as an argument, bracket access, or an env object passed to a parser. An
 * entry with no reader is stale documentation and belongs at the end of this file
 * under "no reader yet" until the owning feature lands or the doc is removed.
 *
 * Adding a name here suppresses the documented-but-unread failure. Keep reasons
 * short and point at the actual reader.
 */
/** Framework, platform and tooling variables the environment supplies; never this project's contract. */
export const PLATFORM_ENV = new Set([
  // Node/npm
  "NODE_ENV",
  "PORT",
  "HOST",
  "CI",
  "PATH",
  "HOME",
  "PWD",
  "TMPDIR",
  "npm_package_version",
  // Windows shell/process platform
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  // Test runners and deploy platforms
  "VITEST",
  "DEV",
  "RENDER_GIT_COMMIT",
  // Set by the desktop shell or its smoke test, never by an operator
  "NEXUS_DESKTOP",
  "NEXUS_DESKTOP_SMOKE",
]);

export const ALLOWLIST = {
  // ── Read through an env object by a config parser ──────────────────────────
  NEXUS_EXEC_MODE: "policyFromEnv(env) in packages/exec-policy/src/index.ts",
  NEXUS_EXEC_ALLOW: "policyFromEnv(env) in packages/exec-policy/src/index.ts",
  NEXUS_EXEC_DENY: "policyFromEnv(env) in packages/exec-policy/src/index.ts",
  NEXUS_EXEC_ROOTS: "policyFromEnv(env) in packages/exec-policy/src/index.ts",
  NEXUS_EXEC_ASK_SURFACES: "policyFromEnv(env) in packages/exec-policy/src/index.ts",
  NEXUS_LSP: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_TYPESCRIPT_CMD: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_PYTHON_CMD: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_GO_CMD: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_RUST_CMD: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_ROOTS: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_MAX_SERVERS: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_IDLE_MS: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_START_TIMEOUT_MS: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_REQUEST_TIMEOUT_MS: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_DIAGNOSTICS_WAIT_MS: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_MAX_MEMORY_MB: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_MAX_DOCUMENTS: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_MAX_FILE_BYTES: "parseLspConfig(env) in packages/lsp/src/config.ts",
  NEXUS_LSP_LOG: "parseLspConfig(env) in packages/lsp/src/config.ts",

  // ── Read by compose and by a helper that takes the name as a string ─────────
  AUTH_LOGIN_RATE_LIMIT: "compose api env; authLimit() in apps/api/src/routes/auth-users.ts",
  AUTH_LOGIN_RATE_WINDOW_MS: "authLimit() in apps/api/src/routes/auth-users.ts",
  AUTH_REGISTER_RATE_LIMIT: "compose api env; authLimit() in apps/api/src/routes/auth-users.ts",
  AUTH_REGISTER_RATE_WINDOW_MS: "authLimit() in apps/api/src/routes/auth-users.ts",
  AUTH_FORGOT_RATE_LIMIT: "authLimit() in apps/api/src/routes/auth-users.ts",
  AUTH_FORGOT_RATE_WINDOW_MS: "authLimit() in apps/api/src/routes/auth-users.ts",
  WORKER_CONCURRENCY_HIGH: "envConcurrency() in apps/worker/src/workers/task-worker.ts",
  WORKER_CONCURRENCY_MEDIUM: "envConcurrency() in apps/worker/src/workers/task-worker.ts",
  WORKER_CONCURRENCY_LOW: "envConcurrency() in apps/worker/src/workers/task-worker.ts",

  // ── Read by Python, not TypeScript ─────────────────────────────────────────
  NEXUS_INGEST_API_KEY: "os.getenv in services/ingest/src/nexus_ingest/auth.py; compose passes it",

  // ── Read through an env object passed to a parser (not process.env here) ────
  NEXUS_PUBLIC_URL: "env object in apps/api/src/lib/mailer.ts",
  NEXUS_SSO_AUTO_PROVISION: "env object in apps/api/src/lib/sso-provisioning.ts",
  NEXUS_SSO_ALLOWED_DOMAINS: "env object in apps/api/src/lib/sso-provisioning.ts",
  NEXUS_OAUTH_VAULT_KEY: "AesGcmVault.fromEnv() in apps/api/src/lib/oauth-token-store.ts",
  NEXUS_SECRETS_KEY:
    "SECRET_KEY_ENV constant in packages/db/src/secret-crypto.ts; env object in security-posture.ts",
  GOOGLE_OAUTH_CLIENT_ID: "env object in packages/llm-oauth/src/registry.ts",
  GOOGLE_OAUTH_CLIENT_SECRET: "env object in packages/llm-oauth/src/registry.ts",
  GOOGLE_CLOUD_PROJECT: "env object in packages/llm-oauth/src/registry.ts",
  GOOGLE_CLOUD_REGION: "env object in packages/llm-oauth/src/registry.ts",
  AZURE_OAUTH_CLIENT_ID: "env object in packages/llm-oauth/src/registry.ts",
  AZURE_OAUTH_CLIENT_SECRET: "env object in packages/llm-oauth/src/registry.ts",
  GITHUB_OAUTH_CLIENT_ID: "requiredEnv of a provider marked unsupported (GitHub Models preview)",
  GITHUB_OAUTH_CLIENT_SECRET:
    "requiredEnv of a provider marked unsupported (GitHub Models preview)",
  AZURE_TENANT_ID: "env object in packages/llm-oauth/src/registry.ts",
  AZURE_OPENAI_ENDPOINT: "env object in packages/llm-oauth/src/registry.ts",
  AZURE_OPENAI_DEPLOYMENT: "env object in packages/llm-oauth/src/registry.ts",
  AZURE_OPENAI_API_VERSION: "env object in packages/llm-oauth/src/registry.ts",

  // ── Read by bracket access, an optional chain, or a computed name ──────────
  NEXUS_INJECTION_GUARD: "env?.[...] in packages/contracts/src/shared/untrusted.ts",
  NEXUS_LLMLINGUA: "process.env?.NEXUS_LLMLINGUA in packages/llm/src/compress/index.ts",
  NEXUS_SANDBOX_IMAGE: "process.env[...] in packages/sandbox and apps/sandbox-helper",
  SANDBOX_SHELL_IMAGE: "process.env[...] in packages/code-repl",
  SANDBOX_RUNTIME: "process.env[...] in packages/sandbox and packages/code-repl",
  DRIVE_BACKUP_S3_ENDPOINT:
    "s3ConfigFromEnv() reads `DRIVE_BACKUP_S3_${suffix}` in packages/sandbox/src/s3.ts",
  DRIVE_BACKUP_S3_REGION:
    "s3ConfigFromEnv() reads `DRIVE_BACKUP_S3_${suffix}` in packages/sandbox/src/s3.ts",
  DRIVE_BACKUP_S3_ACCESS_KEY_ID:
    "s3ConfigFromEnv() reads `DRIVE_BACKUP_S3_${suffix}` in packages/sandbox/src/s3.ts",
  DRIVE_BACKUP_S3_SECRET_ACCESS_KEY:
    "s3ConfigFromEnv() reads `DRIVE_BACKUP_S3_${suffix}` in packages/sandbox/src/s3.ts",
  DRIVE_BACKUP_S3_PREFIX:
    "s3ConfigFromEnv() reads `DRIVE_BACKUP_S3_${suffix}` in packages/sandbox/src/s3.ts",

  // ── No reader yet ─────────────────────────────────────────────────────────
  // Documented for a feature that is not wired, or left over from a removed one.
  // Review for removal; these are the entries the check would otherwise flag.
  OTEL_TRACES_SAMPLER: "no reader; sampler rate is OTEL_TRACES_SAMPLER_ARG",
  RESEARCH_LLM_TIMEOUT_MS: "no reader; only docs/STATUS.md mentions it",
  VITE_API_URL: "no reader; the UI takes NEXUS_API_URL through the Vite proxy",
  VITE_API_KEY: "no reader; no client code reads it",
  ALGOLIA_APP_ID: "no reader; docs-site search is not wired",
  ALGOLIA_API_KEY: "no reader; docs-site search is not wired",
  ALGOLIA_INDEX_NAME: "no reader; docs-site search is not wired",
  DOUBAO_API_KEY: "no reader; provider is BYOK-only or not wired",
  BYTEPLUS_API_KEY: "no reader; provider is BYOK-only or not wired",
  HUNYUAN_API_KEY: "no reader; provider is BYOK-only or not wired",
  SPARK_API_KEY: "no reader; provider is BYOK-only or not wired",
  XINFERENCE_BASE_URL: "no reader; self-hosted provider is not wired",
  REPLICATE_API_KEY: "no reader; provider is not wired",
  DASHSCOPE_API_KEY: "no reader; provider is BYOK-only or not wired",
  CHROMA_URL: "no reader; search-orchestrator does not read it",
  CHROMA_COLLECTION: "no reader; search-orchestrator does not read it",
  HF_TOKEN: "no reader; corpus publisher is not wired",
  HF_REPO_ID: "no reader; corpus publisher is not wired",
  BRIEF_SIGNING_KEY: "no reader; brief signer derives from NEXUS_API_KEY",
  NEXUS_OBSERVATION_DRIVER: "no reader; observation provider selection is code-only",
  OWM_API_KEY: "no reader; weather gateway is not wired",
  OWM_CITY: "no reader; weather gateway is not wired",
  MCP_OAUTH_CLIENT_ID: "no reader; MCP OAuth is configured in code",
  MCP_OAUTH_CLIENT_SECRET: "no reader; MCP OAuth is configured in code",
  MCP_OAUTH_TOKEN_URL: "no reader; MCP OAuth is configured in code",
  MCP_OAUTH_SCOPES: "no reader; MCP OAuth is configured in code",
  REPL_MEMORY_LIMIT: "no reader; code-repl hardcodes the limit",
  REPL_CPU_LIMIT: "no reader; code-repl hardcodes the limit",
  REPL_TIMEOUT_MS: "no reader; code-repl hardcodes the timeout",
  REPL_MAX_SESSIONS: "no reader; code-repl hardcodes the session cap",
};
