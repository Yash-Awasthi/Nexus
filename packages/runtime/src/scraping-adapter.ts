// @ts-nocheck
import { IScrapingExecutionAdapter, IScrapingTask, IEnvironmentTelemetry } from "./interfaces/environment.interface.js";
import { IExecutionContext } from "./interfaces/execution.interface.js";
import { isSafeUrl } from "./security-utils.js";
import { getBridgeManager, BridgeManager } from "../runtime/bridge-manager.js";

export class ScrapingExecutionAdapter implements IScrapingExecutionAdapter {
  constructor(
    private telemetry: IEnvironmentTelemetry,
    private isOfflineMode = true
  ) {}

  canExecute(taskType: string): boolean {
    return taskType === "scraping";
  }

  async execute(task: any, context: IExecutionContext): Promise<any> {
    const payload = task.payload || {};
    const scrapingTask: IScrapingTask = {
      id: context.taskId,
      url: payload.url || "",
      selectors: payload.selectors || [],
      maxDepth: payload.maxDepth || 1,
      maxRequests: payload.maxRequests || 5
    };
    return this.executeScrapingTask(scrapingTask);
  }

  async executeScrapingTask(task: IScrapingTask): Promise<{
    success: boolean;
    data: Record<string, string>;
    requestsCount: number;
    bytesFetched: number;
  }> {
    const maxRequests = task.maxRequests || 5;
    let requestsCount = 0;
    let bytesFetched = 0;
    const data: Record<string, string> = {};

    // Safety checks: restrict recursive parsing of non-http destinations
    if (!isSafeUrl(task.url)) {
      return {
        success: false,
        data: { error: "BLOCKED_BY_SAFETY_POLICY" },
        requestsCount,
        bytesFetched
      };
    }

    if (this.isOfflineMode) {
      // Simulate crawling iterations bounded by maxRequests quota
      for (let i = 0; i < maxRequests; i++) {
        if (requestsCount >= maxRequests) {
          break;
        }
        requestsCount++;
        const simulatedBytes = 150; // mock size per request fetch
        bytesFetched += simulatedBytes;
        this.telemetry.recordFetch(simulatedBytes);
      }

      for (const selector of task.selectors) {
        data[selector] = `Scraped content for selector ${selector} at ${task.url}`;
      }

      return {
        success: true,
        data,
        requestsCount,
        bytesFetched
      };
    }

    // Adaptive web scraping via anti-detection engine bridge
    try {
      const mgr = getBridgeManager();
      const baseUrl = await mgr.url("scraping");

      // Choose stealth mode for sites likely to have bot protection
      const useStealthMode = task.url.includes("cloudflare") ||
        task.url.includes("linkedin") ||
        task.url.includes("twitter") ||
        (task as any).stealth === true;

      const endpoint = useStealthMode ? "/fetch_stealth" : "/fetch";

      const result = await BridgeManager.post<{
        success: boolean;
        url: string;
        status_code: number;
        html: string;
        text: string;
        extracted: Record<string, string>;
        pages_crawled: number;
        bytes_fetched: number;
        error: string;
      }>(baseUrl, endpoint, {
        url: task.url,
        selectors: task.selectors || [],
        timeout: 30_000,
        disable_resources: true,
        block_ads: true
      });

      if (!result.success) {
        return { success: false, data: { error: result.error }, requestsCount: 0, bytesFetched: 0 };
      }

      requestsCount = result.pages_crawled || 1;
      bytesFetched = result.bytes_fetched || 0;
      this.telemetry.recordFetch(bytesFetched);

      // Merge selector extractions + full text into data map
      for (const selector of task.selectors) {
        data[selector] = result.extracted?.[selector] ?? "";
      }
      if (!task.selectors.length) {
        data["__text__"] = result.text || result.html?.slice(0, 10_000) || "";
      }

      return { success: true, data, requestsCount, bytesFetched };
    } catch (err: any) {
      return {
        success: false,
        data: { error: err.message },
        requestsCount,
        bytesFetched
      };
    }
  }
}
