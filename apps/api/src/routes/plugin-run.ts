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
 * network, env, writes or subprocesses), and answers on stdout.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  DenoPluginRunner,
  PluginManifestError,
  SandboxUnavailableError,
  loadPlugin,
  validatePluginManifest,
  type DenoRunnerFn,
  type PluginManifest,
} from "@nexus/plugin-sdk";
import type { FastifyInstance } from "fastify";

import { dataDir } from "../lib/persistent-store.js";
import { requireAuth } from "../middleware/auth.js";

/** Passed to the script as one argv entry, so it stays well under OS command-line limits. */
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_STDERR = 2_000;

function pluginsDir(): string {
  return process.env.NEXUS_PLUGINS_DIR ?? path.join(dataDir(), "plugins");
}

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
  app.get("/plugins/local", { preHandler: requireAuth }, async () => ({
    plugins: (await installed()).map((p) => p.manifest),
  }));

  app.post<{ Params: { id: string }; Body: { input?: unknown } }>(
    "/plugins/:id/run",
    { preHandler: requireAuth },
    async (request, reply) => {
      const plugin = (await installed()).find((p) => p.manifest.id === request.params.id);
      if (!plugin) return reply.code(404).send({ error: "not_found", message: "No such plugin." });

      // No host calls reach the sandbox yet, so a plugin that needs one cannot run.
      let loaded;
      try {
        loaded = loadPlugin(plugin.manifest);
      } catch (err) {
        if (!(err instanceof PluginManifestError)) throw err;
        return reply.code(409).send({
          error: "capabilities_unavailable",
          message: `This plugin needs ${plugin.manifest.capabilities.join(", ")}, which the sandbox does not provide yet.`,
        });
      }

      const entry = await entryPath(plugin);
      if (!entry)
        return reply
          .code(400)
          .send({
            error: "bad_entry",
            message: "The plugin's entry is missing or outside its directory.",
          });

      const input = request.body?.input ?? null;
      if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES)
        return reply.code(413).send({ error: "too_large", message: "Input is over 16 KB." });

      const runner = new DenoPluginRunner(loaded, { runnerFn: opts.runnerFn });
      const res = await runner.run(entry, input);
      if (res.error instanceof SandboxUnavailableError)
        return reply.code(503).send({ error: "sandbox_unavailable", message: res.error.message });
      if (res.error) throw res.error;
      const r = res.result!;
      if (!r.ok)
        return reply
          .code(422)
          .send({
            error: "plugin_failed",
            exitCode: r.exitCode,
            stderr: r.stderr.slice(-MAX_STDERR),
          });
      return { output: r.parsed ?? r.stdout };
    },
  );
}
