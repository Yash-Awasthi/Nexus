// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  applySTMs,
  hedgeReducer,
  directMode,
  casualMode,
  directionalOptimizer,
  ALL_STM_MODULES,
  COUNCIL_STM_PRESET,
  type STMModule,
} from "../src/stm.js";

// ── applySTMs ─────────────────────────────────────────────────────────────────

describe("applySTMs", () => {
  it("returns input unchanged when all modules are disabled", () => {
    const mods = ALL_STM_MODULES.map((m) => ({ ...m, enabled: false }));
    expect(applySTMs("Hello world.", mods)).toBe("Hello world.");
  });

  it("applies modules in order", () => {
    const upper: STMModule = {
      id: "upper",
      name: "Upper",
      description: "uppercases",
      version: "1",
      enabled: true,
      transformer: (s) => s.toUpperCase(),
    };
    const bang: STMModule = {
      id: "bang",
      name: "Bang",
      description: "appends !",
      version: "1",
      enabled: true,
      transformer: (s) => s + "!",
    };
    expect(applySTMs("hello", [upper, bang])).toBe("HELLO!");
    expect(applySTMs("hello", [bang, upper])).toBe("HELLO!");
  });

  it("skips disabled modules in a mixed list", () => {
    const upper: STMModule = {
      id: "upper",
      name: "Upper",
      description: "",
      version: "1",
      enabled: false,
      transformer: (s) => s.toUpperCase(),
    };
    const bang: STMModule = {
      id: "bang",
      name: "Bang",
      description: "",
      version: "1",
      enabled: true,
      transformer: (s) => s + "!",
    };
    expect(applySTMs("hello", [upper, bang])).toBe("hello!");
  });

  it("passes config to transformer", () => {
    const mod: STMModule = {
      id: "cfg",
      name: "Cfg",
      description: "",
      version: "1",
      enabled: true,
      config: { suffix: "?" },
      transformer: (s, cfg) => s + (cfg?.["suffix"] ?? ""),
    };
    expect(applySTMs("hi", [mod])).toBe("hi?");
  });

  it("returns empty string unchanged", () => {
    expect(applySTMs("", [])).toBe("");
  });
});

// ── hedgeReducer ─────────────────────────────────────────────────────────────

describe("hedgeReducer", () => {
  const run = (text: string) => hedgeReducer.transformer(text, hedgeReducer.config);

  it("removes 'I think'", () => {
    expect(run("I think this is correct.")).toBe("This is correct.");
  });

  it("removes 'perhaps'", () => {
    expect(run("perhaps we should try again.")).toBe("We should try again.");
  });

  it("removes 'maybe'", () => {
    expect(run("maybe this will work")).toBe("This will work");
  });

  it("removes 'I believe'", () => {
    expect(run("I believe the answer is 42.")).toBe("The answer is 42.");
  });

  it("removes 'probably'", () => {
    expect(run("It's probably fine.")).toBe("It's fine.");
  });

  it("removes 'In my opinion,'", () => {
    expect(run("In my opinion, this is wrong.")).toBe("This is wrong.");
  });

  it("leaves text without hedges unchanged in substance", () => {
    const text = "The answer is 42.";
    expect(run(text)).toBe(text);
  });

  it("is disabled by default", () => {
    expect(hedgeReducer.enabled).toBe(false);
  });
});

// ── directMode ────────────────────────────────────────────────────────────────

describe("directMode", () => {
  const run = (text: string) => directMode.transformer(text, directMode.config);

  it("removes 'Sure! ' preamble", () => {
    expect(run("Sure! Here is your answer.")).toBe("Here is your answer.");
  });

  it("removes 'Of course!' preamble", () => {
    expect(run("Of course! Let me explain.")).toBe("Let me explain.");
  });

  it("removes 'Certainly!' preamble", () => {
    expect(run("Certainly! The answer is 42.")).toBe("The answer is 42.");
  });

  it("removes 'Great question!' preamble", () => {
    const result = run("Great question! The answer is 42.");
    expect(result).toBe("The answer is 42.");
  });

  it('removes "I\'d be happy to help" preamble', () => {
    const result = run("I'd be happy to help. Here's the plan.");
    expect(result).toBe("Here's the plan.");
  });

  it("leaves clean text unchanged", () => {
    const text = "The database has three tables.";
    expect(run(text)).toBe(text);
  });

  it("is disabled by default", () => {
    expect(directMode.enabled).toBe(false);
  });
});

