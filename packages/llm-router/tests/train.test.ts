// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { hashEmbed, trainRouters, type RoutingSample } from "../src/index.js";

const CODE = [
  "fix this typescript compile error in my function",
  "why does my python loop throw an index error",
  "refactor this javascript class to use async await",
  "write a sql query joining orders and customers",
  "debug a segfault in my c pointer code",
  "how do I type a generic function in typescript",
  "my rust borrow checker error on a mutable reference",
  "optimize this python function that parses json",
];
const PROSE = [
  "write a short poem about autumn rain",
  "draft a warm birthday message for my aunt",
  "suggest a title for my fantasy novel",
  "rewrite this paragraph to sound more poetic",
  "compose a haiku about the ocean at night",
  "write a toast for my best friend's wedding",
  "describe a sunset in vivid lyrical language",
  "invent a bedtime story about a brave fox",
];

/** coder agrees on code questions, bard on prose; each question asked of both. */
function samples(): RoutingSample[] {
  return [
    ...CODE.flatMap((query) => [
      { query, model: "coder", agreed: true },
      { query, model: "bard", agreed: false },
    ]),
    ...PROSE.flatMap((query) => [
      { query, model: "coder", agreed: false },
      { query, model: "bard", agreed: true },
    ]),
  ];
}

describe("hashEmbed", () => {
  it("is a stable unit vector", () => {
    const v = hashEmbed("hello world");
    expect(v).toEqual(hashEmbed("hello world"));
    expect(Math.hypot(...v)).toBeCloseTo(1);
  });
});

describe("trainRouters", () => {
  it("needs two models and at least one agreed answer", () => {
    expect(trainRouters([{ query: "q", model: "a", agreed: true }])).toBeNull();
    expect(
      trainRouters([
        { query: "q", model: "a", agreed: false },
        { query: "q", model: "b", agreed: false },
      ]),
    ).toBeNull();
  });

  it("every router learns which model suits which kind of question", () => {
    const r = trainRouters(samples(), { seed: 7 })!;
    expect(r.models.sort()).toEqual(["bard", "coder"]);
    const code = "fix the type error in this typescript function";
    const prose = "write a gentle poem about the rain";
    for (const [name, pick] of Object.entries({
      knn: (q: string) => r.knn.route(q).chosenAlias,
      mlp: (q: string) => r.mlp.route(hashEmbed(q)).chosenAlias,
      svm: (q: string) => r.svm.route(hashEmbed(q)).chosenAlias,
      mf: (q: string) => r.mf.route(hashEmbed(q)).chosenAlias,
    })) {
      expect(`${name}:${pick(code)}`).toBe(`${name}:coder`);
      expect(`${name}:${pick(prose)}`).toBe(`${name}:bard`);
    }
  });

  it("routes by majority across the four", () => {
    const r = trainRouters(samples(), { seed: 7 })!;
    expect(r.route("debug my python function").model).toBe("coder");
    expect(r.route("a poem for my aunt").votes).toMatchObject({ knn: "bard" });
  });
});
