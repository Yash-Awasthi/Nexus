// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  normalizeWord,
  parseGroups,
  scoreConnections,
  scoreConnectionsQuadratic,
  connectionsMean,
  runConnectionsBenchmark,
} from "./connections-eval";

const ACTUAL: string[][] = [
  ["APPLE", "BANANA", "CHERRY", "DATE"],
  ["RED", "GREEN", "BLUE", "YELLOW"],
  ["CAT", "DOG", "BIRD", "FISH"],
  ["ONE", "TWO", "THREE", "FOUR"],
];

describe("scoreConnectionsQuadratic (benchmark headline)", () => {
  it("gives 100% for all four groups", () => {
    expect(scoreConnectionsQuadratic(ACTUAL, ACTUAL)).toBe(1);
  });

  it("gives the spec values: 0, 1, 2, 3, 4 groups → 0%, 6.25%, 25%, 56.25%, 100%", () => {
    const twoGroups = [
      ["apple", "banana", "cherry", "date"],
      ["red", "green", "blue", "yellow"],
      ["cat", "dog", "mouse", "fish"], // wrong
      ["one", "two", "seven", "four"], // wrong
    ];
    expect(scoreConnectionsQuadratic(ACTUAL, twoGroups)).toBeCloseTo(0.25, 10);

    const oneGroup = [
      ["apple", "banana", "cherry", "date"],
      ["x", "y", "z", "w"],
      ["x", "y", "z", "w"],
      ["x", "y", "z", "w"],
    ];
    expect(scoreConnectionsQuadratic(ACTUAL, oneGroup)).toBeCloseTo(0.0625, 10);
  });

  it("linear score is g/4", () => {
    expect(scoreConnections(ACTUAL, ACTUAL)).toBe(1);
    const twoGroups = [
      ["apple", "banana", "cherry", "date"],
      ["red", "green", "blue", "yellow"],
      ["cat", "dog", "mouse", "fish"],
      ["one", "two", "seven", "four"],
    ];
    expect(scoreConnections(ACTUAL, twoGroups)).toBeCloseTo(0.5, 10);
  });
});

describe("normalizeWord", () => {
  it("strips quotes, numbering, comments, parentheticals and notes", () => {
    expect(normalizeWord(`'apple'`)).toBe("apple");
    expect(normalizeWord(`1. apple`)).toBe("apple");
    expect(normalizeWord(`apple // fruit category`)).toBe("apple");
    expect(normalizeWord(`apple - common fruit`)).toBe("apple");
    expect(normalizeWord(`apple (fruit)`)).toBe("apple");
    expect(normalizeWord(`apple <eos>`)).toBe("apple");
  });

  it("normalizes case-insensitively when matching groups", () => {
    const predicted = [["APPLE", "banana", "CHERRY", "date"], [], [], []];
    expect(scoreConnections(ACTUAL, predicted)).toBeCloseTo(0.25, 10);
  });
});

describe("parseGroups", () => {
  it("parses comma-separated lines into up to 4 groups of 4 words", () => {
    const answer = [
      "1. apple, banana, cherry, date",
      "2. red, green, blue, yellow",
      "3. cat, dog, bird, fish // animals",
      "4. one, two, three, four",
    ].join("\n");
    const groups = parseGroups(answer);
    expect(groups).toHaveLength(4);
    expect(groups[0]).toEqual(["apple", "banana", "cherry", "date"]);
    expect(groups[3]).toEqual(["one", "two", "three", "four"]);
  });
});

describe("runConnectionsBenchmark", () => {
  it("averages per-puzzle quadratic scores and counts exact puzzles", () => {
    const puzzles = [
      { groups: ACTUAL },
      { groups: ACTUAL },
      {
        // Puzzle 3 must score 2/4 groups (quadratic 0.25): the answer's first
        // two lines match actual groups 1–2, and its nonsense lines 3–4 must
        // NOT set-match any actual group. (The placeholder word "WRONG" was
        // previously used AS an actual group word, which made the nonsense
        // answer exactly match it — the fixture defeated its own intent.)
        groups: [
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["RED", "GREEN", "BLUE", "YELLOW"],
          ["SUN", "MOON", "STAR", "MARS"],
          ["IRON", "GOLD", "SILVER", "ZINC"],
        ],
      },
    ];
    const answers = [
      "1. apple, banana, cherry, date\n2. red, green, blue, yellow\n3. cat, dog, bird, fish\n4. one, two, three, four",
      "1. apple, banana, cherry, date\n2. red, green, blue, yellow\n3. cat, dog, bird, fish\n4. one, two, three, four",
      "1. apple, banana, cherry, date\n2. red, green, blue, yellow\n3. wrong, a, b, c\n4. wrong, d, e, f",
    ];
    const result = runConnectionsBenchmark(puzzles, answers);
    // 1.0, 1.0, 0.25 → mean 0.75
    expect(result.mean).toBeCloseTo(0.75, 10);
    expect(result.exactPuzzles).toBe(2);
    expect(result.perPuzzle).toHaveLength(3);
  });

  it("returns mean of empty set as 0", () => {
    expect(connectionsMean([])).toBe(0);
  });
});
