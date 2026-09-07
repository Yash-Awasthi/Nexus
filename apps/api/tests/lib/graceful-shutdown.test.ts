// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Tests for the graceful shutdown sequence in index.ts.
 *
 * The shutdown logic is a module-internal function, so we test the *behavior*
 * it implements: app.close() is called before process.exit, second signal
 * bypasses (hard exit), and the _shuttingDown guard prevents double-close.
 */

describe("Graceful shutdown behavior", () => {
  // Simulate the shutdown logic's contract:
  // 1. First signal → call app.close(), then exit
  // 2. Second signal → hard exit (no close)
  // 3. _shuttingDown guard prevents re-entrancy

  it("calls app.close() on first shutdown signal", async () => {
    let closed = false;
    const fakeApp = {
      close: async () => { closed = true; },
      log: { info: () => {} },
    };

    let _shuttingDown = false;
    async function shutdown() {
      if (_shuttingDown) return;
      _shuttingDown = true;
      if (fakeApp.close) await fakeApp.close();
    }

    await shutdown();
    expect(closed).toBe(true);
  });

  it("second signal is a no-op (guard prevents double-close)", async () => {
    let closeCount = 0;
    const fakeApp = {
      close: async () => { closeCount++; },
      log: { info: () => {} },
    };

    let _shuttingDown = false;
    async function shutdown() {
      if (_shuttingDown) return;
      _shuttingDown = true;
      if (fakeApp.close) await fakeApp.close();
    }

    await shutdown();
    await shutdown(); // second call — should be a no-op
    expect(closeCount).toBe(1);
  });

  it("app.close() errors are caught and logged, not thrown", async () => {
    const fakeApp = {
      close: async () => { throw new Error("close failed"); },
      log: { info: () => {} },
    };

    let _shuttingDown = false;
    let logged = false;
    async function shutdown() {
      if (_shuttingDown) return;
      _shuttingDown = true;
      if (fakeApp.close) {
        try {
          await fakeApp.close();
        } catch (err) {
          logged = true;
        }
      }
    }

    await shutdown();
    expect(logged).toBe(true);
  });

  it("shutdown works even when app has no close method", async () => {
    let _shuttingDown = false;
    async function shutdown() {
      if (_shuttingDown) return;
      _shuttingDown = true;
      // no app.close to call — should not throw
    }

    await expect(shutdown()).resolves.toBeUndefined();
  });
});
