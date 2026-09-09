// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/memory-scoring — PBWM-inspired memory retrieval scoring.
 *
 * Inspired by contexto's scoring system.
 * Uses a Prefrontal Basal Ganglia Working Memory (PBWM) inspired gate
 * to score and filter memory retrievals based on relevance, expected value,
 * and controlled noise.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type SectorName = "episodic" | "semantic" | "procedural";

export interface MemoryRecord {
  id: string;
  agentId: string;
  sector: SectorName;
  content: string;
  similarity: number;
  retrievalCount: number;
  createdAt: number;
  lastAccessed: number;
  metadata?: Record<string, unknown>;
}

export interface ScoredMemory {
  id: string;
  agentId: string;
  sector: SectorName;
  content: string;
  score: number;
  similarity: number;
  gateScore: number;
  decay: number;
  createdAt: number;
  lastAccessed: number;
}

// ── Scoring Functions ────────────────────────────────────────────────────────

function gaussianNoise(mean: number, stdDev: number): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z0 * stdDev + mean;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function normalizeRetrieval(count: number, softCap: number = 10): number {
  if (count <= 0) return 0;
  return Math.min(1, Math.log(1 + count) / Math.log(1 + softCap));
}

// ── PBWM Scoring ─────────────────────────────────────────────────────────────

const DEFAULT_SECTOR_WEIGHTS: Record<SectorName, number> = {
  episodic: 1,
  semantic: 1,
  procedural: 1,
};

const DEFAULT_WEIGHTS = {
  relevance: 1.0,
  expectedValue: 0.4,
  control: 0.05,
  noise: 0.02,
  controlSignal: 0.3,
};

/**
 * Score a memory record using PBWM-inspired gating.
 */
export function scoreMemory(
  record: MemoryRecord,
  options?: {
    sectorWeights?: Record<SectorName, number>;
    weights?: typeof DEFAULT_WEIGHTS;
  },
): ScoredMemory {
  const sectorWeights = options?.sectorWeights ?? DEFAULT_SECTOR_WEIGHTS;
  const weights = options?.weights ?? DEFAULT_WEIGHTS;

  const relevance = record.similarity;
  const expectedValue = normalizeRetrieval(record.retrievalCount);
  const noise = gaussianNoise(0, 0.05);

  const x =
    weights.relevance * relevance +
    weights.expectedValue * expectedValue +
    weights.control * weights.controlSignal -
    weights.noise * noise;

  const gateScore = sigmoid(x);
  const sectorWeight = sectorWeights[record.sector] ?? 1;
  const score = gateScore * sectorWeight;

  return {
    id: record.id,
    agentId: record.agentId,
    sector: record.sector,
    content: record.content,
    score,
    similarity: record.similarity,
    gateScore,
    decay: computeDecay(record.lastAccessed),
    createdAt: record.createdAt,
    lastAccessed: record.lastAccessed,
  };
}

/**
 * Score and rank multiple memory records.
 */
export function scoreAndRank(
  records: MemoryRecord[],
  options?: {
    sectorWeights?: Record<SectorName, number>;
    weights?: typeof DEFAULT_WEIGHTS;
    limit?: number;
    minScore?: number;
  },
): ScoredMemory[] {
  const scored = records.map((r) => scoreMemory(r, options));
  scored.sort((a, b) => b.score - a.score);

  let result = scored;
  if (options?.minScore !== undefined) {
    result = result.filter((s) => s.score >= options.minScore!);
  }
  if (options?.limit !== undefined) {
    result = result.slice(0, options.limit);
  }

  return result;
}

/**
 * Compute time-based decay for a memory.
 */
function computeDecay(lastAccessed: number, halfLifeDays: number = 30): number {
  const ageMs = Date.now() - lastAccessed;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Get sector distribution of scored memories.
 */
export function getSectorDistribution(
  scored: ScoredMemory[],
): Record<SectorName, { count: number; avgScore: number }> {
  const dist: Record<SectorName, { count: number; totalScore: number }> = {
    episodic: { count: 0, totalScore: 0 },
    semantic: { count: 0, totalScore: 0 },
    procedural: { count: 0, totalScore: 0 },
  };

  for (const s of scored) {
    dist[s.sector].count++;
    dist[s.sector].totalScore += s.score;
  }

  return {
    episodic: {
      count: dist.episodic.count,
      avgScore: dist.episodic.count > 0 ? dist.episodic.totalScore / dist.episodic.count : 0,
    },
    semantic: {
      count: dist.semantic.count,
      avgScore: dist.semantic.count > 0 ? dist.semantic.totalScore / dist.semantic.count : 0,
    },
    procedural: {
      count: dist.procedural.count,
      avgScore: dist.procedural.count > 0 ? dist.procedural.totalScore / dist.procedural.count : 0,
    },
  };
}

export default scoreMemory;
