// SPDX-License-Identifier: Apache-2.0
/**
 * Stage E2 — sign-in through an app-owned window, with the session sealed by
 * the OS keychain.
 *
 * Everything the flow touches is injected, so these drive the real code with a
 * fake window, a fake keychain and a fake API. What they pin: the token never
 * lands in plaintext, a cancelled window leaves nothing behind, a refresh needs
 * no window at all, and no error message carries the authorization code.
 */
import { describe, it, expect, vi } from "vitest";

import { KeychainUnavailableError, OsKeychainVault } from "../src/auth/keychain";
import {
  SignInCancelledError,
  SignInFailedError,
  createDesktopAuth,
  type JsonHttp,
  type SessionFile,
} from "../src/auth/session";

const API = "http://127.0.0.1:3000";
const CODE = "super-secret-authorization-code";

/** Reversible stand-in for the OS key: enough to prove sealing happened. */
function fakeOs(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`os:${plain}`, "utf8"),
    decryptString: (buf: Buffer) => buf.toString("utf8").replace(/^os:/, ""),
  };
}

function memoryFile(): SessionFile & { contents: string | null } {
  return {
    contents: null as string | null,
    read() {
      return this.contents;
    },
    write(sealed: string) {
      this.contents = sealed;
    },
    clear() {
      this.contents = null;
    },
  };
}

function http(responses: Record<string, Record<string, unknown>>): JsonHttp & {
  calls: { url: string; token?: string }[];
} {
  const calls: { url: string; token?: string }[] = [];
  return {
    calls,
    async getJson(url, accessToken) {
      calls.push({ url, ...(accessToken ? { token: accessToken } : {}) });
      const key = Object.keys(responses).find((k) => url.startsWith(k));
      return responses[key ?? ""] ?? {};
    },
    async postJson(url, _body, accessToken) {
      calls.push({ url, ...(accessToken ? { token: accessToken } : {}) });
      const key = Object.keys(responses).find((k) => url.startsWith(k));
      return responses[key ?? ""] ?? {};
    },
  };
}

function auth(opts: {
  responses?: Record<string, Record<string, unknown>>;
  openSignIn?: (authUrl: string, callbackPrefix: string) => Promise<URL>;
  file?: SessionFile;
  available?: boolean;
}) {
  const file = opts.file ?? memoryFile();
  const client = http(opts.responses ?? {});
  const openSignIn =
    opts.openSignIn ??
    (async (_authUrl: string, prefix: string) => new URL(`${prefix}?code=${CODE}&state=s1`));
  return {
    file,
    client,
    openSignIn: vi.fn(openSignIn),
    build() {
      return createDesktopAuth({
        apiBase: API,
        http: client,
        vault: new OsKeychainVault(fakeOs(opts.available ?? true)),
        file,
        openSignIn: this.openSignIn,
      });
    },
  };
}

const SIGNED_IN = {
  [`${API}/api/v1/oauth/github/callback`]: {
    accessToken: "jwt-access",
    refreshToken: "jwt-refresh",
    userId: "u1",
    email: "person@example.com",
  },
};

describe("keychain vault", () => {
  it("refuses to seal when the OS cannot encrypt, rather than writing plaintext", () => {
    const vault = new OsKeychainVault(fakeOs(false));

    expect(vault.available).toBe(false);
    expect(() => vault.seal("jwt-access")).toThrow(KeychainUnavailableError);
  });

  it("round-trips through the OS key", () => {
    const vault = new OsKeychainVault(fakeOs());

    expect(vault.open(vault.seal("jwt-access"))).toBe("jwt-access");
  });
});

describe("account sign-in", () => {
  it("opens the API's consent entry point and never asks for a pasted token", async () => {
    const harness = auth({ responses: SIGNED_IN });

    const session = await harness.build().signIn("github");

    expect(harness.openSignIn).toHaveBeenCalledWith(
      `${API}/api/v1/oauth/github`,
      `${API}/api/v1/oauth/github/callback`,
    );
    expect(session).toEqual({
      user: { id: "u1", email: "person@example.com" },
      accessToken: "jwt-access",
    });
  });

  it("stores the session sealed, with no token readable on disk", async () => {
    const harness = auth({ responses: SIGNED_IN });

    await harness.build().signIn("github");

    const stored = harness.file.read() ?? "";
    expect(stored).not.toContain("jwt-access");
    expect(stored).not.toContain("jwt-refresh");
    expect(Buffer.from(stored, "base64").toString("utf8")).toContain("jwt-access");
  });

  it("hands the renderer the access token but never the refresh token", async () => {
    const harness = auth({ responses: SIGNED_IN });
    const desktop = harness.build();

    await desktop.signIn("github");

    expect(desktop.getSession()).toEqual({
      user: { id: "u1", email: "person@example.com" },
      accessToken: "jwt-access",
    });
    expect(JSON.stringify(desktop.getSession())).not.toContain("jwt-refresh");
  });

  it("leaves nothing stored when the user closes the window", async () => {
    const harness = auth({
      responses: SIGNED_IN,
      openSignIn: () => Promise.reject(new SignInCancelledError()),
    });
    const desktop = harness.build();

    await expect(desktop.signIn("github")).rejects.toBeInstanceOf(SignInCancelledError);
    expect(harness.file.read()).toBeNull();
    expect(desktop.getSession()).toBeNull();
    expect(harness.client.calls).toEqual([]);
  });

  it("reports a denied consent without echoing the authorization code", async () => {
    const harness = auth({
      openSignIn: async (_url, prefix) =>
        new URL(`${prefix}?error=access_denied&code=${CODE}&state=s1`),
    });

    const failure = await harness
      .build()
      .signIn("github")
      .then(() => null)
      .catch((err: unknown) => err as Error);

    expect(failure).toBeInstanceOf(SignInFailedError);
    expect(failure?.message).toContain("access_denied");
    expect(failure?.message).not.toContain(CODE);
    expect(harness.file.read()).toBeNull();
  });

  it("refuses a sign-in provider it does not know before opening any window", async () => {
    const harness = auth({});

    await expect(harness.build().signIn("myspace")).rejects.toThrow(/myspace/);
    expect(harness.openSignIn).not.toHaveBeenCalled();
  });
});

