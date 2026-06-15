// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/tier-gate — Route-level feature gates by subscription tier.
 *
 * Architecture
 * ─────────────
 *   Tier                     — "free" | "pro" | "enterprise"
 *   TierGateDefinition       — maps a feature key to its minimum required tier
 *   TierGateRegistry         — register gates, check/assert access by tier
 *   TierGateError            — thrown (or replied) when access is denied
 *   makeTierGatePreHandler   — Fastify preHandler factory (reads x-nexus-tier header)
 *   globalTierGate           — default registry pre-seeded with platform gates
 *   platformGates            — canonical tier requirements for shipped features
 *
 * Tier ordering (ascending privilege):  free < pro < enterprise
 *
 * Usage
 * ─────
 * ```ts
 * import { globalTierGate, makeTierGatePreHandler } from "@nexus/tier-gate";
 *
 * // Declarative route gate
 * fastify.addHook("preHandler", makeTierGatePreHandler({ feature: "ultraplinian" }));
 *
 * // Programmatic check
 * if (globalTierGate.check("council", userTier)) { ... }
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type Tier = "free" | "pro" | "enterprise";

const TIER_ORDER: Record<Tier, number> = { free: 0, pro: 1, enterprise: 2 };

/** Tier gate definition interface definition. */
export interface TierGateDefinition {
  feature: string;
  requiredTier: Tier;
  description?: string;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class TierGateError extends Error {
  readonly code = "TIER_GATE_DENIED" as const;
  readonly feature: string;
  readonly requiredTier: Tier;
  readonly userTier: Tier;

  constructor(feature: string, requiredTier: Tier, userTier: Tier) {
    super(`Feature "${feature}" requires tier "${requiredTier}" (user has "${userTier}")`);
    this.name = "TierGateError";
    this.feature = feature;
    this.requiredTier = requiredTier;
    this.userTier = userTier;
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class TierGateRegistry {
  private readonly gates = new Map<string, TierGateDefinition>();

  /** Register a feature gate. Overwrites any existing definition for the same key. */
  register(def: TierGateDefinition): void {
    this.gates.set(def.feature, def);
  }

  /**
   * Returns true if userTier satisfies the requirement for feature.
   * Ungated (unregistered) features always return true.
   */
  check(feature: string, userTier: Tier): boolean {
    const gate = this.gates.get(feature);
    if (!gate) return true;
    return TIER_ORDER[userTier] >= TIER_ORDER[gate.requiredTier];
  }

  /** Like check() but throws TierGateError when access is denied. */
  assert(feature: string, userTier: Tier): void {
    const gate = this.gates.get(feature);
    if (!gate) return;
    if (TIER_ORDER[userTier] < TIER_ORDER[gate.requiredTier]) {
      throw new TierGateError(feature, gate.requiredTier, userTier);
    }
  }

  get(feature: string): TierGateDefinition | undefined {
    return this.gates.get(feature);
  }

  list(): TierGateDefinition[] {
    return [...this.gates.values()];
  }

  /** Return all gates accessible at the given tier (requiredTier <= userTier). */
  featuresForTier(tier: Tier): TierGateDefinition[] {
    return this.list().filter((g) => TIER_ORDER[tier] >= TIER_ORDER[g.requiredTier]);
  }
}

// ── Platform gates ────────────────────────────────────────────────────────────

export const platformGates: TierGateDefinition[] = [
  { feature: "ultraplinian", requiredTier: "pro", description: "Multi-model race mode" },
  { feature: "consortium", requiredTier: "pro", description: "Hive-mind synthesis" },
  { feature: "code-map", requiredTier: "pro", description: "AST codebase indexer" },
  {
    feature: "sandbox.docker",
    requiredTier: "pro",
    description: "Sandboxed Docker code execution",
  },
  { feature: "autotune", requiredTier: "pro", description: "Pre-generation parameter optimizer" },
  { feature: "best-of-n", requiredTier: "pro", description: "Multi-completion scoring" },
  { feature: "ragtime", requiredTier: "pro", description: "Memory-specific RAG retrieval" },
  { feature: "openclaw", requiredTier: "pro", description: "Conversation pattern analysis" },
  { feature: "multi-reviewer", requiredTier: "enterprise", description: "Multi-model code review" },
  {
    feature: "federated-search",
    requiredTier: "enterprise",
    description: "Cross-connector federated search",
  },
  { feature: "council", requiredTier: "enterprise", description: "AI safety council verdicts" },
];

/** Default registry pre-seeded with all platform gates. Import and use directly. */
export const globalTierGate = new TierGateRegistry();
for (const gate of platformGates) globalTierGate.register(gate);

// ── Fastify preHandler factory ────────────────────────────────────────────────

export interface TierGatePreHandlerOptions {
  /** Feature key to enforce. */
  feature: string;
  /** Use a custom registry instead of globalTierGate. */
  registry?: TierGateRegistry;
  /**
   * Override how to extract the user's tier from the Fastify request.
   * Default: reads `x-nexus-tier` header (valid values: "pro" | "enterprise",
   * anything else → "free").
   */
  getTier?: (req: unknown) => Tier;
}

/** Minimal Fastify reply surface needed by the preHandler. */
export interface TierGateReply {
  code(n: number): { send(body: unknown): void };
}

/**
 * Returns a Fastify preHandler that enforces the tier gate for one feature.
 * On denial, replies 403 with a structured JSON error payload and halts the chain.
 */
export function makeTierGatePreHandler(opts: TierGatePreHandlerOptions) {
  const registry = opts.registry ?? globalTierGate;

  const getTier =
    opts.getTier ??
    ((req: unknown): Tier => {
      const r = req as { headers?: Record<string, string | string[] | undefined> };
      const raw = r.headers?.["x-nexus-tier"];
      const val = Array.isArray(raw) ? raw[0] : raw;
      if (val === "pro" || val === "enterprise") return val;
      return "free";
    });

  return async function tierGatePreHandler(request: unknown, reply: TierGateReply): Promise<void> {
    const tier = getTier(request);
    try {
      registry.assert(opts.feature, tier);
    } catch (err) {
      if (err instanceof TierGateError) {
        reply.code(403).send({
          code: "TIER_GATE_DENIED",
          feature: err.feature,
          requiredTier: err.requiredTier,
          userTier: err.userTier,
          message: err.message,
        });
      } else {
        reply.code(500).send({ code: "INTERNAL_ERROR", message: "Tier check failed" });
      }
    }
  };
}
