// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-ingest — Proxy to nexus-ingest FastAPI service.
 * Task types: ingest.scrape, ingest.scrape-batch
 */

import { defineAdapter, requireEnv, AdapterHttpError, type IExecutionContext } from "@nexus/plugin-sdk";
import type { ScrapeRequest, BatchScrapeRequest, ScrapeResponse, BatchScrapeResponse } from "@nexus/contracts";

export interface IngestScrapeTask extends ScrapeRequest { taskType: "ingest.scrape"; }
export interface IngestScrapeBatchTask extends BatchScrapeRequest { taskType: "ingest.scrape-batch"; }
export type IngestTask = IngestScrapeTask | IngestScrapeBatchTask;

async function execute(task: IngestTask, ctx: IExecutionContext): Promise<ScrapeResponse | BatchScrapeResponse> {
  const ingestUrl = requireEnv(ctx, "NEXUS_INGEST_URL");

  if (task.taskType === "ingest.scrape") {
    ctx.logger.info("ingest.scrape", { source: task.source });
    const { taskType: _, ...body } = task;
    const response = await fetch(`${ingestUrl}/scrape/${task.source}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new AdapterHttpError("nexus-adapter-ingest", response.status, await response.text());
    return response.json() as Promise<ScrapeResponse>;
  }

  // ingest.scrape-batch
  ctx.logger.info("ingest.scrape-batch", { sources: task.sources });
  const { taskType: _, ...body } = task;
  const response = await fetch(`${ingestUrl}/scrape/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new AdapterHttpError("nexus-adapter-ingest", response.status, await response.text());
  return response.json() as Promise<BatchScrapeResponse>;
}

export const ingestAdapter = defineAdapter<IngestTask, ScrapeResponse | BatchScrapeResponse>({
  name: "nexus-adapter-ingest", version: "0.1.0", capabilities: ["scraping.financial"],
  taskTypes: ["ingest.scrape", "ingest.scrape-batch"],
  execute,
});
export default ingestAdapter;
