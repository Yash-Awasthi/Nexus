// SPDX-License-Identifier: Apache-2.0

// ── Triggers ──────────────────────────────────────────────────────────────────

export interface KeywordTrigger {
  type: "keyword";
  /** One or more keywords — input matches if it contains any of them. */
  keywords: string[];
  caseSensitive?: boolean;
}

export interface RegexTrigger {
  type: "regex";
  /** Pattern string — compiled to a RegExp on match. */
  pattern: string;
  flags?: string;
}

export interface AlwaysTrigger {
  type: "always";
}

export type Trigger = KeywordTrigger | RegexTrigger | AlwaysTrigger;

// ── Skill types ───────────────────────────────────────────────────────────────

export interface SkillContext<TContext = unknown> {
  input: string;
  matchedTrigger: Trigger;
  skill: Skill<TContext>;
  context: TContext;
}

export interface SkillResult {
  output: string;
  handled: boolean;
  metadata?: Record<string, unknown>;
}

export type SkillHandler<TContext = unknown> = (
  ctx: SkillContext<TContext>,
) => Promise<SkillResult> | SkillResult;

export interface Skill<TContext = unknown> {
  id: string;
  name: string;
  description?: string;
  triggers: Trigger[];
  /** Higher priority skills are matched first. Default: 0. */
  priority?: number;
  handler: SkillHandler<TContext>;
  metadata?: Record<string, unknown>;
}

export interface MatchedSkill<TContext = unknown> {
  skill: Skill<TContext>;
  trigger: Trigger;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class SkillError extends Error {
  readonly code: string;
  readonly skillId?: string;
  constructor(message: string, code: string, skillId?: string) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.skillId = skillId;
  }
}

// ── Trigger matching ──────────────────────────────────────────────────────────

function matchesTrigger(input: string, trigger: Trigger): boolean {
  switch (trigger.type) {
    case "always":
      return true;

    case "keyword": {
      const haystack = trigger.caseSensitive ? input : input.toLowerCase();
      return trigger.keywords.some((kw) => {
        const needle = trigger.caseSensitive ? kw : kw.toLowerCase();
        return haystack.includes(needle);
      });
    }

    case "regex": {
      const re = new RegExp(trigger.pattern, trigger.flags);
      return re.test(input);
    }
  }
}

// ── SkillRegistry ─────────────────────────────────────────────────────────────

export class SkillRegistry<TContext = unknown> {
  private readonly _skills = new Map<string, Skill<TContext>>();

  /**
   * Register a skill. Throws SkillError if a skill with the same id already exists,
   * unless `replace` is true.
   */
  register(skill: Skill<TContext>, replace = false): void {
    if (this._skills.has(skill.id) && !replace) {
      throw new SkillError(
        `Skill '${skill.id}' is already registered. Pass replace=true to overwrite.`,
        "DUPLICATE_SKILL",
        skill.id,
      );
    }
    if (!skill.id.trim()) {
      throw new SkillError("Skill id must be a non-empty string.", "INVALID_SKILL_ID");
    }
    if (!skill.triggers.length) {
      throw new SkillError(
        `Skill '${skill.id}' must have at least one trigger.`,
        "NO_TRIGGERS",
        skill.id,
      );
    }
    this._skills.set(skill.id, skill);
  }

  /** Returns true if the skill was found and removed. */
  unregister(id: string): boolean {
    return this._skills.delete(id);
  }

  get(id: string): Skill<TContext> | undefined {
    return this._skills.get(id);
  }

  has(id: string): boolean {
    return this._skills.has(id);
  }

  list(): Skill<TContext>[] {
    return Array.from(this._skills.values());
  }

  size(): number {
    return this._skills.size;
  }

  /**
   * Return all skills whose triggers match the input, ordered by priority descending
   * then registration order.
   */
  match(input: string): MatchedSkill<TContext>[] {
    const results: MatchedSkill<TContext>[] = [];

    for (const skill of this._skills.values()) {
      for (const trigger of skill.triggers) {
        if (matchesTrigger(input, trigger)) {
          results.push({ skill, trigger });
          break; // one match per skill
        }
      }
    }

    return results.sort((a, b) => (b.skill.priority ?? 0) - (a.skill.priority ?? 0));
  }

  /** Return the highest-priority matching skill, or undefined. */
  first(input: string): MatchedSkill<TContext> | undefined {
    return this.match(input)[0];
  }

  /**
   * Execute the first matching skill with the given context.
   * Returns undefined if no skill matches.
   */
  async run(input: string, context: TContext): Promise<SkillResult | undefined> {
    const matched = this.first(input);
    if (!matched) return undefined;

    const ctx: SkillContext<TContext> = {
      input,
      matchedTrigger: matched.trigger,
      skill: matched.skill,
      context,
    };

    return matched.skill.handler(ctx);
  }

  /**
   * Run all matching skills in priority order and return all results.
   */
  async runAll(input: string, context: TContext): Promise<SkillResult[]> {
    const matched = this.match(input);
    const results: SkillResult[] = [];
    for (const { skill, trigger } of matched) {
      const ctx: SkillContext<TContext> = { input, matchedTrigger: trigger, skill, context };
      results.push(await skill.handler(ctx));
    }
    return results;
  }
}

// ── defineSkill helper ────────────────────────────────────────────────────────

/** Convenience function for declaring skills with full type inference. */
export function defineSkill<TContext = unknown>(
  def: Omit<Skill<TContext>, "handler"> & { handler: SkillHandler<TContext> },
): Skill<TContext> {
  return def as Skill<TContext>;
}

// ── Built-in skills ───────────────────────────────────────────────────────────

/** Echo skill — reflects the input back as output. Always trigger. */
export const ECHO_SKILL: Skill = defineSkill({
  id: "builtin:echo",
  name: "Echo",
  description: "Echoes the input back unchanged.",
  triggers: [{ type: "always" }],
  priority: -100,
  handler: (ctx) => ({ output: ctx.input, handled: true }),
});

/** Noop skill — does nothing, always matches at lowest priority. */
export const NOOP_SKILL: Skill = defineSkill({
  id: "builtin:noop",
  name: "Noop",
  description: "Does nothing. Useful as a fallback placeholder.",
  triggers: [{ type: "always" }],
  priority: -999,
  handler: () => ({ output: "", handled: false }),
});

/** Help skill — matches "help" keyword and returns a description of how to use skills. */
export const HELP_SKILL: Skill = defineSkill({
  id: "builtin:help",
  name: "Help",
  description: "Responds to 'help' with usage information.",
  triggers: [{ type: "keyword", keywords: ["help", "?"] }],
  priority: 0,
  handler: () => ({
    output: "Available skills: use a SkillRegistry to list and match skills by input.",
    handled: true,
  }),
});
