// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAPI specification for Nexus Council Consensus and Knowledge Graph endpoints.
 */

export const councilOpenApiSpec = {
  "/api/v1/council/consensus": {
    post: {
      operationId: "councilConsensus",
      summary: "Multi-model council consensus",
      description:
        "Sends a prompt to multiple LLM models simultaneously and merges their responses using a consensus algorithm. Returns individual model answers with confidence scores, agreement metrics, and a merged answer.",
      tags: ["Council"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["prompt"],
              properties: {
                prompt: { type: "string", description: "The prompt to send to all council models" },
                models: {
                  type: "array",
                  items: { type: "string" },
                  description: "Specific models to consult (defaults to top 3)",
                  example: ["claude-sonnet-4-6", "openai/gpt-oss-120b", "gemini-3.6-flash"],
                },
                majorityThreshold: {
                  type: "number",
                  default: 0.67,
                  description: "Agreement threshold for supermajority (0.5 = simple majority)",
                },
              },
            },
            example: {
              prompt:
                "What is the best approach to handle concurrent writes in a distributed system?",
              models: ["claude-4-sonnet", "gpt-4o"],
              majorityThreshold: 0.67,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Consensus result",
          content: {
            "application/json": {
              example: {
                answers: [
                  {
                    model: "claude-4-sonnet",
                    answer: "Use optimistic locking with conflict detection...",
                    confidence: 0.92,
                  },
                  {
                    model: "gpt-4o",
                    answer: "Implement CRDTs for conflict-free replication...",
                    confidence: 0.85,
                  },
                ],
                mergedAnswer: "Use optimistic locking with conflict detection...",
                agreement: 0.75,
                bestModel: "claude-4-sonnet",
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/knowledge-graph/query": {
    post: {
      operationId: "queryKnowledgeGraph",
      summary: "Query the knowledge graph",
      description:
        "Traverse the knowledge graph starting from a node, with optional depth, type filters, and text search.",
      tags: ["Knowledge Graph"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["startNode"],
              properties: {
                startNode: { type: "string", description: "Starting node ID" },
                depth: { type: "integer", default: 2, description: "Traversal depth" },
                nodeTypes: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: [
                      "person",
                      "organization",
                      "concept",
                      "code_symbol",
                      "document",
                      "event",
                      "location",
                      "technology",
                      "file",
                    ],
                  },
                  description: "Filter by node types",
                },
                textSearch: { type: "string", description: "Text search on node labels" },
                limit: { type: "integer", default: 50, description: "Max results" },
              },
            },
            example: {
              startNode: "node-typescript",
              depth: 2,
              nodeTypes: ["technology", "concept"],
              limit: 20,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Graph query results",
          content: {
            "application/json": {
              example: {
                nodes: [
                  {
                    id: "node-typescript",
                    label: "TypeScript",
                    type: "technology",
                    properties: {},
                  },
                  { id: "node-react", label: "React", type: "technology", properties: {} },
                ],
                edges: [
                  {
                    id: "e1",
                    source: "node-typescript",
                    target: "node-react",
                    relation: "used_by",
                    weight: 1.0,
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/knowledge-graph/shortest-path": {
    post: {
      operationId: "findShortestPath",
      summary: "Find shortest path between two nodes",
      tags: ["Knowledge Graph"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["sourceId", "targetId"],
              properties: {
                sourceId: { type: "string" },
                targetId: { type: "string" },
                maxDepth: { type: "integer", default: 6 },
              },
            },
            example: { sourceId: "node-typescript", targetId: "node-python" },
          },
        },
      },
      responses: {
        "200": {
          description: "Shortest path result",
          content: {
            "application/json": {
              example: {
                found: true,
                path: [
                  { id: "node-typescript", label: "TypeScript", type: "technology" },
                  { id: "node-nodejs", label: "Node.js", type: "technology" },
                  { id: "node-python", label: "Python", type: "technology" },
                ],
                edges: [
                  { source: "node-typescript", target: "node-nodejs", relation: "compiles_to" },
                  { source: "node-nodejs", target: "node-python", relation: "interop" },
                ],
                totalWeight: 2.0,
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/knowledge-graph/stats": {
    get: {
      operationId: "getKnowledgeGraphStats",
      summary: "Get knowledge graph statistics",
      tags: ["Knowledge Graph"],
      responses: {
        "200": {
          description: "Graph statistics",
          content: {
            "application/json": {
              example: {
                nodeCount: 150,
                edgeCount: 420,
                typeDistribution: { technology: 45, concept: 30, person: 25, code_symbol: 50 },
                avgDegree: 5.6,
                connectedComponents: 3,
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/knowledge-graph/search": {
    get: {
      operationId: "searchKnowledgeGraph",
      summary: "Full-text search across knowledge graph nodes",
      tags: ["Knowledge Graph"],
      parameters: [
        {
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Search query",
        },
        { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
      ],
      responses: {
        "200": {
          description: "Search results",
          content: {
            "application/json": {
              example: {
                nodes: [
                  {
                    id: "node-typescript",
                    label: "TypeScript",
                    type: "technology",
                    properties: { score: 15 },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
};
