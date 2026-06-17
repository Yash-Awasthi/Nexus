import type { Meta, StoryObj } from "@storybook/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "./card";
import { Button } from "./button";
import { Badge } from "./badge";

const meta: Meta<typeof Card> = {
  title: "UI/Card",
  component: Card,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
  argTypes: {
    size: {
      control: "select",
      options: ["default", "sm"],
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card style={{ width: "320px" }}>
      <CardHeader>
        <CardTitle>Card Title</CardTitle>
        <CardDescription>A brief description of the card content.</CardDescription>
      </CardHeader>
      <CardContent>
        <p>This is the main content area of the card.</p>
      </CardContent>
    </Card>
  ),
};

export const WithFooter: Story = {
  render: () => (
    <Card style={{ width: "320px" }}>
      <CardHeader>
        <CardTitle>With Footer</CardTitle>
        <CardDescription>Card with action buttons in the footer.</CardDescription>
      </CardHeader>
      <CardContent>
        <p>Card content goes here.</p>
      </CardContent>
      <CardFooter style={{ gap: "8px" }}>
        <Button variant="outline" size="sm">Cancel</Button>
        <Button size="sm">Confirm</Button>
      </CardFooter>
    </Card>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Card style={{ width: "320px" }}>
      <CardHeader>
        <CardTitle>Agent Status</CardTitle>
        <CardDescription>Multi-agent coordination overview</CardDescription>
        <CardAction>
          <Badge variant="default">Active</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p>3 agents running — 2 tasks queued.</p>
      </CardContent>
    </Card>
  ),
};

export const Small: Story = {
  render: () => (
    <Card size="sm" style={{ width: "280px" }}>
      <CardHeader>
        <CardTitle>Small Card</CardTitle>
        <CardDescription>Compact card variant.</CardDescription>
      </CardHeader>
      <CardContent>
        <p>Smaller padding and spacing.</p>
      </CardContent>
    </Card>
  ),
};

export const AgentCard: Story = {
  render: () => (
    <Card style={{ width: "340px" }}>
      <CardHeader>
        <CardTitle>Research Agent</CardTitle>
        <CardDescription>GPT-4o · RAG enabled · Knowledge: Docs</CardDescription>
        <CardAction>
          <Badge variant="secondary">Idle</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p style={{ fontSize: "12px", opacity: 0.7 }}>
          Last run: 2 minutes ago · 12 tasks completed today
        </p>
      </CardContent>
      <CardFooter style={{ gap: "8px" }}>
        <Button variant="ghost" size="sm">Configure</Button>
        <Button size="sm">Run</Button>
      </CardFooter>
    </Card>
  ),
};
