// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  openApiToMcpTools,
  createOpenApiCaller,
  type OpenApiDoc,
  type OpenApiCallResponse,
} from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PETSTORE: OpenApiDoc = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.example.com/v1" }],
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          status: { type: "string", enum: ["available", "sold"] },
        },
        required: ["name"],
      },
    },
  },
  paths: {
    "/pets": {
      parameters: [{ name: "verbose", in: "query", schema: { type: "boolean" } }],
      get: {
        operationId: "listPets",
        summary: "List all pets",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
      },
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "pet.findByStatus",
        description: "Fetch one pet",
        parameters: [{ name: "petId", in: "path", required: true }],
      },
    },
  },
};

const LONGPATH: OpenApiDoc = {
  openapi: "3.0.3",
  paths: {
    "/very-long-resource": {
      get: {
        operationId:
          "getVeryLongOperationNameThatExceedsTheSixtyFourCharacterToolNameLimitByQuiteABit",
      },
    },
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("openApiToMcpTools", () => {
  it("turns each operation into a tool with merged parameters", () => {
    const tools = openApiToMcpTools(PETSTORE);
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["createPet", "listPets", "pet_findByStatus"]);
  });

  it("path-level and operation parameters merge, keeping required", () => {
    const listPets = openApiToMcpTools(PETSTORE).find((t) => t.name === "listPets")!;
    expect(listPets.description).toBe("List all pets");
    expect(Object.keys(listPets.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["verbose", "limit"]),
    );
    expect(listPets.inputSchema.required).toBeUndefined();
  });

  it("treats path parameters as required and resolves $ref body schemas", () => {
    const tools = openApiToMcpTools(PETSTORE);
    const findPet = tools.find((t) => t.name === "pet_findByStatus")!;
    expect(findPet.inputSchema.required).toContain("petId");
    expect(findPet.description).toBe("Fetch one pet");
    expect(findPet.parameters).toEqual([{ name: "petId", in: "path" }]);

    const createPet = tools.find((t) => t.name === "createPet")!;
    expect(createPet.inputSchema.required).toContain("requestBody");
    expect(createPet.bodyContentType).toBe("application/json");
    const bodyProp = createPet.inputSchema.properties?.requestBody as {
      type?: string;
      required?: string[];
    };
    expect(bodyProp.type).toBe("object");
    expect(bodyProp.required).toContain("name");
  });

  it("sanitizes dots and falls back to method_path naming", () => {
    const tools = openApiToMcpTools({
      openapi: "3.0.3",
      paths: { "/search": { get: { summary: "no operationId" } } },
    });
    expect(tools[0]?.name).toBe("get_search");
    expect(tools[0]?.description).toBe("no operationId");
  });

  it("caps tool names at maxToolNameLength with a deterministic hash", () => {
    const tools = openApiToMcpTools(LONGPATH);
    const name = tools[0]?.name ?? "";
    expect(name.length).toBeLessThanOrEqual(64);
    // Deterministic: same input → same name
    const again = openApiToMcpTools(LONGPATH);
    expect(again[0]?.name).toBe(name);
    // Head and tail survive (before the hash suffix) so the name stays readable
    expect(name.startsWith("getVeryLongOperationName")).toBe(true);
    expect(name).toContain("__");
    expect(name).toContain("QuiteABit");
    expect(name).toMatch(/_([0-9a-f]{6})$/);
  });
});

describe("createOpenApiCaller", () => {
  const capture = () => {
    const calls: {
      url: string;
      init: { method: string; headers: Record<string, string>; body?: string };
    }[] = [];
    const fetchFn = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      calls.push({ url, init });
      return {
        status: 200,
        ok: true,
        text: async () => `ok ${init.method} ${url}`,
      };
    };
    return { calls, fetchFn };
  };

  it("executes GET with query parameters against baseUrl + path", async () => {
    const tools = openApiToMcpTools(PETSTORE);
    const { calls, fetchFn } = capture();
    const call = createOpenApiCaller(tools, {
      baseUrl: "https://api.example.com/v1",
      fetch: fetchFn,
    });
    const res: OpenApiCallResponse = await call("listPets", { limit: 5, verbose: true });
    expect(res.ok).toBe(true);
    const url = calls[0]?.url ?? "";
    expect(url.startsWith("https://api.example.com/v1/pets?")).toBe(true);
    expect(url).toContain("limit=5");
    expect(url).toContain("verbose=true");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("substitutes path parameters and sends JSON bodies", async () => {
    const tools = openApiToMcpTools(PETSTORE);
    const { calls, fetchFn } = capture();
    const call = createOpenApiCaller(tools, {
      baseUrl: "https://api.example.com/v1",
      fetch: fetchFn,
    });
    await call("pet_findByStatus", { petId: "p 1" });
    expect(calls[0]?.url).toContain("/pets/p%201");

    await call("createPet", { requestBody: { name: "Rex", status: "available" } });
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ name: "Rex", status: "available" }));
    expect(calls[1]?.init.headers["content-type"]).toBe("application/json");
  });

  it("throws on a missing path parameter and unknown tools", async () => {
    const tools = openApiToMcpTools(PETSTORE);
    const call = createOpenApiCaller(tools, {
      baseUrl: "https://api.example.com/v1",
      fetch: capture().fetchFn,
    });
    await expect(call("pet_findByStatus", {})).rejects.toThrow(/petId/);
    await expect(call("nope", {})).rejects.toThrow(/No tool/);
  });

  it("applies caller-level headers", async () => {
    const tools = openApiToMcpTools(PETSTORE);
    const { calls, fetchFn } = capture();
    const call = createOpenApiCaller(tools, {
      baseUrl: "https://api.example.com/v1",
      fetch: fetchFn,
      headers: { Authorization: "Bearer abc" },
    });
    await call("listPets", {});
    expect(calls[0]?.init.headers["Authorization"]).toBe("Bearer abc");
  });
});
