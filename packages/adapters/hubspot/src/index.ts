// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-hubspot — HubSpot CRM API v3 adapter.
 *
 * Task types
 * ----------
 *   hubspot.get_contact        Fetch a contact by ID
 *   hubspot.search_contacts    Search contacts by property filter
 *   hubspot.create_contact     Create a new contact
 *   hubspot.update_contact     Update contact properties
 *   hubspot.create_deal        Create a new deal
 *   hubspot.get_deal           Fetch a deal by ID
 *   hubspot.search_companies   Search companies by name / domain
 *
 * Env vars
 * --------
 *   HUBSPOT_API_KEY   Private app access token (pat-…)
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const BASE = "https://api.hubapi.com";

// ── Task types ────────────────────────────────────────────────────────────────

export interface HubSpotGetContactTask {
  taskType: "hubspot.get_contact";
  contactId: string;
  properties?: string[];
}

export interface HubSpotSearchContactsTask {
  taskType: "hubspot.search_contacts";
  filters: {
    propertyName: string;
    operator: "EQ" | "NEQ" | "CONTAINS_TOKEN" | "HAS_PROPERTY";
    value?: string;
  }[];
  properties?: string[];
  limit?: number;
  after?: string;
}

export interface HubSpotCreateContactTask {
  taskType: "hubspot.create_contact";
  properties: Record<string, string>;
}

export interface HubSpotUpdateContactTask {
  taskType: "hubspot.update_contact";
  contactId: string;
  properties: Record<string, string>;
}

export interface HubSpotCreateDealTask {
  taskType: "hubspot.create_deal";
  properties: Record<string, string>;
  associations?: {
    toObjectId: string;
    toObjectType: string;
    associationTypeId?: number;
  }[];
}

export interface HubSpotGetDealTask {
  taskType: "hubspot.get_deal";
  dealId: string;
  properties?: string[];
}

export interface HubSpotSearchCompaniesTask {
  taskType: "hubspot.search_companies";
  filters: {
    propertyName: string;
    operator: "EQ" | "NEQ" | "CONTAINS_TOKEN" | "HAS_PROPERTY";
    value?: string;
  }[];
  properties?: string[];
  limit?: number;
}

export type HubSpotTask =
  | HubSpotGetContactTask
  | HubSpotSearchContactsTask
  | HubSpotCreateContactTask
  | HubSpotUpdateContactTask
  | HubSpotCreateDealTask
  | HubSpotGetDealTask
  | HubSpotSearchCompaniesTask;

// ── Result types ───────────────────────────────────────────────────────────────

export interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

export interface HubSpotSearchResult {
  results: HubSpotObject[];
  total: number;
  paging?: { next?: { after: string } };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function hsFetch(
  method: "GET" | "POST" | "PATCH",
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-hubspot", res.status, await res.text());
  }
  return res.json();
}

function toObject(raw: Record<string, unknown>): HubSpotObject {
  return {
    id: raw.id as string,
    properties: (raw.properties as Record<string, string | null> | undefined) ?? {},
    createdAt: (raw.createdAt as string | undefined) ?? "",
    updatedAt: (raw.updatedAt as string | undefined) ?? "",
  };
}

// ── Execute ────────────────────────────────────────────────────────────────────

async function execute(task: HubSpotTask, ctx: IExecutionContext): Promise<unknown> {
  const apiKey = requireEnv(ctx, "HUBSPOT_API_KEY");

  switch (task.taskType) {
    case "hubspot.get_contact": {
      ctx.logger.info("hubspot.get_contact", { contactId: task.contactId });
      const props = task.properties?.length ? `?properties=${task.properties.join(",")}` : "";
      return toObject(
        (await hsFetch(
          "GET",
          `/crm/v3/objects/contacts/${task.contactId}${props}`,
          apiKey,
        )) as Record<string, unknown>,
      );
    }

    case "hubspot.search_contacts": {
      ctx.logger.info("hubspot.search_contacts", { filterCount: task.filters.length });
      const raw = (await hsFetch("POST", "/crm/v3/objects/contacts/search", apiKey, {
        filterGroups: [{ filters: task.filters }],
        properties: task.properties ?? ["firstname", "lastname", "email"],
        limit: task.limit ?? 20,
        ...(task.after ? { after: task.after } : {}),
      })) as {
        results: Record<string, unknown>[];
        total: number;
        paging?: { next?: { after: string } };
      };
      return {
        results: raw.results.map(toObject),
        total: raw.total,
        paging: raw.paging,
      } satisfies HubSpotSearchResult;
    }

    case "hubspot.create_contact": {
      ctx.logger.info("hubspot.create_contact");
      return toObject(
        (await hsFetch("POST", "/crm/v3/objects/contacts", apiKey, {
          properties: task.properties,
        })) as Record<string, unknown>,
      );
    }

    case "hubspot.update_contact": {
      ctx.logger.info("hubspot.update_contact", { contactId: task.contactId });
      return toObject(
        (await hsFetch("PATCH", `/crm/v3/objects/contacts/${task.contactId}`, apiKey, {
          properties: task.properties,
        })) as Record<string, unknown>,
      );
    }

    case "hubspot.create_deal": {
      ctx.logger.info("hubspot.create_deal");
      const body: Record<string, unknown> = { properties: task.properties };
      if (task.associations?.length) {
        body.associations = task.associations.map((a) => ({
          to: { id: a.toObjectId },
          types: [
            { associationCategory: "HUBSPOT_DEFINED", associationTypeId: a.associationTypeId ?? 3 },
          ],
        }));
      }
      return toObject(
        (await hsFetch("POST", "/crm/v3/objects/deals", apiKey, body)) as Record<string, unknown>,
      );
    }

    case "hubspot.get_deal": {
      ctx.logger.info("hubspot.get_deal", { dealId: task.dealId });
      const props = task.properties?.length ? `?properties=${task.properties.join(",")}` : "";
      return toObject(
        (await hsFetch("GET", `/crm/v3/objects/deals/${task.dealId}${props}`, apiKey)) as Record<
          string,
          unknown
        >,
      );
    }

    case "hubspot.search_companies": {
      ctx.logger.info("hubspot.search_companies", { filterCount: task.filters.length });
      const raw = (await hsFetch("POST", "/crm/v3/objects/companies/search", apiKey, {
        filterGroups: [{ filters: task.filters }],
        properties: task.properties ?? ["name", "domain", "hs_lastmodifieddate"],
        limit: task.limit ?? 20,
      })) as {
        results: Record<string, unknown>[];
        total: number;
        paging?: { next?: { after: string } };
      };
      return {
        results: raw.results.map(toObject),
        total: raw.total,
        paging: raw.paging,
      } satisfies HubSpotSearchResult;
    }
  }
}

export const hubspotAdapter = defineAdapter<HubSpotTask>({
  name: "nexus-adapter-hubspot",
  version: "0.1.0",
  capabilities: ["database.query", "database.execute"],
  taskTypes: [
    "hubspot.get_contact",
    "hubspot.search_contacts",
    "hubspot.create_contact",
    "hubspot.update_contact",
    "hubspot.create_deal",
    "hubspot.get_deal",
    "hubspot.search_companies",
  ],
  execute,
});
export default hubspotAdapter;