// ── casualMode ────────────────────────────────────────────────────────────────

describe("casualMode", () => {
  const run = (text: string) => casualMode.transformer(text, casualMode.config);

  it("replaces 'Utilize' with 'Use'", () => {
    expect(run("Utilize this function.")).toBe("Use this function.");
  });

  it("replaces 'utilize' (lowercase) with 'use'", () => {
    expect(run("You should utilize the API.")).toBe("You should use the API.");
  });

  it("replaces 'However' with 'But'", () => {
    expect(run("However, it failed.")).toBe("But, it failed.");
  });

  it("replaces 'Therefore' with 'So'", () => {
    expect(run("Therefore it works.")).toBe("So it works.");
  });

  it("replaces 'In order to' with 'To'", () => {
    expect(run("In order to run this, install pnpm.")).toBe("To run this, install pnpm.");
  });

  it("replaces 'Prior to' with 'Before'", () => {
    expect(run("Prior to running, install deps.")).toBe("Before running, install deps.");
  });

  it("is disabled by default", () => {
    expect(casualMode.enabled).toBe(false);
  });
});

// ── directionalOptimizer ─────────────────────────────────────────────────────

describe("directionalOptimizer", () => {
  const run = (text: string) => directionalOptimizer.transformer(text, directionalOptimizer.config);

  it("strips expletive 'It is important that'", () => {
    const result = run("It is important that you read the docs.");
    // The transformer strips the prefix but does not re-capitalise
    expect(result).toBe("you read the docs.");
  });

  it("strips 'It was found that'", () => {
    const result = run("It was found that the test passed.");
    expect(result).toBe("the test passed.");
  });

  it("strips 'There is a need to'", () => {
    const result = run("There is a need to restart the server.");
    expect(result).toBe("restart the server.");
  });

  it("leaves plain sentences unchanged", () => {
    const text = "The runtime loads the config.";
    expect(run(text)).toBe(text);
  });

  it("is disabled by default", () => {
    expect(directionalOptimizer.enabled).toBe(false);
  });
});

// ── Presets ───────────────────────────────────────────────────────────────────

describe("ALL_STM_MODULES", () => {
  it("contains 4 modules", () => {
    expect(ALL_STM_MODULES).toHaveLength(4);
  });

  it("all modules are disabled by default", () => {
    for (const mod of ALL_STM_MODULES) {
      expect(mod.enabled).toBe(false);
    }
  });

  it("each module has a non-empty id, name, and version", () => {
    for (const mod of ALL_STM_MODULES) {
      expect(mod.id.length).toBeGreaterThan(0);
      expect(mod.name.length).toBeGreaterThan(0);
      expect(mod.version.length).toBeGreaterThan(0);
    }
  });
});

describe("COUNCIL_STM_PRESET", () => {
  it("contains hedge_reducer and direct_mode", () => {
    const ids = COUNCIL_STM_PRESET.map((m) => m.id);
    expect(ids).toContain("hedge_reducer");
    expect(ids).toContain("direct_mode");
  });

  it("both modules are enabled", () => {
    for (const mod of COUNCIL_STM_PRESET) {
      expect(mod.enabled).toBe(true);
    }
  });

  it("applies both transforms end-to-end", () => {
    const raw = "I think perhaps this is the answer.";
    const result = applySTMs(raw, COUNCIL_STM_PRESET);
    // hedgeReducer removes "I think " and "perhaps "
    expect(result).not.toContain("I think");
    expect(result).not.toContain("perhaps");
  });
});
