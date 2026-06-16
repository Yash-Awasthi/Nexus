// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal global state store — Zustand-compatible surface without the npm dep.
 *
 * createStore<T>(initialState, actions?) returns:
 *   useStore()        — React hook that subscribes to state changes
 *   getState()        — sync snapshot (outside React)
 *   setState(patch)   — partial update; triggers all subscribers
 *   subscribe(fn)     — low-level subscription
 *
 * Usage:
 *   const useAuth = createStore({ user: null, token: null });
 *   const { user } = useAuth();
 *   useAuth.setState({ user: { id: "1" } });
 */

import { useState, useEffect } from "react";

type Listener<T> = (state: T) => void;

export interface Store<T> {
  (): T;
  getState: () => T;
  setState: (patch: Partial<T> | ((prev: T) => Partial<T>)) => void;
  subscribe: (fn: Listener<T>) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = { ...initial };
  const listeners = new Set<Listener<T>>();

  function getState(): T {
    return state;
  }

  function setState(patch: Partial<T> | ((prev: T) => Partial<T>)): void {
    const update = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...update };
    listeners.forEach((fn) => fn(state));
  }

  function subscribe(fn: Listener<T>): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // React hook — re-renders the component when state changes
  function useStore(): T {
    const [snap, setSnap] = useState(state);
    useEffect(() => subscribe(setSnap), []);
    return snap;
  }

  useStore.getState = getState;
  useStore.setState = setState;
  useStore.subscribe = subscribe;

  return useStore as Store<T>;
}

// ── Global app stores ─────────────────────────────────────────────────────────

/** Auth store — persists token in sessionStorage. */
export const useAuthStore = createStore<{
  token: string | null;
  userId: string | null;
  email: string | null;
  tier: "free" | "pro" | "enterprise";
}>({
  token: sessionStorage.getItem("nexus_token"),
  userId: sessionStorage.getItem("nexus_user_id"),
  email: sessionStorage.getItem("nexus_email"),
  tier: (sessionStorage.getItem("nexus_tier") as "free" | "pro" | "enterprise") ?? "free",
});

// Persist token changes to sessionStorage
useAuthStore.subscribe((s) => {
  if (s.token) sessionStorage.setItem("nexus_token", s.token);
  else sessionStorage.removeItem("nexus_token");
  if (s.userId) sessionStorage.setItem("nexus_user_id", s.userId);
  else sessionStorage.removeItem("nexus_user_id");
  if (s.email) sessionStorage.setItem("nexus_email", s.email);
  else sessionStorage.removeItem("nexus_email");
  sessionStorage.setItem("nexus_tier", s.tier);
});

/** UI preferences store. */
export const usePrefsStore = createStore<{
  theme: "light" | "dark" | "system";
  sidebarOpen: boolean;
  chatModel: string;
}>({
  theme: (localStorage.getItem("nexus_theme") as "light" | "dark" | "system") ?? "system",
  sidebarOpen: true,
  chatModel: localStorage.getItem("nexus_chat_model") ?? "nexus/smart",
});

usePrefsStore.subscribe((s) => {
  localStorage.setItem("nexus_theme", s.theme);
  localStorage.setItem("nexus_chat_model", s.chatModel);
});
