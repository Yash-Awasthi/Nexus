// SPDX-License-Identifier: Apache-2.0
/**
 * Desktop sign-in: the account session and the provider links behind it.
 *
 * Sign-in opens the API's OAuth entry point in a window the app owns. The
 * window is never allowed to load the callback: the main process intercepts
 * that navigation and fetches the callback itself, so the authorization code is
 * consumed here rather than rendered into a page. What comes back is sealed
 * with the OS keychain and written to disk; the renderer only ever receives the
 * access token in memory, never a file path or a refresh token.
 *
 * Everything the flow touches is injected — the HTTP client, the vault, the
 * file, and the window opener — so the whole thing is testable without Electron
 * and without a provider.
 *
 * Nothing in this module logs. A thrown error carries the provider's error code
 * at most, never a code, token, or callback URL.
 */

import type { OsKeychainVault } from "./keychain";

interface SessionUser {
  id: string;
  email?: string;
}

/** What the renderer is given: the user, and a token it can send. */
export interface RendererSession {
  user: SessionUser;
  accessToken: string;
}

interface StoredSession extends RendererSession {
  refreshToken?: string;
}

export class SignInCancelledError extends Error {
  constructor() {
    super("Sign-in was cancelled.");
    this.name = "SignInCancelledError";
  }
}

export class SignInFailedError extends Error {
  constructor(reason: string) {
    super(`Sign-in failed: ${reason}`);
    this.name = "SignInFailedError";
  }
}

/** Opens `authUrl` and resolves with the callback URL the flow lands on. */
export type OpenSignInWindow = (authUrl: string, callbackPrefix: string) => Promise<URL>;

export interface JsonHttp {
  getJson(url: string, accessToken?: string): Promise<Record<string, unknown>>;
  postJson(url: string, body: unknown, accessToken?: string): Promise<Record<string, unknown>>;
}

/** Sealed-blob persistence. One session per installation. */
export interface SessionFile {
  read(): string | null;
  write(sealed: string): void;
  clear(): void;
}

interface SessionDeps {
  apiBase: string;
  http: JsonHttp;
  vault: OsKeychainVault;
  file: SessionFile;
  openSignIn: OpenSignInWindow;
}

export interface DesktopAuth {
  signIn(provider: string): Promise<RendererSession>;
  /** An account on the API this window talks to; the local one has no provider to sign in with. */
  signInWithPassword(email: string, password: string): Promise<RendererSession>;
  getSession(): RendererSession | null;
  /** Exchange the refresh token. No window: there is nothing for a user to see. */
  refresh(): Promise<RendererSession | null>;
  signOut(): void;
  connectProvider(providerId: string): Promise<void>;
  isProviderConnected(providerId: string): Promise<boolean>;
}

const ACCOUNT_PROVIDERS = new Set(["github", "google", "slack"]);

export function createDesktopAuth(deps: SessionDeps): DesktopAuth {
  const { apiBase, http, vault, file, openSignIn } = deps;

  const load = (): StoredSession | null => {
    const sealed = file.read();
    if (!sealed) return null;
    try {
      return JSON.parse(vault.open(sealed)) as StoredSession;
    } catch {
      // A blob sealed by another OS user, or a corrupted file: treat it as no
      // session rather than as an error the user cannot act on.
      return null;
    }
  };

  const persist = (session: StoredSession): RendererSession => {
    file.write(vault.seal(JSON.stringify(session)));
    return { user: session.user, accessToken: session.accessToken };
  };

  /** Seal the session a sign-in answered with, or report why none was issued. */
  const persistIssued = (
    result: Record<string, unknown>,
    user: { id?: unknown; email?: unknown },
  ): RendererSession => {
    const accessToken = typeof result.accessToken === "string" ? result.accessToken : "";
    if (!accessToken) {
      const why = [result.message, result.error].find((v) => typeof v === "string");
      throw new SignInFailedError((why as string | undefined) ?? "no session was issued");
    }
    return persist({
      accessToken,
      ...(typeof result.refreshToken === "string" ? { refreshToken: result.refreshToken } : {}),
      user: {
        id: typeof user.id === "string" ? user.id : "local",
        ...(typeof user.email === "string" ? { email: user.email } : {}),
      },
    });
  };

  const requireSession = (): StoredSession => {
    const session = load();
    if (!session) throw new SignInFailedError("not signed in");
    return session;
  };

  return {
    async signIn(provider) {
      if (!ACCOUNT_PROVIDERS.has(provider)) {
        throw new SignInFailedError(`unknown sign-in provider "${provider}"`);
      }
      const callback = await openSignIn(
        `${apiBase}/api/v1/oauth/${provider}`,
        `${apiBase}/api/v1/oauth/${provider}/callback`,
      );

      const denied = callback.searchParams.get("error");
      if (denied) throw new SignInFailedError(denied);

      const result = await http.getJson(callback.href);
      return persistIssued(result, { id: result.userId, email: result.email });
    },

    async signInWithPassword(email, password) {
      const result = await http.postJson(`${apiBase}/api/v1/auth/login`, { email, password });
      return persistIssued(result, (result.user ?? {}) as { id?: unknown; email?: unknown });
    },

    getSession() {
      const session = load();
      return session ? { user: session.user, accessToken: session.accessToken } : null;
    },

    async refresh() {
      const session = load();
      if (!session?.refreshToken) return null;
      const result = await http.postJson(`${apiBase}/api/v1/auth/refresh`, {
        refreshToken: session.refreshToken,
      });
      const accessToken = typeof result.accessToken === "string" ? result.accessToken : "";
      if (!accessToken) {
        // Only a refused token ends the session; a server error or rate limit leaves it for a retry.
        if (result.error === "invalid_refresh_token" || result.error === "user_not_found") {
          file.clear();
        }
        return null;
      }
      return persist({
        ...session,
        accessToken,
        ...(typeof result.refreshToken === "string" ? { refreshToken: result.refreshToken } : {}),
      });
    },

    signOut() {
      file.clear();
    },

    async connectProvider(providerId) {
      const session = requireSession();
      const started = await http.postJson(
        `${apiBase}/api/v1/llm-oauth/${providerId}/start`,
        {},
        session.accessToken,
      );
      const authUrl = typeof started.authUrl === "string" ? started.authUrl : "";
      if (!authUrl) {
        throw new SignInFailedError(
          typeof started.error === "string"
            ? started.error
            : `provider "${providerId}" is not configured`,
        );
      }

      const callback = await openSignIn(
        authUrl,
        `${apiBase}/api/v1/llm-oauth/${providerId}/callback`,
      );
      const denied = callback.searchParams.get("error");
      if (denied) throw new SignInFailedError(denied);

      // The API exchanges the code and stores the provider tokens itself; the
      // desktop holds no provider credential of its own.
      const result = await http.getJson(callback.href);
      if (result.ok !== true) {
        throw new SignInFailedError(
          typeof result.error === "string" ? result.error : "the provider link was not completed",
        );
      }
    },

    async isProviderConnected(providerId) {
      const session = load();
      if (!session) return false;
      const status = await http.getJson(`${apiBase}/api/v1/llm-oauth/status`, session.accessToken);
      const linked = Array.isArray(status.linked) ? status.linked : [];
      return linked.some((row) => (row as { providerId?: string }).providerId === providerId);
    },
  };
}
