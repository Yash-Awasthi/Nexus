// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export interface AuthUser {
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
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const STORAGE_KEY = "nexus_user";
const TOKEN_KEY = "nexus_token";
const REFRESH_KEY = "nexus_refresh_token";

/** Decode the access token's exp (seconds) — 0 when unparseable. */
function tokenExpiry(): number {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return 0;
    const payload = JSON.parse(atob(raw.split(".")[1] ?? "")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/**
 * Silent refresh: exchange the stored refresh token for a fresh pair shortly
 * before the access token expires, so mid-session /api/v1 calls stop dying
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
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;
  try {
    const res = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
    if (data.accessToken) localStorage.setItem(TOKEN_KEY, data.accessToken);
    if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken);
    return !!data.accessToken;
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const token = localStorage.getItem(TOKEN_KEY);
      if (raw && token) {
        if (tokenExpiry() * 1000 > Date.now()) {
          setUserState(JSON.parse(raw) as AuthUser);
        } else {
          // Access token already dead at load: try one silent refresh before
          // deciding. If it fails, sign out — a stale profile blob must never
          // count as "authenticated" (it hijacked the register→login flow by
          // bouncing /login → /chat into the previous account's workspace).
          refreshSession().then((ok) => {
            if (ok) {
              setUserState(JSON.parse(raw) as AuthUser);
            } else {
              localStorage.removeItem(STORAGE_KEY);
              localStorage.removeItem(TOKEN_KEY);
              localStorage.removeItem(REFRESH_KEY);
              setUserState(null);
            }
          });
        }
      } else if (raw && !token) {
        // Profile with NO token at all = local-mode user (setup wizard /
        // Electron). There is no token to validate — keep the session.
        setUserState(JSON.parse(raw) as AuthUser);
      } else if (typeof window !== "undefined" && (window as { molecule?: unknown }).molecule) {
        // Electron desktop — no backend auth needed, auto-login as local user
        const localUser: AuthUser = { id: "local", username: "You" };
        setUserState(localUser);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(localUser));
      }
    } catch {
      // ignore
    }
    setIsLoading(false);
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
    if (!(window as { molecule?: unknown }).molecule && localStorage.getItem(TOKEN_KEY)) {
      schedule();
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  const setUser = (u: AuthUser | null) => {
    setUserState(u);
    if (u) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    setUser(null);
  };

  const login = async (email: string, password: string) => {
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      try {
        const parsed = JSON.parse(raw) as { message?: string; error?: string };
        throw new Error(parsed.message ?? parsed.error ?? "Login failed");
      } catch (err) {
        if (err instanceof SyntaxError) throw new Error(raw || "Login failed");
        throw err;
      }
    }
    const data = (await res.json()) as {
      accessToken?: string;
      refreshToken?: string;
      user: AuthUser;
    };
    // Persist the JWT so authFetch() can attach it to API calls (see ~/lib/api),
    // plus the refresh token so the session can outlive the 15-minute TTL.
    if (data.accessToken) localStorage.setItem(TOKEN_KEY, data.accessToken);
    if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken);
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
