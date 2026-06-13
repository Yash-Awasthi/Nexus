// SPDX-License-Identifier: Apache-2.0
import { NavLink, Outlet } from "react-router-dom";

const NAV = [
  { to: "/", label: "Dashboard", icon: "⬡" },
  { to: "/chat", label: "Chat", icon: "◈" },
  { to: "/signals", label: "Signals", icon: "⚡" },
  { to: "/council", label: "Council", icon: "⚖" },
  { to: "/tasks", label: "Tasks", icon: "◎" },
  { to: "/approvals", label: "Approvals", icon: "✓" },
  { to: "/audit", label: "Audit", icon: "⛓" },
];

const styles = {
  shell: { display: "flex", minHeight: "100vh" } as React.CSSProperties,
  sidebar: {
    width: 220,
    background: "#161b27",
    borderRight: "1px solid #1e2535",
    padding: "24px 0",
    display: "flex",
    flexDirection: "column" as const,
  },
  logo: {
    padding: "0 20px 24px",
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: "-0.5px",
    color: "#7c3aed",
  },
  nav: { flex: 1 },
  link: (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 20px",
    fontSize: 14,
    color: active ? "#c4b5fd" : "#94a3b8",
    background: active ? "rgba(124,58,237,0.12)" : "transparent",
    borderLeft: active ? "2px solid #7c3aed" : "2px solid transparent",
    transition: "all 0.15s",
  }),
  main: { flex: 1, padding: 32, overflow: "auto" } as React.CSSProperties,
};

export default function Layout() {
  return (
    <div style={styles.shell}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>⬡ NEXUS</div>
        <nav style={styles.nav}>
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              style={({ isActive }) => styles.link(isActive)}
            >
              <span>{icon}</span>
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main style={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
