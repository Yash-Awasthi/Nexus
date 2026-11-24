// SPDX-License-Identifier: Apache-2.0
/**
 * Offline acceptance: the checks from the offline track, one pass/fail line each.
 *
 * Every check runs with outbound sockets disabled (`scripts/e2e-offline.cjs`), so a
 * pass means the step worked without the WAN, not that it happened to. Prerequisites
 * a machine may not have (Ollama, a running SearXNG) report `skip` with the reason;
 * anything that was attempted and failed is a `fail` and exits 1.
 *
 * Usage: node scripts/offline-check.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { probeLsp } from "./offline-lsp-probe.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OFFLINE_HOOK = join(ROOT, "scripts", "e2e-offline.cjs");
const SPA_DIR = join(ROOT, "apps", "ui", "build", "client");
const DESKTOP_MAIN = join(ROOT, "apps", "desktop", "dist", "main.js");
const SANDBOX_IMAGE = process.env.NEXUS_SANDBOX_IMAGE ?? "nexus-sandbox:local";
const SEARXNG_URL = process.env.SEARXNG_URL ?? "";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

const results = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
  console.log(`[${status}] ${name}${detail ? `: ${detail}` : ""}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Run a command to completion, with a budget. */
function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: stderr + err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

/** Boot the API with no DATABASE_URL and outbound sockets blocked, then ask /health/ready. */
async function checkBoot() {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "nexus-offline-"));
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    NEXUS_API_KEY: "offline-check-key-000000000000",
    NEXUS_JWT_SECRET: "offline-check-jwt-000000000000",
    NEXUS_AUDIT_KEY: "offline-check-audit-00000000000",
    NEXUS_SECRETS_KEY: "offline-check-secrets-000000000",
    NEXUS_DATA_DIR: join(dataDir, "stores"),
  };
  delete env.DATABASE_URL;

  const child = spawn(
    process.execPath,
    ["--require", OFFLINE_HOOK, join(ROOT, "apps", "api", "src", "index.ts")],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (log += chunk.toString("utf8")));

  const deadline = Date.now() + 120_000;
  let lastError = "no answer";
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        record("fail", "offline boot", `API exited with code ${String(child.exitCode)}`);
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health/ready`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) {
          const body = await res.json();
          const checks = body.checks ?? {};
          const ready = Object.values(checks).every((value) => value === "ok");
          record(
            ready ? "pass" : "fail",
            "offline boot",
            `pglite, /health/ready ${res.status}, checks ${JSON.stringify(checks)}`,
          );
          return;
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    record("fail", "offline boot", `never became ready (${lastError})`);
    if (log.trim()) console.log(log.trim().split("\n").slice(-8).join("\n"));
  } finally {
    child.kill();
  }
}

async function checkModel() {
  let tags;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tags = await res.json();
  } catch {
    record("skip", "offline model", `Ollama is not answering at ${OLLAMA_URL}`);
    return;
  }
  const models = (tags.models ?? []).map((m) => m.name);
  const wanted = "qwen2.5:7b";
  const found = models.some((name) => name === wanted || name === `${wanted}:latest`);
  if (!found) {
    record("skip", "offline model", `${wanted} is not pulled (ollama pull ${wanted})`);
    return;
  }
  // Pulled is not the same as answering: run one short turn so a broken daemon or a
  // missing weight blob shows up here rather than during a demo.
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: wanted,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        stream: false,
        options: { num_predict: 8 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answer = await res.json();
    const text = (answer.message?.content ?? "").trim();
    record(
      "pass",
      "offline model",
      `${wanted} answered (${answer.eval_count ?? 0} tokens): ${text}`,
    );
  } catch (err) {
    record(
      "fail",
      "offline model",
      `${wanted} is pulled but did not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function checkSandbox() {
  const probe = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeoutMs: 10_000,
  });
  if (probe.code !== 0) {
    record("skip", "sandbox image", "Docker is not reachable");
    return;
  }
  const result = await run(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--tmpfs=/nexus-scratch:rw,nosuid,nodev,size=64m,mode=1777",
      "--user=1000:1000",
      "--cap-drop=ALL",
      SANDBOX_IMAGE,
      "python3",
      "-c",
      "print(1 + 1)",
    ],
    { timeoutMs: 60_000 },
  );
  record(
    result.code === 0 && result.stdout.trim() === "2" ? "pass" : "fail",
    "sandbox image",
    `${SANDBOX_IMAGE} under --network=none printed ${JSON.stringify(result.stdout.trim())}`,
  );
}

async function checkSearch() {
  if (!SEARXNG_URL) {
    record("skip", "searxng", "SEARXNG_URL is not set");
    return;
  }
  try {
    const res = await fetch(`${SEARXNG_URL}/search?q=nexus&format=json`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.json();
    const hits = Array.isArray(body.results) ? body.results.length : 0;
    // SearXNG is a metasearch front end, not a local corpus: it answers without the
    // WAN, but results still come from upstream engines. Reachability is the check.
    record(
      res.ok ? "pass" : "fail",
      "searxng",
      `HTTP ${res.status}, ${hits} result(s)${hits === 0 ? " (upstream engines need the WAN)" : ""}`,
    );
  } catch (err) {
    record("fail", "searxng", err instanceof Error ? err.message : String(err));
  }
}

async function checkLsp() {
  const result = await probeLsp();
  record(result.status, "offline lsp", result.detail);
}

function checkDesktopBuild() {
  const missing = [
    [DESKTOP_MAIN, "apps/desktop/dist/main.js"],
    [SPA_DIR, "apps/ui/build/client"],
  ].filter(([path]) => !existsSync(path));
  record(
    missing.length === 0 ? "pass" : "skip",
    "offline desktop",
    missing.length === 0
      ? "main process and UI build are present; run pnpm --filter @nexus/desktop start"
      : `build first: ${missing.map(([, name]) => name).join(", ")} missing`,
  );
}

await checkBoot();
await checkModel();
await checkSandbox();
await checkSearch();
await checkLsp();
checkDesktopBuild();

const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;
console.log(`\n${results.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
