// SPDX-License-Identifier: Apache-2.0
/**
 * Stripe webhook handler skeleton.
 *
 * Responsibilities:
 *   1. Verify the Stripe-Signature header (HMAC-SHA256)
 *   2. Deduplicate events via stripe_webhook_events table
 *   3. Dispatch to domain handlers for subscription lifecycle events
 *
 * Note: This module does NOT import the Stripe SDK.  It implements
 *   signature verification manually using Node's crypto module and
 *   models event shapes as plain TypeScript types.  Add the Stripe SDK
 *   (`npm i stripe`) and swap out verifyStripeSignature when moving to
 *   production — the handler dispatch logic stays identical.
 *
 * Env vars:
 *   STRIPE_WEBHOOK_SECRET  — Webhook endpoint secret (whsec_...)
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { db } from "@nexus/db";
import type { NewSubscription } from "@nexus/db/schema";
import { subscriptions, stripeWebhookEvents, apiKeys } from "@nexus/db/schema";
import { eq } from "drizzle-orm";

// ── Stripe event shape (minimal) ──────────────────────────────────────────────

export interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

export interface StripeSubscriptionObject {
  id: string;
  customer: string;
  status: "active" | "past_due" | "canceled" | "trialing" | "incomplete";
  current_period_end: number;
  cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
  items?: {
    data?: { price?: { id?: string; nickname?: string } }[];
  };
}

// ── Signature verification ────────────────────────────────────────────────────

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSignatureError";
  }
}

/**
 * Verify the Stripe-Signature header and return the parsed event.
 *
 * @param rawBody  Raw request body bytes (Buffer or string)
 * @param signature  Value of the Stripe-Signature header
 * @param secret  Webhook endpoint secret (whsec_...)
 * @param toleranceSeconds  Max age of the timestamp (default: 300s)
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  signature: string,
  secret: string,
  toleranceSeconds = 300,
): StripeEvent {
  // Parse t=timestamp,v1=hash pairs
  const parts: Record<string, string> = {};
  for (const part of signature.split(",")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      parts[part.slice(0, idx)] = part.slice(idx + 1);
    }
  }

  const timestamp = parts["t"];
  const v1 = parts["v1"];

  if (!timestamp || !v1) {
    throw new StripeSignatureError("Invalid Stripe-Signature header format");
  }

  // Check timestamp freshness
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    throw new StripeSignatureError(
      `Webhook timestamp too old (${now - ts}s ago, tolerance: ${toleranceSeconds}s)`,
    );
  }

  // Compute expected signature: HMAC-SHA256(secret, "<timestamp>.<rawBody>")
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signedPayload = `${timestamp}.${body}`;
  const expectedSig = createHmac("sha256", secret).update(signedPayload).digest("hex");

  const expectedBuf = Buffer.from(expectedSig, "hex");
  const actualBuf = Buffer.from(v1, "hex");

  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new StripeSignatureError("Stripe-Signature mismatch");
  }

  return JSON.parse(body) as StripeEvent;
}

// ── Webhook processor ─────────────────────────────────────────────────────────

export interface WebhookProcessResult {
  eventId: string;
  eventType: string;
  skipped: boolean;
  error?: string;
}

export class StripeWebhookProcessor {
  private readonly secret: string;

  constructor(secret?: string) {
    this.secret = secret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "";
    if (!this.secret) {
      throw new Error("STRIPE_WEBHOOK_SECRET is required for StripeWebhookProcessor");
    }
  }

  async process(rawBody: Buffer | string, signatureHeader: string): Promise<WebhookProcessResult> {
    const event = verifyStripeSignature(rawBody, signatureHeader, this.secret);

    // Idempotency check
    const [existing] = await db
      .select()
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.stripeEventId, event.id))
      .limit(1);

    if (existing) {
      return { eventId: event.id, eventType: event.type, skipped: true };
    }

    let handlerError: string | undefined;

    try {
      await this.dispatch(event);
    } catch (err) {
      handlerError = err instanceof Error ? err.message : String(err);
    }

    // Record processed (even on error — prevents retry loops for bad events)
    await db
      .insert(stripeWebhookEvents)
      .values({
        stripeEventId: event.id,
        eventType: event.type,
        error: handlerError ?? null,
      })
      .onConflictDoNothing();

    return {
      eventId: event.id,
      eventType: event.type,
      skipped: false,
      error: handlerError,
    };
  }

  private async dispatch(event: StripeEvent): Promise<void> {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await this.handleSubscriptionUpsert(
          event.data.object as unknown as StripeSubscriptionObject,
        );
        break;

      case "customer.subscription.deleted":
        await this.handleSubscriptionDeleted(
          event.data.object as unknown as StripeSubscriptionObject,
        );
        break;

      case "invoice.payment_succeeded":
        await this.handleInvoicePaymentSucceeded(event.data.object);
        break;

      case "invoice.payment_failed":
        await this.handleInvoicePaymentFailed(event.data.object);
        break;

      default:
        // Unhandled event types are silently ignored — Stripe sends many
        break;
    }
  }

  // ── Domain handlers ─────────────────────────────────────────────────────────

  private async handleSubscriptionUpsert(sub: StripeSubscriptionObject): Promise<void> {
    const plan = resolvePlanFromSubscription(sub);
    const ownerId = sub.metadata?.["owner_id"] ?? sub.customer;

    await db
      .insert(subscriptions)
      .values({
        ownerId,
        stripeCustomerId: sub.customer,
        stripeSubscriptionId: sub.id,
        plan,
        status: sub.status,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      } satisfies Omit<NewSubscription, "id" | "createdAt" | "updatedAt">)
      .onConflictDoUpdate({
        target: subscriptions.stripeSubscriptionId,
        set: {
          status: sub.status,
          plan,
          currentPeriodEnd: sub.current_period_end,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          updatedAt: new Date(),
        },
      });

    // Sync plan to all API keys for this owner
    if (ownerId) {
      await db.update(apiKeys).set({ plan }).where(eq(apiKeys.ownerId, ownerId));
    }
  }

  private async handleSubscriptionDeleted(sub: StripeSubscriptionObject): Promise<void> {
    await db
      .update(subscriptions)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(eq(subscriptions.stripeSubscriptionId, sub.id));

    // Downgrade API keys to free plan
    const ownerId = sub.metadata?.["owner_id"] ?? sub.customer;
    if (ownerId) {
      await db.update(apiKeys).set({ plan: "free" }).where(eq(apiKeys.ownerId, ownerId));
    }
  }

  private async handleInvoicePaymentSucceeded(_invoice: Record<string, unknown>): Promise<void> {
    // Hook point: send receipt email, update billing period, etc.
    // For now a no-op — override in a subclass or extend via event bus.
  }

  private async handleInvoicePaymentFailed(_invoice: Record<string, unknown>): Promise<void> {
    // Hook point: send dunning email, suspend access, etc.
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolvePlanFromSubscription(sub: StripeSubscriptionObject): "free" | "pro" | "enterprise" {
  // Convention: price nickname or metadata.plan encodes the plan tier.
  const metaPlan = sub.metadata?.["plan"];
  if (metaPlan === "pro" || metaPlan === "enterprise") return metaPlan;

  const priceNickname = sub.items?.data?.[0]?.price?.nickname?.toLowerCase() ?? "";
  if (priceNickname.includes("enterprise")) return "enterprise";
  if (priceNickname.includes("pro")) return "pro";
  return "free";
}
