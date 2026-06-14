// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-salesforce — Salesforce REST API v58.0 adapter.
 *
 * Task types
 * ----------
 *   salesforce.query          Execute a SOQL SELECT query
 *   salesforce.get_record     Fetch a single record by object type + ID
 *   salesforce.create_record  Create a new SObject record
 *   salesforce.update_record  Update an existing SObject record
 *   salesforce.delete_record  Delete a record by type + ID
 *   salesforce.describe       Describe a SObject (field metadata)
 *
 * Env vars
 * --------
 *   SALESFORCE_INSTANCE_URL   e.g. https://yourorg.my.salesforce.com
 *   SALESFORCE_ACCESS_TOKEN   OAuth 2.0 access token
 *
 * Note: Access tokens expire.  For long-lived access use the Connected App
 * OAuth flow to obtain a refresh token and exchange it before each request.
 * This adapter accepts the access token directly — refresh is the caller's
 * responsibility.
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const API_VERSION = "v58.0";

// ── Task types ────────────────────────────────────────────────────────────────

export interface SalesforceQueryTask {
  taskType: "salesforce.query";
  soql: string;
  /** Follow nextRecordsUrl for all pages (default: false — returns first page only) */
  fetchAll?: boolean;
}

export interface SalesforceGetRecordTask {
  taskType: "salesforce.get_record";
  objectType: string;
  recordId: string;
  fields?: string[];
}

export interface SalesforceCreateRecordTask {
  taskType: "salesforce.create_record";
  objectType: string;
  fields: Record<string, unknown>;
}

export interface SalesforceUpdateRecordTask {
  taskType: "salesforce.update_record";
  objectType: string;
  recordId: string;
  fields: Record<string, unknown>;
}

export interface SalesforceDeleteRecordTask {
  taskType: "salesforce.delete_record";
  objectType: string;
  recordId: string;
}

export interface SalesforceDescribeTask {
  taskType: "salesforce.describe";
  objectType: string;
}

export type SalesforceTask =
  | SalesforceQueryTask
  | SalesforceGetRecordTask
  | SalesforceCreateRecordTask
  | SalesforceUpdateRecordTask
  | SalesforceDeleteRecordTask
  | SalesforceDescribeTask;

// ── Result types ───────────────────────────────────────────────────────────────

export interface SalesforceQueryResult {
  records: Record<string, unknown>[];
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
}

export interface SalesforceCreateResult {
  id: string;
  success: boolean;
  errors: unknown[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function sfFetch(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  // 204 No Content (delete, update) — success
  if (res.status === 204) return { success: true };
  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-salesforce", res.status, await res.text());
  }
  return res.json();
}

// ── Execute ────────────────────────────────────────────────────────────────────

async function execute(task: SalesforceTask, ctx: IExecutionContext): Promise<unknown> {
  const instanceUrl = requireEnv(ctx, "SALESFORCE_INSTANCE_URL").replace(/\/$/, "");
  const token = requireEnv(ctx, "SALESFORCE_ACCESS_TOKEN");
  const base = `${instanceUrl}/services/data/${API_VERSION}`;

  switch (task.taskType) {
    case "salesforce.query": {
      ctx.logger.info("salesforce.query", { soql: task.soql.slice(0, 80) });
      const url = `${base}/query?q=${encodeURIComponent(task.soql)}`;
      const first = (await sfFetch("GET", url, token)) as SalesforceQueryResult;

      if (!task.fetchAll || first.done) return first;

      // Paginate all records
      const allRecords = [...first.records];
      let current = first;
      while (!current.done && current.nextRecordsUrl) {
        current = (await sfFetch(
          "GET",
          `${instanceUrl}${current.nextRecordsUrl}`,
          token,
        )) as SalesforceQueryResult;
        allRecords.push(...current.records);
      }
      return { ...current, records: allRecords, totalSize: allRecords.length };
    }

    case "salesforce.get_record": {
      ctx.logger.info("salesforce.get_record", { type: task.objectType, id: task.recordId });
      const fieldsParam = task.fields?.length ? `?fields=${task.fields.join(",")}` : "";
      return sfFetch(
        "GET",
        `${base}/sobjects/${task.objectType}/${task.recordId}${fieldsParam}`,
        token,
      );
    }

    case "salesforce.create_record": {
      ctx.logger.info("salesforce.create_record", { type: task.objectType });
      return sfFetch("POST", `${base}/sobjects/${task.objectType}`, token, task.fields);
    }

    case "salesforce.update_record": {
      ctx.logger.info("salesforce.update_record", { type: task.objectType, id: task.recordId });
      return sfFetch(
        "PATCH",
        `${base}/sobjects/${task.objectType}/${task.recordId}`,
        token,
        task.fields,
      );
    }

    case "salesforce.delete_record": {
      ctx.logger.info("salesforce.delete_record", { type: task.objectType, id: task.recordId });
      return sfFetch("DELETE", `${base}/sobjects/${task.objectType}/${task.recordId}`, token);
    }

    case "salesforce.describe": {
      ctx.logger.info("salesforce.describe", { type: task.objectType });
      return sfFetch("GET", `${base}/sobjects/${task.objectType}/describe`, token);
    }
  }
}

export const salesforceAdapter = defineAdapter<SalesforceTask>({
  name: "nexus-adapter-salesforce",
  version: "0.1.0",
  capabilities: ["database.query", "database.execute"],
  taskTypes: [
    "salesforce.query",
    "salesforce.get_record",
    "salesforce.create_record",
    "salesforce.update_record",
    "salesforce.delete_record",
    "salesforce.describe",
  ],
  execute,
});
export default salesforceAdapter;
