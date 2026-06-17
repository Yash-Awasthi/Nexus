export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
}

export interface Provider {
  id: string;
  name: string;
  description: string;
  icon: string;
  models: ProviderModel[];
  apiKeyPlaceholder?: string;
  supportsBaseUrl?: boolean;
}

export interface ConnectedProvider {
  id: string;
  providerId: string;
  displayName: string;
  apiKey: string;
  baseUrl?: string;
  enabledModels: string[];
  isDefault: boolean;
}

export const AVAILABLE_PROVIDERS: Provider[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT-4o, GPT-4, and more",
    icon: "openai",
    apiKeyPlaceholder: "sk-...",
    models: [
      { id: "gpt-4o", name: "GPT-4o", description: "Most capable model" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", description: "Fast and affordable" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", description: "High intelligence" },
      { id: "gpt-4", name: "GPT-4", description: "Original GPT-4" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", description: "Fast legacy model" },
      { id: "o1", name: "o1", description: "Reasoning model" },
      { id: "o1-mini", name: "o1 Mini", description: "Fast reasoning" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude 4, Claude 3.5, and more",
    icon: "anthropic",
    apiKeyPlaceholder: "sk-ant-...",
    models: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", description: "Most capable" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", description: "Balanced performance" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", description: "Fast and efficient" },
      { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", description: "Previous generation" },
      { id: "claude-3-opus", name: "Claude 3 Opus", description: "Previous generation" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    description: "Gemini Pro, Flash, and Ultra",
    icon: "google",
    apiKeyPlaceholder: "AI...",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Most capable" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast and efficient" },
      { id: "gemini-2.0-pro", name: "Gemini 2.0 Pro", description: "Previous generation" },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", description: "Long context" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    description: "Ultra-fast inference engine",
    icon: "groq",
    apiKeyPlaceholder: "gsk_...",
    models: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B", description: "Fast and capable" },
      { id: "llama-3.1-8b", name: "Llama 3.1 8B", description: "Ultra-fast" },
      { id: "mixtral-8x7b", name: "Mixtral 8x7B", description: "Mixture of experts" },
      { id: "gemma2-9b", name: "Gemma 2 9B", description: "Google open model" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Run models locally",
    icon: "ollama",
    supportsBaseUrl: true,
    models: [
      { id: "llama3.3", name: "Llama 3.3", description: "Meta's latest" },
      { id: "mistral", name: "Mistral", description: "Mistral 7B" },
      { id: "codellama", name: "Code Llama", description: "Code generation" },
      { id: "phi3", name: "Phi-3", description: "Microsoft's small model" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Access multiple providers via one API",
    icon: "openrouter",
    apiKeyPlaceholder: "sk-or-...",
    models: [
      { id: "auto", name: "Auto", description: "Best model for the task" },
      { id: "openrouter/optimus", name: "Optimus", description: "OpenRouter's pick" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral Large, Medium, and Small",
    icon: "mistral",
    apiKeyPlaceholder: "...",
    models: [
      { id: "mistral-large", name: "Mistral Large", description: "Most capable" },
      { id: "mistral-medium", name: "Mistral Medium", description: "Balanced" },
      { id: "mistral-small", name: "Mistral Small", description: "Fast" },
      { id: "codestral", name: "Codestral", description: "Code generation" },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    description: "Ultra-fast wafer-scale inference",
    icon: "cerebras",
    apiKeyPlaceholder: "csk-...",
    models: [
      { id: "llama-3.3-70b-cerebras", name: "Llama 3.3 70B", description: "Fast inference" },
      { id: "llama-3.1-8b-cerebras", name: "Llama 3.1 8B", description: "Ultra-fast" },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    description: "Command R and enterprise models",
    icon: "cohere",
    apiKeyPlaceholder: "...",
    models: [
      { id: "command-r-plus", name: "Command R+", description: "Most capable" },
      { id: "command-r", name: "Command R", description: "Fast and efficient" },
      { id: "command-light", name: "Command Light", description: "Lightweight" },
    ],
  },
  {
    id: "custom",
    name: "Custom",
    description: "Connect any OpenAI-compatible API",
    icon: "custom",
    supportsBaseUrl: true,
    apiKeyPlaceholder: "...",
    models: [],
  },
];

export const INITIAL_CONNECTED_PROVIDERS: ConnectedProvider[] = [
  {
    id: "conn-openai",
    providerId: "openai",
    displayName: "OpenAI",
    apiKey: "sk-••••••••••••••••••••••••",
    enabledModels: ["gpt-4o", "gpt-4o-mini", "o1"],
    isDefault: true,
  },
  {
    id: "conn-anthropic",
    providerId: "anthropic",
    displayName: "Anthropic",
    apiKey: "sk-ant-••••••••••••••••••••",
    enabledModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    isDefault: false,
  },
];

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member" | "viewer";
  avatar?: string;
  customInstructions: string;
  theme: "auto" | "light" | "dark";
  defaultPreset: string;
  defaultRounds: number;
  maxAgents: number;
  connectedAccounts: {
    github: boolean;
    google: boolean;
  };
}

export const mockUser: User = {
  id: "user-1",
  name: "Alex Johnson",
  email: "alex.johnson@example.com",
  role: "admin",
  customInstructions:
    "I prefer concise, technical responses. When discussing code, always include examples. Focus on TypeScript and React patterns. Avoid unnecessary pleasantries and get straight to the point. When presenting multiple options, use a numbered list with pros/cons for each.",
  theme: "dark",
  defaultPreset: "technical",
  defaultRounds: 3,
  maxAgents: 5,
  connectedAccounts: {
    github: true,
    google: false,
  },
};

// --- Conversations ---

export const mockConversations = [
  {
    id: "conv_1",
    title: "API Architecture Review",
    updatedAt: "2026-04-22T14:30:00Z",
    messageCount: 24,
    mode: "auto" as const,
    projectId: "proj_1",
  },
  {
    id: "conv_2",
    title: "Database Schema Optimization",
    updatedAt: "2026-04-22T12:15:00Z",
    messageCount: 18,
    mode: "manual" as const,
    projectId: "proj_1",
  },
  {
    id: "conv_3",
    title: "Security Audit Discussion",
    updatedAt: "2026-04-21T16:45:00Z",
    messageCount: 32,
    mode: "auto" as const,
    projectId: null,
  },
  {
    id: "conv_4",
    title: "Frontend Component Strategy",
    updatedAt: "2026-04-21T09:20:00Z",
    messageCount: 15,
    mode: "direct" as const,
    projectId: null,
  },
  {
    id: "conv_5",
    title: "ML Pipeline Design",
    updatedAt: "2026-04-20T17:00:00Z",
    messageCount: 41,
    mode: "auto" as const,
    projectId: null,
  },
  {
    id: "conv_6",
    title: "Infrastructure Cost Analysis",
    updatedAt: "2026-04-20T11:30:00Z",
    messageCount: 12,
    mode: "manual" as const,
    projectId: "proj_2",
  },
  {
    id: "conv_7",
    title: "OAuth2 Implementation Plan",
    updatedAt: "2026-04-19T15:45:00Z",
    messageCount: 28,
    mode: "auto" as const,
    projectId: null,
  },
  {
    id: "conv_8",
    title: "Performance Benchmarking Results",
    updatedAt: "2026-04-19T09:00:00Z",
    messageCount: 19,
    mode: "direct" as const,
    projectId: "proj_1",
  },
  {
    id: "conv_9",
    title: "Data Migration Strategy",
    updatedAt: "2026-04-18T14:20:00Z",
    messageCount: 35,
    mode: "auto" as const,
    projectId: "proj_2",
  },
  {
    id: "conv_10",
    title: "CI/CD Pipeline Optimization",
    updatedAt: "2026-04-18T08:15:00Z",
    messageCount: 22,
    mode: "manual" as const,
    projectId: null,
  },
  {
    id: "conv_11",
    title: "Microservices Communication Patterns",
    updatedAt: "2026-04-17T16:30:00Z",
    messageCount: 47,
    mode: "auto" as const,
    projectId: "proj_1",
  },
  {
    id: "conv_12",
    title: "Error Handling Best Practices",
    updatedAt: "2026-04-17T10:00:00Z",
    messageCount: 14,
    mode: "direct" as const,
    projectId: null,
  },
];

// --- Workflows ---

export const mockWorkflows = [
  {
    id: "wf_1",
    name: "Code Review Pipeline",
    description: "Automated code review with multiple archetypes analyzing PRs",
    status: "active" as const,
    steps: 4,
    lastRun: "2026-04-22T13:00:00Z",
    runs: 42,
    archetypes: ["architect", "pragmatist", "contrarian"],
  },
  {
    id: "wf_2",
    name: "Research Synthesis",
    description: "Multi-perspective research analysis and summary generation",
    status: "active" as const,
    steps: 6,
    lastRun: "2026-04-21T18:30:00Z",
    runs: 28,
    archetypes: ["empiricist", "historian", "futurist"],
  },
  {
    id: "wf_3",
    name: "Decision Framework",
    description: "Structured decision-making with diverse viewpoints",
    status: "paused" as const,
    steps: 5,
    lastRun: "2026-04-20T09:00:00Z",
    runs: 15,
    archetypes: ["strategist", "ethicist", "judge"],
  },
  {
    id: "wf_4",
    name: "Content Generation",
    description: "Creative content pipeline with editing and refinement",
    status: "active" as const,
    steps: 3,
    lastRun: "2026-04-22T10:45:00Z",
    runs: 63,
    archetypes: ["creator", "minimalist"],
  },
  {
    id: "wf_5",
    name: "Security Assessment",
    description: "Automated security review combining technical and ethical analysis",
    status: "draft" as const,
    steps: 7,
    lastRun: null,
    runs: 0,
    archetypes: ["architect", "contrarian", "ethicist", "judge"],
  },
  {
    id: "wf_6",
    name: "User Feedback Analysis",
    description: "Process user feedback through empathetic and data-driven lenses",
    status: "active" as const,
    steps: 4,
    lastRun: "2026-04-21T14:15:00Z",
    runs: 31,
    archetypes: ["empath", "empiricist", "pragmatist"],
  },
];

// --- Knowledge Bases ---

export const mockKnowledgeBases = [
  {
    id: "kb_1",
    name: "Engineering Standards",
    description: "Company coding standards, architecture decisions, and best practices",
    documentCount: 47,
    totalSize: "12.4 MB",
    lastUpdated: "2026-04-22T08:00:00Z",
    status: "indexed" as const,
  },
  {
    id: "kb_2",
    name: "Product Documentation",
    description: "Product specs, user guides, and release notes",
    documentCount: 128,
    totalSize: "34.7 MB",
    lastUpdated: "2026-04-21T16:00:00Z",
    status: "indexed" as const,
  },
  {
    id: "kb_3",
    name: "Research Papers",
    description: "AI/ML research papers and technical references",
    documentCount: 83,
    totalSize: "156.2 MB",
    lastUpdated: "2026-04-20T12:00:00Z",
    status: "indexed" as const,
  },
  {
    id: "kb_4",
    name: "Compliance Policies",
    description: "Legal, compliance, and regulatory documentation",
    documentCount: 24,
    totalSize: "8.1 MB",
    lastUpdated: "2026-04-15T10:00:00Z",
    status: "indexing" as const,
  },
];

// --- Marketplace ---

export const mockMarketplace = [
  {
    id: "mp_1",
    name: "Advanced Code Reviewer",
    author: "Nexus-labs",
    description: "Multi-archetype code review workflow with security and performance analysis",
    category: "development" as const,
    downloads: 1247,
    rating: 4.8,
    tags: ["code-review", "security", "performance"],
    price: "free" as const,
  },
  {
    id: "mp_2",
    name: "Legal Document Analyzer",
    author: "legaltech-co",
    description: "Contract analysis using ethicist and judge archetypes",
    category: "legal" as const,
    downloads: 834,
    rating: 4.6,
    tags: ["legal", "contracts", "compliance"],
    price: "premium" as const,
  },
  {
    id: "mp_3",
    name: "Market Research Suite",
    author: "bizinsights",
    description: "Comprehensive market analysis with futurist and empiricist perspectives",
    category: "research" as const,
    downloads: 2103,
    rating: 4.9,
    tags: ["market-research", "analysis", "trends"],
    price: "free" as const,
  },
  {
    id: "mp_4",
    name: "Creative Writing Workshop",
    author: "wordcraft-ai",
    description: "Multi-perspective creative writing with iterative refinement",
    category: "creative" as const,
    downloads: 567,
    rating: 4.3,
    tags: ["writing", "creative", "storytelling"],
    price: "free" as const,
  },
  {
    id: "mp_5",
    name: "Technical Architecture Planner",
    author: "Nexus-labs",
    description: "System design workflow with architect and strategist archetypes",
    category: "development" as const,
    downloads: 1892,
    rating: 4.7,
    tags: ["architecture", "system-design", "planning"],
    price: "premium" as const,
  },
  {
    id: "mp_6",
    name: "Stakeholder Communication Kit",
    author: "comms-pro",
    description: "Generate stakeholder reports with empath and pragmatist lenses",
    category: "business" as const,
    downloads: 421,
    rating: 4.4,
    tags: ["communication", "stakeholders", "reports"],
    price: "free" as const,
  },
];

// --- Archetypes ---

export const mockArchetypes = [
  {
    id: "architect",
    name: "The Architect",
    thinkingStyle: "Systems thinking",
    icon: "building-2",
    color: "#3B82F6",
    description: "Analyzes complex systems and identifies structural patterns",
  },
  {
    id: "contrarian",
    name: "The Contrarian",
    thinkingStyle: "Devil's advocate",
    icon: "shield-alert",
    color: "#EF4444",
    description: "Challenges assumptions and presents opposing viewpoints",
  },
  {
    id: "empiricist",
    name: "The Empiricist",
    thinkingStyle: "Data-driven",
    icon: "bar-chart-3",
    color: "#10B981",
    description: "Grounds decisions in evidence and measurable outcomes",
  },
  {
    id: "ethicist",
    name: "The Ethicist",
    thinkingStyle: "Values-driven",
    icon: "heart",
    color: "#8B5CF6",
    description: "Evaluates moral and ethical implications",
  },
  {
    id: "futurist",
    name: "The Futurist",
    thinkingStyle: "Long-term effects",
    icon: "telescope",
    color: "#06B6D4",
    description: "Considers long-term trends and future implications",
  },
  {
    id: "pragmatist",
    name: "The Pragmatist",
    thinkingStyle: "Action-oriented",
    icon: "target",
    color: "#F59E0B",
    description: "Focuses on practical, implementable solutions",
  },
  {
    id: "historian",
    name: "The Historian",
    thinkingStyle: "Pattern recognition",
    icon: "book-open",
    color: "#D97706",
    description: "Draws lessons from historical precedents",
  },
  {
    id: "empath",
    name: "The Empath",
    thinkingStyle: "Human-centered",
    icon: "users",
    color: "#EC4899",
    description: "Centers human experience and emotional intelligence",
  },
  {
    id: "outsider",
    name: "The Outsider",
    thinkingStyle: "Cross-domain",
    icon: "compass",
    color: "#14B8A6",
    description: "Brings unexpected perspectives from other fields",
  },
  {
    id: "strategist",
    name: "The Strategist",
    thinkingStyle: "Game theory",
    icon: "swords",
    color: "#6366F1",
    description: "Applies strategic thinking and competitive analysis",
  },
  {
    id: "minimalist",
    name: "The Minimalist",
    thinkingStyle: "Simplification",
    icon: "minimize-2",
    color: "#64748B",
    description: "Reduces complexity to essential elements",
  },
  {
    id: "creator",
    name: "The Creator",
    thinkingStyle: "Divergent thinking",
    icon: "lightbulb",
    color: "#F97316",
    description: "Generates novel ideas and creative solutions",
  },
  {
    id: "judge",
    name: "The Judge",
    thinkingStyle: "Risk mitigation",
    icon: "scale",
    color: "#78716C",
    description: "Weighs evidence and assesses risks objectively",
  },
];

// --- Analytics ---

function generateDailyUsage() {
  const data = [];
  const now = new Date("2026-04-22T00:00:00Z");
  for (let i = 29; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const conversations = Math.floor(Math.random() * 40) + 15;
    const tokens = Math.floor(Math.random() * 150000) + 50000;
    const cost = parseFloat((tokens * 0.000018).toFixed(2));
    data.push({
      date: date.toISOString().split("T")[0],
      conversations,
      tokens,
      cost,
    });
  }
  return data;
}

export const mockAnalytics = {
  totalConversations: 847,
  totalMessages: 12453,
  activeProviders: 2,
  knowledgeBases: 3,
  workflowRuns: 156,
  tokensUsed: 2847562,
  costThisMonth: 47.83,
  dailyUsage: generateDailyUsage(),
};

// --- Admin Users ---

export const mockUsers = [
  {
    id: "usr_demo123",
    username: "admin",
    email: "admin@Nexus.dev",
    role: "admin" as const,
    status: "active" as const,
    lastActive: "2026-04-22T14:30:00Z",
    conversationCount: 312,
    createdAt: "2024-01-15T10:00:00Z",
  },
  {
    id: "usr_002",
    username: "sarah.chen",
    email: "sarah.chen@Nexus.dev",
    role: "editor" as const,
    status: "active" as const,
    lastActive: "2026-04-22T12:00:00Z",
    conversationCount: 187,
    createdAt: "2024-03-20T08:00:00Z",
  },
  {
    id: "usr_003",
    username: "marcus.johnson",
    email: "marcus.j@Nexus.dev",
    role: "viewer" as const,
    status: "active" as const,
    lastActive: "2026-04-21T16:45:00Z",
    conversationCount: 94,
    createdAt: "2024-05-10T14:00:00Z",
  },
  {
    id: "usr_004",
    username: "elena.rodriguez",
    email: "elena.r@Nexus.dev",
    role: "editor" as const,
    status: "active" as const,
    lastActive: "2026-04-22T09:30:00Z",
    conversationCount: 245,
    createdAt: "2024-02-28T11:00:00Z",
  },
  {
    id: "usr_005",
    username: "james.park",
    email: "james.park@Nexus.dev",
    role: "admin" as const,
    status: "active" as const,
    lastActive: "2026-04-20T17:00:00Z",
    conversationCount: 156,
    createdAt: "2024-01-15T10:00:00Z",
  },
  {
    id: "usr_006",
    username: "priya.sharma",
    email: "priya.s@Nexus.dev",
    role: "viewer" as const,
    status: "inactive" as const,
    lastActive: "2026-04-10T08:00:00Z",
    conversationCount: 43,
    createdAt: "2024-07-01T09:00:00Z",
  },
  {
    id: "usr_007",
    username: "david.kim",
    email: "david.kim@Nexus.dev",
    role: "editor" as const,
    status: "active" as const,
    lastActive: "2026-04-22T11:15:00Z",
    conversationCount: 198,
    createdAt: "2024-04-15T13:00:00Z",
  },
  {
    id: "usr_008",
    username: "lisa.wang",
    email: "lisa.wang@Nexus.dev",
    role: "viewer" as const,
    status: "suspended" as const,
    lastActive: "2026-03-28T10:00:00Z",
    conversationCount: 12,
    createdAt: "2024-08-20T15:00:00Z",
  },
  {
    id: "usr_009",
    username: "alex.thompson",
    email: "alex.t@Nexus.dev",
    role: "editor" as const,
    status: "active" as const,
    lastActive: "2026-04-21T14:20:00Z",
    conversationCount: 167,
    createdAt: "2024-06-05T10:00:00Z",
  },
  {
    id: "usr_010",
    username: "nina.patel",
    email: "nina.p@Nexus.dev",
    role: "viewer" as const,
    status: "active" as const,
    lastActive: "2026-04-22T08:45:00Z",
    conversationCount: 78,
    createdAt: "2024-09-12T11:00:00Z",
  },
];

// --- Audit Log ---

export const mockAuditLog = [
  {
    id: "audit_1",
    userId: "usr_demo123",
    username: "admin",
    action: "provider.connect",
    details: "Connected OpenAI provider",
    timestamp: "2026-04-22T14:30:00Z",
    ip: "192.168.1.100",
  },
  {
    id: "audit_2",
    userId: "usr_002",
    username: "sarah.chen",
    action: "conversation.create",
    details: "Created conversation: API Architecture Review",
    timestamp: "2026-04-22T12:15:00Z",
    ip: "192.168.1.101",
  },
  {
    id: "audit_3",
    userId: "usr_demo123",
    username: "admin",
    action: "workflow.run",
    details: "Executed workflow: Code Review Pipeline",
    timestamp: "2026-04-22T10:45:00Z",
    ip: "192.168.1.100",
  },
  {
    id: "audit_4",
    userId: "usr_005",
    username: "james.park",
    action: "user.update",
    details: "Updated user role for priya.sharma to viewer",
    timestamp: "2026-04-21T16:00:00Z",
    ip: "192.168.1.105",
  },
  {
    id: "audit_5",
    userId: "usr_004",
    username: "elena.rodriguez",
    action: "knowledge.upload",
    details: "Uploaded 12 documents to Engineering Standards",
    timestamp: "2026-04-21T14:30:00Z",
    ip: "192.168.1.104",
  },
  {
    id: "audit_6",
    userId: "usr_demo123",
    username: "admin",
    action: "system.config",
    details: "Updated system configuration: rate limiting enabled",
    timestamp: "2026-04-21T09:00:00Z",
    ip: "192.168.1.100",
  },
  {
    id: "audit_7",
    userId: "usr_007",
    username: "david.kim",
    action: "conversation.delete",
    details: "Deleted conversation: Test Conversation",
    timestamp: "2026-04-20T17:30:00Z",
    ip: "192.168.1.107",
  },
  {
    id: "audit_8",
    userId: "usr_demo123",
    username: "admin",
    action: "provider.disconnect",
    details: "Disconnected Groq provider",
    timestamp: "2026-04-20T11:00:00Z",
    ip: "192.168.1.100",
  },
];

// --- Prompts ---

export const mockPrompts = [
  {
    id: "prompt_1",
    name: "Technical Analysis",
    content:
      "Analyze the following technical problem from multiple perspectives. Consider architecture, performance, security, and maintainability.",
    category: "analysis" as const,
    isDefault: true,
    createdAt: "2024-06-15T10:00:00Z",
    updatedAt: "2026-04-20T08:00:00Z",
    usageCount: 234,
  },
  {
    id: "prompt_2",
    name: "Code Review Checklist",
    content:
      "Review this code for: 1) Correctness 2) Performance 3) Security vulnerabilities 4) Code style 5) Test coverage. Provide specific suggestions for each area.",
    category: "development" as const,
    isDefault: false,
    createdAt: "2024-08-20T14:00:00Z",
    updatedAt: "2026-04-18T12:00:00Z",
    usageCount: 189,
  },
  {
    id: "prompt_3",
    name: "Strategic Decision Matrix",
    content:
      "Evaluate this decision using a weighted matrix. Consider: impact, feasibility, risk, cost, and alignment with goals. Rate each factor 1-5.",
    category: "business" as const,
    isDefault: false,
    createdAt: "2024-09-01T09:00:00Z",
    updatedAt: "2026-04-15T16:00:00Z",
    usageCount: 67,
  },
  {
    id: "prompt_4",
    name: "Ethical Impact Assessment",
    content:
      "Assess the ethical implications of this proposal. Consider stakeholder impact, fairness, transparency, privacy, and long-term societal effects.",
    category: "analysis" as const,
    isDefault: false,
    createdAt: "2024-10-10T11:00:00Z",
    updatedAt: "2026-04-12T10:00:00Z",
    usageCount: 45,
  },
  {
    id: "prompt_5",
    name: "Creative Brainstorm",
    content:
      "Generate 10 creative solutions for this challenge. Think outside the box. Consider cross-domain inspiration and unconventional approaches.",
    category: "creative" as const,
    isDefault: false,
    createdAt: "2024-11-05T13:00:00Z",
    updatedAt: "2026-04-10T14:00:00Z",
    usageCount: 112,
  },
];

// --- Memory ---

export const mockMemoryEntries = [
  {
    id: "mem_1",
    content: "User prefers TypeScript over JavaScript for all new projects",
    source: "conversation",
    sourceId: "conv_1",
    createdAt: "2026-04-15T10:00:00Z",
    tags: ["preferences", "development"],
  },
  {
    id: "mem_2",
    content: "Team uses PostgreSQL as primary database with Redis for caching",
    source: "conversation",
    sourceId: "conv_2",
    createdAt: "2026-04-14T14:00:00Z",
    tags: ["infrastructure", "database"],
  },
  {
    id: "mem_3",
    content: "Deployment pipeline uses GitHub Actions with staging and production environments",
    source: "knowledge-base",
    sourceId: "kb_1",
    createdAt: "2026-04-12T09:00:00Z",
    tags: ["ci-cd", "infrastructure"],
  },
  {
    id: "mem_4",
    content: "Company follows SOC 2 Type II compliance requirements",
    source: "conversation",
    sourceId: "conv_3",
    createdAt: "2026-04-10T16:00:00Z",
    tags: ["compliance", "security"],
  },
  {
    id: "mem_5",
    content: "API rate limiting is set to 100 requests per minute per user",
    source: "knowledge-base",
    sourceId: "kb_1",
    createdAt: "2026-04-08T11:00:00Z",
    tags: ["api", "configuration"],
  },
];