describe("password sign-in", () => {
  it("signs in against the local API and keeps the session sealed", async () => {
    const file = memoryFile();
    const harness = auth({
      file,
      responses: {
        [`${API}/api/v1/auth/login`]: {
          accessToken: "jwt-local",
          refreshToken: "jwt-local-refresh",
          user: { id: "u9", email: "me@example.com" },
        },
      },
    });
    const desktop = harness.build();

    const session = await desktop.signInWithPassword("me@example.com", "pw-123456789");

    expect(session).toEqual({
      accessToken: "jwt-local",
      user: { id: "u9", email: "me@example.com" },
    });
    expect(harness.openSignIn).not.toHaveBeenCalled();
    expect(file.contents).not.toContain("jwt-local");
    expect(desktop.getSession()?.accessToken).toBe("jwt-local");
  });

  it("reports the API's reason when the password is wrong, and stores nothing", async () => {
    const harness = auth({
      responses: { [`${API}/api/v1/auth/login`]: { message: "Invalid credentials" } },
    });
    const desktop = harness.build();
    await expect(desktop.signInWithPassword("me@example.com", "nope")).rejects.toThrow(
      /Invalid credentials/,
    );
    expect(desktop.getSession()).toBeNull();
  });
});

describe("refresh", () => {
  it("exchanges the refresh token with no window", async () => {
    const harness = auth({
      responses: {
        ...SIGNED_IN,
        [`${API}/api/v1/auth/refresh`]: { accessToken: "jwt-access-2" },
      },
    });
    const desktop = harness.build();
    await desktop.signIn("github");
    harness.openSignIn.mockClear();

    const refreshed = await desktop.refresh();

    expect(refreshed?.accessToken).toBe("jwt-access-2");
    expect(desktop.getSession()?.accessToken).toBe("jwt-access-2");
    expect(harness.openSignIn).not.toHaveBeenCalled();
  });

  it("clears the session when the server no longer honours the refresh token", async () => {
    const harness = auth({
      responses: {
        ...SIGNED_IN,
        [`${API}/api/v1/auth/refresh`]: { error: "invalid_refresh_token" },
      },
    });
    const desktop = harness.build();
    await desktop.signIn("github");

    expect(await desktop.refresh()).toBeNull();
    expect(desktop.getSession()).toBeNull();
  });

  it("keeps the session through a server error, so the next refresh can succeed", async () => {
    const harness = auth({
      responses: {
        ...SIGNED_IN,
        [`${API}/api/v1/auth/refresh`]: { error: "unexpected response (503)" },
      },
    });
    const desktop = harness.build();
    await desktop.signIn("github");

    expect(await desktop.refresh()).toBeNull();
    expect(desktop.getSession()?.accessToken).toBeTruthy();
  });
});

describe("provider links", () => {
  it("carries the session token to the API and completes the link there", async () => {
    const harness = auth({
      responses: {
        ...SIGNED_IN,
        [`${API}/api/v1/llm-oauth/google-vertex/start`]: {
          authUrl: "https://accounts.example/auth",
        },
        [`${API}/api/v1/llm-oauth/google-vertex/callback`]: { ok: true, provider: "google-vertex" },
      },
    });
    const desktop = harness.build();
    await desktop.signIn("github");

    await desktop.connectProvider("google-vertex");

    const start = harness.client.calls.find((c) => c.url.endsWith("/start"));
    expect(start?.token).toBe("jwt-access");
    expect(harness.openSignIn).toHaveBeenLastCalledWith(
      "https://accounts.example/auth",
      `${API}/api/v1/llm-oauth/google-vertex/callback`,
    );
  });

  it("refuses to start a link with no session", async () => {
    const harness = auth({});

    await expect(harness.build().connectProvider("google-vertex")).rejects.toThrow(/not signed in/);
    expect(harness.openSignIn).not.toHaveBeenCalled();
  });

  it("reports an unconfigured provider instead of opening an empty window", async () => {
    const harness = auth({
      responses: {
        ...SIGNED_IN,
        [`${API}/api/v1/llm-oauth/unknown/start`]: { error: "unknown_or_unsupported_provider" },
      },
    });
    const desktop = harness.build();
    await desktop.signIn("github");
    harness.openSignIn.mockClear();

    await expect(desktop.connectProvider("unknown")).rejects.toThrow(
      /unknown_or_unsupported_provider/,
    );
    expect(harness.openSignIn).not.toHaveBeenCalled();
  });

  it("answers the connected question from the API's linked list", async () => {
    const harness = auth({
      responses: {
        ...SIGNED_IN,
        [`${API}/api/v1/llm-oauth/status`]: { linked: [{ providerId: "google-vertex" }] },
      },
    });
    const desktop = harness.build();
    await desktop.signIn("github");

    expect(await desktop.isProviderConnected("google-vertex")).toBe(true);
    expect(await desktop.isProviderConnected("azure-openai")).toBe(false);
  });

  it("is not connected to anything when nobody is signed in", async () => {
    const harness = auth({ responses: SIGNED_IN });

    expect(await harness.build().isProviderConnected("google-vertex")).toBe(false);
    expect(harness.client.calls).toEqual([]);
  });
});
