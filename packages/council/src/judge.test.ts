// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { judgeAgreement } from "./agreement.js";
import { runCouncilDebate, type IStreamingTransport } from "./debate.js";

const finals = [
  { label: "A", text: "Reasoning.\nFINAL: Yes, adopt the new framework." },
  { label: "B", text: "FINAL: No, do not adopt the new framework." },
  { label: "C", text: "FINAL: Go ahead and switch to it." },
];

describe("judgeAgreement", () => {
  it("groups members by the position the model names, whatever the wording", async () => {
    let prompt = "";
    const res = await judgeAgreement(
      async (p) => {
        prompt = p;
        return 'Sure:\n{"groups":[{"members":["A","C"],"position":"adopt it"},{"members":["B"],"position":"do not adopt"}]}';
      },
      "Should we adopt the framework?",
      finals,
    );
    expect(prompt).toContain("A: Yes, adopt the new framework.");
    expect(prompt).toContain("yes and no");
    expect(res.method).toBe("model");
    expect(res.agreement).toMatchObject({ agreeing: ["A", "C"], total: 3, agreement: 0.67 });
    expect(res.groups).toEqual([
      { members: ["A", "C"], position: "adopt it" },
      { members: ["B"], position: "do not adopt" },
    ]);
  });

  it("reports no majority when every member stands alone, and keeps members the model skipped", async () => {
    const res = await judgeAgreement(
      async () =>
        '{"groups":[{"members":["A"],"position":"yes"},{"members":["B"],"position":"no"}]}',
      "q",
      finals,
    );
    expect(res.agreement).toBeNull();
    expect(res.groups.map((g) => g.members)).toEqual([["A"], ["B"], ["C"]]);
  });

  it("throws on a reply it cannot read, so the caller can fall back", async () => {
    await expect(judgeAgreement(async () => "they mostly agree", "q", finals)).rejects.toThrow();
    await expect(
      judgeAgreement(async () => '{"groups":[{"members":["Z"],"position":"x"}]}', "q", finals),
    ).rejects.toThrow();
  });
});

describe("runCouncilDebate with a judge", () => {
  const transport = (texts: Record<string, string>): IStreamingTransport => ({
    async streamMember(member, _messages, onDelta) {
      const text = texts[member.label]!;
      onDelta(text);
      return { text, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  });
  const members = ["A", "B", "C"].map((label) => ({ label, provider: "p", model: "m" }));
  const texts = Object.fromEntries(finals.map((f) => [f.label, f.text]));
  const noop = { onDelta: () => {}, onMemberError: () => {} };

  it("uses the judge's groups for the verdict", async () => {
    const out = await runCouncilDebate(
      transport(texts),
      {
        message: "Adopt?",
        members,
        judge: async () =>
          '{"groups":[{"members":["A","C"],"position":"adopt"},{"members":["B"],"position":"do not"}]}',
      },
      noop,
    );
    expect(out.judgedBy).toBe("model");
    expect(out.agreement?.agreeing).toEqual(["A", "C"]);
    expect(out.positions).toHaveLength(2);
  });

  it("falls back to word overlap when the judge fails", async () => {
    const out = await runCouncilDebate(
      transport(texts),
      { message: "Adopt?", members, judge: async () => Promise.reject(new Error("down")) },
      noop,
    );
    expect(out.judgedBy).toBe("overlap");
    // Overlap sees three different wordings, so it finds no shared position at all.
    expect(out.agreement).toBeNull();
    expect(out.positions).toHaveLength(3);
  });
});
