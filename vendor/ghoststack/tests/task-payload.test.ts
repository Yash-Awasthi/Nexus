import { buildQueuePayloadFromTask } from "../orchestration/task-payload";
import { Task } from "../orchestration/task-router";

describe("buildQueuePayloadFromTask", () => {
  it("uses explicit type/action/arguments when provided", () => {
    const task: Task = {
      id: "t1",
      title: "Scrape",
      description: "ignored for typed tasks",
      priority: "normal",
      status: "pending",
      dependencies: [],
      type: "scraping",
      action: "scrape_url",
      arguments: { url: "https://example.com", selectors: ["h1"] }
    };
    const payload = buildQueuePayloadFromTask(task);
    expect(payload.type).toBe("scraping");
    expect(payload.payload.action).toBe("scrape_url");
    expect(payload.payload.url).toBe("https://example.com");
  });

  it("falls back to legacy description keyword routing", () => {
    const task: Task = {
      id: "my-bucket",
      title: "S3",
      description: "floci create bucket action",
      priority: "high",
      status: "pending",
      dependencies: []
    };
    const payload = buildQueuePayloadFromTask(task);
    expect(payload.type).toBe("floci");
    expect(payload.payload.action).toBe("create_s3_bucket");
    expect(payload.payload.bucketName).toBe("my-bucket");
  });
});
