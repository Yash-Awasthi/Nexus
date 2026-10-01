// SPDX-License-Identifier: Apache-2.0
/**
 * The local API the desktop app runs for itself (spec milestone M2).
 *
 * The same Fastify service the cloud runs, in a child process, against an
 * embedded Postgres (`pglite://`) under the app's data directory and serving
 * the built `apps/ui` from the same origin. The renderer therefore talks to
 * `/api/*` exactly as it does in a browser, and nothing in the UI knows it is
 * offline.
 *
 * A child process rather than in-process: a route that crashes must not take
 * the window with it, and the spec keeps worker-shaped work out of both the
 * renderer and the main process.
 *
 * Electron is not imported here, so the boot sequence is testable without a
 * browser process — paths and process spawning come in as ports.
 */

export interface LocalApiPaths {
  /** Compiled API entrypoint (`apps/api/dist/index.js`). */
  entry: string;
  /** Built SPA directory (`apps/ui/build/client`). */
  spaDir: string;
  /** Writable directory for the embedded database and file-backed stores. */
  dataDir: string;
}

export interface SpawnedProcess {
  on(event: "exit", listener: (code: number | null) => void): void;
  kill(): void;
}

export interface LocalApiPorts {
  spawn(entry: string, env: Record<string, string>): SpawnedProcess;
  /** Resolves once the service answers, rejects when it never does. */
  waitForHealth(url: string): Promise<void>;
  /** A local API key, minted once and kept by the caller (the OS keychain). */
  apiKey(): string;
  /**
   * Stable keys minted once per install, by the environment variable that carries each:
   * the secret store's key, the session-signing key and the audit chain's key.
   */
  keys?(): Record<string, string>;
  /** TCP port to bind. */
  port: number;
}

export interface LocalApi {
  /** Origin the renderer loads and calls `/api/*` on. */
  readonly url: string;
  stop(): void;
}

/** Everything the API needs to run as a single-user local service. */
export function localApiEnv(
  paths: LocalApiPaths,
  apiKey: string,
  port: number,
  keys: Record<string, string> = {},
) {
  return {
    ...keys,
    NODE_ENV: "production",
    PORT: String(port),
    // Loopback only. A desktop database reachable from the local network is a
    // different product, and not one anyone asked for.
    HOST: "127.0.0.1",
    NEXUS_API_KEY: apiKey,
    DATABASE_URL: `pglite://${paths.dataDir}/postgres`,
    NEXUS_DATA_DIR: `${paths.dataDir}/stores`,
    NEXUS_SPA_DIR: paths.spaDir,
    // No Redis on a laptop: the KV layer falls back to its in-process store,
    // and the durable surfaces sit on the embedded Postgres above.
    NEXUS_DESKTOP: "1",
  };
}

/**
 * Boot the local API and resolve once it answers. Rejects if it exits or never
 * becomes healthy — the caller shows that as a failure to start rather than an
 * empty window.
 */
export async function startLocalApi(paths: LocalApiPaths, ports: LocalApiPorts): Promise<LocalApi> {
  const url = `http://127.0.0.1:${ports.port}`;
  const child = ports.spawn(
    paths.entry,
    localApiEnv(paths, ports.apiKey(), ports.port, ports.keys?.()),
  );

  let exited: number | null | undefined;
  const died = new Promise<never>((_resolve, reject) => {
    child.on("exit", (code) => {
      exited = code;
      reject(new Error(`Local API exited with code ${String(code)} before it was ready.`));
    });
  });

  await Promise.race([ports.waitForHealth(`${url}/health/ready`), died]);

  return {
    url,
    stop: () => {
      if (exited === undefined) child.kill();
    },
  };
}
