import type { Route } from "./+types/product.developer-platform";
import { ProductPage } from "~/components/product-page";
import {
  Code,
  Radio,
  Webhook,
  AppWindow,
  MessageCircle,
  Terminal,
} from "lucide-react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "API, MCP & SDK | JUDICA" },
    {
      name: "description",
      content:
        "Full REST API access covering every platform capability. Model Context Protocol server for AI agent interoperability. Build on JUDICA or integrate it into your stack.",
    },
  ];
}

export default function ProductDeveloperPlatform() {
  return (
    <ProductPage
      badge="For Developers"
      title="API, MCP &"
      titleHighlight="SDK"
      subtitle="Full REST API access covering every platform capability. Model Context Protocol server for AI agent interoperability. Build on JUDICA or integrate it into your stack."
      features={[
        {
          icon: Code,
          title: "REST API",
          description:
            "Comprehensive Fastify route plugins covering every platform capability. OpenAPI documentation with typed request and response schemas.",
        },
        {
          icon: Radio,
          title: "MCP Protocol",
          description:
            "Model Context Protocol server supporting stdio, SSE, and streamable-http transports. Let external AI agents use JUDICA as a tool.",
        },
        {
          icon: Webhook,
          title: "Webhooks",
          description:
            "Real-time event notifications for deliberation completions, workflow triggers, and system events. Configurable retry policies.",
        },
        {
          icon: AppWindow,
          title: "Embeddable Widget",
          description:
            "Drop a deliberation interface into any web application with a single script tag. Fully themeable and customizable.",
        },
        {
          icon: MessageCircle,
          title: "Slack & Discord Integration",
          description:
            "Run deliberations directly from Slack or Discord. Bot commands trigger councils and stream results back to your channels.",
        },
        {
          icon: Terminal,
          title: "Code Sandbox",
          description:
            "Secure V8 and Python bubblewrap sandboxes for executing agent-generated code. Run computations safely within deliberations.",
        },
      ]}
      howItWorks={[
        {
          step: "1",
          title: "Integrate",
          description:
            "Connect via REST API or MCP protocol. Generate API keys and configure authentication in minutes.",
        },
        {
          step: "2",
          title: "Build",
          description:
            "Create custom tools, extensions, and integrations. Use webhooks and the embeddable widget to extend the platform.",
        },
        {
          step: "3",
          title: "Deploy",
          description:
            "Ship with Docker, Kubernetes, or Cloudflare. Production-ready deployment options for any infrastructure.",
        },
      ]}
    />
  );
}
