import type { Route } from "./+types/product.knowledge";
import { ProductPage } from "~/components/product-page";
import {
  FileSearch,
  Globe,
  Layers,
  ArrowUpDown,
  SlidersHorizontal,
  Database,
} from "lucide-react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Knowledge Bases & RAG | JUDICA" },
    {
      name: "description",
      content:
        "Advanced retrieval-augmented generation with HyDE, federated search, and parent-child chunking for precise, context-aware answers.",
    },
  ];
}

export default function ProductKnowledge() {
  return (
    <ProductPage
      badge="Core Feature"
      title="Knowledge Bases &"
      titleHighlight="RAG"
      subtitle="Advanced retrieval-augmented generation with HyDE, federated search, and parent-child chunking for precise, context-aware answers."
      features={[
        {
          icon: FileSearch,
          title: "HyDE",
          description:
            "Hypothetical Document Embeddings generate synthetic answers to improve retrieval accuracy. Your queries find the right documents, even with imprecise phrasing.",
        },
        {
          icon: Globe,
          title: "Federated Search",
          description:
            "Search across knowledge bases, repositories, conversations, and facts simultaneously. One query, all your data sources.",
        },
        {
          icon: Layers,
          title: "Parent-Child Chunking",
          description:
            "Hierarchical document splitting preserves context. Child chunks are retrieved for precision, parent chunks provide surrounding context.",
        },
        {
          icon: ArrowUpDown,
          title: "RRF Reranking",
          description:
            "Reciprocal Rank Fusion combines results from multiple retrieval strategies into a single, optimally ranked list.",
        },
        {
          icon: SlidersHorizontal,
          title: "Adaptive k-Selection",
          description:
            "Dynamic retrieval count adjusts based on query complexity and document relevance. No more guessing the right number of results.",
        },
        {
          icon: Database,
          title: "Vector Embeddings",
          description:
            "1536-dimensional embeddings stored in PostgreSQL with native vector similarity search. Fast cosine distance lookups across millions of chunks.",
        },
      ]}
      howItWorks={[
        {
          step: "1",
          title: "Ingest",
          description:
            "Upload documents or connect repositories. Support for PDFs, markdown, code, and more.",
        },
        {
          step: "2",
          title: "Index",
          description:
            "Automatic chunking and embedding. Parent-child hierarchies are built and stored with vector similarity search for fast retrieval.",
        },
        {
          step: "3",
          title: "Retrieve",
          description:
            "Semantic search with HyDE enhancement and RRF reranking delivers the most relevant context to your agents.",
        },
      ]}
    />
  );
}
