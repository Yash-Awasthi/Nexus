// SPDX-License-Identifier: Apache-2.0
/**
 * WebSearchAdapter — routes "search" and "answer" task types through
 * the WebSearchEngine (search classification → research → LLM synthesis).
 *
 * Task payload shape:
 *   { query: string, mode?: "speed"|"balanced"|"quality", history?: ChatMessage[] }
 */

import type { IExecutionContext } from "./interfaces/execution.interface.js";
import type { ILanguageModel, ChatMessage } from "./interfaces/language-model.interface.js";
import { createLanguageModel } from "./language-model.js";
import type { SearchMode } from "./web-search-engine.js";
import { WebSearchEngine } from "./web-search-engine.js";

export class WebSearchAdapter {
  private engine: WebSearchEngine;

  constructor(opts?: { llm?: ILanguageModel; tavilyApiKey?: string; deepScrape?: boolean }) {
    const llm =
      opts?.llm ??
      createLanguageModel({
        provider: "groq",
        groqApiKey: process.env.GROQ_API_KEY,
      });
    this.engine = new WebSearchEngine({
      llm,
      tavilyApiKey: opts?.tavilyApiKey ?? process.env.TAVILY_API_KEY,
      deepScrape: opts?.deepScrape ?? false,
      maxIterations: 3,
    });
  }

  canExecute(taskType: string): boolean {
    return taskType === "search" || taskType === "answer" || taskType === "web_search";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(task: any, context: IExecutionContext): Promise<Record<string, unknown>> {
    const payload = task?.payload ?? task ?? {};
    const query: string =
      payload.query ?? payload.objective ?? payload.prompt ?? payload.input ?? "";
    const mode: SearchMode = payload.mode ?? "balanced";
    const history: ChatMessage[] = Array.isArray(payload.history) ? payload.history : [];

    if (!query) {
      return { success: false, error: "No query provided in task payload" };
    }

    context.logger.info(`WebSearch: [${mode}] "${query.slice(0, 80)}..."`);

    try {
      const result = await this.engine.search(query, { mode, history });
      context.logger.info(
        `WebSearch complete: ${result.findings.length} findings, ${result.queriesUsed.length} queries`,
      );
      return {
        success: true,
        answer: result.answer,
        findings: result.findings,
        queriesUsed: result.queriesUsed,
        mode: result.mode,
        skippedSearch: result.skippedSearch,
        findingsCount: result.findings.length,
      };
    } catch (err: any) {
      context.logger.error(`WebSearch failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}
