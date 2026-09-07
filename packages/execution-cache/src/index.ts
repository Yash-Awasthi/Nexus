// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/execution-cache — Execution cache with artifact verification.
 *
 * Inspired by hypha's ArtifactManagerExecutionCacheVerifier.
 * Caches agent execution results with integrity verification,
 * TTL-based expiration, and content-addressed storage.
 */

import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CachedArtifact {
  id: string;
  contentHash: string;
  data: unknown;
  createdAt: number;
  expiresAt?: number;
  scope: string;
  version: number;
}

export interface CacheEntry {
  key: string;
  artifact: CachedArtifact;
  hitCount: number;
  lastAccessedAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number;
}

export interface CacheVerifyResult {
  valid: boolean;
  reason?: string;
  artifactId?: string;
}

// ── Execution Cache ──────────────────────────────────────────────────────────

export class ExecutionCache {
  private store: Map<string, CacheEntry> = new Map();
  private maxSize: number;
  private defaultTtlMs?: number;
  private stats = { hits: 0, misses: 0, evictions: 0 };

  constructor(options?: { maxSize?: number; defaultTtlMs?: number }) {
    this.maxSize = options?.maxSize ?? 10_000;
    this.defaultTtlMs = options?.defaultTtlMs;
  }

  /**
   * Store an artifact in the cache.
   */
  set(
    key: string,
    data: unknown,
    options?: { ttlMs?: number; scope?: string },
  ): CachedArtifact {
    const contentHash = this.computeHash(data);
    const now = Date.now();

    const artifact: CachedArtifact = {
      id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      contentHash,
      data,
      createdAt: now,
      expiresAt: options?.ttlMs ? now + options.ttlMs : this.defaultTtlMs ? now + this.defaultTtlMs : undefined,
      scope: options?.scope ?? "default",
      version: 1,
    };

    const existing = this.store.get(key);
    const version = existing ? existing.artifact.version + 1 : 1;
    artifact.version = version;

    this.store.set(key, {
      key,
      artifact,
      hitCount: 0,
      lastAccessedAt: now,
    });

    // Evict if over capacity
    this.evictIfNeeded();

    return artifact;
  }

  /**
   * Retrieve an artifact from the cache.
   */
  get(key: string): { artifact: CachedArtifact; data: unknown } | null {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check expiration
    if (entry.artifact.expiresAt && Date.now() > entry.artifact.expiresAt) {
      this.store.delete(key);
      this.stats.misses++;
      return null;
    }

    entry.hitCount++;
    entry.lastAccessedAt = Date.now();
    this.stats.hits++;

    return { artifact: entry.artifact, data: entry.artifact.data };
  }

  /**
   * Verify a cached artifact's integrity.
   */
  verify(key: string): CacheVerifyResult {
    const entry = this.store.get(key);
    if (!entry) {
      return { valid: false, reason: "Artifact not found" };
    }

    // Check expiration
    if (entry.artifact.expiresAt && Date.now() > entry.artifact.expiresAt) {
      return { valid: false, reason: "Artifact expired", artifactId: entry.artifact.id };
    }

    // Verify content hash
    const currentHash = this.computeHash(entry.artifact.data);
    if (currentHash !== entry.artifact.contentHash) {
      return { valid: false, reason: "Content hash mismatch", artifactId: entry.artifact.id };
    }

    return { valid: true, artifactId: entry.artifact.id };
  }

  /**
   * Invalidate a cached artifact.
   */
  invalidate(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Invalidate all artifacts in a scope.
   */
  invalidateScope(scope: string): number {
    let count = 0;
    for (const [key, entry] of this.store) {
      if (entry.artifact.scope === scope) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.store.size,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * Get all keys in the cache.
   */
  keys(): string[] {
    return Array.from(this.store.keys());
  }

  /**
   * Get cache entry count.
   */
  size(): number {
    return this.store.size;
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  private computeHash(data: unknown): string {
    const str = JSON.stringify(data);
    return createHash("sha256").update(str).digest("hex").slice(0, 16);
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxSize) {
      // Evict least recently accessed
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      for (const [key, entry] of this.store) {
        if (entry.lastAccessedAt < oldestTime) {
          oldestTime = entry.lastAccessedAt;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.store.delete(oldestKey);
        this.stats.evictions++;
      } else {
        break;
      }
    }
  }
}

export default ExecutionCache;
