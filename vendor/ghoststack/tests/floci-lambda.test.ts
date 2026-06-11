import { normalizeLambdaInvokeBody } from "../orchestration/floci-lambda";

describe("floci-lambda helpers", () => {
  it("parses JSON invoke response bodies", () => {
    expect(normalizeLambdaInvokeBody('{"statusCode":200}')).toEqual({ statusCode: 200 });
  });

  it("returns raw string when body is not JSON", () => {
    expect(normalizeLambdaInvokeBody("plain-text")).toBe("plain-text");
  });
});
