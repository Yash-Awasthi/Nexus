// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { SCRAPE_SOURCES, COUNCIL_TASK_TYPES } from "../src/index.js";
import type {
  ScrapeSource,
  ScrapeRequest,
  BatchScrapeRequest,
  ArticleOut,
  FinEventOut,
  ScrapeResponse,
  BatchScrapeResponse,
  IngestedEvent,
  Verdict,
  EventType,
  ProposalInput,
  ProposalOutcome,
  ModelVote,
  ProposalResult,
  CouncilRequest,
  CouncilResponse,
  CouncilTaskType,
} from "../src/index.js";

// ── SCRAPE_SOURCES ─────────────────────────────────────────────────────────────

describe("SCRAPE_SOURCES", () => {
  it("is a non-empty readonly tuple", () => {
    expect(SCRAPE_SOURCES.length).toBeGreaterThan(0);
  });

  it("contains the expected financial data sources", () => {
    const expected = [
      "bloomberg",
      "reuters",
      "edgar",
      "yahoo",
      "cnbc",
      "ft",
      "benzinga",
      "google_news",
      "google_serp",
      "investingcom",
      "marketwatch",
      "rss",
      "seekingalpha",
    ];
    for (const src of expected) {
      expect(SCRAPE_SOURCES).toContain(src);
    }
  });

  it("has exactly 13 sources", () => {
    expect(SCRAPE_SOURCES).toHaveLength(13);
  });

  it("contains no duplicates", () => {
    const unique = new Set(SCRAPE_SOURCES);
    expect(unique.size).toBe(SCRAPE_SOURCES.length);
  });
});

// ── ScrapeSource type guard ────────────────────────────────────────────────────

describe("ScrapeSource", () => {
  it("every element of SCRAPE_SOURCES is assignable to ScrapeSource", () => {
    const check = (s: ScrapeSource) => s;
    for (const src of SCRAPE_SOURCES) {
      expect(check(src)).toBe(src);
    }
  });
});

// ── ScrapeRequest shape ────────────────────────────────────────────────────────

describe("ScrapeRequest", () => {
  it("accepts a minimal request with only source", () => {
    const req: ScrapeRequest = { source: "bloomberg" };
    expect(req.source).toBe("bloomberg");
    expect(req.maxArticles).toBeUndefined();
    expect(req.maxAgeHours).toBeUndefined();
  });

  it("accepts a fully populated request", () => {
    const req: ScrapeRequest = { source: "reuters", maxArticles: 10, maxAgeHours: 4 };
    expect(req.source).toBe("reuters");
    expect(req.maxArticles).toBe(10);
    expect(req.maxAgeHours).toBe(4);
  });
});

describe("BatchScrapeRequest", () => {
  it("accepts an array of sources", () => {
    const req: BatchScrapeRequest = { sources: ["bloomberg", "reuters"] };
    expect(req.sources).toHaveLength(2);
  });
});

// ── ArticleOut shape ───────────────────────────────────────────────────────────

describe("ArticleOut", () => {
  it("contains all required fields", () => {
    const article: ArticleOut = {
      url: "https://bloomberg.com/article",
      title: "Fed raises rates",
      text: "The Federal Reserve raised interest rates...",
      source: "bloomberg",
      publishedAt: "2024-01-01T12:00:00Z",
      ageHours: 2,
      rawTickers: ["SPY", "QQQ"],
    };
    expect(article.url).toBeTruthy();
    expect(article.rawTickers).toHaveLength(2);
  });

  it("allows null publishedAt and ageHours", () => {
    const article: ArticleOut = {
      url: "https://example.com",
      title: "No date",
      text: "...",
      source: "rss",
      publishedAt: null,
      ageHours: null,
      rawTickers: [],
    };
    expect(article.publishedAt).toBeNull();
    expect(article.ageHours).toBeNull();
  });
});

// ── FinEventOut / Verdict / EventType ─────────────────────────────────────────

describe("Verdict type", () => {
  it("recognizes all four verdicts", () => {
    const verdicts: Verdict[] = ["INVEST", "OBSERVE", "CAUTIOUS", "PULL_OUT"];
    expect(verdicts).toHaveLength(4);
  });
});

describe("EventType", () => {
  it("covers the expected event categories", () => {
    const types: EventType[] = [
      "earnings",
      "guidance",
      "price_target_change",
      "analyst_upgrade",
      "analyst_downgrade",
      "merger_acquisition",
      "regulatory_decision",
      "product_launch",
      "management_change",
      "market_movement",
      "investment_activity",
      "geopolitical_event",
      "bankrupt",
      "ipo",
      "other",
    ];
    expect(types).toHaveLength(15);
    for (const t of types) {
      expect(typeof t).toBe("string");
    }
  });
});

