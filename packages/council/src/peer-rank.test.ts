// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { rankPeers } from "./borda.js";

const finals = [
  { label: "Qwen", text: "FINAL: Use Postgres." },
  { label: "DeepSeek", text: "FINAL: Use SQLite." },
  { label: "Mimo", text: "FINAL: Use Postgres with backups." },
];

describe("rankPeers", () => {
  it("anonymises the answers, collects each member's ranking and tallies Borda points", async () => {
    const prompts = new Map<string, string>();
    const res = await rankPeers(
      async (label, prompt) => {
        prompts.set(label, prompt);
        // Everyone ranks Mimo's answer first and DeepSeek's last, whatever letters they got.
        const order = ["Use Postgres with backups.", "Use Postgres.", "Use SQLite."].map(
          (answer) =>
            new RegExp(`Response ([A-H]):\\n${answer.replace(".", "\\.")}\\n`).exec(prompt)![1],
        );
        return `Ranking: ${order.join(", ")}`;
      },
      "Which database?",
      finals,
      42,
    );
    const prompt = prompts.get("Qwen")!;
    expect(prompt).not.toContain("Qwen");
    expect(prompt).toContain("strongest to weakest");
    expect(res!.standings.map((s) => `${s.label}:${s.points}`)).toEqual([
      "Mimo:6",
      "Qwen:3",
      "DeepSeek:0",
    ]);
    expect(res!.strength).toBe("consensus");
    expect(res!.line).toBe(
      "Peer ranking (consensus): 1. Mimo 6 pts, 2. Qwen 3 pts, 3. DeepSeek 0 pts",
    );
  });

  it("skips a member whose ranking fails and needs two answers", async () => {
    expect(await rankPeers(async () => "A", "q", finals.slice(0, 1), 1)).toBeNull();
    const res = await rankPeers(
      async (label) => (label === "Qwen" ? Promise.reject(new Error("down")) : "A, B, C"),
      "q",
      finals,
      1,
    );
    expect(res!.rankings).toBe(2);
  });
});
