// SPDX-License-Identifier: Apache-2.0
import type { IExecutionContext } from "@nexus/plugin-sdk";
import { AdapterConfigError, AdapterHttpError } from "@nexus/plugin-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { stripeAdapter, formEncode } from "../src/index.js";

function makeCtx(env: Record<string, string> = {}): IExecutionContext {
  return {
    taskId: "task-test",
    startTime: new Date(),
    attempt: 1,
    environment: env,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  };
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

const ENV = { STRIPE_API_KEY: "sk_test_123" };

describe("formEncode", () => {
  it("encodes flat fields", () => {
    expect(formEncode({ a: 1, b: "x y" })).toBe("a=1&b=x%20y");
  });
  it("encodes nested metadata with bracket notation", () => {
    expect(formEncode({ metadata: { k: "v" } })).toBe("metadata%5Bk%5D=v");
  });
  it("skips undefined and null", () => {
    expect(formEncode({ a: 1, b: undefined, c: null })).toBe("a=1");
  });
});

describe("stripeAdapter", () => {
  describe("metadata", () => {
    it("has the correct name", () => expect(stripeAdapter.name).toBe("nexus-adapter-stripe"));
    it("exposes database capabilities", () => {
      expect(stripeAdapter.capabilities).toContain("database.query");
      expect(stripeAdapter.capabilities).toContain("database.execute");
    });
  });

  describe("canExecute()", () => {
    for (const t of [
      "stripe.create-customer",
      "stripe.create-payment-intent",
      "stripe.list-charges",
      "stripe.get-balance",
      "stripe.refund",
    ]) {
      it(`handles ${t}`, () => expect(stripeAdapter.canExecute(t)).toBe(true));
    }
    it("rejects unknown types", () =>
      expect(stripeAdapter.canExecute("github.get-repo")).toBe(false));
  });

  describe("auth", () => {
    it("throws AdapterConfigError when STRIPE_API_KEY is missing", async () => {
      await expect(
        stripeAdapter.execute({ taskType: "stripe.get-balance" }, makeCtx()),
      ).rejects.toBeInstanceOf(AdapterConfigError);
    });
  });

  describe("execute()", () => {
    it("create-customer POSTs form-encoded body with Bearer auth", async () => {
      const fetchFn = mockFetch(200, { id: "cus_1", object: "customer" });
      const out = await stripeAdapter.execute(
        { taskType: "stripe.create-customer", email: "a@b.com", name: "A" },
        makeCtx(ENV),
      );
      expect(out).toMatchObject({ id: "cus_1" });
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(url).toBe("https://api.stripe.com/v1/customers");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer sk_test_123");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(init.body).toContain("email=a%40b.com");
    });

    it("create-payment-intent sends amount + currency", async () => {
      const fetchFn = mockFetch(200, { id: "pi_1" });
      await stripeAdapter.execute(
        { taskType: "stripe.create-payment-intent", amount: 1500, currency: "usd" },
        makeCtx(ENV),
      );
      const init = fetchFn.mock.calls[0]![1];
      expect(init.body).toContain("amount=1500");
      expect(init.body).toContain("currency=usd");
    });

    it("list-charges uses GET with query string and no body", async () => {
      const fetchFn = mockFetch(200, { data: [] });
      await stripeAdapter.execute({ taskType: "stripe.list-charges", limit: 5 }, makeCtx(ENV));
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(url).toBe("https://api.stripe.com/v1/charges?limit=5");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
    });

    it("honours STRIPE_API_URL override", async () => {
      const fetchFn = mockFetch(200, {});
      await stripeAdapter.execute(
        { taskType: "stripe.get-balance" },
        makeCtx({ ...ENV, STRIPE_API_URL: "https://stripe.mock" }),
      );
      expect(fetchFn.mock.calls[0]![0]).toBe("https://stripe.mock/v1/balance");
    });

    it("throws AdapterHttpError on non-2xx", async () => {
      mockFetch(402, { error: { message: "card declined" } });
      await expect(
        stripeAdapter.execute(
          { taskType: "stripe.create-payment-intent", amount: 1, currency: "usd" },
          makeCtx(ENV),
        ),
      ).rejects.toBeInstanceOf(AdapterHttpError);
    });
  });
});
