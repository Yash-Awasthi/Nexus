// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  classify,
  RuleClassifier,
  ClassifierPipeline,
  ClassifierRule,
  DEFAULT_RULES,
} from "../src/index.js";

const TECH_DOC = `
This document describes the API endpoint for user authentication.
The function \`getUser(id: string)\` returns an async Promise.
export interface User { id: string; email: string; }
\`\`\`ts
const user = await getUser("123");
\`\`\`
`;

const LEGAL_DOC = `
AGREEMENT dated this day, between Party A and Party B.
WHEREAS the parties wish to enter into this agreement,
pursuant to the terms and conditions set forth herein.
The liability of each party shall be limited accordingly.
Indemnification clauses apply to all defendants and plaintiffs.
`;

const FINANCE_DOC = `
Q3 Fiscal Report — Revenue grew by 23% YoY.
EBITDA margin improved to 18%. Total assets: $4.2M.
Net profit after liabilities: $1.1M. Cash flow positive.
Balance sheet remains strong.
`;

const HR_DOC = `
Employee Onboarding Policy.
All new employees must complete benefits enrollment within 30 days.
PTO accrual begins after 90 days. Salary reviews occur annually.
Human resources contact: hr@company.com. Code of conduct applies.
`;

const RESEARCH_DOC = `
Abstract: This study presents a novel methodology for analyzing dataset quality.
The hypothesis was tested via controlled experiment.
Findings indicate p < 0.05 significance. See references: Smith et al. 2024.
Conclusion: methodology is sound.
`;

const SUPPORT_DOC = `
Ticket #4521 — Priority: High
Customer reports error when logging in.
Bug: session token expires immediately.
Severity: critical. Escalated to backend team. Workaround applied.
`;

describe("classify (default rules)", () => {
  it("classifies technical document correctly", () => {
    const r = classify(TECH_DOC);
    expect(r.category).toBe("technical");
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("classifies legal document correctly", () => {
    const r = classify(LEGAL_DOC);
    expect(r.category).toBe("legal");
  });

  it("classifies financial document correctly", () => {
    const r = classify(FINANCE_DOC);
    expect(r.category).toBe("financial");
  });

  it("classifies HR document correctly", () => {
    const r = classify(HR_DOC);
    expect(r.category).toBe("hr");
  });

  it("classifies research document correctly", () => {
    const r = classify(RESEARCH_DOC);
    expect(r.category).toBe("research");
  });

  it("classifies support document correctly", () => {
    const r = classify(SUPPORT_DOC);
    expect(r.category).toBe("support");
  });

  it("returns general for content with no matches", () => {
    const r = classify("hello world foo bar baz");
    expect(r.category).toBe("general");
  });

  it("returns confidence in [0, 1]", () => {
    const r = classify(TECH_DOC);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("returns matchedRules array", () => {
    const r = classify(TECH_DOC);
    expect(Array.isArray(r.matchedRules)).toBe(true);
    expect(r.matchedRules!.length).toBeGreaterThan(0);
  });

  it("returns durationMs and classifiedAt", () => {
    const r = classify(TECH_DOC);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof r.classifiedAt).toBe("string");
  });
});

describe("RuleClassifier", () => {
  it("accepts custom rules", () => {
    const rules: ClassifierRule[] = [
      { name: "custom-recipe", category: "recipe", keywords: ["ingredients", "bake", "oven"] },
    ];
    const clf = new RuleClassifier(rules);
    const r = clf.classify("Mix the ingredients and bake in the oven at 350°F.");
    expect(r.category).toBe("recipe");
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("uses weight multiplier", () => {
    const low: ClassifierRule[]  = [{ name: "a", category: "a", keywords: ["hello"], weight: 0.1 }];
    const high: ClassifierRule[] = [{ name: "b", category: "b", keywords: ["hello"], weight: 2.0 }];
    const rLow  = new RuleClassifier(low).classify("hello hello hello");
    const rHigh = new RuleClassifier(high).classify("hello hello hello");
    expect(rHigh.confidence).toBeGreaterThan(rLow.confidence);
  });

  it("handles empty content gracefully", () => {
    const clf = new RuleClassifier();
    const r = clf.classify("");
    expect(r.category).toBe("general");
  });
});

describe("ClassifierPipeline", () => {
  it("returns highest-confidence result across classifiers", () => {
    const lowConf = new RuleClassifier([
      { name: "a", category: "a", keywords: ["foo"], weight: 0.1 },
    ]);
    const highConf = new RuleClassifier(DEFAULT_RULES);
    const pipeline = new ClassifierPipeline([lowConf, highConf]);
    const r = pipeline.classify(TECH_DOC);
    expect(r.category).toBe("technical");
  });

  it("handles empty pipeline", () => {
    const pipeline = new ClassifierPipeline([]);
    const r = pipeline.classify("anything");
    expect(r.category).toBe("general");
  });
});
