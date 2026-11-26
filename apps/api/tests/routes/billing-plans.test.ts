// SPDX-License-Identifier: Apache-2.0
/** Billing is free plus BYOK by design; no paid subscription row may appear. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

const { billingBridgeRoutes } = await import("../../src/routes/billing-bridge.ts");

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(billingBridgeRoutes, { prefix: "/api", costLog: [] });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it("reports free and BYOK at zero price", async () => {
  const res = await app.inject({ method: "GET", url: "/api/billing/plans" });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ model: string; plans: { id: string; price: number }[] }>();
  expect(body.model).toBe("free+byok");
  expect(body.plans.map((plan) => plan.id)).toEqual(["free", "byok"]);
  expect(body.plans.every((plan) => plan.price === 0)).toBe(true);
});
