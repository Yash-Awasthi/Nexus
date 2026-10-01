// SPDX-License-Identifier: Apache-2.0
/** Drivers built with no config read their provider's key from the environment, as the SDK docs show. */
import { afterEach, expect, it } from "vitest";

import { AnthropicDriver, GroqDriver, OpenAIDriver } from "../src/index.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

it("reads GROQ_API_KEY, ANTHROPIC_API_KEY and OPENAI_API_KEY when no key is passed", async () => {
  process.env.GROQ_API_KEY = "gsk-env";
  process.env.ANTHROPIC_API_KEY = "sk-ant-env";
  process.env.OPENAI_API_KEY = "sk-env";
  const keyOf = (d: object) => (d as { apiKey: string }).apiKey;
  expect(keyOf(new GroqDriver())).toBe("gsk-env");
  expect(keyOf(new AnthropicDriver())).toBe("sk-ant-env");
  expect(keyOf(new OpenAIDriver())).toBe("sk-env");
  expect(keyOf(new GroqDriver({ apiKey: "explicit" }))).toBe("explicit");
});
