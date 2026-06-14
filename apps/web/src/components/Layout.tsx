// SPDX-License-Identifier: Apache-2.0
import { NavLink, Outlet } from "react-router-dom";

const NAV_CORE = [
  { to: "/", label: "Dashboard", icon: "⬡" },
  { to: "/chat", label: "Chat", icon: "◈" },
  { to: "/discover", label: "Discover", icon: "◑" },
  { to: "/signals", label: "Signals", icon: "⚡" },
  { to: "/council", label: "Council", icon: "⚖" },
  { to: "/tasks", label: "Tasks", icon: "◎" },
  { to: "/approvals", label: "Approvals", icon: "✓" },
  { to: "/audit", label: "Audit", icon: "⛓" },
  { to: "/memory", label: "Memory", icon: "⊙" },
];

const NAV_EXTENDED = [
  { to: "/voice", label: "Voice", icon: "🎙" },
  { to: "/image-gen", label: "Image Gen", icon: "⊞" },
  { to: "/knowledge-graph", label: "KG Explorer", icon: "⊛" },
  { to: "/connectors", label: "Connectors", icon: "⊕" },
  { to: "/billing", label: "Billing", icon: "⊘" },
  { to: "/settings", label: "Settings", icon: "⚙" },
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
    overflowY: "auto" as const,
  },
  logo: {
    padding: "0 20px 20px",
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: "-0.5px",
    color: "#7c3aed",
    flexShrink: 0,
  },
  nav: { flex: 1 },
  divider: {
    margin: "8px 20px",
    borderTop: "1px solid #1e2535",
    fontSize: 10,
    color: "#334155",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    paddingTop: 8,
  },
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

function NavItem({ to, label, icon }: { to: string; label: string; icon: string }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      style={({ isActive }) => styles.link(isActive)}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

export default function Layout() {
  return (
    <div style={styles.shell}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>⬡ NEXUS</div>
        <nav style={styles.nav}>
          {NAV_CORE.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
          <div style={styles.divider}>Extended</div>
          {NAV_EXTENDED.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>
      </aside>
      <main style={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
