// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { hostCan, hostInvoke } from "~/lib/host";
import {
  adoptStoredToken,
  getSessionToken,
  holdSessionUntil,
  sessionReady,
  setSessionToken,
} from "~/lib/session-token";

/** What a host that owns the session returns from `getSession` / `signIn`. */
export interface HostSession {
  user: { id: string; email?: string };
  accessToken: string;
}

interface AuthUser {
  id: string;
  username: string;
  email?: string;
  role?: string;
  customInstructions?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  setUser: (user: AuthUser | null) => void;
  /** Rejects with `code: "mfa_required"` when the account wants an authenticator code. */
  login: (email: string, password: string, code?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const STORAGE_KEY = "nexus_user";
/** Where earlier versions kept the refresh token; it now lives in an httpOnly cookie. */
const LEGACY_REFRESH_KEY = "nexus_refresh_token";

/** Decode the access token's exp (seconds) — 0 when unparseable. */
function tokenExpiry(): number {
  try {
    const raw = getSessionToken();
    if (!raw) return 0;
    const payload = JSON.parse(atob(raw.split(".")[1] ?? "")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/**
 * Silent refresh: exchange the refresh cookie for a fresh access token shortly
 * before the current one expires, so mid-session /api/v1 calls stop dying
 * with 401 after the (15-minute) access TTL. Falls back to a clean logout
 * when the refresh token is missing or revoked.
 *
 * Concurrent refreshes are coalesced: token rotation means the loser of a
 * simultaneous exchange gets a 401 on an already-used token — dev mode mounts
 * the provider twice, so without this guard two timers can race.
 */
let refreshInFlight: Promise<boolean> | null = null;

export async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function doRefresh(): Promise<boolean> {
  // The host keeps the refresh token in the OS keychain and exchanges it itself.
  if (hostCan("localAccount")) {
    const session = await hostInvoke<HostSession | null>("localAccount", "refreshSession").catch(
      () => null,
    );
    if (session) setSessionToken(session.accessToken);
    return !!session;
  }
  // A token an earlier version stored is spent once to move the session onto the cookie.
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_REFRESH_KEY);
    localStorage.removeItem(LEGACY_REFRESH_KEY);
  } catch {
    /* storage unavailable */
  }
  try {
    const res = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(legacy ? { refreshToken: legacy } : {}),
      credentials: "same-origin",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken?: string };
    if (data.accessToken) setSessionToken(data.accessToken);
    return !!data.accessToken;
  } catch {
    return false;
  }
}

let hostSession: Promise<HostSession | null> | null = null;

/** The host's session for this window, asked once; an unreadable one counts as none. */
function readHostSession(): Promise<HostSession | null> {
  hostSession ??= hostInvoke<HostSession | null>("localAccount", "getSession")
    .then((session) => {
      if (session) setSessionToken(session.accessToken);
      return session;
    })
    .catch(() => null);
  return hostSession;
}

/**
 * Settle the browser session before any page asks the API for data: pages run
 * their effects before this provider does, so the token cannot wait for it.
 */
export function bootstrapSession(): void {
  if (typeof window === "undefined") return;
  if (hostCan("localAccount")) {
    holdSessionUntil(readHostSession());
    return;
  }
  adoptStoredToken();
  let profile: string | null = null;
  try {
    profile = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  if (profile && tokenExpiry() * 1000 <= Date.now()) holdSessionUntil(refreshSession());
}

function hostUser(session: HostSession, name?: string | null): AuthUser {
  const { id, email } = session.user;
  return { id, username: name ?? email ?? "You", ...(email ? { email } : {}) };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // A host that owns the session is asked first, before any browser storage:
    // the profile blob a previous run left behind would otherwise match below
    // and the keychain session would never be read, leaving the window signed
    // in by appearance and unauthenticated on every API call.
    if (hostCan("localAccount")) {
      // A token that expired while the app was closed is refreshed on its first 401.
      // The token stays in memory for this window: writing it to localStorage
      // would put back exactly what the keychain avoids.
      void readHostSession()
        .then((session) => {
          if (!session) {
            if (!/^\/(login|register)$/.test(window.location.pathname))
              navigate("/login", { replace: true });
            return;
          }
          setUserState(hostUser(session));
          return undefined;
        })
        .finally(() => setIsLoading(false));
      return;
    }

    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    if (!raw) {
      setIsLoading(false);
      return;
    }
    const profile = JSON.parse(raw) as AuthUser;
    // bootstrapSession already exchanged the refresh cookie if it had to. A stale
    // profile blob must never count as signed in (it once bounced /login → /chat
    // into the previous account's workspace).
    void sessionReady()
      .then(() => {
        if (tokenExpiry() * 1000 > Date.now()) setUserState(profile);
        else {
          localStorage.removeItem(STORAGE_KEY);
          setUserState(null);
        }
        return undefined;
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Keep the session alive past the access-token TTL: refresh before expiry,
  // retry on transient failure while the access token is still valid, and only
  // log out when the session is genuinely unrecoverable.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const exp = tokenExpiry();
      if (!exp) return;
      // Refresh 60s before expiry; poll every 5 min as a safety net so a
      // stalled tab still recovers once the network is back.
      const delayMs = Math.max(15_000, Math.min(exp * 1000 - Date.now() - 60_000, 5 * 60_000));
      timer = setTimeout(async () => {
        let refreshed = await refreshSession();
        if (!refreshed) {
          // One retry after a short beat: rotation races 401 the loser once,
          // and the access token usually still has life left. Only give up
          // when the access token is genuinely dead AND refresh still fails.
          await new Promise((r) => setTimeout(r, 2_000));
          refreshed = await refreshSession();
        }
        if (!refreshed && tokenExpiry() * 1000 <= Date.now()) {
          // Access token is truly dead and no refresh path — sign out cleanly.
          logout();
          window.location.href = "/login";
          return;
        }
        schedule();
      }, delayMs);
    };
    // Re-armed on sign-in: the token arrives after mount now, not from storage.
    if (!hostCan("localAccount")) schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [user]);

  const setUser = (raw: (AuthUser & { name?: string | null }) | null) => {
    // The API sends `name`; screens read `username`.
    const u = raw && { ...raw, username: raw.username || raw.name || raw.email || "You" };
    setUserState(u);
    if (u) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const logout = () => {
    setSessionToken(null);
    if (hostCan("localAccount")) {
      void hostInvoke("localAccount", "signOut").catch(() => {
        /* the in-memory token is already gone */
      });
    } else {
      // Revokes the refresh token and clears its cookie.
      void fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      }).catch(() => {
        /* offline: the cookie outlives this tab until it expires */
      });
    }
    setUser(null);
  };

  const login = async (email: string, password: string, code?: string) => {
    if (hostCan("localAccount")) {
      const session = await hostInvoke<HostSession>(
        "localAccount",
        "signInWithPassword",
        email,
        password,
      );
      setSessionToken(session.accessToken);
      setUserState(hostUser(session));
      return;
    }
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(code ? { code } : {}) }),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      try {
        const parsed = JSON.parse(raw) as { message?: string; error?: string };
        throw Object.assign(new Error(parsed.message ?? parsed.error ?? "Login failed"), {
          code: parsed.error,
        });
      } catch (err) {
        if (err instanceof SyntaxError) throw new Error(raw || "Login failed");
        throw err;
      }
    }
    const data = (await res.json()) as { accessToken?: string; user: AuthUser };
    // The refresh token arrived as an httpOnly cookie; the body's copy is for API clients.
    setSessionToken(data.accessToken ?? null);
    setUser(data.user);
  };

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated: !!user, isLoading, setUser, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
