// SPDX-License-Identifier: Apache-2.0
/** MCP tools generated from an OpenAPI spec, and the calls they make. */
import { describe, expect, it } from "vitest";

import { openApiToMcp } from "../src/index.js";

describe("openApiToMcp", () => {
  const spec = {
    openapi: "3.0.0",
    servers: [{ url: "https://api.example.com/v2" }],
    paths: {
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          summary: "Get a pet",
          parameters: [
            { name: "petId", in: "path", required: true, schema: { type: "string" } },
            { name: "fields", in: "query", schema: { type: "string" } },
          ],
        },
      },
      "/pets": {
        post: {
          summary: "Create a pet",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              },
            },
          },
        },
      },
    },
  };

  it("turns each operation into a tool with its parameters as the input schema", () => {
    const { tools } = openApiToMcp(spec);
    expect(tools.map((t) => t.name)).toEqual(["getPet", "post_pets"]);
    const get = tools[0]!;
    expect(get.description).toBe("Get a pet");
    expect(get.inputSchema).toMatchObject({
      type: "object",
      properties: { petId: { type: "string" }, fields: { type: "string" } },
      required: ["petId"],
    });
    expect(tools[1]!.inputSchema).toMatchObject({
      properties: { body: { type: "object" } },
      required: ["body"],
    });
  });

  it("calls the operation with path, query and body filled in", async () => {
    const sent: { url: string; method: string; body?: string; auth: string | null }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        method: init.method!,
        body: init.body as string | undefined,
        auth: new Headers(init.headers).get("authorization"),
      });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const { execute } = openApiToMcp(spec, {
      fetch: fetchFn,
      headers: { authorization: "Bearer t" },
    });

    const got = await execute("getPet", { petId: "p 1", fields: "name" });
    expect(sent[0]).toMatchObject({
      url: "https://api.example.com/v2/pets/p%201?fields=name",
      method: "GET",
      auth: "Bearer t",
    });
    expect(got.text).toBe('{"ok":true}');

    await execute("post_pets", { body: { name: "Rex" } });
    expect(sent[1]).toMatchObject({ method: "POST", body: '{"name":"Rex"}' });
  });
});
