// SPDX-License-Identifier: Apache-2.0
/**
 * The local API boot sequence (M2), with the machine stubbed out.
 *
 * What matters here is what the child process is told and what happens when it
 * never comes up — a window that loads against a dead API is the failure this
 * guards.
 */
import { describe, it, expect, vi } from "vitest";

import {
  localApiEnv,
  startLocalApi,
  type LocalApiPaths,
  type SpawnedProcess,
} from "../src/local-api";

const PATHS: LocalApiPaths = {
  entry: "/app/api/dist/index.js",
  spaDir: "/app/ui/build/client",
  dataDir: "/home/u/.nexus",
};

/** A child that never exits, and records what it was launched with. */
function liveChild(): SpawnedProcess & { killed: boolean } {
  return {
    on: () => undefined,
    kill() {
      this.killed = true;
    },
    killed: false,
  };
}

describe("localApiEnv", () => {
  const env = localApiEnv(PATHS, "key-123", 41234);

  it("points the service at the embedded database under the app's data directory", () => {
    expect(env.DATABASE_URL).toBe("pglite:///home/u/.nexus/postgres");
    expect(env.NEXUS_DATA_DIR).toBe("/home/u/.nexus/stores");
  });

  it("serves the built SPA so the renderer is same-origin with /api", () => {
    expect(env.NEXUS_SPA_DIR).toBe("/app/ui/build/client");
  });

  it("binds loopback only", () => {
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("41234");
  });

  it("carries the local API key", () => {
    expect(env.NEXUS_API_KEY).toBe("key-123");
  });

  it("passes the install's keys through, so sign-up and secrets work with no configuration", () => {
    expect("NEXUS_SECRETS_KEY" in env).toBe(false);
    const keys = { NEXUS_SECRETS_KEY: "a".repeat(64), NEXUS_JWT_SECRET: "b".repeat(64) };
    expect(localApiEnv(PATHS, "key-123", 41234, keys)).toMatchObject(keys);
  });
});

describe("startLocalApi", () => {
  it("launches the compiled entrypoint and returns its origin once healthy", async () => {
    const spawn = vi.fn(() => liveChild());
    const waitForHealth = vi.fn().mockResolvedValue(undefined);

    const api = await startLocalApi(PATHS, {
      port: 41234,
      spawn,
      waitForHealth,
      apiKey: () => "key-123",
    });

    expect(api.url).toBe("http://127.0.0.1:41234");
    expect(spawn).toHaveBeenCalledWith("/app/api/dist/index.js", expect.any(Object));
    // The boot-time liveness server answers /health too; only the full server answers ready.
    expect(waitForHealth).toHaveBeenCalledWith("http://127.0.0.1:41234/health/ready");
  });

  it("fails when the service exits before it is ready", async () => {
    const child: SpawnedProcess = {
      on: (_event, listener) => listener(1),
      kill: () => undefined,
    };

    await expect(
      startLocalApi(PATHS, {
        port: 41234,
        spawn: () => child,
        // Never resolves: the exit has to be what settles this.
        waitForHealth: () => new Promise<void>(() => undefined),
        apiKey: () => "key-123",
      }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("fails when the service never answers", async () => {
    await expect(
      startLocalApi(PATHS, {
        port: 41234,
        spawn: () => liveChild(),
        waitForHealth: () => Promise.reject(new Error("did not become healthy")),
        apiKey: () => "key-123",
      }),
    ).rejects.toThrow(/did not become healthy/);
  });

  it("stops the child on request", async () => {
    const child = liveChild();
    const api = await startLocalApi(PATHS, {
      port: 41234,
      spawn: () => child,
      waitForHealth: () => Promise.resolve(),
      apiKey: () => "key-123",
    });

    api.stop();

    expect(child.killed).toBe(true);
  });
});
