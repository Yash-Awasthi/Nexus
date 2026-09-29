// SPDX-License-Identifier: Apache-2.0
/**
 * Runs plugins installed on this host in the Deno sandbox.
 *
 *   GET  /plugins/local      → { plugins: PluginManifest[] }
 *   POST /plugins/:id/run    { input } → { output }
 *
 * A plugin is a directory under NEXUS_PLUGINS_DIR (default <data dir>/plugins)
 * holding `manifest.json` and its entry script. The script gets the input as
 * JSON in its first argument, may read its own directory and nothing else (no
 * env, writes, subprocesses or network), and answers on stdout. Its declared
 * capabilities are served by a host bridge (lib/plugin-host.ts) named in its
 * second argument, as the user who ran it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DenoPluginRunner,
  SandboxUnavailableError,
  loadPlugin,
  validatePluginManifest,
  type DenoRunnerFn,
  type PluginManifest,
} from "@nexus/plugin-sdk";
import type { FastifyInstance } from "fastify";

import { searchDuckDuckGo } from "../lib/duckduckgo.js";
import { createNotification } from "../lib/notifications-store.js";
import { dataDir, PersistentStore } from "../lib/persistent-store.js";
import { withPluginBridge, type HostHandler } from "../lib/plugin-host.js";
import { requireAuth } from "../middleware/auth.js";

import { getDefaultDriver } from "./api-bridge.js";

/** Passed to the script as one argv entry, so it stays well under OS command-line limits. */
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_STDERR = 2_000;

function pluginsDir(): string {
  return process.env.NEXUS_PLUGINS_DIR ?? path.join(dataDir(), "plugins");
}

const pluginStorage = new PersistentStore<{ value: unknown }>("plugin_storage");
const MAX_STORED = 64 * 1024;
const MAX_LOG_LINES = 200;

/** Capabilities this host serves over the bridge, each as the user who ran the plugin. */
function hostHandlers(
  userId: string,
  pluginId: string,
  logs: string[],
): Record<string, HostHandler> {
  // Bridge calls arrive on their own socket; this keeps the caller's keys and context.
  const asCaller = AsyncLocalStorage.snapshot();
  const key = (k: unknown) => {
    const name = String(k ?? "").slice(0, 200);
    if (!name) throw new Error("key is required");
    return `${userId}:${pluginId}:${name}`;
  };
  return {
    "llm.inference": (input) =>
      asCaller(async () => {
        const driver = getDefaultDriver();
        if (!driver) throw new Error("No model is configured for this account.");
        const res = await driver.complete({
          model: driver.model,
          messages: [{ role: "user", content: String(input.prompt ?? "").slice(0, 20_000) }],
          maxTokens: Math.min(Number(input.maxTokens) || 512, 2048),
        });
        return res.content;
      }),
    "search.web": (input) =>
      searchDuckDuckGo(
        String(input.query ?? "").slice(0, 300),
        Math.min(Number(input.max) || 5, 10),
      ),
    "storage.read": async (input) => pluginStorage.get(key(input.key))?.value ?? null,
    "storage.write": async (input) => {
      if (JSON.stringify(input.value ?? null).length > MAX_STORED)
        throw new Error("A stored value is at most 64 KB.");
      await pluginStorage.save(key(input.key), { value: input.value ?? null });
      return true;
    },
    "monitoring.log": async (input) => {
      if (logs.length < MAX_LOG_LINES) logs.push(String(input.message ?? "").slice(0, 2000));
      return true;
    },
    "monitoring.alert": async (input) => {
      await createNotification(userId, {
        type: "plugin",
        title: `${pluginId}: ${String(input.title ?? "").slice(0, 200)}`,
        message: String(input.message ?? "").slice(0, 2000),
      });
      return true;
    },
  };
}
const BACKED = new Set(Object.keys(hostHandlers("", "", [])));

interface Installed {
  dir: string;
  manifest: PluginManifest;
}

/** Every directory with a valid manifest; the rest are skipped with a warning. */
async function installed(): Promise<Installed[]> {
  const root = pluginsDir();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const found: Installed[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as unknown;
      found.push({ dir, manifest: validatePluginManifest(raw) });
    } catch (err) {
      console.warn(`[plugins] skipped ${dir}: ${String(err)}`);
    }
  }
  return found;
}

/** The entry's real path, or null when it resolves outside the plugin's directory. */
async function entryPath(p: Installed): Promise<string | null> {
  try {
    const dir = await fs.realpath(p.dir);
    const entry = await fs.realpath(path.resolve(p.dir, p.manifest.entry));
    return entry.startsWith(dir + path.sep) ? entry : null;
  } catch {
    return null;
  }
}

export async function pluginRunRoutes(
  app: FastifyInstance,
  opts: { runnerFn?: DenoRunnerFn } = {},
): Promise<void> {
  await pluginStorage.load();

  app.get("/plugins/local", { preHandler: requireAuth }, async () => ({
    plugins: (await installed()).map((p) => p.manifest),
  }));

  app.post<{ Params: { id: string }; Body: { input?: unknown } }>(
    "/plugins/:id/run",
    { preHandler: requireAuth },
    async (request, reply) => {
      const plugin = (await installed()).find((p) => p.manifest.id === request.params.id);
      if (!plugin) return reply.code(404).send({ error: "not_found", message: "No such plugin." });

      const unbacked = plugin.manifest.capabilities.filter((c) => !BACKED.has(c));
      if (unbacked.length)
        return reply.code(409).send({
          error: "capabilities_unavailable",
          message: `This plugin needs ${unbacked.join(", ")}, which this host does not provide.`,
        });
      const loaded = loadPlugin(plugin.manifest, {
        grantedCapabilities: [...plugin.manifest.capabilities],
      });

      const entry = await entryPath(plugin);
      if (!entry)
        return reply.code(400).send({
          error: "bad_entry",
          message: "The plugin's entry is missing or outside its directory.",
        });

      const input = request.body?.input ?? null;
      if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES)
        return reply.code(413).send({ error: "too_large", message: "Input is over 16 KB." });

      const runner = new DenoPluginRunner(loaded, { runnerFn: opts.runnerFn });
      const logs: string[] = [];
      const res = await withPluginBridge(
        loaded.grantedCapabilities,
        hostHandlers(request.nexusUserId ?? "anonymous", plugin.manifest.id, logs),
        (bridge) => runner.run(entry, input, bridge),
      );
      if (res.error instanceof SandboxUnavailableError)
        return reply.code(503).send({ error: "sandbox_unavailable", message: res.error.message });
      if (res.error) throw res.error;
      const r = res.result!;
      if (!r.ok)
        return reply.code(422).send({
          error: "plugin_failed",
          exitCode: r.exitCode,
          stderr: r.stderr.slice(-MAX_STDERR),
        });
      return { output: r.parsed ?? r.stdout, ...(logs.length ? { logs } : {}) };
    },
  );
}
