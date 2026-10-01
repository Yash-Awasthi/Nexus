// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("an OpenAPI spec becomes MCP tools from the MCP page", async ({ page }) => {
  const name = `Pets ${Date.now()}`;
  const spec = {
    openapi: "3.0.0",
    info: { title: "Pets", version: "1" },
    servers: [{ url: "https://pets.example.com" }],
    paths: {
      "/pets": { get: { operationId: "listPets", summary: "List pets" } },
      "/pets/{id}": {
        get: {
          operationId: "getPet",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
    },
  };

  await page.goto("/mcp-servers");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Spec URL or JSON").fill(JSON.stringify(spec));
  await page.getByRole("button", { name: "Add API" }).click();

  const card = page.locator("div.rounded-lg").filter({ hasText: name });
  await expect(card.getByText("listPets")).toBeVisible();
  await expect(card.getByText("getPet")).toBeVisible();
  await expect(card.getByText(/\/api\/v1\/mcp\/openapi\/.+\/mcp/)).toBeVisible();

  await card.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(page.getByText(name)).toHaveCount(0);
});
