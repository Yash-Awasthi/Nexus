import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  BotIcon,
  MessagesSquareIcon,
  BrainIcon,
  ActivityIcon,
  TrendingUpIcon,
  ZapIcon,
  CheckCircleIcon,
  ClockIcon,
} from "lucide-react";

const meta: Meta = {
  title: "Components/Dashboard",
  parameters: {
    layout: "fullscreen",
  },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof meta>;

const StatCard = ({
  title,
  value,
  description,
  icon: Icon,
  trend,
}: {
  title: string;
  value: string;
  description: string;
  icon: React.ElementType;
  trend?: string;
}) => (
  <Card>
    <CardHeader>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <CardDescription>{title}</CardDescription>
          <CardTitle style={{ fontSize: "24px", fontWeight: 700, marginTop: "4px" }}>
            {value}
          </CardTitle>
        </div>
        <div
          style={{
            padding: "8px",
            borderRadius: "8px",
            background: "rgba(59,130,246,0.1)",
            color: "#3b82f6",
          }}
        >
          <Icon size={18} />
        </div>
      </div>
    </CardHeader>
    <CardContent>
      <p style={{ fontSize: "11px", opacity: 0.6 }}>
        {trend && (
          <span style={{ color: "#10b981", fontWeight: 600 }}>{trend} </span>
        )}
        {description}
      </p>
    </CardContent>
  </Card>
);

const AgentRow = ({
  name,
  model,
  status,
  tasks,
}: {
  name: string;
  model: string;
  status: "active" | "idle" | "error";
  tasks: number;
}) => {
  const statusVariant =
    status === "active" ? "default" : status === "idle" ? "secondary" : "destructive";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 0",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <BotIcon size={14} style={{ opacity: 0.6 }} />
        <div>
          <div style={{ fontSize: "12px", fontWeight: 500 }}>{name}</div>
          <div style={{ fontSize: "11px", opacity: 0.5 }}>{model}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <span style={{ fontSize: "11px", opacity: 0.5 }}>{tasks} tasks</span>
        <Badge variant={statusVariant}>{status}</Badge>
      </div>
    </div>
  );
};

export const Default: Story = {
  render: () => (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: 600 }}>Dashboard</h1>
        <p style={{ fontSize: "12px", opacity: 0.5, marginTop: "4px" }}>
          AI Council — Multi-Agent Platform Overview
        </p>
      </div>

      {/* Stats Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "16px",
          marginBottom: "24px",
        }}
      >
        <StatCard
          title="Active Agents"
          value="12"
          description="agents deployed"
          icon={BotIcon}
          trend="+3"
        />
        <StatCard
          title="Conversations Today"
          value="284"
          description="vs 221 yesterday"
          icon={MessagesSquareIcon}
          trend="+28%"
        />
        <StatCard
          title="Memory Entries"
          value="1,847"
          description="across all agents"
          icon={BrainIcon}
        />
        <StatCard
          title="Avg Response Time"
          value="1.2s"
          description="p95 over last 24h"
          icon={ZapIcon}
          trend="-0.3s"
        />
      </div>

      {/* Agent List + Activity */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <Card>
          <CardHeader>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <CardTitle>Agent Fleet</CardTitle>
              <Button size="sm" variant="outline">View All</Button>
            </div>
            <CardDescription>Active and idle agents</CardDescription>
          </CardHeader>
          <CardContent>
            <AgentRow name="Research Agent" model="Claude 3.5 Sonnet" status="active" tasks={7} />
            <AgentRow name="Code Review Agent" model="GPT-4o" status="active" tasks={3} />
            <AgentRow name="Support Agent" model="Claude 3 Haiku" status="idle" tasks={0} />
            <AgentRow name="Data Analyst" model="Gemini 1.5 Pro" status="active" tasks={12} />
            <AgentRow name="Content Writer" model="GPT-4o Mini" status="error" tasks={0} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest system events</CardDescription>
          </CardHeader>
          <CardContent>
            {[
              { icon: CheckCircleIcon, text: "Research Agent completed task #284", time: "2m ago", color: "#10b981" },
              { icon: ActivityIcon, text: "Data Analyst started new analysis", time: "5m ago", color: "#3b82f6" },
              { icon: ClockIcon, text: "Knowledge base synced (847 docs)", time: "12m ago", color: "#f59e0b" },
              { icon: CheckCircleIcon, text: "Code Review Agent finished PR #142", time: "18m ago", color: "#10b981" },
              { icon: TrendingUpIcon, text: "Memory consolidation completed", time: "1h ago", color: "#a855f7" },
            ].map((event, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "7px 0",
                  borderBottom: i < 4 ? "1px solid rgba(255,255,255,0.06)" : "none",
                }}
              >
                <event.icon size={12} style={{ color: event.color, flexShrink: 0 }} />
                <span style={{ fontSize: "11px", flex: 1 }}>{event.text}</span>
                <span style={{ fontSize: "10px", opacity: 0.4, flexShrink: 0 }}>{event.time}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  ),
};

export const EmptyState: Story = {
  render: () => (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: 600 }}>Dashboard</h1>
      </div>
      <Card style={{ textAlign: "center", padding: "48px" }}>
        <CardContent>
          <BotIcon size={48} style={{ margin: "0 auto 16px", opacity: 0.3 }} />
          <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}>No agents yet</h2>
          <p style={{ fontSize: "12px", opacity: 0.5, marginBottom: "16px" }}>
            Deploy your first AI agent to get started with AI Council.
          </p>
          <Button>Deploy Agent</Button>
        </CardContent>
      </Card>
    </div>
  ),
};
