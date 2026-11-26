// SPDX-License-Identifier: Apache-2.0
/**
 * The offline notice: when a failed send is worth keeping, and what the UI says about it.
 *
 * The decision that matters is `isNetworkFailure`. Queueing a prompt the server *refused* (a 401,
 * a validation error, a deleted thread) would put permanently-unsendable text in a queue that
 * retries it forever; queueing one the network dropped is the whole point. So the classifier is
 * generous only about transport wording, and everything else is left to the error message.
 */
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

import {
  canQueueOffline,
  flushOffline,
  isNetworkFailure,
  offlineNotice,
  queueOffline,
  queuedInsteadOfFailed,
  readOfflineState,
} from "../app/lib/offline-notice";

const installHost = (methods: Record<string, (args: readonly unknown[]) => unknown>) => {
  const invoke = vi.fn(async (name: string, ...args: unknown[]) => {
    const fn = methods[name];
    if (!fn) throw new Error(`no ${name}`);
    return fn(args);
  });
  (window as unknown as { nexusHost?: unknown }).nexusHost = {
    name: "test-host",
    capabilities: ["offlineQueue"],
    invoke,
  };
  return invoke;
};

beforeEach(() => {
  delete (window as unknown as { nexusHost?: unknown }).nexusHost;
});

describe("isNetworkFailure", () => {
  it("recognises the ways a dead connection is reported", () => {
    for (const message of [
      "Failed to fetch",
      "TypeError: NetworkError when attempting to fetch resource.",
      "fetch failed",
      "The operation timed out",
      "connect ECONNREFUSED 127.0.0.1:3000",
      "socket hang up",
      "Load failed",
    ])
      expect(isNetworkFailure(message), message).toBe(true);
  });

  it("does not queue what the server refused, because waiting will not change it", () => {
    for (const message of [
      "401 Unauthorized",
      "Your session expired. Sign in again, then resend.",
      "400: the thread was deleted",
      "429 Too Many Requests",
      "The council could not reach a verdict.",
    ])
      expect(isNetworkFailure(message), message).toBe(false);
  });

  it("is case-insensitive and tolerant of surrounding text", () => {
    expect(isNetworkFailure("DELIBERATION FAILED: FAILED TO FETCH")).toBe(true);
  });
});

describe("queueOffline", () => {
  it("hands the text and its conversation to the host, and returns the queue length", async () => {
    const invoke = installHost({ queuePrompt: () => 3 });
    expect(canQueueOffline()).toBe(true);
    expect(await queueOffline("hello", "s1")).toBe(3);
    expect(invoke).toHaveBeenCalledWith("queuePrompt", { text: "hello", sessionId: "s1" });
  });

  it("returns null in a browser tab, where there is nothing to queue into", async () => {
    expect(canQueueOffline()).toBe(false);
    expect(await queueOffline("hello", null)).toBeNull();
  });

  it("returns null rather than claiming success when the host throws or the text is blank", async () => {
    installHost({
      queuePrompt: () => {
        throw new Error("disk full");
      },
    });
    expect(await queueOffline("hello", "s1")).toBeNull();
    installHost({ queuePrompt: () => 1 });
    expect(await queueOffline("   ", "s1")).toBeNull();
  });
});

describe("readOfflineState and flushOffline", () => {
  it("reads the queue and treats a missing flag as online", async () => {
    installHost({ getOfflineState: () => ({ queued: 2 }) });
    expect(await readOfflineState()).toEqual({ online: true, queued: 2 });
    installHost({ getOfflineState: () => ({ online: false, queued: -5 }) });
    expect(await readOfflineState()).toEqual({ online: false, queued: 0 });
  });

  it("is null when the host cannot answer, so the chip simply does not render", async () => {
    expect(await readOfflineState()).toBeNull();
    installHost({
      getOfflineState: () => {
        throw new Error("boom");
      },
    });
    expect(await readOfflineState()).toBeNull();
  });

  it("asks the host to flush, and never throws when it cannot", async () => {
    const invoke = installHost({ flushOfflineQueue: () => ({ ok: true }) });
    await flushOffline();
    expect(invoke).toHaveBeenCalledWith("flushOfflineQueue");
    delete (window as unknown as { nexusHost?: unknown }).nexusHost;
    await expect(flushOffline()).resolves.toBeUndefined();
  });
});

describe("the words", () => {
  it("says nothing when nothing is queued", () => {
    expect(offlineNotice(0)).toBe("");
  });

  it("agrees in number, and promises the one thing that is true", () => {
    expect(offlineNotice(1)).toBe("1 prompt saved — it will send when the connection returns");
    expect(offlineNotice(4)).toBe("4 prompts saved — they will send when the connection returns");
    expect(queuedInsteadOfFailed(1)).toBe(
      "1 prompt saved — it will send when the connection returns You can keep writing; the queue sends in order.",
    );
  });
});
