// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  SkillRegistry,
  SkillError,
  defineSkill,
  ECHO_SKILL,
  NOOP_SKILL,
  HELP_SKILL,
  type Skill,
  type SkillResult,
  type SkillContext,
} from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

type Ctx = { user: string };

function makeSkill(
  id: string,
  triggers: Skill["triggers"],
  priority = 0,
  output = `handled by ${id}`,
): Skill<Ctx> {
  return defineSkill<Ctx>({
    id,
    name: id,
    triggers,
    priority,
    handler: () => ({ output, handled: true }),
  });
}

function alwaysSkill(id: string, priority = 0): Skill<Ctx> {
  return makeSkill(id, [{ type: "always" }], priority);
}

function keywordSkill(id: string, keywords: string[], priority = 0): Skill<Ctx> {
  return makeSkill(id, [{ type: "keyword", keywords }], priority);
}

function regexSkill(id: string, pattern: string, priority = 0): Skill<Ctx> {
  return makeSkill(id, [{ type: "regex", pattern }], priority);
}

// ── defineSkill ───────────────────────────────────────────────────────────────

describe("defineSkill", () => {
  it("creates a skill with all provided fields", () => {
    const skill = defineSkill({
      id: "test:greet",
      name: "Greet",
      description: "Greets the user",
      triggers: [{ type: "keyword", keywords: ["hello"] }],
      handler: () => ({ output: "Hello!", handled: true }),
    });
    expect(skill.id).toBe("test:greet");
    expect(skill.name).toBe("Greet");
    expect(skill.triggers).toHaveLength(1);
  });

  it("handler can return a SkillResult", () => {
    const skill = defineSkill({
      id: "x",
      name: "x",
      triggers: [{ type: "always" }],
      handler: (ctx) => ({ output: `Echo: ${ctx.input}`, handled: true }),
    });
    // Call handler directly
    const result = skill.handler({
      input: "hello",
      matchedTrigger: { type: "always" },
      skill,
      context: undefined,
    } as any);
    expect((result as SkillResult).output).toBe("Echo: hello");
  });
});

// ── Trigger matching ──────────────────────────────────────────────────────────

describe("Trigger matching", () => {
  let registry: SkillRegistry<Ctx>;

  beforeEach(() => {
    registry = new SkillRegistry<Ctx>();
  });

  it("always trigger matches any input", () => {
    registry.register(alwaysSkill("a"));
    expect(registry.match("anything")).toHaveLength(1);
    expect(registry.match("")).toHaveLength(1);
  });

  it("keyword trigger matches when input contains keyword", () => {
    registry.register(keywordSkill("k", ["python"]));
    expect(registry.match("I love python programming")).toHaveLength(1);
    expect(registry.match("I love ruby programming")).toHaveLength(0);
  });

  it("keyword trigger is case-insensitive by default", () => {
    registry.register(keywordSkill("k", ["Python"]));
    expect(registry.match("i know PYTHON")).toHaveLength(1);
  });

  it("keyword trigger respects caseSensitive: true", () => {
    registry.register(
      makeSkill("k", [{ type: "keyword", keywords: ["Python"], caseSensitive: true }]),
    );
    expect(registry.match("i know python")).toHaveLength(0);
    expect(registry.match("i know Python")).toHaveLength(1);
  });

  it("keyword trigger matches any keyword in the list", () => {
    registry.register(keywordSkill("k", ["cat", "dog", "fish"]));
    expect(registry.match("I have a dog")).toHaveLength(1);
    expect(registry.match("I have a cat")).toHaveLength(1);
    expect(registry.match("I have a bird")).toHaveLength(0);
  });

  it("regex trigger matches by pattern", () => {
    registry.register(regexSkill("r", "^\\d{4}$"));
    expect(registry.match("1234")).toHaveLength(1);
    expect(registry.match("12345")).toHaveLength(0);
    expect(registry.match("abcd")).toHaveLength(0);
  });

  it("regex trigger uses provided flags", () => {
    registry.register(makeSkill("r", [{ type: "regex", pattern: "hello", flags: "i" }]));
    expect(registry.match("HELLO world")).toHaveLength(1);
  });

  it("skill with multiple triggers matches on any trigger", () => {
    const skill = defineSkill<Ctx>({
      id: "multi",
      name: "multi",
      triggers: [
        { type: "keyword", keywords: ["help"] },
        { type: "regex", pattern: "^\\?" },
      ],
      handler: () => ({ output: "ok", handled: true }),
    });
    registry.register(skill);
    expect(registry.match("help me")).toHaveLength(1);
    expect(registry.match("? what")).toHaveLength(1);
    expect(registry.match("something else")).toHaveLength(0);
  });
});

