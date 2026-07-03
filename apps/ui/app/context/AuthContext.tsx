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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
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
    setUser(null);
  };

  const login = async (email: string, password: string) => {
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => "Login failed"));
    const data = (await res.json()) as { accessToken?: string; user: AuthUser };
    // Persist the JWT so authFetch() can attach it to API calls (see ~/lib/api).
    if (data.accessToken) localStorage.setItem(TOKEN_KEY, data.accessToken);
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
