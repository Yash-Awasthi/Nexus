// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/council-config — Hierarchical council configuration system.
 *
 * Inspired by gemini-llm-council's config and persona system.
 * Supports project-level and global-level config with Zod validation,
 * reasoning effort levels, and specialized persona definitions.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ModelConfig {
  id: string;
  name: string;
  features: {
    reasoning?: boolean;
    caching?: boolean;
  };
}

export interface CouncilConfig {
  defaultModels: string[];
  reasoningEffort: ReasoningEffort;
  maxTokens?: number;
  temperature?: number;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  focusAreas: string[];
  preferredModels?: string[];
}

export interface ConfigStatus {
  exists: boolean;
  scope: "project" | "global" | "none";
  configPath: string;
}

// ── Config Manager ───────────────────────────────────────────────────────────

const CONFIG_DIR = ".nexus";
const CONFIG_FILE = "council.json";
const GLOBAL_CONFIG_DIR = join(homedir(), ".nexus", "extensions", "council");

const DEFAULT_CONFIG: CouncilConfig = {
  defaultModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"],
  reasoningEffort: "medium",
  maxTokens: 4096,
  temperature: 0.7,
};

export class CouncilConfigManager {
  private projectConfigPath: string;
  private globalConfigPath: string;

  constructor(workDir?: string) {
    const dir = workDir ?? process.cwd();
    this.projectConfigPath = join(dir, CONFIG_DIR, CONFIG_FILE);
    this.globalConfigPath = join(GLOBAL_CONFIG_DIR, CONFIG_FILE);
  }

  /**
   * Load config with hierarchical resolution.
   * Project config overrides global config, which overrides defaults.
   */
  load(): CouncilConfig {
    const globalConfig = this.loadFromFile(this.globalConfigPath);
    const projectConfig = this.loadFromFile(this.projectConfigPath);

    return {
      ...DEFAULT_CONFIG,
      ...globalConfig,
      ...projectConfig,
    };
  }

  /**
   * Get config status (which level is active).
   */
  getStatus(): ConfigStatus {
    if (existsSync(this.projectConfigPath)) {
      return { exists: true, scope: "project", configPath: this.projectConfigPath };
    }
    if (existsSync(this.globalConfigPath)) {
      return { exists: true, scope: "global", configPath: this.globalConfigPath };
    }
    return { exists: false, scope: "none", configPath: "" };
  }

  /**
   * Save config at project level.
   */
  saveProject(config: Partial<CouncilConfig>): void {
    const dir = dirname(this.projectConfigPath);
    mkdirSync(dir, { recursive: true });

    const existing = this.loadFromFile(this.projectConfigPath);
    const merged = { ...DEFAULT_CONFIG, ...existing, ...config };

    writeFileSync(this.projectConfigPath, JSON.stringify(merged, null, 2));
  }

  /**
   * Save config at global level.
   */
  saveGlobal(config: Partial<CouncilConfig>): void {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });

    const existing = this.loadFromFile(this.globalConfigPath);
    const merged = { ...DEFAULT_CONFIG, ...existing, ...config };

    writeFileSync(this.globalConfigPath, JSON.stringify(merged, null, 2));
  }

  /**
   * Delete project config.
   */
  deleteProject(): boolean {
    if (existsSync(this.projectConfigPath)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(this.projectConfigPath);
      return true;
    }
    return false;
  }

  private loadFromFile(path: string): Partial<CouncilConfig> | null {
    try {
      if (!existsSync(path)) return null;
      const content = readFileSync(path, "utf-8");
      const parsed = JSON.parse(content);
      return this.normalizeConfig(parsed);
    } catch {
      return null;
    }
  }

  private normalizeConfig(raw: Record<string, unknown>): Partial<CouncilConfig> {
    return {
      defaultModels: Array.isArray(raw.defaultModels) ? raw.defaultModels : undefined,
      reasoningEffort: typeof raw.reasoningEffort === "string" ? raw.reasoningEffort as ReasoningEffort : undefined,
      maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : undefined,
      temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
    };
  }
}

// ── Persona Registry ─────────────────────────────────────────────────────────

const DEFAULT_PERSONAS: Persona[] = [
  {
    id: "security",
    name: "Security Analyst",
    description: "Focuses on vulnerabilities, attack vectors, and security best practices",
    systemPrompt: "You are a security analyst. Review the given code or architecture for vulnerabilities, attack vectors, and security best practices. Be specific about CVEs, OWASP Top 10, and common pitfalls.",
    focusAreas: ["vulnerabilities", "authentication", "authorization", "data protection"],
    preferredModels: ["anthropic/claude-sonnet-4-20250514"],
  },
  {
    id: "performance",
    name: "Performance Engineer",
    description: "Focuses on scalability, latency, and resource optimization",
    systemPrompt: "You are a performance engineer. Review the given code or architecture for scalability issues, latency bottlenecks, and resource optimization opportunities. Provide specific metrics and benchmarks.",
    focusAreas: ["scalability", "latency", "memory", "CPU", "caching"],
    preferredModels: ["openai/gpt-4o"],
  },
  {
    id: "architect",
    name: "Software Architect",
    description: "Focuses on design patterns, modularity, and maintainability",
    systemPrompt: "You are a software architect. Review the given code or architecture for design patterns, modularity, coupling, cohesion, and long-term maintainability. Consider separation of concerns and SOLID principles.",
    focusAreas: ["design patterns", "modularity", "coupling", "maintainability"],
  },
  {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Focuses on code quality, readability, and best practices",
    systemPrompt: "You are a senior code reviewer. Review the given code for readability, naming conventions, error handling, test coverage, and adherence to best practices. Be constructive and specific.",
    focusAreas: ["readability", "naming", "error handling", "testing"],
  },
];

export class PersonaRegistry {
  private personas: Map<string, Persona>;

  constructor(customPersonas?: Persona[]) {
    this.personas = new Map(DEFAULT_PERSONAS.map((p) => [p.id, p]));
    if (customPersonas) {
      for (const p of customPersonas) {
        this.personas.set(p.id, p);
      }
    }
  }

  get(id: string): Persona | undefined {
    return this.personas.get(id);
  }

  list(): Persona[] {
    return Array.from(this.personas.values());
  }

  register(persona: Persona): void {
    this.personas.set(persona.id, persona);
  }

  /**
   * Auto-detect the best persona for a query.
   */
  detectPersona(query: string): Persona | null {
    const lower = query.toLowerCase();
    let bestMatch: Persona | null = null;
    let bestScore = 0;

    for (const persona of this.personas.values()) {
      const score = persona.focusAreas.reduce((sum, area) => {
        return sum + (lower.includes(area.toLowerCase()) ? 1 : 0);
      }, 0);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = persona;
      }
    }

    return bestScore > 0 ? bestMatch : null;
  }
}

export default CouncilConfigManager;
