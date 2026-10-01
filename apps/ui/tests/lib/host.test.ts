// SPDX-License-Identifier: Apache-2.0
/**
 * Stage E1 — the renderer side of the host bridge.
 *
 * The rule these pin: a feature asks what the host can do, never who it is, and
 * a call made without its capability fails loudly rather than resolving to
 * undefined.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  HostUnsupportedError,
  host,
  hostCan,
  hostInvoke,
  hostOn,
  isHosted,
  runMode,
} from "../../app/lib/host";

type TestHost = {
  name: string;
  capabilities: string[];
  invoke: (method: string, ...args: unknown[]) => Promise<unknown>;
  on?: (event: string, cb: (detail: unknown) => void) => () => void;
};

function install(bridge: TestHost | undefined): void {
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { nexusHost?: unknown }).nexusHost = bridge;
}

beforeEach(() => install(undefined));

describe("no host", () => {
  it("reports no bridge and no capability", () => {
    expect(host()).toBeNull();
    expect(isHosted()).toBe(false);
    expect(hostCan("glass")).toBe(false);
  });

  it("rejects an invoke instead of resolving to undefined", async () => {
    await expect(hostInvoke("glass", "toggleGlass", true)).rejects.toBeInstanceOf(
      HostUnsupportedError,
    );
  });

  it("returns a working unsubscribe for a subscription nobody can serve", () => {
    expect(() => hostOn("deliberation:started", () => {})()).not.toThrow();
  });
});

describe("a host that declares a capability", () => {
  it("routes the call and returns the host's answer", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    install({ name: "test-host", capabilities: ["glass"], invoke });

    await expect(hostInvoke("glass", "toggleGlass", true)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("toggleGlass", true);
  });

  it("still refuses a capability it did not declare", async () => {
    install({ name: "test-host", capabilities: ["glass"], invoke: vi.fn() });

    expect(hostCan("providerSignIn")).toBe(false);
    await expect(hostInvoke("providerSignIn", "connectProvider", "anthropic")).rejects.toThrow(
      /providerSignIn/,
    );
  });
});

describe("identity", () => {
  it("never decides anything from the host's name", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    install({ name: "some-other-shell", capabilities: ["memory"], invoke });

    expect(isHosted()).toBe(true);
    expect(hostCan("memory")).toBe(true);
    await expect(hostInvoke("memory", "getMemory")).resolves.toBeNull();
  });

  it("ignores an object on the window that is not a bridge", () => {
    install({ name: "broken" } as unknown as TestHost);

    expect(host()).toBeNull();
    expect(hostCan("glass")).toBe(false);
  });
});

describe("runMode", () => {
  it("reports cloud in a plain browser tab", async () => {
    install(undefined);
    (globalThis as { location?: unknown }).location = { origin: "https://nexus.example" };

    expect(await runMode()).toEqual({ mode: "cloud", apiUrl: "https://nexus.example" });
  });

  it("asks a host that can answer", async () => {
    install({
      name: "desktop",
      capabilities: ["runMode"],
      invoke: (method) =>
        method === "getRunMode"
          ? Promise.resolve({ mode: "local-only", apiUrl: "http://127.0.0.1:41000" })
          : Promise.reject(new Error("unexpected")),
    });

    expect(await runMode()).toEqual({ mode: "local-only", apiUrl: "http://127.0.0.1:41000" });
  });

  it("says nothing rather than guessing when a host cannot answer", async () => {
    install({ name: "old-host", capabilities: [], invoke: () => Promise.resolve(null) });

    expect(await runMode()).toBeNull();
  });

  it("says nothing when the host call fails", async () => {
    install({
      name: "desktop",
      capabilities: ["runMode"],
      invoke: () => Promise.reject(new Error("ipc down")),
    });

    expect(await runMode()).toBeNull();
  });
});
