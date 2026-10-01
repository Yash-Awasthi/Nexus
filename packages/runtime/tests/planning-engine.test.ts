// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import { PlanningEngine } from "../src/planning-engine.js";

describe("PlanningEngine — keyword-based blueprint selection", () => {
  const engine = new PlanningEngine(); // no LLM → keyword matching

  it("returns a plan with a unique planId and matching objective", async () => {
    const trace = await engine.generatePlan("run an ingestion pipeline");
    expect(trace.planId).toMatch(/^plan-/);
    expect(trace.objective).toBe("run an ingestion pipeline");
    expect(trace.timestamp).toBeInstanceOf(Date);
  });

  it("selects the ingestion blueprint for 'data ingestion' objectives", async () => {
    const trace = await engine.generatePlan("create an ingestion workflow");
    expect(trace.synthesisResults.some((t) => t.action === "create_s3_bucket")).toBe(true);
    expect(trace.synthesisResults.some((t) => t.action === "create_sqs_queue")).toBe(true);
  });

  it("selects the scraper blueprint for scraper objectives", async () => {
    const trace = await engine.generatePlan("deploy a web scraper");
    expect(trace.synthesisResults.some((t) => t.action === "deploy_scraper_lambda")).toBe(true);
  });

  it("selects the backup blueprint for backup objectives", async () => {
    const trace = await engine.generatePlan("set up a secure backup");
    expect(trace.synthesisResults.some((t) => t.action === "create_iam_role")).toBe(true);
  });

  it("selects the search blueprint for standalone search objectives", async () => {
    const trace = await engine.generatePlan("run a web search");
    expect(trace.synthesisResults.some((t) => t.action === "web_search")).toBe(true);
  });

  it("selects the code blueprint for code generation objectives", async () => {
    const trace = await engine.generatePlan("run the code agent");
    expect(trace.synthesisResults.some((t) => t.action === "code_agent_run")).toBe(true);
  });

  it("selects the dangerous blueprint for dangerous objectives", async () => {
    const trace = await engine.generatePlan("execute a dangerous operation");
    expect(trace.synthesisResults.some((t) => t.action === "request_approval")).toBe(true);
  });

  it("selects the delete blueprint for deletion objectives", async () => {
    const trace = await engine.generatePlan("delete old resources");
    expect(trace.synthesisResults.some((t) => t.action === "delete_resources")).toBe(true);
  });

  it("falls back to default blueprint for unknown objectives", async () => {
    const trace = await engine.generatePlan("something completely novel");
    expect(trace.synthesisResults.length).toBeGreaterThan(0);
    // Default template uses generic_execution action
    expect(trace.synthesisResults.some((t) => t.action === "generic_execution")).toBe(true);
  });

  it("resolves dependency IDs as task IDs within the same plan", async () => {
    const trace = await engine.generatePlan("run an ingestion pipeline");
    // create_sqs_queue depends on create_s3_bucket
    const sqsTask = trace.synthesisResults.find((t) => t.action === "create_sqs_queue");
    expect(sqsTask).toBeDefined();
    expect(sqsTask!.dependencies.length).toBeGreaterThan(0);
    // The dependency ID should match the s3 task's ID
    const s3Task = trace.synthesisResults.find((t) => t.action === "create_s3_bucket");
    expect(sqsTask!.dependencies).toContain(s3Task!.taskId);
  });

  it("extracts key=value argument overrides from objective", async () => {
    const trace = await engine.generatePlan("deploy a web scraper memoryMb=1024");
    const lambdaTask = trace.synthesisResults.find((t) => t.action === "deploy_scraper_lambda");
    expect(lambdaTask?.arguments?.memoryMb).toBe(1024);
  });

  it("assigns 'high' priority to the first task and 'medium' to subsequent ones", async () => {
    const trace = await engine.generatePlan("run an ingestion pipeline");
    expect(trace.synthesisResults[0]?.priority).toBe("high");
    expect(trace.synthesisResults[1]?.priority).toBe("medium");
  });

  it("assigns adapterType from template or falls back to 'floci'", async () => {
    const searchTrace = await engine.generatePlan("run a web search");
    const searchTask = searchTrace.synthesisResults.find((t) => t.action === "web_search");
    expect(searchTask?.adapterType).toBe("search");

    const ingestTrace = await engine.generatePlan("run an ingestion pipeline");
    expect(ingestTrace.synthesisResults[0]?.adapterType).toBe("floci");
  });
});

describe("PlanningEngine — LLM-backed blueprint selection", () => {
  it("delegates blueprint selection to the LLM when provided", async () => {
    const mockLLM = {
      generateObject: vi.fn().mockResolvedValue({ blueprintKey: "ingestion" }),
    };
    const engine = new PlanningEngine(mockLLM as never);
    const trace = await engine.generatePlan("ingest some data please");

    // LLM's generateObject was consulted
    expect(mockLLM.generateObject).toHaveBeenCalled();
    // Should produce a valid plan with ingestion tasks
    expect(trace.synthesisResults.some((t) => t.action === "create_s3_bucket")).toBe(true);
  });

  it("falls back to keyword matching when LLM returns unrecognised key", async () => {
    const mockLLM = {
      generateObject: vi.fn().mockResolvedValue({ blueprintKey: "nonexistent_key" }),
    };
    const engine = new PlanningEngine(mockLLM as never);
    const trace = await engine.generatePlan("create an ingestion workflow");

    // Should still produce a valid plan via keyword fallback
    expect(trace.synthesisResults.length).toBeGreaterThan(0);
    expect(trace.synthesisResults.some((t) => t.action === "create_s3_bucket")).toBe(true);
  });

  it("falls back to keyword matching when LLM throws", async () => {
    const mockLLM = {
      generateObject: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    };
    const engine = new PlanningEngine(mockLLM as never);
    const trace = await engine.generatePlan("deploy a web scraper");

    // Keyword fallback should kick in
    expect(trace.synthesisResults.some((t) => t.action === "deploy_scraper_lambda")).toBe(true);
  });
});
