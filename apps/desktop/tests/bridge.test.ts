// SPDX-License-Identifier: Apache-2.0
/**
 * Stage E1 — the host contract, tested without booting Electron.
 *
 * What matters here is that the capability list and the implemented methods
 * agree: a renderer that trusts a declared capability must not meet an
 * unimplemented method, and a method must not be reachable without its
 * capability being declared.
 */
import { describe, it, expect, vi } from "vitest";

import {
  CAPABILITY_METHODS,
  DESKTOP_CAPABILITIES,
  UnsupportedMethodError,
  createHostApi,
  createInvokeHandler,
  type HostImplementation,
} from "../src/bridge";

const SESSION = { user: { id: "u1" }, accessToken: "jwt" };

function impl(): HostImplementation & {
  setGlass: ReturnType<typeof vi.fn>;
  saveCouncilMembers: ReturnType<typeof vi.fn>;
} {
  return {
    runMode: () => ({ mode: "local-only" as const, apiUrl: "http://127.0.0.1:41000" }),
    syncNow: () => Promise.resolve({ pulled: 0, pushed: 0 }),
    syncLedger: () => [],
    setGlass: vi.fn(),
    saveCouncilMembers: vi.fn(),
    auth: {
      signIn: vi.fn().mockResolvedValue(SESSION),
      signInWithPassword: vi.fn().mockResolvedValue(SESSION),
      getSession: vi.fn().mockReturnValue(SESSION),
      refresh: vi.fn().mockResolvedValue(SESSION),
      signOut: vi.fn(),
      connectProvider: vi.fn().mockResolvedValue(undefined),
      isProviderConnected: vi.fn().mockResolvedValue(true),
    },
  };
}

describe("capability list", () => {
  it("declares only what the shell implements", () => {
    expect(DESKTOP_CAPABILITIES).toEqual([
      "localAccount",
      "providerSignIn",
      "glass",
      "councilSync",
      "runMode",
      "sync",
    ]);
  });

  it("claims nothing the web path already serves over HTTP", () => {
    for (const web of ["deliberate", "threads", "memory"]) {
      expect(DESKTOP_CAPABILITIES).not.toContain(web);
    }
  });

  it("implements every method its capabilities name", async () => {
    const handler = createInvokeHandler(impl());
    const declared = Object.values(CAPABILITY_METHODS).flat();

    for (const method of declared) {
      // `signOut` and the session readers answer with a value or null; what is
      // asserted is that none of them reaches UnsupportedMethodError.
      await expect(handler(method, ["github"])).resolves.not.toBeUndefined();
    }
  });
});

describe("invoke handler", () => {
  it("passes the glass flag through as a boolean", async () => {
    const deps = impl();
    const handler = createInvokeHandler(deps);

    await handler("toggleGlass", [true]);
    await handler("toggleGlass", ["not a boolean"]);

    expect(deps.setGlass).toHaveBeenNthCalledWith(1, true);
    expect(deps.setGlass).toHaveBeenNthCalledWith(2, false);
  });

  it("hands council membership to the host store", async () => {
    const deps = impl();
    const members = [{ label: "Alpha", provider: "openai", model: "m" }];

    await createInvokeHandler(deps)("setCouncilMembers", [members]);

    expect(deps.saveCouncilMembers).toHaveBeenCalledWith(members);
  });

  it("refuses an unknown method by name instead of returning undefined", async () => {
    const handler = createInvokeHandler(impl());

    await expect(handler("openDevTools", [])).rejects.toBeInstanceOf(UnsupportedMethodError);
    await expect(handler("openDevTools", [])).rejects.toThrow(/openDevTools/);
  });
});

describe("session methods", () => {
  it("passes the chosen sign-in provider through", async () => {
    const deps = impl();

    await createInvokeHandler(deps)("signIn", ["google"]);

    expect(deps.auth.signIn).toHaveBeenCalledWith("google");
  });

  it("asks the host for the stored session rather than the renderer", async () => {
    const deps = impl();

    await expect(createInvokeHandler(deps)("getSession", [])).resolves.toEqual(SESSION);
  });
});

describe("exposed host object", () => {
  it("carries the capability list and forwards calls with their arguments", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const host = createHostApi({ invoke }, { name: "nexus-desktop", version: "0.1.0" });

    expect(host.name).toBe("nexus-desktop");
    expect(host.capabilities).toEqual([...DESKTOP_CAPABILITIES]);

    await host.invoke("toggleGlass", true);
    expect(invoke).toHaveBeenCalledWith("toggleGlass", [true]);
  });

  it("exposes nothing beyond the declared surface", () => {
    const host = createHostApi(
      { invoke: async () => null },
      { name: "nexus-desktop", version: "0.1.0" },
    );

    expect(Object.keys(host).sort()).toEqual(["capabilities", "invoke", "name", "version"]);
  });
});
