// SPDX-License-Identifier: Apache-2.0
import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";

function Hero() {
  return (
    <header
      style={{
        background: "linear-gradient(135deg, #0f1117 0%, #1e1035 50%, #0f1117 100%)",
        padding: "6rem 0",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 1rem" }}>
        <h1
          style={{
            fontSize: "3.5rem",
            fontWeight: 800,
            background: "linear-gradient(135deg, #c4b5fd, #7c3aed)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            marginBottom: "1rem",
          }}
        >
          ⬡ NEXUS
        </h1>
        <p style={{ fontSize: "1.25rem", color: "#94a3b8", marginBottom: "2rem" }}>
          Autonomous orchestration platform — sense, think, decide, act.
          <br />
          One governance plane. One observability story. One plugin model.
        </p>
        <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
          <Link
            to="/docs/quick-start"
            style={{
              background: "#7c3aed",
              color: "#fff",
              padding: "0.75rem 2rem",
              borderRadius: "0.5rem",
              fontWeight: 600,
              fontSize: "1rem",
              textDecoration: "none",
            }}
          >
            Get Started →
          </Link>
          <Link
            to="/docs/architecture"
            style={{
              background: "transparent",
              color: "#c4b5fd",
              padding: "0.75rem 2rem",
              borderRadius: "0.5rem",
              fontWeight: 600,
              fontSize: "1rem",
              border: "1px solid #4c1d95",
              textDecoration: "none",
            }}
          >
            Architecture
          </Link>
        </div>
      </div>
    </header>
  );
}

const FEATURES = [
  {
    icon: "⚡",
    title: "Sense",
    description:
      "nexus-ingest scrapes 13 financial sources concurrently. Gmail, GitHub, Slack — every event flows through a unified pipeline.",
  },
  {
    icon: "⚖",
    title: "Think",
    description:
      "14 archetype LLM personas deliberate on every signal. Consensus, dissent, confidence — all tracked, all auditable.",
  },
  {
    icon: "🛡",
    title: "Decide",
    description:
      "GovernanceEngine enforces constraints, policies, and guardrails. HITL gates on dangerous operations. HMAC-chained audit log.",
  },
  {
    icon: "◎",
    title: "Act",
    description:
      "15 first-party adapters. BullMQ workers with priority queues. Every action is a typed task with retry, DLQ, and full traceability.",
  },
  {
    icon: "🔌",
    title: "Extensible",
    description:
      "IExecutionAdapter interface. Define a new adapter in < 30 minutes. Zero framework coupling — just TypeScript and fetch.",
  },
  {
    icon: "🔍",
    title: "Observable",
    description:
      "OpenTelemetry tracing, Prometheus metrics, SLO tracking, Grafana dashboards. Know what's happening, always.",
  },
];

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <Hero />
      <main style={{ padding: "4rem 1rem" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h2
            style={{
              textAlign: "center",
              fontSize: "2rem",
              fontWeight: 700,
              marginBottom: "3rem",
            }}
          >
            Everything you need to build autonomous agents
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: "1.5rem",
            }}
          >
            {FEATURES.map(({ icon, title, description }) => (
              <div
                key={title}
                style={{
                  background: "#161b27",
                  border: "1px solid #1e2535",
                  borderRadius: "0.75rem",
                  padding: "1.5rem",
                }}
              >
                <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>{icon}</div>
                <h3 style={{ fontWeight: 700, marginBottom: "0.5rem" }}>{title}</h3>
                <p style={{ color: "#94a3b8", margin: 0, lineHeight: 1.6 }}>{description}</p>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: "4rem",
              background: "#161b27",
              border: "1px solid #1e2535",
              borderRadius: "0.75rem",
              padding: "2rem",
            }}
          >
            <h2 style={{ fontWeight: 700, marginBottom: "1rem" }}>30-second demo</h2>
            <pre
              style={{
                background: "#0f1117",
                borderRadius: "0.5rem",
                padding: "1.5rem",
                overflow: "auto",
                fontSize: "0.875rem",
              }}
            >
              <code>{`# Start the stack
docker compose up -d
pnpm dev

# Ingest a financial signal
nexus ingest event \\
  --source bloomberg --type market.alert \\
  --payload '{"ticker":"AAPL","headline":"Q4 beats by 12%"}' \\
  --priority high

# Run council deliberation
nexus council deliberate \\
  --title "Should we increase AAPL position?" \\
  --budget 0.10

# ● Outcome: APPROVED
#   Consensus: 78%  ·  7 YES / 2 NO / 0 ABSTAIN`}</code>
            </pre>
          </div>
        </div>
      </main>
    </Layout>
  );
}
