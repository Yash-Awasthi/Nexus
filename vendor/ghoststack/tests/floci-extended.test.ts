import {
  dispatchExtendedAction,
  EXTENDED_FLOCI_ACTIONS,
  flociPutObject,
  flociGetObject,
  flociDeleteObject,
  flociListObjects,
  flociPutItem,
  flociGetItem,
  flociQuery,
  flociDeleteItem,
  flociSendMessage,
  flociReceiveMessage,
  flociDeleteMessage,
  flociCreateTopic,
  flociPublish,
  flociPutMetricData,
  flociListFunctions,
  flociCreateEventSourceMapping
} from "../orchestration/floci-extended";
import { normalizeFlociEndpoint, FlociClientError } from "../orchestration/floci-client";

// ─── Helpers ─────────────────────────────────────────────────────────

const ENDPOINT = "http://localhost:4566";
const DEAD_ENDPOINT = "http://localhost:1";

// Mock flociFetch to throw FlociClientError on dead endpoints.
// We mock at the module level (not global.fetch) because some operations
// (like SQS) pass a different requestUrl than the endpoint to fetch().
jest.mock("../orchestration/floci-client", () => {
  const actual = jest.requireActual("../orchestration/floci-client");
  return {
    ...actual,
    flociFetch: jest.fn(async (endpoint: string, init: any) => {
      if (endpoint.includes(":1")) {
        throw new actual.FlociClientError(
          "Floci request failed: fetch failed: connection refused",
          "UNREACHABLE"
        );
      }
      return actual.flociFetch(endpoint, init);
    })
  };
});

// All extended action functions throw FlociClientError when endpoint is unreachable.
// Use .rejects.toThrow(FlociClientError) to verify they propagate errors correctly.

// ─── Tests ───────────────────────────────────────────────────────────

describe("EXTENDED_FLOCI_ACTIONS", () => {
  test("contains all expected actions", () => {
    expect(EXTENDED_FLOCI_ACTIONS).toContain("s3_put_object");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("s3_get_object");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("s3_delete_object");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("s3_list_objects");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("ddb_put_item");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("ddb_get_item");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("ddb_query");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("ddb_delete_item");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("sqs_send_message");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("sqs_receive_message");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("sqs_delete_message");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("sqs_purge_queue");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("sns_create_topic");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("sns_publish");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("sns_list_topics");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("cloudwatch_put_metrics");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("lambda_list_functions");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("lambda_create_event_source_mapping");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("lambda_list_event_source_mappings");
    expect(EXTENDED_FLOCI_ACTIONS.length).toBeGreaterThanOrEqual(19);
  });
});

describe("dispatchExtendedAction", () => {
  test("throws for unknown action", async () => {
    await expect(
      dispatchExtendedAction(ENDPOINT, "unknown_action", {})
    ).rejects.toThrow("Unknown extended Floci action");
  });

  test("throws FlociClientError when endpoint is unreachable", async () => {
    await expect(
      dispatchExtendedAction(DEAD_ENDPOINT, "s3_put_object", {
        bucketName: "test-bucket",
        key: "test.txt",
        body: "hello"
      })
    ).rejects.toThrow(FlociClientError);
  });

  test.each([
    ["s3_list_objects", { bucketName: "test-bucket" }],
    ["ddb_get_item", { tableName: "test-table", key: { id: "test-id" } }],
    ["sqs_send_message", { queueUrl: "http://localhost:4566/q/test-queue", messageBody: "test" }],
    ["sns_create_topic", { topicName: "test-topic" }],
    ["cloudwatch_put_metrics", { namespace: "Test", metricData: [{ metricName: "m", value: 1 }] }],
    ["lambda_list_functions", {}]
  ])("dispatches action: %s", async (action, args) => {
    await expect(
      dispatchExtendedAction(DEAD_ENDPOINT, action, args)
    ).rejects.toThrow(FlociClientError);
  });
});

