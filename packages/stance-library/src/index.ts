/**
 * @nexus/stance-library — Anti-groupthink debate stances and role presets.
 *
 * Provides named stances (skeptic, advocate, pragmatist, neutral) that can
 * be assigned to models in multi-model debates to prevent groupthink and
 * ensure diverse perspectives.  Inspired by the Ensemble repo's stance system.
 *
 * Usage:
 *   const preset = createPreset("diverse", ["gpt4o", "claude", "deepseek"]);
 *   // → { gpt4o: SKEPTIC, claude: ADVOCATE, deepseek: PRAGMATIST }
 */

// ─── Stance Definitions ──────────────────────────────────────────────────────

export interface Stance {
  id: string;
  name: string;
  instruction: string;
  /** Whether this stance is adversarial by nature */
  adversarial: boolean;
}

export const SKEPTIC: Stance = {
  id: "skeptic",
  name: "Skeptic",
  instruction:
    "Take a skeptical, critical stance. Stress-test every claim, surface risks, " +
    "edge cases, and failure modes; accept nothing without justification. " +
    "Look for hidden assumptions, logical gaps, and unexamined risks.",
  adversarial: true,
};

export const ADVOCATE: Stance = {
  id: "advocate",
  name: "Advocate",
  instruction:
    "Take an optimistic, constructive stance. Build the strongest possible case " +
    "for the most promising approach. Highlight benefits, opportunities, and " +
    "potential upside while acknowledging limitations honestly.",
  adversarial: false,
};

export const PRAGMATIST: Stance = {
  id: "pragmatist",
  name: "Pragmatist",
  instruction:
    "Take a pragmatic stance. Favor what is simplest, most reliable, and shippable; " +
    "weigh cost, complexity, and maintenance. Focus on what actually works in " +
    "production, not theoretical ideals.",
  adversarial: false,
};

export const NEUTRAL: Stance = {
  id: "neutral",
  name: "Neutral",
  instruction:
    "Remain neutral and balanced; weigh all sides strictly on the merits. " +
    "Provide objective analysis without favoring any particular approach. " +
    "Evaluate evidence, not advocacy.",
  adversarial: false,
};

export const REDTEAM: Stance = {
  id: "redteam",
  name: "Red Team",
  instruction:
    "Take an adversarial red-team stance. Actively try to break, subvert, or " +
    "find critical flaws in every proposal. Assume the worst case and probe " +
    "for vulnerabilities, attack surfaces, and catastrophic failure modes.",
  adversarial: true,
};

export const BLUESKY: Stance = {
  id: "bluesky",
  name: "Blue Sky",
  instruction:
    "Take an imaginative, blue-sky stance. Explore the most ambitious and " +
    "creative possibilities. Challenge conventional thinking and propose " +
    "novel approaches that push boundaries.",
  adversarial: false,
};

/** All built-in stances */
export const STANCE_LIBRARY: Record<string, Stance> = {
  skeptic: SKEPTIC,
  advocate: ADVOCATE,
  pragmatist: PRAGMATIST,
  neutral: NEUTRAL,
  redteam: REDTEAM,
  bluesky: BLUESKY,
};

// ─── Role Presets ────────────────────────────────────────────────────────────

export type RolePresetName = "none" | "diverse" | "redteam" | "balanced" | "intensive";

export interface RoleAssignment {
  modelId: string;
  stance: Stance;
  /** Optional display alias (e.g. "Participant A") */
  alias?: string;
}

/**
 * Assign stances to models based on a preset.
 *
 * - "none": No stance assignment (all models behave normally)
 * - "diverse": Cycles through skeptic → advocate → pragmatist
 * - "redteam": One advocate (proposer) + rest are skeptics
 * - "balanced": Even split between skeptic and advocate
 * - "intensive": Each model gets a unique stance
 */
export function createPreset(
  preset: RolePresetName,
  modelIds: string[],
): RoleAssignment[] {
  if (preset === "none" || modelIds.length === 0) {
    return [];
  }

  const aliases = assignAliases(modelIds);

  switch (preset) {
    case "diverse": {
      const cycle: Stance[] = [SKEPTIC, ADVOCATE, PRAGMATIST];
      return modelIds.map((id, i) => ({
        modelId: id,
        stance: cycle[i % cycle.length],
        alias: aliases[i],
      }));
    }

    case "redteam": {
      return modelIds.map((id, i) => ({
        modelId: id,
        stance: i === 0 ? ADVOCATE : SKEPTIC,
        alias: aliases[i],
      }));
    }

    case "balanced": {
      const half = Math.ceil(modelIds.length / 2);
      return modelIds.map((id, i) => ({
        modelId: id,
        stance: i < half ? ADVOCATE : SKEPTIC,
        alias: aliases[i],
      }));
    }

    case "intensive": {
      const allStances = [SKEPTIC, ADVOCATE, PRAGMATIST, NEUTRAL, REDTEAM, BLUESKY];
      return modelIds.map((id, i) => ({
        modelId: id,
        stance: allStances[i % allStances.length],
        alias: aliases[i],
      }));
    }

    default:
      return [];
  }
}

/**
 * Override specific model stances within a preset.
 */
export function overrideStances(
  assignments: RoleAssignment[],
  overrides: Record<string, string>,
): RoleAssignment[] {
  return assignments.map((a) => {
    const override = overrides[a.modelId];
    if (!override) return a;

    const stance = STANCE_LIBRARY[override];
    if (stance) {
      return { ...a, stance };
    }

    // Treat as custom instruction text
    return {
      ...a,
      stance: {
        id: `custom-${a.modelId}`,
        name: "Custom",
        instruction: override,
        adversarial: false,
      },
    };
  });
}

/**
 * Generate anonymous aliases for models (Participant A, B, C, ...).
 */
function assignAliases(modelIds: string[]): string[] {
  return modelIds.map(
    (_, i) => `Participant ${String.fromCharCode(65 + (i % 26))}`,
  );
}

// ─── Stance-Aware Prompt Builder ─────────────────────────────────────────────

/**
 * Inject a stance instruction into a system prompt.
 */
export function applyStance(
  systemPrompt: string,
  stance: Stance,
): string {
  return (
    systemPrompt +
    "\n\n---\n" +
    `## Your Role: ${stance.name}\n\n` +
    stance.instruction
  );
}

/**
 * Build a debate context with anonymized participant labels.
 */
export interface DebateContextConfig {
  prompt: string;
  assignments: RoleAssignment[];
  /** Previous round contributions */
  history?: Array<{
    alias: string;
    phase: string;
    content: string;
  }>;
}

export function buildDebateContext(config: DebateContextConfig): string {
  const parts: string[] = [];

  parts.push(`# Debate: ${config.prompt}`);
  parts.push("");
  parts.push("## Participants");
  for (const a of config.assignments) {
    parts.push(`- **${a.alias}** (${a.stance.name}): ${a.stance.instruction}`);
  }
  parts.push("");

  if (config.history && config.history.length > 0) {
    parts.push("## Previous Contributions");
    for (const h of config.history) {
      parts.push(`### ${h.alias} — ${h.phase}`);
      parts.push(h.content);
      parts.push("");
    }
  }

  parts.push("## Your Contribution");
  parts.push(
    "Provide your response below. Stay in character based on your assigned role.",
  );

  return parts.join("\n");
}
