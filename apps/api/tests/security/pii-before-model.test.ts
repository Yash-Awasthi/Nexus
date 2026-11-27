// SPDX-License-Identifier: Apache-2.0
/**
 * Personal data is removed before the model sees it, not after.
 *
 * "We redact PII" is easy to believe and easy to get wrong in one place: a notice that says a card number was
 * found is not a redaction, and a redaction applied to the transcript rather than to the prompt leaves the
 * data in the provider's request. This test drives the real `/api/chat/stream` route with a scripted driver
 * and reads what that driver was actually asked — the only place that can tell the difference.
 *
 * It also pins the second half of the promise: with detection on and auto-anonymize off, the user is told
 * what was found and the message goes out unchanged, because silently altering someone's question is its own
 * surprise. The setting that changes behaviour is reported to the user in the same stream.
 */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm/drivers";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm/drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const SECRET = "pii-before-model-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

/** Every prompt a driver was asked, in order, with the user message it carried. */
const seen: string[] = [];

async function stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
  const last = String(opts.messages.at(-1)?.content ?? "");
  seen.push(last);
  await handler({ delta: "FINAL: noted.", done: true });
  return {
    id: "s",
    content: "FINAL: noted.",
    model: opts.model,
    finishReason: "stop",
  } as LlmResponse;
}

vi.mock("../../src/lib/provider-keys.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.ts")>()),
  buildUserDriverRegistry: async (_userId: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    for (const provider of new Set(providers))
      registry.register(
        { provider, model: "s", complete: stream, stream } as unknown as LlmDriver,
        provider,
      );
    return { registry, missing: [] as string[] };
  },
}));

const { buildServer } = await import("../../src/server.ts");
const { findPii, redactPii } = await import("../../src/lib/chat-safety.ts");

function tokenFor(userId: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${signature}`;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const CARD = "4111 1111 1111 1111";
const EMAIL = "person@example.com";
const QUESTION = `My card is ${CARD} and my email is ${EMAIL} — can you summarise the refund policy?`;

async function ask(token: string, message: string): Promise<string> {
  seen.length = 0;
  const response = await app.inject({
    method: "POST",
    url: "/api/chat/stream",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      message,
      members: [{ label: "Solo", provider: "openai", model: "m" }],
      round: 0,
      threadId: crypto.randomUUID(),
    },
  });
  return response.payload;
}

async function setPreferences(token: string, body: Record<string, unknown>): Promise<void> {
  const saved = await app.inject({
    method: "POST",
    url: "/api/settings/preferences",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  expect(saved.statusCode).toBeLessThan(400);
}

describe("detection and redaction", () => {
  it("recognises the shapes that matter and leaves ordinary text alone", () => {
    const kinds = findPii(QUESTION).map((item) => item.type);
    expect(kinds).toContain("card number");
    expect(kinds).toContain("email");
    expect(findPii("refunds take five working days")).toEqual([]);
  });

  it("redacts rather than deleting the sentence around it", () => {
    const redacted = redactPii(QUESTION);
    expect(redacted).not.toContain(CARD);
    expect(redacted).not.toContain(EMAIL);
    expect(redacted).toContain("[CARD_NUMBER]");
    expect(redacted).toContain("[EMAIL]");
    expect(redacted).toContain("summarise the refund policy");
  });

  it("does not mistake a digit-only slug for a card or a key", () => {
    // A Luhn-invalid 16-digit string is a reference number, not a card.
    expect(findPii("reference 1234 5678 9012 3456").map((item) => item.type)).not.toContain(
      "card number",
    );
    expect(findPii("install sk-learn-pipelines-2024 today")).toEqual([]);
  });
});

describe("what the model is actually asked", () => {
  it("sends the redacted message when auto-anonymize is on", async () => {
    const token = tokenFor(crypto.randomUUID());
    await setPreferences(token, { piiDetection: true, autoAnonymize: true });

    const body = await ask(token, QUESTION);

    expect(seen.length).toBeGreaterThan(0);
    for (const prompt of seen) {
      expect(prompt).not.toContain(CARD);
      expect(prompt).not.toContain(EMAIL);
      expect(prompt).toContain("[CARD_NUMBER]");
    }
    // The user is told what happened, in the same stream, before the answer.
    expect(body).toContain("Removed personal details or secrets");
    expect(body).toContain("card number");
  });

  it("asks the user first when detection is on and anonymize is off", async () => {
    const token = tokenFor(crypto.randomUUID());
    await setPreferences(token, { piiDetection: true, autoAnonymize: false });

    const body = await ask(token, QUESTION);

    expect(body).toContain("Turn on auto-anonymize");
    // Unchanged, because the user has not agreed to the edit yet.
    expect(seen.some((prompt) => prompt.includes(EMAIL))).toBe(true);
  });

  it("leaves a message alone when the user turned detection off", async () => {
    const token = tokenFor(crypto.randomUUID());
    await setPreferences(token, { piiDetection: false, autoAnonymize: false });

    const body = await ask(token, QUESTION);

    expect(body).not.toContain("personal details");
    expect(seen.some((prompt) => prompt.includes(EMAIL))).toBe(true);
  });
});
