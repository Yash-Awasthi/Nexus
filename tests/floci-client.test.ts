import { normalizeFlociEndpoint, probeFlociHealth } from "../orchestration/floci-client";

describe("floci-client", () => {
  it("normalizes trailing slashes", () => {
    expect(normalizeFlociEndpoint("http://localhost:4566/")).toBe("http://localhost:4566");
  });

  it("reports unreachable for dead port", async () => {
    const status = await probeFlociHealth("http://127.0.0.1:9", 500);
    expect(status.reachable).toBe(false);
    expect(status.error).toBeDefined();
  });
});
