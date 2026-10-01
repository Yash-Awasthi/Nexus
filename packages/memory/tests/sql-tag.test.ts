// SPDX-License-Identifier: Apache-2.0
/** PgVectorStore can run on any Postgres client: its tagged-template SQL becomes a numbered query. */
import { expect, it } from "vitest";

import { sqlFromQuery } from "../src/index.js";

it("turns a tagged template into numbered parameters and returns the rows", async () => {
  const seen: { text: string; params: unknown[] }[] = [];
  const sql = sqlFromQuery(async (text, params) => {
    seen.push({ text, params });
    return { rows: [{ id: "m1" }] };
  });
  const id = "m1";
  const limit = 5;
  const rows = await sql`SELECT * FROM memories WHERE id = ${id} LIMIT ${limit}`;
  expect(rows).toEqual([{ id: "m1" }]);
  expect(seen[0]).toEqual({
    text: "SELECT * FROM memories WHERE id = $1 LIMIT $2",
    params: ["m1", 5],
  });
});