// ── SkillRegistry ─────────────────────────────────────────────────────────────

describe("SkillRegistry", () => {
  let registry: SkillRegistry<Ctx>;

  beforeEach(() => {
    registry = new SkillRegistry<Ctx>();
  });

  it("register adds skill to registry", () => {
    registry.register(alwaysSkill("a"));
    expect(registry.size()).toBe(1);
  });

  it("get returns registered skill", () => {
    const skill = alwaysSkill("a");
    registry.register(skill);
    expect(registry.get("a")).toBe(skill);
  });

  it("get returns undefined for unknown id", () => {
    expect(registry.get("ghost")).toBeUndefined();
  });

  it("has returns true for registered skill", () => {
    registry.register(alwaysSkill("x"));
    expect(registry.has("x")).toBe(true);
    expect(registry.has("y")).toBe(false);
  });

  it("list returns all registered skills", () => {
    registry.register(alwaysSkill("a"));
    registry.register(alwaysSkill("b"));
    expect(registry.list()).toHaveLength(2);
  });

  it("unregister removes skill", () => {
    registry.register(alwaysSkill("a"));
    expect(registry.unregister("a")).toBe(true);
    expect(registry.has("a")).toBe(false);
  });

  it("unregister returns false for unknown id", () => {
    expect(registry.unregister("ghost")).toBe(false);
  });

  it("register throws DUPLICATE_SKILL on duplicate id", () => {
    registry.register(alwaysSkill("a"));
    expect(() => registry.register(alwaysSkill("a"))).toThrow(SkillError);
    try {
      registry.register(alwaysSkill("a"));
    } catch (e) {
      expect((e as SkillError).code).toBe("DUPLICATE_SKILL");
      expect((e as SkillError).skillId).toBe("a");
    }
  });

  it("register with replace=true overwrites existing skill", () => {
    registry.register(alwaysSkill("a"));
    const replacement = alwaysSkill("a");
    registry.register(replacement, true);
    expect(registry.get("a")).toBe(replacement);
  });

  it("register throws INVALID_SKILL_ID for empty id", () => {
    const skill = alwaysSkill(" ");
    expect(() => registry.register(skill)).toThrow(SkillError);
    try {
      registry.register(skill);
    } catch (e) {
      expect((e as SkillError).code).toBe("INVALID_SKILL_ID");
    }
  });

  it("register throws NO_TRIGGERS for skill with empty triggers array", () => {
    const skill: Skill<Ctx> = {
      id: "empty",
      name: "empty",
      triggers: [],
      handler: () => ({ output: "", handled: false }),
    };
    expect(() => registry.register(skill)).toThrow(SkillError);
    try {
      registry.register(skill);
    } catch (e) {
      expect((e as SkillError).code).toBe("NO_TRIGGERS");
    }
  });

  it("match returns skills ordered by priority descending", () => {
    registry.register(alwaysSkill("low", -1));
    registry.register(alwaysSkill("high", 10));
    registry.register(alwaysSkill("mid", 5));
    const matches = registry.match("anything");
    expect(matches.map((m) => m.skill.id)).toEqual(["high", "mid", "low"]);
  });

  it("first returns highest priority match", () => {
    registry.register(alwaysSkill("low", 0));
    registry.register(alwaysSkill("high", 100));
    expect(registry.first("x")!.skill.id).toBe("high");
  });

  it("first returns undefined when nothing matches", () => {
    registry.register(keywordSkill("k", ["python"]));
    expect(registry.first("ruby")).toBeUndefined();
  });

  it("each skill only appears once in match results", () => {
    // Skill with two triggers that both match
    const skill = defineSkill<Ctx>({
      id: "dual",
      name: "dual",
      triggers: [
        { type: "keyword", keywords: ["python"] },
        { type: "regex", pattern: "python" },
      ],
      handler: () => ({ output: "ok", handled: true }),
    });
    registry.register(skill);
    expect(registry.match("I love python")).toHaveLength(1);
  });

  it("run invokes handler of first matching skill", async () => {
    registry.register(keywordSkill("a", ["help"], 10));
    registry.register(alwaysSkill("b", 0));
    const result = await registry.run("help me", { user: "Yash" });
    expect(result!.output).toBe("handled by a");
  });

  it("run returns undefined when no skill matches", async () => {
    registry.register(keywordSkill("k", ["python"]));
    expect(await registry.run("ruby", { user: "x" })).toBeUndefined();
  });

  it("run passes correct context to handler", async () => {
    let capturedCtx: SkillContext<Ctx> | undefined;
    const skill = defineSkill<Ctx>({
      id: "ctx-test",
      name: "ctx-test",
      triggers: [{ type: "always" }],
      handler: (ctx) => {
        capturedCtx = ctx;
        return { output: "ok", handled: true };
      },
    });
    registry.register(skill);
    await registry.run("hello", { user: "Yash" });
    expect(capturedCtx!.input).toBe("hello");
    expect(capturedCtx!.context.user).toBe("Yash");
    expect(capturedCtx!.skill.id).toBe("ctx-test");
  });

  it("runAll invokes all matching skills in priority order", async () => {
    registry.register(alwaysSkill("a", 5));
    registry.register(alwaysSkill("b", 10));
    registry.register(keywordSkill("c", ["x"], 1)); // won't match
    const results = await registry.runAll("anything", { user: "u" });
    expect(results).toHaveLength(2);
    expect(results[0]!.output).toContain("b");
    expect(results[1]!.output).toContain("a");
  });

  it("runAll returns [] when nothing matches", async () => {
    registry.register(keywordSkill("k", ["nope"]));
    expect(await registry.runAll("yes", { user: "u" })).toEqual([]);
  });
});

