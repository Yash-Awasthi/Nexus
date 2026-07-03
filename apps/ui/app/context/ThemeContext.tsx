// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("nexus_theme") as Theme | null;
    if (saved) setThemeState(saved);
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    if (typeof window !== "undefined") {
      localStorage.setItem("nexus_theme", t);
      document.documentElement.classList.toggle("dark", t === "dark");
    }
  };

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  useEffect(() => {
    if (typeof window !== "undefined") {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