describe("FinEventOut", () => {
  it("has all required fields with correct types", () => {
    const event: FinEventOut = {
      subject: "Apple Q4 Earnings",
      eventType: "earnings",
      tickers: ["AAPL"],
      impactDirection: "positive",
      signalScore: 0.85,
      confidence: 0.9,
      verdict: "INVEST",
      heuristicImpact: 1.2,
      divergenceFlag: false,
      sources: ["bloomberg"],
      articles: ["https://bloomberg.com/aapl"],
      timestamp: "2024-01-01T12:00:00Z",
      reasoning: "Beat expectations by 15%",
      magnitude: "high",
      novelty: "breaking",
      actionability: "high",
      affectedEntities: ["Apple Inc"],
      secondOrderEffects: ["MSFT", "GOOGL"],
      sectorImpact: "Technology",
      keyMetrics: { eps: 2.18 },
    };

    expect(event.tickers).toContain("AAPL");
    expect(event.verdict).toBe("INVEST");
    expect(event.divergenceFlag).toBe(false);
    expect(event.magnitude).toBe("high");
    expect(event.novelty).toBe("breaking");
    expect(event.actionability).toBe("high");
  });
});

// ── ScrapeResponse / BatchScrapeResponse ──────────────────────────────────────

describe("ScrapeResponse", () => {
  it("has source, articles, events, durationMs, scrapedAt", () => {
    const resp: ScrapeResponse = {
      source: "yahoo",
      articles: [],
      events: [],
      durationMs: 420,
      scrapedAt: "2024-01-01T12:00:00Z",
    };
    expect(resp.source).toBe("yahoo");
    expect(resp.durationMs).toBe(420);
  });
});

describe("BatchScrapeResponse", () => {
  it("aggregates results with total counts", () => {
    const resp: BatchScrapeResponse = {
      results: [],
      totalArticles: 0,
      totalEvents: 0,
      durationMs: 1000,
      scrapedAt: "2024-01-01T12:00:00Z",
    };
    expect(resp.totalArticles).toBe(0);
    expect(resp.totalEvents).toBe(0);
  });
});

// ── IngestedEvent ──────────────────────────────────────────────────────────────

describe("IngestedEvent", () => {
  it("wraps a FinEventOut with id, source, and ingestedAt", () => {
    const event: FinEventOut = {
      subject: "Test",
      eventType: "other",
      tickers: [],
      impactDirection: "neutral",
      signalScore: 0,
      confidence: 0,
      verdict: "OBSERVE",
      heuristicImpact: 0,
      divergenceFlag: false,
      sources: [],
      articles: [],
      timestamp: "2024-01-01T00:00:00Z",
      reasoning: "",
      magnitude: "low",
      novelty: "standard",
      actionability: "low",
      affectedEntities: [],
      secondOrderEffects: [],
      sectorImpact: "",
      keyMetrics: {},
    };
    const ingested: IngestedEvent = {
      id: "evt-001",
      source: "rss",
      event,
      ingestedAt: "2024-01-01T00:01:00Z",
    };
    expect(ingested.id).toBe("evt-001");
    expect(ingested.source).toBe("rss");
  });
});

// ── COUNCIL_TASK_TYPES ─────────────────────────────────────────────────────────

describe("COUNCIL_TASK_TYPES", () => {
  it("contains exactly council.deliberate and council.evaluate", () => {
    expect(COUNCIL_TASK_TYPES).toContain("council.deliberate");
    expect(COUNCIL_TASK_TYPES).toContain("council.evaluate");
    expect(COUNCIL_TASK_TYPES).toHaveLength(2);
  });

  it("has no duplicates", () => {
    const unique = new Set(COUNCIL_TASK_TYPES);
    expect(unique.size).toBe(COUNCIL_TASK_TYPES.length);
  });
});

describe("CouncilTaskType", () => {
  it("both task type values are assignable to CouncilTaskType", () => {
    const check = (t: CouncilTaskType) => t;
    expect(check("council.deliberate")).toBe("council.deliberate");
    expect(check("council.evaluate")).toBe("council.evaluate");
  });
});

// ── ProposalInput ──────────────────────────────────────────────────────────────