// ── Built-in skills ───────────────────────────────────────────────────────────

describe("Built-in skills", () => {
  it("ECHO_SKILL echoes input", async () => {
    const registry = new SkillRegistry();
    registry.register(ECHO_SKILL, true);
    const result = await registry.run("hello world", undefined);
    expect(result!.output).toBe("hello world");
  });

  it("NOOP_SKILL returns handled=false", async () => {
    const registry = new SkillRegistry();
    registry.register(NOOP_SKILL, true);
    const result = await registry.run("anything", undefined);
    expect(result!.handled).toBe(false);
  });

  it("HELP_SKILL matches 'help' keyword", () => {
    const registry = new SkillRegistry();
    registry.register(HELP_SKILL, true);
    expect(registry.first("help me please")).toBeDefined();
    expect(registry.first("what is python")).toBeUndefined();
  });

  it("HELP_SKILL matches '?' keyword", () => {
    const registry = new SkillRegistry();
    registry.register(HELP_SKILL, true);
    expect(registry.first("? how does this work")).toBeDefined();
  });

  it("ECHO_SKILL has lower priority than HELP_SKILL", () => {
    const registry = new SkillRegistry();
    registry.register(ECHO_SKILL, true);
    registry.register(HELP_SKILL, true);
    const match = registry.first("help");
    expect(match!.skill.id).toBe("builtin:help");
  });

  it("all built-in skills have builtin: prefix id", () => {
    [ECHO_SKILL, NOOP_SKILL, HELP_SKILL].forEach((s) => {
      expect(s.id.startsWith("builtin:")).toBe(true);
    });
  });
});

// ── SkillError ────────────────────────────────────────────────────────────────

describe("SkillError", () => {
  it("has correct name, code, skillId, and message", () => {
    const e = new SkillError("skill not found", "NOT_FOUND", "my:skill");
    expect(e.name).toBe("SkillError");
    expect(e.code).toBe("NOT_FOUND");
    expect(e.skillId).toBe("my:skill");
    expect(e instanceof Error).toBe(true);
  });

  it("skillId is optional", () => {
    const e = new SkillError("bad input", "BAD_INPUT");
    expect(e.skillId).toBeUndefined();
  });
});
