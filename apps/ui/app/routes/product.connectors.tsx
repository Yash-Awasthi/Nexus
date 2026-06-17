import type { Route } from "./+types/product.connectors";
import { ProductPage } from "~/components/product-page";
import {
  Brain,
  Cloud,
  Gem,
  Server,
  Cpu,
  Database,
  FolderOpen,
} from "lucide-react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "19 LLM Providers, Vector DBs & 51 Data Connectors | JUDICA" },
    {
      name: "description",
      content:
        "Connect to any major AI provider and 51 data sources — Notion, Slack, GitHub, Confluence, Google Drive, Salesforce, and more. Circuit breaker protection and automatic failover.",
    },
  ];
}

export default function ProductConnectors() {
  return (
    <ProductPage
      badge="Integrations"
      title="19 LLM Providers &"
      titleHighlight="51 Data Connectors"
      subtitle="Connect to any major AI provider and ingest from 51 data sources. Circuit breaker protection and automatic failover keep your system running even when providers go down."
      features={[
        {
          icon: Brain,
          title: "OpenAI & Azure OpenAI",
          description:
            "Full support for GPT-4o, GPT-4 Turbo, and all OpenAI models. Azure OpenAI for enterprise deployments with regional compliance.",
        },
        {
          icon: Cloud,
          title: "Anthropic, Gemini & More",
          description:
            "Claude 3.5, Gemini Pro/Ultra, Groq, Mistral, vLLM, LiteLLM, and OpenRouter — 9 adapters covering 19+ provider families.",
        },
        {
          icon: Server,
          title: "Ollama (Local)",
          description:
            "Run models locally with Ollama. Full privacy, zero API costs, and offline capability for sensitive workloads.",
        },
        {
          icon: Database,
          title: "Vector DBs",
          description:
            "pgvector, Pinecone, Weaviate, and Vespa. Choose the vector database that fits your scale and performance requirements.",
        },
        {
          icon: FolderOpen,
          title: "51 Data Source Connectors",
          description:
            "Notion, Slack, GitHub, Confluence, Jira, Google Drive, Salesforce, Dropbox, S3, OneDrive, Discord, Telegram, HubSpot, Linear, Zendesk, and 36 more.",
        },
        {
          icon: Gem,
          title: "Circuit Breaker Protection",
          description:
            "Automatic failover and load balancing across providers. Your deliberations keep running even when individual providers go down.",
        },
      ]}
      howItWorks={[
        {
          step: "1",
          title: "Connect",
          description:
            "Add provider API keys and data source credentials through the settings panel. Test connections instantly.",
        },
        {
          step: "2",
          title: "Configure",
          description:
            "Set failover priorities and routing rules. Define which models handle which tasks and which sources feed your knowledge bases.",
        },
        {
          step: "3",
          title: "Scale",
          description:
            "Automatic load balancing and circuit breakers keep your system running. 51 data connectors keep your knowledge bases fresh.",
        },
      ]}
    />
  );
}
