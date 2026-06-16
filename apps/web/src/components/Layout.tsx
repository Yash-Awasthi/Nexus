// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

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
  { to: "/research", label: "Research", icon: "🔬" },
];

const NAV_EXTENDED = [
  { to: "/voice", label: "Voice", icon: "🎙" },
  { to: "/image-gen", label: "Image Gen", icon: "⊞" },
  { to: "/knowledge-graph", label: "KG Explorer", icon: "⊛" },
  { to: "/connectors", label: "Connectors", icon: "⊕" },
  { to: "/billing", label: "Billing", icon: "⊘" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

// ── Breadcrumb ────────────────────────────────────────────────────────────────

const ALL_NAV = [...NAV_CORE, ...NAV_EXTENDED];

function useBreadcrumb(): string {
  const { pathname } = useLocation();
  if (pathname === "/") return "Dashboard";
  const seg = pathname.slice(1).split("/")[0] ?? "";
  return (
    ALL_NAV.find((n) => n.to === `/${seg}`)?.label ?? seg.charAt(0).toUpperCase() + seg.slice(1)
  );
}

// ── NavItem ───────────────────────────────────────────────────────────────────

function NavItem({
  to,
  label,
  icon,
  collapsed,
}: {
  to: string;
  label: string;
  icon: string;
  collapsed: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      title={collapsed ? label : undefined}
      style={({ isActive }) => ({
        display: "flex",
        alignItems: "center",
        gap: collapsed ? 0 : 10,
        padding: collapsed ? "9px 0" : "9px 20px",
        justifyContent: collapsed ? "center" : "flex-start",
        fontSize: 14,
        color: isActive ? "#c4b5fd" : "#94a3b8",
        background: isActive ? "rgba(124,58,237,0.12)" : "transparent",
        borderLeft: isActive ? "2px solid #7c3aed" : "2px solid transparent",
        transition: "all 0.15s",
        whiteSpace: "nowrap",
        overflow: "hidden",
      })}
    >
      <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

// ── Topbar ────────────────────────────────────────────────────────────────────

function Topbar({ breadcrumb, onToggle }: { breadcrumb: string; onToggle: () => void }) {
  const [showUser, setShowUser] = useState(false);

  return (
    <header
      style={{
        height: 48,
        background: "#0f1117",
        borderBottom: "1px solid #1e2535",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        flexShrink: 0,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={onToggle}
          title="Toggle sidebar"
          style={{
            background: "transparent",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            fontSize: 18,
            padding: "2px 4px",
            lineHeight: 1,
          }}
        >
          ☰
        </button>
        <span style={{ color: "#64748b", fontSize: 13 }}>Nexus</span>
        <span style={{ color: "#334155" }}>/</span>
        <span style={{ color: "#c4b5fd", fontSize: 13, fontWeight: 600 }}>{breadcrumb}</span>
      </div>

      <div style={{ position: "relative" }}>
        <button
          onClick={() => setShowUser((v) => !v)}
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "rgba(124,58,237,0.2)",
            border: "1px solid #5b21b6",
            color: "#c4b5fd",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="User menu"
        >
          Y
        </button>
        {showUser && (
          <div
            style={{
              position: "absolute",
              top: 40,
              right: 0,
              background: "#161b27",
              border: "1px solid #1e2535",
              borderRadius: 10,
              padding: "4px 0",
              minWidth: 160,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              zIndex: 100,
            }}
          >
            {["Profile ◉", "API Keys ⊛", "Sign out ⊘"].map((item) => (
              <button
                key={item}
                onClick={() => setShowUser(false)}
                style={{
                  width: "100%",
                  padding: "9px 16px",
                  background: "transparent",
                  border: "none",
                  color: "#94a3b8",
                  cursor: "pointer",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                {item}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const breadcrumb = useBreadcrumb();
  const sidebarW = collapsed ? 52 : 220;

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: sidebarW,
          minWidth: sidebarW,
          background: "#161b27",
          borderRight: "1px solid #1e2535",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          overflowX: "hidden",
          transition: "width 0.2s, min-width 0.2s",
          position: "sticky",
          top: 0,
          height: "100vh",
        }}
      >
        <div
          style={{
            padding: collapsed ? "20px 0" : "20px",
            textAlign: collapsed ? "center" : undefined,
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: "-0.5px",
            color: "#7c3aed",
            flexShrink: 0,
            borderBottom: "1px solid #1e2535",
            marginBottom: 8,
          }}
        >
          ⬡{!collapsed && " NEXUS"}
        </div>
        <nav style={{ flex: 1 }}>
          {NAV_CORE.map((item) => (
            <NavItem key={item.to} {...item} collapsed={collapsed} />
          ))}
          {collapsed ? (
            <div style={{ margin: "8px 0", borderTop: "1px solid #1e2535" }} />
          ) : (
            <div
              style={{
                margin: "8px 20px",
                borderTop: "1px solid #1e2535",
                fontSize: 10,
                color: "#334155",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                paddingTop: 8,
              }}
            >
              Extended
            </div>
          )}
          {NAV_EXTENDED.map((item) => (
            <NavItem key={item.to} {...item} collapsed={collapsed} />
          ))}
        </nav>
        {!collapsed && (
          <div style={{ padding: "12px 20px", color: "#334155", fontSize: 11 }}>v0.1.0</div>
        )}
      </aside>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar breadcrumb={breadcrumb} onToggle={() => setCollapsed((c) => !c)} />
        <main style={{ flex: 1, padding: 32, overflow: "auto" }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
