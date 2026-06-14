// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import hubspotAdapter from "../src/index.js";
import type { IExecutionContext } from "@nexus/plugin-sdk";

const makeCtx = (): IExecutionContext =>
  ({
    taskId: "t",
    startTime: new Date(),
    attempt: 1,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    environment: { HUBSPOT_API_KEY: "pat-na1-test" },
  }) as unknown as IExecutionContext;

const RAW_CONTACT = {
  id: "101",
  properties: { firstname: "Jane", lastname: "Doe", email: "jane@doe.com" },
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};
const RAW_DEAL = {
  id: "201",
  properties: { dealname: "Big Deal", amount: "50000" },
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};

describe("@nexus/adapter-hubspot", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.restoreAllMocks());

  it("name and capabilities", () => {
    expect(hubspotAdapter.name).toBe("nexus-adapter-hubspot");
    expect(hubspotAdapter.capabilities).toContain("database.query");
    expect(hubspotAdapter.capabilities).toContain("database.execute");
  });

  it("canExecute all seven task types", () => {
    for (const t of [
      "hubspot.get_contact",
      "hubspot.search_contacts",
      "hubspot.create_contact",
      "hubspot.update_contact",
      "hubspot.create_deal",
      "hubspot.get_deal",
      "hubspot.search_companies",
    ]) {
      expect(hubspotAdapter.canExecute(t)).toBe(true);
    }
  });

  it("get_contact — uses Bearer token and maps to HubSpotObject", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => RAW_CONTACT,
      text: async () => "",
    });
    const obj = (await hubspotAdapter.execute(
      { taskType: "hubspot.get_contact", contactId: "101" },
      makeCtx(),
    )) as { id: string; properties: Record<string, string | null> };
    expect(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>,
    ).toMatchObject({ Authorization: "Bearer pat-na1-test" });
    expect(obj.id).toBe("101");
    expect(obj.properties.email).toBe("jane@doe.com");
  });

  it("search_contacts — sends filterGroups in POST body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [RAW_CONTACT], total: 1 }),
      text: async () => "",
    });
    await hubspotAdapter.execute(
      {
        taskType: "hubspot.search_contacts",
        filters: [{ propertyName: "email", operator: "EQ", value: "jane@doe.com" }],
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { filterGroups: { filters: { propertyName: string }[] }[] };
    expect(body.filterGroups[0].filters[0].propertyName).toBe("email");
  });

  it("create_contact — sends properties in body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => RAW_CONTACT,
      text: async () => "",
    });
    await hubspotAdapter.execute(
      {
        taskType: "hubspot.create_contact",
        properties: { email: "new@acme.com", firstname: "New" },
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { properties: Record<string, string> };
    expect(body.properties.email).toBe("new@acme.com");
  });

  it("create_deal — hits /crm/v3/objects/deals", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_DEAL, text: async () => "" });
    await hubspotAdapter.execute(
      { taskType: "hubspot.create_deal", properties: { dealname: "Big Deal", amount: "50000" } },
      makeCtx(),
    );
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("/deals");
  });

  it("create_deal — includes associations in body when provided", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_DEAL, text: async () => "" });
    await hubspotAdapter.execute(
      {
        taskType: "hubspot.create_deal",
        properties: { dealname: "Assoc Deal" },
        associations: [{ toObjectId: "101", associationTypeId: 3 }],
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { associations: { to: { id: string } }[] };
    expect(body.associations[0].to.id).toBe("101");
  });

  it("update_contact — sends PATCH to /contacts/:id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => RAW_CONTACT,
      text: async () => "",
    });
    await hubspotAdapter.execute(
      {
        taskType: "hubspot.update_contact",
        contactId: "101",
        properties: { firstname: "Updated" },
      },
      makeCtx(),
    );
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/contacts/101");
    expect(opts.method).toBe("PATCH");
  });

  it("get_deal — hits /crm/v3/objects/deals/:id", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_DEAL, text: async () => "" });
    const result = (await hubspotAdapter.execute(
      { taskType: "hubspot.get_deal", dealId: "201" },
      makeCtx(),
    )) as { id: string };
    expect(result.id).toBe("201");
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("/deals/201");
  });

  it("get_deal — appends ?properties= query when properties provided", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_DEAL, text: async () => "" });
    await hubspotAdapter.execute(
      { taskType: "hubspot.get_deal", dealId: "201", properties: ["dealname", "amount"] },
      makeCtx(),
    );
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain("?properties=dealname,amount");
  });

  it("search_companies — sends filterGroups POST to companies", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], total: 0 }),
      text: async () => "",
    });
    await hubspotAdapter.execute(
      {
        taskType: "hubspot.search_companies",
        filters: [{ propertyName: "domain", operator: "EQ", value: "acme.com" }],
      },
      makeCtx(),
    );
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("/companies/search");
  });

  it("get_contact — appends ?properties= when properties provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => RAW_CONTACT,
      text: async () => "",
    });
    await hubspotAdapter.execute(
      { taskType: "hubspot.get_contact", contactId: "101", properties: ["email", "firstname"] },
      makeCtx(),
    );
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("?properties=email,firstname");
  });

  it("search_contacts — passes after cursor when provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], total: 0 }),
      text: async () => "",
    });
    await hubspotAdapter.execute(
      {
        taskType: "hubspot.search_contacts",
        filters: [],
        after: "cursor-abc",
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { after: string };
    expect(body.after).toBe("cursor-abc");
  });

  it("create_deal — defaults associationTypeId to 3 when omitted", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RAW_DEAL, text: async () => "" });
    await hubspotAdapter.execute(
      {
        taskType: "hubspot.create_deal",
        properties: { dealname: "Default Assoc" },
        associations: [{ toObjectId: "101" }],
      },
      makeCtx(),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { associations: { types: { associationTypeId: number }[] }[] };
    expect(body.associations[0].types[0].associationTypeId).toBe(3);
  });

  it("toObject — falls back to empty defaults when optional fields are absent", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "999" }), // no properties, createdAt, updatedAt
      text: async () => "",
    });
    const result = (await hubspotAdapter.execute(
      { taskType: "hubspot.get_contact", contactId: "999" },
      makeCtx(),
    )) as { id: string; properties: Record<string, string | null>; createdAt: string };
    expect(result.id).toBe("999");
    expect(result.properties).toEqual({});
    expect(result.createdAt).toBe("");
  });

  it("throws AdapterHttpError on 400", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Bad request" });
    await expect(
      hubspotAdapter.execute({ taskType: "hubspot.get_contact", contactId: "bad" }, makeCtx()),
    ).rejects.toThrow();
  });
});
