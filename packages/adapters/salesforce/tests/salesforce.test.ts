// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import salesforceAdapter from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";

const makeCtx = (): IExecutionContext =>
  ({
    taskId: "t",
    startTime: new Date(),
    attempt: 1,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    environment: {
      SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com",
      SALESFORCE_ACCESS_TOKEN: "00D...",
    },
  }) as unknown as IExecutionContext;

describe("@nexus/adapter-salesforce", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.restoreAllMocks());

  it("name and capabilities", () => {
    expect(salesforceAdapter.name).toBe("nexus-adapter-salesforce");
    expect(salesforceAdapter.capabilities).toContain("database.query");
    expect(salesforceAdapter.capabilities).toContain("database.execute");
  });

  it("canExecute all six task types", () => {
    for (const t of [
      "salesforce.query",
      "salesforce.get_record",
      "salesforce.create_record",
      "salesforce.update_record",
      "salesforce.delete_record",
      "salesforce.describe",
    ]) {
      expect(salesforceAdapter.canExecute(t)).toBe(true);
    }
  });

  it("query — uses Bearer token and encodes SOQL in URL", async () => {
    const resp = { records: [{ Id: "001x", Name: "Acme Corp" }], totalSize: 1, done: true };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => resp, text: async () => "" });
    const r = (await salesforceAdapter.execute(
      { taskType: "salesforce.query", soql: "SELECT Id, Name FROM Account LIMIT 10" },
      makeCtx(),
    )) as typeof resp;
    expect(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>,
    ).toMatchObject({ Authorization: "Bearer 00D..." });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("/query?q=");
    expect(r.records[0].Name).toBe("Acme Corp");
  });

  it("query fetchAll — paginates until done:true", async () => {
    const page1 = {
      records: [{ Id: "1" }],
      totalSize: 2,
      done: false,
      nextRecordsUrl: "/services/data/v58.0/query/next",
    };
    const page2 = { records: [{ Id: "2" }], totalSize: 2, done: true };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => page1, text: async () => "" });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => page2, text: async () => "" });
    const r = (await salesforceAdapter.execute(
      { taskType: "salesforce.query", soql: "SELECT Id FROM Account", fetchAll: true },
      makeCtx(),
    )) as { records: { Id: string }[] };
    expect(r.records).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("get_record — hits /sobjects/:type/:id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Id: "001x", Name: "Acme" }),
      text: async () => "",
    });
    await salesforceAdapter.execute(
      { taskType: "salesforce.get_record", objectType: "Account", recordId: "001x" },
      makeCtx(),
    );
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("/sobjects/Account/001x");
  });

  it("create_record — POST with fields", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "001y", success: true, errors: [] }),
      text: async () => "",
    });
    const r = (await salesforceAdapter.execute(
      { taskType: "salesforce.create_record", objectType: "Account", fields: { Name: "NewCo" } },
      makeCtx(),
    )) as { id: string; success: boolean };
    expect(r.success).toBe(true);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe("POST");
  });

  it("update_record — returns success on 204", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
      text: async () => "",
    });
    const r = (await salesforceAdapter.execute(
      {
        taskType: "salesforce.update_record",
        objectType: "Account",
        recordId: "001x",
        fields: { Name: "Updated" },
      },
      makeCtx(),
    )) as { success: boolean };
    expect(r.success).toBe(true);
  });

  it("delete_record — returns success on 204", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
      text: async () => "",
    });
    const r = (await salesforceAdapter.execute(
      { taskType: "salesforce.delete_record", objectType: "Account", recordId: "001x" },
      makeCtx(),
    )) as { success: boolean };
    expect(r.success).toBe(true);
  });

  it("throws AdapterHttpError on 401", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Session expired",
    });
    await expect(
      salesforceAdapter.execute(
        { taskType: "salesforce.query", soql: "SELECT Id FROM Account" },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });
});
