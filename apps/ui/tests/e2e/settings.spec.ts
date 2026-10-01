// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "./fixtures";

test("provider keys ask Bedrock for each part of its credential", async ({ page }) => {
  await page.goto("/provider-keys");
  await page.getByRole("button", { name: "Add key" }).first().click();
  await page.getByRole("combobox").first().click();
  for (const p of ["Groq", "Google Gemini", "Mistral"])
    await page.getByRole("option", { name: p, exact: true }).waitFor();
  await page.getByRole("option", { name: "AWS Bedrock", exact: true }).click();
  await page.getByLabel("Access Key ID").waitFor();
  await page.getByLabel("Secret Access Key").waitFor();
});

test("an OpenAI-compatible endpoint saves under its own name, and Ollama needs no key", async ({
  page,
  api,
}) => {
  await page.goto("/provider-keys");
  await page.getByRole("button", { name: "Add key" }).first().click();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "OpenAI-compatible endpoint" }).click();
  await page.getByLabel("Name (agents use name/model)").fill("e2e-endpoint");
  await page.getByLabel("Base URL").fill("https://api.example.com/v1");
  await page.getByLabel("Default model").fill("vendor/model");
  await page.getByLabel("API key (optional)").fill("e2e-endpoint-key-0000");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved e2e-endpoint key.").waitFor();
  await page.getByRole("button", { name: "Delete e2e-endpoint key" }).click();
  await page
    .getByRole("button", { name: "Delete e2e-endpoint key" })
    .waitFor({ state: "detached" });

  // On the desktop a server on this computer is the user's own; a shared server refuses it.
  const local = (await api.call("GET", "/api/local/status")).status === 200;
  await page.getByRole("button", { name: "Add key" }).first().click();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Ollama (on this computer)" }).click();
  await expect(page.getByLabel("Base URL")).toHaveValue("http://localhost:11434/v1");
  await page.getByRole("button", { name: "Save" }).click();
  if (!local) {
    await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    return;
  }
  await page.getByText("Saved ollama key.").waitFor();
  await page.getByRole("button", { name: "Delete ollama key" }).click();
  await page.getByRole("button", { name: "Delete ollama key" }).waitFor({ state: "detached" });
});
