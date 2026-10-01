// SPDX-License-Identifier: Apache-2.0
/**
 * Node-backed ports for the local API (see `local-api.ts` for the contract).
 *
 * Split out so the boot sequence stays testable: everything here touches the
 * real filesystem, real sockets or a real child process.
 */

import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { LocalApiPorts, SpawnedProcess } from "./local-api";

/** An OS-assigned free port, asked for and released immediately. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * The local API key, minted once per install and kept in the data directory.
 *
 * It is not a user secret: it authenticates the renderer to a loopback-only
 * service on the same machine, and the file sits beside the database that
 * service owns. Account credentials stay in the OS keychain, which is a
 * different thing and stored differently.
 */
function localApiKey(dataDir: string, name = "local-api-key"): string {
  const file = join(dataDir, name);
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  mkdirSync(dataDir, { recursive: true });
  const minted = randomBytes(32).toString("hex");
  writeFileSync(file, minted, { encoding: "utf8", mode: 0o600 });
  return minted;
}

/** Poll `url` until it answers or the budget runs out. */
async function waitForHealth(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Local API did not become healthy within ${timeoutMs}ms (${lastError}).`);
}

/** Ports backed by this machine. `dataDir` must be writable by the app. */
export function nodeLocalApiPorts(dataDir: string, port: number): LocalApiPorts {
  return {
    port,
    apiKey: () => localApiKey(dataDir),
    // Same file discipline as the API key; they must never change, or stored secrets, sessions
    // and the audit chain stop verifying.
    keys: () => ({
      NEXUS_SECRETS_KEY: localApiKey(dataDir, "secrets-key"),
      NEXUS_JWT_SECRET: localApiKey(dataDir, "jwt-secret"),
      NEXUS_AUDIT_KEY: localApiKey(dataDir, "audit-key"),
    }),
    waitForHealth: (url) => waitForHealth(url),
    spawn: (entry, env): SpawnedProcess => {
      // Both are build outputs and both are gitignored, so a checkout that has
      // never been built reaches here with neither. Failing on the missing path
      // beats a child that exits with a stack about a module it could not find.
      for (const [what, where] of [
        ["API", entry],
        ["UI", env.NEXUS_SPA_DIR],
      ] as const) {
        if (!where || !existsSync(where)) {
          throw new Error(
            `Built ${what} not found at ${where ?? "(unset)"}. Run \`pnpm build\` first.`,
          );
        }
      }
      return fork(entry, [], {
        // The child inherits nothing it was not given: a stray DATABASE_URL in
        // the developer's shell would otherwise point the desktop app at a
        // cloud database.
        env: { PATH: process.env.PATH ?? "", ...env },
        // 39 workspace packages point `main` at their TypeScript source, and
        // Node's built-in stripping rejects the parameter properties several of
        // them use — plain `node dist/index.js` dies on the first one. The
        // loader is what the API's own Docker dev stage already uses.
        execArgv: ["--import", "tsx/esm"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    },
  };
}
