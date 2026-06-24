// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-stripe — Stripe REST API adapter
 *
 * Capabilities: database.query, database.execute
 * Task types:
 *   stripe.create-customer        — create a customer
 *   stripe.create-payment-intent  — create a PaymentIntent
 *   stripe.list-charges           — list recent charges
 *   stripe.get-balance            — fetch account balance
 *   stripe.refund                 — refund a charge or payment intent
 *
 * Auth: STRIPE_API_KEY (secret key, sk_…)
 * Base URL override: STRIPE_API_URL (default: https://api.stripe.com)
 *
 * Note: the Stripe API consumes application/x-www-form-urlencoded bodies with
 * bracketed nested keys, not JSON — `formEncode` handles that.
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

// ── Task input / output types ─────────────────────────────────────────────────

export interface StripeCreateCustomerTask {
  taskType: "stripe.create-customer";
  email?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface StripeCreatePaymentIntentTask {
  taskType: "stripe.create-payment-intent";
  amount: number; // smallest currency unit (e.g. cents)
  currency: string; // ISO 4217, e.g. "usd"
  customer?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface StripeListChargesTask {
  taskType: "stripe.list-charges";
  limit?: number;
  customer?: string;
}

export interface StripeGetBalanceTask {
  taskType: "stripe.get-balance";
}

export interface StripeRefundTask {
  taskType: "stripe.refund";
  charge?: string;
  payment_intent?: string;
  amount?: number;
}

export type StripeTask =
  | StripeCreateCustomerTask
  | StripeCreatePaymentIntentTask
  | StripeListChargesTask
  | StripeGetBalanceTask
  | StripeRefundTask;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode a flat/nested object as Stripe-style form params (e.g. metadata[key]=v). */
export function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") {
      parts.push(formEncode(value as Record<string, unknown>, field));
    } else {
      parts.push(`${encodeURIComponent(field)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

function stripeFetch(
  path: string,
  apiKey: string,
  method: "GET" | "POST",
  form?: Record<string, unknown>,
  baseUrl = "https://api.stripe.com",
): Promise<Response> {
  const isGet = method === "GET";
  const body = form ? formEncode(form) : undefined;
  const url = isGet && body ? `${baseUrl}${path}?${body}` : `${baseUrl}${path}`;
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: isGet ? undefined : body,
  });
}

async function assertOk(res: Response): Promise<unknown> {
  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-stripe", res.status, await res.text());
  }
  return res.json();
}

// ── Execute ───────────────────────────────────────────────────────────────────

async function execute(task: StripeTask, ctx: IExecutionContext): Promise<unknown> {
  const apiKey = requireEnv(ctx, "STRIPE_API_KEY");
  const baseUrl =
    (ctx.environment?.["STRIPE_API_URL"] as string | undefined) ?? "https://api.stripe.com";

  switch (task.taskType) {
    case "stripe.create-customer": {
      ctx.logger.info("stripe.create-customer", { email: task.email });
      const res = await stripeFetch(
        "/v1/customers",
        apiKey,
        "POST",
        { email: task.email, name: task.name, description: task.description, metadata: task.metadata },
        baseUrl,
      );
      return assertOk(res);
    }

    case "stripe.create-payment-intent": {
      ctx.logger.info("stripe.create-payment-intent", {
        amount: task.amount,
        currency: task.currency,
      });
      const res = await stripeFetch(
        "/v1/payment_intents",
        apiKey,
        "POST",
        {
          amount: task.amount,
          currency: task.currency,
          customer: task.customer,
          description: task.description,
          metadata: task.metadata,
        },
        baseUrl,
      );
      return assertOk(res);
    }

    case "stripe.list-charges": {
      ctx.logger.info("stripe.list-charges", { limit: task.limit });
      const res = await stripeFetch(
        "/v1/charges",
        apiKey,
        "GET",
        { limit: task.limit ?? 10, customer: task.customer },
        baseUrl,
      );
      return assertOk(res);
    }

    case "stripe.get-balance": {
      ctx.logger.info("stripe.get-balance", {});
      const res = await stripeFetch("/v1/balance", apiKey, "GET", undefined, baseUrl);
      return assertOk(res);
    }

    case "stripe.refund": {
      ctx.logger.info("stripe.refund", { charge: task.charge, payment_intent: task.payment_intent });
      const res = await stripeFetch(
        "/v1/refunds",
        apiKey,
        "POST",
        { charge: task.charge, payment_intent: task.payment_intent, amount: task.amount },
        baseUrl,
      );
      return assertOk(res);
    }

    default: {
      const exhaustive: never = task;
      throw new Error(`Unhandled Stripe task type: ${(exhaustive as StripeTask).taskType}`);
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const stripeAdapter = defineAdapter<StripeTask>({
  name: "nexus-adapter-stripe",
  version: "0.1.0",
  capabilities: ["database.query", "database.execute"],
  taskTypes: [
    "stripe.create-customer",
    "stripe.create-payment-intent",
    "stripe.list-charges",
    "stripe.get-balance",
    "stripe.refund",
  ],
  execute,
});

export default stripeAdapter;
