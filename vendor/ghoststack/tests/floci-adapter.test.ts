import { FlociExecutionAdapter } from "../orchestration/floci-adapter";
import { IExecutionContext } from "../orchestration/interfaces/execution.interface";

describe("Milestone 2: Floci Client & Execution Adapter", () => {
  const prevStrict = process.env.GHOSTSTACK_FLOCI_STRICT;
  const prevMock = process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK;
  beforeAll(() => {
    process.env.GHOSTSTACK_FLOCI_STRICT = "0";
    process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK = "true";
    process.env.GHOSTSTACK_OFFLINE_MODE = "true";
  });
  afterAll(() => {
    if (prevStrict === undefined) delete process.env.GHOSTSTACK_FLOCI_STRICT;
    else process.env.GHOSTSTACK_FLOCI_STRICT = prevStrict;
    if (prevMock === undefined) delete process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK;
    else process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK = prevMock;
  });

  const context: IExecutionContext = {
    taskId: "task-01",
    startTime: new Date(),
    attempt: 1,
    environment: {},
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }
  };

  it("should match task types matching floci", () => {
    const adapter = new FlociExecutionAdapter();
    expect(adapter.canExecute("floci")).toBe(true);
    expect(adapter.canExecute("process")).toBe(false);
  });

  it("should execute S3 bucket creation action successfully with resilient local fallback", async () => {
    const adapter = new FlociExecutionAdapter({
      endpoint: "http://127.0.0.1:9",
      strict: false,
      allowMockFallback: true
    });

    const task = {
      type: "floci",
      payload: {
        action: "create_s3_bucket",
        bucketName: "ghoststack-test-bucket"
      }
    };

    const result = await adapter.execute(task, context);
    expect(result.status).toBe("success");
    expect(result.service).toBe("s3");
    expect(result.bucketName).toBe("ghoststack-test-bucket");
    expect(result.bucketUrl).toBe("http://127.0.0.1:9/ghoststack-test-bucket");
    expect(result.mocked).toBe(true);
  });

  it("should execute SQS queue creation action successfully with resilient local fallback", async () => {
    const adapter = new FlociExecutionAdapter({
      endpoint: "http://127.0.0.1:9",
      strict: false,
      allowMockFallback: true
    });

    const task = {
      type: "floci",
      payload: {
        action: "create_sqs_queue",
        queueName: "ghoststack-test-queue"
      }
    };

    const result = await adapter.execute(task, context);
    expect(result.status).toBe("success");
    expect(result.service).toBe("sqs");
    expect(result.queueName).toBe("ghoststack-test-queue");
    expect(result.queueUrl).toBe("http://127.0.0.1:9/000000000000/ghoststack-test-queue");
  });

  it("should execute DynamoDB table creation action successfully with resilient local fallback", async () => {
    const adapter = new FlociExecutionAdapter({
      endpoint: "http://127.0.0.1:9",
      strict: false,
      allowMockFallback: true
    });

    const task = {
      type: "floci",
      payload: {
        action: "create_dynamodb_table",
        tableName: "ghoststack-test-table"
      }
    };

    const result = await adapter.execute(task, context);
    expect(result.status).toBe("success");
    expect(result.service).toBe("dynamodb");
    expect(result.tableName).toBe("ghoststack-test-table");
  });

  it("invoke_lambda falls back to mock on unreachable endpoint", async () => {
    const adapter = new FlociExecutionAdapter({
      endpoint: "http://127.0.0.1:9",
      strict: false,
      allowMockFallback: true
    });
    const result = await adapter.execute(
      {
        type: "floci",
        payload: { action: "invoke_lambda", functionName: "test-fn", payload: { x: 1 } }
      },
      context
    );
    expect(result.status).toBe("success");
    expect(result.mocked).toBe(true);
    expect(result.service).toBe("lambda");
  });

  it("strict mode fails fast when Floci is not reachable", async () => {
    const adapter = new FlociExecutionAdapter({
      endpoint: "http://127.0.0.1:9",
      strict: true
    });
    const task = {
      type: "floci",
      payload: { action: "health" }
    };
    await expect(adapter.execute(task, context)).rejects.toThrow(/strict mode/i);
  });
});