describe("S3 Object Operations", () => {
  test.each([
    ["putObject", () => flociPutObject(DEAD_ENDPOINT, "bucket", "key.txt", "hello")],
    ["getObject", () => flociGetObject(DEAD_ENDPOINT, "bucket", "key.txt")],
    ["deleteObject", () => flociDeleteObject(DEAD_ENDPOINT, "bucket", "key.txt")],
    ["listObjects", () => flociListObjects(DEAD_ENDPOINT, "bucket", { prefix: "test/", maxKeys: 10 })]
  ])("throws FlociClientError on %s", async (_name, fn) => {
    await expect(fn()).rejects.toThrow(FlociClientError);
  });
});

describe("DynamoDB Item Operations", () => {
  test.each([
    ["putItem", () => flociPutItem(DEAD_ENDPOINT, "test-table", { id: "test-id", name: "test" })],
    ["getItem", () => flociGetItem(DEAD_ENDPOINT, "test-table", { id: "test-id" })],
    ["query", () => flociQuery(DEAD_ENDPOINT, "test-table", "id = :id", { ":id": "test-id" })],
    ["deleteItem", () => flociDeleteItem(DEAD_ENDPOINT, "test-table", { id: "test-id" })]
  ])("throws FlociClientError on %s", async (_name, fn) => {
    await expect(fn()).rejects.toThrow(FlociClientError);
  });
});

describe("SQS Message Operations", () => {
  test.each([
    ["sendMessage", () => flociSendMessage(DEAD_ENDPOINT, "http://localhost:4566/q/test-queue", "test body")],
    ["receiveMessage", () => flociReceiveMessage(DEAD_ENDPOINT, "http://localhost:4566/q/test-queue", { maxNumberOfMessages: 5 })],
    ["deleteMessage", () => flociDeleteMessage(DEAD_ENDPOINT, "http://localhost:4566/q/test-queue", "handle")]
  ])("throws FlociClientError on %s", async (_name, fn) => {
    await expect(fn()).rejects.toThrow(FlociClientError);
  });
});

describe("SNS Operations", () => {
  test.each([
    ["createTopic", () => flociCreateTopic(DEAD_ENDPOINT, "test-topic")],
    ["publish", () => flociPublish(DEAD_ENDPOINT, "arn:aws:sns:us-east-1:000000000000:test-topic", "test message", { subject: "Test" })]
  ])("throws FlociClientError on %s", async (_name, fn) => {
    await expect(fn()).rejects.toThrow(FlociClientError);
  });
});

describe("CloudWatch Operations", () => {
  test("throws FlociClientError on putMetricData", async () => {
    await expect(
      flociPutMetricData(DEAD_ENDPOINT, "GhostStack/Test", [
        { metricName: "test_count", value: 1, unit: "Count" },
        { metricName: "test_latency", value: 42.5, unit: "Milliseconds" }
      ])
    ).rejects.toThrow(FlociClientError);
  });
});

describe("Lambda Extended Operations", () => {
  test.each([
    ["listFunctions", () => flociListFunctions(DEAD_ENDPOINT, { maxItems: 10 })],
    ["createEventSourceMapping", () => flociCreateEventSourceMapping(DEAD_ENDPOINT, "test-func", "arn:aws:sqs:::test-queue")]
  ])("throws FlociClientError on %s", async (_name, fn) => {
    await expect(fn()).rejects.toThrow(FlociClientError);
  });
});

describe("normalizeFlociEndpoint", () => {
  test("removes trailing slashes", () => {
    expect(normalizeFlociEndpoint("http://localhost:4566/")).toBe("http://localhost:4566");
    expect(normalizeFlociEndpoint("http://localhost:4566///")).toBe("http://localhost:4566");
  });

  test("preserves clean endpoints", () => {
    expect(normalizeFlociEndpoint("http://localhost:4566")).toBe("http://localhost:4566");
    expect(normalizeFlociEndpoint("http://127.0.0.1:4566")).toBe("http://127.0.0.1:4566");
  });
});