describe("ProposalInput", () => {
  it("requires title and description, context and models optional", () => {
    const minimal: ProposalInput = {
      title: "Invest in AAPL?",
      description: "Given Q4 earnings beat, should we invest?",
    };
    expect(minimal.title).toBeTruthy();
    expect(minimal.context).toBeUndefined();
    expect(minimal.models).toBeUndefined();
  });

  it("accepts optional context and models", () => {
    const full: ProposalInput = {
      title: "Invest in MSFT?",
      description: "Azure growth exceeds expectations",
      context: { tickers: ["MSFT"], events: ["earnings"] },
      models: ["gpt-4o", "claude-3-5-sonnet"],
    };
    expect(full.context?.["tickers"]).toBeDefined();
    expect(full.models).toHaveLength(2);
  });
});

// ── ProposalOutcome ────────────────────────────────────────────────────────────

describe("ProposalOutcome", () => {
  it("covers approved, rejected, deferred", () => {
    const outcomes: ProposalOutcome[] = ["approved", "rejected", "deferred"];
    expect(outcomes).toHaveLength(3);
  });
});

// ── ModelVote ──────────────────────────────────────────────────────────────────

describe("ModelVote", () => {
  it("captures vote, reasoning, confidence, and latency", () => {
    const vote: ModelVote = {
      model: "gpt-4o",
      provider: "openai",
      vote: "yes",
      reasoning: "Strong fundamentals",
      confidence: 0.9,
      latencyMs: 1200,
    };
    expect(vote.vote).toBe("yes");
    expect(vote.confidence).toBe(0.9);
    expect(vote.latencyMs).toBe(1200);
  });

  it("supports abstain vote", () => {
    const vote: ModelVote = {
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      vote: "abstain",
      reasoning: "Insufficient data",
      confidence: 0.4,
      latencyMs: 800,
    };
    expect(vote.vote).toBe("abstain");
  });
});

// ── ProposalResult shape ───────────────────────────────────────────────────────

describe("ProposalResult", () => {
  it("contains all required fields", () => {
    const result: ProposalResult = {
      proposalId: "prop-001",
      title: "Buy AAPL?",
      outcome: "approved",
      votes: [],
      consensus: 2,
      dissent: 1,
      majority: "yes",
      summary: "2 of 3 models voted yes",
      deliberatedAt: "2024-01-01T12:00:00Z",
      totalLatencyMs: 3000,
    };
    expect(result.proposalId).toBe("prop-001");
    expect(result.outcome).toBe("approved");
    expect(result.majority).toBe("yes");
  });

  it("supports tie majority", () => {
    const result: ProposalResult = {
      proposalId: "prop-002",
      title: "Sell GOOGL?",
      outcome: "deferred",
      votes: [],
      consensus: 1,
      dissent: 1,
      majority: "tie",
      summary: "Split decision",
      deliberatedAt: "2024-01-01T12:00:00Z",
      totalLatencyMs: 2500,
    };
    expect(result.majority).toBe("tie");
    expect(result.outcome).toBe("deferred");
  });
});

// ── CouncilRequest / CouncilResponse ──────────────────────────────────────────

describe("CouncilRequest", () => {
  it("wraps a ProposalInput with optional budget and timeout", () => {
    const req: CouncilRequest = {
      proposal: { title: "Test", description: "test proposal" },
    };
    expect(req.proposal.title).toBe("Test");
    expect(req.budgetUsd).toBeUndefined();
    expect(req.timeoutMs).toBeUndefined();
  });

  it("accepts budget and timeout constraints", () => {
    const req: CouncilRequest = {
      proposal: { title: "Test", description: "..." },
      budgetUsd: 0.5,
      timeoutMs: 30_000,
    };
    expect(req.budgetUsd).toBe(0.5);
    expect(req.timeoutMs).toBe(30_000);
  });
});

describe("CouncilResponse", () => {
  it("ok:true carries a ProposalResult", () => {
    const resp: CouncilResponse = {
      ok: true,
      result: {
        proposalId: "prop-003",
        title: "Buy?",
        outcome: "approved",
        votes: [],
        consensus: 3,
        dissent: 0,
        majority: "yes",
        summary: "Unanimous",
        deliberatedAt: "2024-01-01T12:00:00Z",
        totalLatencyMs: 2000,
      },
    };
    expect(resp.ok).toBe(true);
    expect(resp.result?.outcome).toBe("approved");
  });

  it("ok:false carries an error string", () => {
    const resp: CouncilResponse = { ok: false, error: "budget exceeded" };
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/budget/i);
  });
});
