// SPDX-License-Identifier: Apache-2.0
/** Every document added to a knowledge base is classified and tagged. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const savedDb = process.env.DATABASE_URL;
const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
let kbId = "";
beforeAll(async () => {
  delete process.env.DATABASE_URL;
  app = await buildServer();
  await app.ready();
  kbId = (await app.inject({ method: "POST", url: "/api/kb", payload: { name: "inbox" } })).json<{
    id: string;
  }>().id;
});
afterAll(async () => {
  await app.inject({ method: "DELETE", url: `/api/kb/${kbId}` });
  await app.close();
  if (savedDb) process.env.DATABASE_URL = savedDb;
});

const upload = (name: string, content: string) =>
  app.inject({ method: "POST", url: `/api/kb/${kbId}/documents`, payload: { name, content } });

describe("knowledge-base document classification", () => {
  it("labels an invoice with its class and tags", async () => {
    const res = await upload(
      "acme-2026-07.txt",
      "INVOICE #1042\nBill to: Nexus Ltd\nSubtotal $1,200\nAmount due by 2026-08-01",
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      docClass: "invoice",
      tags: expect.arrayContaining(["invoice", "financial", "year:2026"]),
    });
  });

  it("keeps the label on the document list", async () => {
    await upload("nda.txt", "This agreement is made between the parties, who hereby agree to...");
    const docs = (await app.inject({ method: "GET", url: `/api/kb/${kbId}/documents` })).json<{
      documents: { name: string; docClass?: string }[];
    }>().documents;
    expect(docs.find((d) => d.name === "nda.txt")?.docClass).toBe("contract");
  });
});
