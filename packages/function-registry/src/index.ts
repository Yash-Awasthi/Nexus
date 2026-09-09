// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/function-registry — Versioned function registry with dependency tracking.
 *
 * Inspired by BabyAGI's functionz framework.
 * Store, version, and execute functions with dependency resolution,
 * import tracking, and automatic loading.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface FunctionEntry {
  name: string;
  version: number;
  code: string;
  description: string;
  imports: string[];
  dependencies: string[]; // other functions this depends on
  args: string[];
  return_type?: string;
  active: boolean;
  created_at: number;
  updated_at: number;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface FunctionVersion {
  version: number;
  entry: FunctionEntry;
}

export interface ExecutionResult {
  functionName: string;
  version: number;
  result: unknown;
  durationMs: number;
  timestamp: number;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export class FunctionRegistry {
  private functions: Map<string, FunctionVersion[]> = new Map();
  private activeVersions: Map<string, number> = new Map();
  private executionLog: ExecutionResult[] = [];

  /**
   * Register a new function.
   */
  register(config: {
    name: string;
    code: string;
    description?: string;
    imports?: string[];
    dependencies?: string[];
    args?: string[];
    return_type?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): FunctionEntry {
    const versions = this.functions.get(config.name) ?? [];
    const nextVersion = versions.length + 1;

    const entry: FunctionEntry = {
      name: config.name,
      version: nextVersion,
      code: config.code,
      description: config.description ?? "",
      imports: config.imports ?? [],
      dependencies: config.dependencies ?? [],
      args: config.args ?? [],
      return_type: config.return_type,
      active: true,
      created_at: Date.now(),
      updated_at: Date.now(),
      tags: config.tags ?? [],
      metadata: config.metadata,
    };

    versions.push({ version: nextVersion, entry });
    this.functions.set(config.name, versions);
    this.activeVersions.set(config.name, nextVersion);

    return entry;
  }

  /**
   * Update a function (creates new version).
   */
  update(
    name: string,
    updates: Partial<Omit<FunctionEntry, "name" | "version" | "created_at">>,
  ): FunctionEntry | null {
    const versions = this.functions.get(name);
    if (!versions || versions.length === 0) return null;

    const latest = versions[versions.length - 1]!;
    const nextVersion = latest.version + 1;

    const entry: FunctionEntry = {
      ...latest.entry,
      ...updates,
      version: nextVersion,
      updated_at: Date.now(),
    };

    versions.push({ version: nextVersion, entry });
    this.activeVersions.set(name, nextVersion);

    return entry;
  }

  /**
   * Get a function by name (returns active version).
   */
  get(name: string): FunctionEntry | null {
    const versions = this.functions.get(name);
    if (!versions || versions.length === 0) return null;

    const activeVersion = this.activeVersions.get(name) ?? versions.length;
    const version = versions.find((v) => v.version === activeVersion);
    return version?.entry ?? null;
  }

  /**
   * Get a specific version of a function.
   */
  getVersion(name: string, version: number): FunctionEntry | null {
    const versions = this.functions.get(name);
    if (!versions) return null;
    const v = versions.find((ver) => ver.version === version);
    return v?.entry ?? null;
  }

  /**
   * Get all versions of a function.
   */
  getVersions(name: string): FunctionVersion[] {
    return this.functions.get(name) ?? [];
  }

  /**
   * Activate a specific version.
   */
  activateVersion(name: string, version: number): boolean {
    const versions = this.functions.get(name);
    if (!versions) return false;
    const exists = versions.find((v) => v.version === version);
    if (!exists) return false;
    this.activeVersions.set(name, version);
    return true;
  }

  /**
   * Get all functions.
   */
  list(): FunctionEntry[] {
    const result: FunctionEntry[] = [];
    for (const [name] of this.functions) {
      const entry = this.get(name);
      if (entry) result.push(entry);
    }
    return result;
  }

  /**
   * Search functions by tag or description.
   */
  search(query: string): FunctionEntry[] {
    const lower = query.toLowerCase();
    return this.list().filter(
      (f) =>
        f.name.toLowerCase().includes(lower) ||
        f.description.toLowerCase().includes(lower) ||
        f.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  /**
   * Get dependency graph for a function.
   */
  getDependencyGraph(name: string, visited: Set<string> = new Set()): string[] {
    if (visited.has(name)) return [`${name} (circular!)`];
    visited.add(name);

    const entry = this.get(name);
    if (!entry) return [];

    const deps: string[] = [name];
    for (const dep of entry.dependencies) {
      deps.push(...this.getDependencyGraph(dep, visited));
    }
    return deps;
  }

  /**
   * Check if a function's dependencies are satisfied.
   */
  checkDependencies(name: string): { satisfied: boolean; missing: string[] } {
    const entry = this.get(name);
    if (!entry) return { satisfied: false, missing: [name] };

    const missing: string[] = [];
    for (const dep of entry.dependencies) {
      if (!this.get(dep)) {
        missing.push(dep);
      }
    }

    return { satisfied: missing.length === 0, missing };
  }

  /**
   * Record an execution result.
   */
  recordExecution(result: ExecutionResult): void {
    this.executionLog.push(result);
    if (this.executionLog.length > 1000) {
      this.executionLog = this.executionLog.slice(-1000);
    }
  }

  /**
   * Get execution history for a function.
   */
  getExecutionHistory(name: string): ExecutionResult[] {
    return this.executionLog.filter((r) => r.functionName === name);
  }

  /**
   * Delete a function and all its versions.
   */
  delete(name: string): boolean {
    const existed = this.functions.delete(name);
    this.activeVersions.delete(name);
    return existed;
  }

  /**
   * Export all functions as JSON.
   */
  export(): FunctionEntry[] {
    return this.list();
  }

  /**
   * Import functions from JSON.
   */
  import(entries: FunctionEntry[]): number {
    let count = 0;
    for (const entry of entries) {
      this.register({
        name: entry.name,
        code: entry.code,
        description: entry.description,
        imports: entry.imports,
        dependencies: entry.dependencies,
        args: entry.args,
        return_type: entry.return_type,
        tags: entry.tags,
        metadata: entry.metadata,
      });
      count++;
    }
    return count;
  }
}

export default FunctionRegistry;
