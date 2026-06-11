import { BrowserExecutionAdapter } from "../orchestration/browser-adapter";
import { ScrapingExecutionAdapter } from "../orchestration/scraping-adapter";
import { EnvironmentTelemetry } from "../orchestration/environment-telemetry";

describe("Milestone 2 & 3: Bounded Browser & Bounded Scraping Quotas", () => {
  let telemetry: EnvironmentTelemetry;

  beforeEach(() => {
    telemetry = new EnvironmentTelemetry();
  });

  describe("Browser Execution Adapter Controls", () => {
    it("should allow safe navigations and update environment telemetry", async () => {
      const adapter = new BrowserExecutionAdapter(telemetry, true); // true for simulated offline mode
      const result = await adapter.executeBrowserTask({
        id: "task-b1",
        url: "https://github.com",
        actions: [{ type: "navigate", value: "https://news.ycombinator.com" }, { type: "screenshot" }],
        timeoutMs: 5000
      });

      expect(result.success).toBe(true);
      expect(result.screenshotUrl).toBe("http://localhost:4566/screenshots/task-b1.png");
      expect(telemetry.navigationHistory).toContain("https://github.com");
      expect(telemetry.navigationHistory).toContain("https://news.ycombinator.com");
    });

    it("should block navigation safety attempts to restricted URL bounds", async () => {
      const adapter = new BrowserExecutionAdapter(telemetry, true);

      // Block metadata private IPs
      const res1 = await adapter.executeBrowserTask({
        id: "task-b2",
        url: "http://169.254.169.254/latest/meta-data",
        actions: [],
        timeoutMs: 5000
      });
      expect(res1.success).toBe(false);
      expect(res1.content).toBe("BLOCKED_BY_SAFETY_POLICY");

      // Block local path access
      const res2 = await adapter.executeBrowserTask({
        id: "task-b3",
        url: "file:///etc/passwd",
        actions: [],
        timeoutMs: 5000
      });
      expect(res2.success).toBe(false);
      expect(res2.content).toBe("BLOCKED_BY_SAFETY_POLICY");
    });

    it("should reject redirect steps traversing safety protocol blocks", async () => {
      const adapter = new BrowserExecutionAdapter(telemetry, true);
      const res = await adapter.executeBrowserTask({
        id: "task-b4",
        url: "https://github.com",
        actions: [{ type: "navigate", value: "file:///C:/Users/yasha/Desktop/secrets.json" }],
        timeoutMs: 5000
      });
      expect(res.success).toBe(false);
      expect(res.content).toBe("BLOCKED_BY_SAFETY_POLICY");
    });

    it("should enforce execution session timeout boundary limits", async () => {
      const adapter = new BrowserExecutionAdapter(telemetry, true);
      const res = await adapter.executeBrowserTask({
        id: "task-b5",
        url: "https://github.com",
        actions: [],
        timeoutMs: 20 // Ultra small timeout limit
      });
      expect(res.success).toBe(false);
      expect(res.content).toBe("TIMEOUT_BREACHED");
    });
  });

  describe("Bounded Scraping Crawler Controls", () => {
    it("should scrape elements up to cumulative request ceilings", async () => {
      const adapter = new ScrapingExecutionAdapter(telemetry, true);
      const res = await adapter.executeScrapingTask({
        id: "task-s1",
        url: "https://github.com",
        selectors: [".repo-title", ".star-button"],
        maxDepth: 1,
        maxRequests: 3
      });

      expect(res.success).toBe(true);
      expect(res.requestsCount).toBe(3); // capped at maxRequests ceiling
      expect(res.bytesFetched).toBe(450); // 3 * 150 mock size bytes
      expect(res.data[".repo-title"]).toContain("Scraped content");
      expect(telemetry.totalBytesFetched).toBe(450);
    });

    it("should block scraping access to private metadata subnet destinations", async () => {
      const adapter = new ScrapingExecutionAdapter(telemetry, true);
      const res = await adapter.executeScrapingTask({
        id: "task-s2",
        url: "http://169.254.169.254/latest/meta-data",
        selectors: ["*"],
        maxRequests: 5
      });

      expect(res.success).toBe(false);
      expect(res.data.error).toBe("BLOCKED_BY_SAFETY_POLICY");
    });
  });
});
