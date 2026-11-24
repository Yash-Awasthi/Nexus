// SPDX-License-Identifier: Apache-2.0
/**
 * Offline LSP probe: run `typescript-language-server` from
 * NEXUS_LSP_TYPESCRIPT_CMD or PATH over a temp fixture and ask for a
 * definition. Absent binary is a `skip`, never a failure; no network is used.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

const PACKAGE_INDEX = new URL("../packages/lsp/src/index.ts", import.meta.url).href;
const DEFAULT_COMMAND = "typescript-language-server --stdio";
export const LSP_PROBE_TIMEOUT_MS = 60_000;

/** Quote-aware split, matching the package's `splitCommand`. */
function splitCommand(input) {
  const parts = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (started) {
        parts.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quoted) throw new Error(`unterminated double quote in command: ${input}`);
  if (started) parts.push(current);
  return parts;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Absolute executable path for a bare name, or `undefined`. Pure filesystem lookup. */
export function resolveExecutable(command, env = process.env, platform = process.platform) {
  if (command.includes("/") || command.includes(sep) || isAbsolute(command)) {
    return isFile(command) ? command : undefined;
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Command and argv from NEXUS_LSP_TYPESCRIPT_CMD, resolved on PATH. */
export function resolveLspCommand(env = process.env, platform = process.platform) {
  const raw = (env.NEXUS_LSP_TYPESCRIPT_CMD ?? "").trim() || DEFAULT_COMMAND;
  const [command = "", ...args] = splitCommand(raw);
  if (!command) return undefined;
  const executable = resolveExecutable(command, env, platform);
  return executable ? { command: executable, args } : undefined;
}

/**
 * Returns `{ status: "skip" | "pass" | "fail", detail }`. The caller records it;
 * a skip never changes the exit code.
 */
export async function probeLsp({ env = process.env, platform = process.platform } = {}) {
  const resolved = resolveLspCommand(env, platform);
  if (!resolved) {
    return { status: "skip", detail: "no binary: typescript-language-server is not on PATH" };
  }

  const dir = mkdtempSync(join(tmpdir(), "nexus-lsp-offline-"));
  const lib = join(dir, "lib.ts");
  const use = join(dir, "use.ts");
  let manager;
  let timer;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      lib,
      "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
    );
    writeFileSync(
      use,
      'import { greet } from "./lib";\nexport const message = greet("offline");\n',
    );

    const probe = (async () => {
      const { createLspManager } = await import(PACKAGE_INDEX);
      manager = createLspManager({
        workingDir: dir,
        env,
        authorize: async () => "allow",
        config: {
          enabled: true,
          maxServers: 1,
          startTimeoutMs: 30_000,
          requestTimeoutMs: 30_000,
          commands: {
            typescript: resolved,
            python: { command: "", args: [] },
            go: { command: "", args: [] },
            rust: { command: "", args: [] },
          },
        },
      });

      const result = await manager.definition({ path: use, line: 2, column: 24 });
      if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
      const expected = resolve(lib);
      const hit = result.locations.find((location) => resolve(location.path) === expected);
      if (!hit) {
        throw new Error(
          `definition returned ${result.locations.map((location) => location.path).join(", ") || "nothing"}`,
        );
      }
      return `definition for use.ts resolved lib.ts:${hit.line}`;
    })();
    probe.catch(() => {}); // The timeout race may win; never leak a rejection.

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${LSP_PROBE_TIMEOUT_MS / 1000}s`)),
        LSP_PROBE_TIMEOUT_MS,
      );
    });
    return { status: "pass", detail: await Promise.race([probe, timeout]) };
  } catch (error) {
    return { status: "fail", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    if (manager) {
      try {
        await manager.dispose();
      } catch {
        // Dispose is best-effort; the temp tree is removed below.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
