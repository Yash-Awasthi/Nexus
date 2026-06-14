// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

interface AliasEntry { alias: string; model: string; overridden: boolean; }
interface FeatureFlag { key: string; enabled: boolean; description?: string; }
interface SystemSettings {
  defaultModel: string;
  maxConcurrency: number;
  logLevel: "debug" | "info" | "warn" | "error";
  enableTelemetry: boolean;
}

const s = {
  title: { fontSize: 24, fontWeight: 700, marginBottom: 28 } as React.CSSProperties,
  section: { background: "#161b27", border: "1px solid #1e2535", borderRadius: 10, padding: "20px 24px", marginBottom: 20 },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: "#e2e8f0", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #1e2535" },
  label: { fontSize: 13, color: "#e2e8f0" },
  sublabel: { fontSize: 11, color: "#64748b", marginTop: 2 },
  input: {
    background: "#0d1117", border: "1px solid #1e2535", borderRadius: 6, color: "#e2e8f0",
    fontSize: 13, padding: "6px 10px", width: 200,
  } as React.CSSProperties,
  toggle: (on: boolean): React.CSSProperties => ({
    width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
    background: on ? "#7c3aed" : "#334155", flexShrink: 0,
  }),
  saveBtn: {
    background: "#7c3aed", border: "none", borderRadius: 8, color: "#fff",
    fontSize: 13, fontWeight: 600, padding: "8px 20px", cursor: "pointer", marginTop: 16,
  } as React.CSSProperties,
  badge: (on: boolean): React.CSSProperties => ({
    fontSize: 11, padding: "2px 8px", borderRadius: 12, fontWeight: 600,
    background: on ? "#14532d" : "#1c1917", color: on ? "#4ade80" : "#78716c",
  }),
};

export default function Settings() {
  const [aliases, setAliases] = useState<AliasEntry[]>([]);
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [sys, setSys] = useState<SystemSettings>({ defaultModel: "nexus/smart", maxConcurrency: 4, logLevel: "info", enableTelemetry: true });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<{ routes: AliasEntry[] }>("/admin/routes")
      .then((r) => setAliases(r.routes))
      .catch(() => setAliases([
        { alias: "nexus/smart", model: "claude-3-5-sonnet-20241022", overridden: false },
        { alias: "nexus/fast", model: "gpt-4o-mini", overridden: false },
        { alias: "nexus/planner", model: "gpt-4o", overridden: true },
        { alias: "nexus/eval", model: "gemini-1.5-flash", overridden: false },
      ]));
    api.get<{ flags: FeatureFlag[] }>("/feature-flags")
      .then((r) => setFlags(r.flags))
      .catch(() => setFlags([
        { key: "enable_memory", enabled: true, description: "Persist and retrieve agent memory" },
        { key: "enable_kg", enabled: true, description: "Knowledge graph construction" },
        { key: "enable_voice", enabled: false, description: "Voice input/output interface" },
        { key: "enable_image_gen", enabled: false, description: "Image generation capabilities" },
        { key: "enable_mlx", enabled: false, description: "Apple Silicon (MLX) local inference" },
      ]));
  }, []);

  const toggleFlag = (key: string) => {
    setFlags((fs) => fs.map((f) => f.key === key ? { ...f, enabled: !f.enabled } : f));
  };

  const save = () => {
    api.post("/admin/settings", sys).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <h1 style={s.title}>Settings</h1>

      <div style={s.section}>
        <div style={s.sectionTitle}>🔀 Model Aliases</div>
        {aliases.map((a) => (
          <div key={a.alias} style={s.row}>
            <div>
              <div style={s.label}>{a.alias}</div>
              <div style={s.sublabel}>{a.model}</div>
            </div>
            <span style={s.badge(a.overridden)}>{a.overridden ? "overridden" : "static"}</span>
          </div>
        ))}
      </div>

      <div style={s.section}>
        <div style={s.sectionTitle}>🚀 Feature Flags</div>
        {flags.map((f) => (
          <div key={f.key} style={s.row}>
            <div>
              <div style={s.label}>{f.key}</div>
              {f.description && <div style={s.sublabel}>{f.description}</div>}
            </div>
            <button style={s.toggle(f.enabled)} onClick={() => toggleFlag(f.key)} />
          </div>
        ))}
      </div>

      <div style={s.section}>
        <div style={s.sectionTitle}>⚙️ System</div>
        {([
          { key: "defaultModel" as const, label: "Default Model" },
          { key: "maxConcurrency" as const, label: "Max Concurrency" },
          { key: "logLevel" as const, label: "Log Level" },
        ] as { key: keyof SystemSettings; label: string }[]).map(({ key, label }) => (
          <div key={key} style={s.row}>
            <div style={s.label}>{label}</div>
            <input
              style={s.input}
              value={String(sys[key])}
              onChange={(e) => setSys((s) => ({ ...s, [key]: key === "maxConcurrency" ? Number(e.target.value) : e.target.value }))}
            />
          </div>
        ))}
        <div style={s.row}>
          <div style={s.label}>Enable Telemetry</div>
          <button style={s.toggle(sys.enableTelemetry)} onClick={() => setSys((s) => ({ ...s, enableTelemetry: !s.enableTelemetry }))} />
        </div>
        <button style={s.saveBtn} onClick={save}>
          {saved ? "✓ Saved" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}
