import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { probeFlociHealth, resolveFlociEndpoint } from "../orchestration/floci-client";
import { IExecutionContext } from "../orchestration/interfaces/execution.interface";

const runIntegration = process.env.GHOSTSTACK_FLOCI_INTEGRATION === "1";

(runIntegration ? describe : describe.skip)("Floci integration (requires running emulator)", () => {
  const context: IExecutionContext = {
    taskId: "integration-01",
    startTime: new Date(),
    attempt: 1,
    environment: {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  };

  beforeAll(async () => {
    const health = await probeFlociHealth(resolveFlociEndpoint(), 8000);
    if (!health.reachable) {
      throw new Error(`Floci not reachable for integration tests: ${health.error}`);
    }
  });

  it("health probe succeeds against live Floci", async () => {
    const health = await probeFlociHealth(resolveFlociEndpoint());
    expect(health.reachable).toBe(true);
    expect(health.healthPath).toBeDefined();
  });

  it("creates DynamoDB table in strict mode", async () => {
    const adapter = new FlociExecutionAdapter({
      endpoint: resolveFlociEndpoint(),
      strict: true,
      allowMockFallback: false
    });
    const tableName = `ghoststack-ddb-${Date.now()}`;
    const result = await adapter.execute(
      {
        type: "floci",
        payload: { action: "create_dynamodb_table", tableName }
      },
      context
    );
    expect(result.mocked).toBe(false);
    expect(result.status).toBe("success");
  });

  it("creates and invokes Lambda function", async () => {
    const adapter = new FlociExecutionAdapter({
      endpoint: resolveFlociEndpoint(),
      strict: true,
      allowMockFallback: false
    });
    const functionName = `ghoststack-fn-${Date.now()}`;
    const createResult = await adapter.execute(
      {
        type: "floci",
        payload: {
          action: "create_lambda",
          functionName,
          handlerBody: "JSON.stringify({ message: 'ghoststack-it' })"
        }
      },
      context
    );
    expect(createResult.mocked).toBe(false);
    expect(createResult.status).toBe("success");

    const invokeResult = await adapter.execute(
      {
        type: "floci",
        payload: {
          action: "invoke_lambda",
          functionName,
          payload: { ping: true }
        }
      },
      context
    );
    expect(invokeResult.mocked).toBe(false);
    expect(invokeResult.status).toBe("success");
    expect(JSON.stringify(invokeResult.data)).toContain("ghoststack-it");

    await adapter.execute(
      { type: "floci", payload: { action: "delete_lambda", functionName } },
      context
    );
  }, 120000);

  it("creates S3 bucket without mock fallback in strict mode", async () => {
    const adapter = new FlociExecutionAdapter({
      endpoint: resolveFlociEndpoint(),
      strict: true,
      allowMockFallback: false
    });
    const bucketName = `ghoststack-it-${Date.now()}`;
    const result = await adapter.execute(
      {
        type: "floci",
        payload: { action: "create_s3_bucket", bucketName }
      },
      context
    );
    expect(result.mocked).toBe(false);
    expect(result.status).toBe("success");
  });
});
