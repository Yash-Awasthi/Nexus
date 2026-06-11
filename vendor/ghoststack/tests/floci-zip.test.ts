import { buildMinimalZip, buildNodeLambdaHandlerZip } from "../orchestration/floci-zip";

describe("floci-zip", () => {
  it("builds a valid minimal zip with index.js", () => {
    const zip = buildNodeLambdaHandlerZip("'hello'");
    expect(zip.length).toBeGreaterThan(100);
    expect(zip[0]).toBe(0x50); // PK
    expect(zip[1]).toBe(0x4b);
  });

  it("builds zip for arbitrary filename", () => {
    const zip = buildMinimalZip("test.txt", Buffer.from("data"));
    expect(zip.subarray(0, 2).toString()).toBe("PK");
  });
});
