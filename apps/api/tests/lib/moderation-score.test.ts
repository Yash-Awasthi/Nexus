// SPDX-License-Identifier: Apache-2.0
/**
 * Moderation scores come from OpenAI's moderation endpoint when a key is at hand, and from a
 * keyword heuristic when no model is reachable at all, so /moderation never has to 502.
 */
import { expect, it } from "vitest";

import { heuristicScores, openaiScores } from "../../src/lib/moderation-score.js";

const CATS = ["hate", "violence", "sexual", "self_harm", "harassment", "spam"];

it("flags threats, self-harm and spam by keyword and leaves plain text at zero", () => {
  expect(heuristicScores("I will kill you tomorrow", CATS).violence).toBeGreaterThan(0.8);
  expect(heuristicScores("I want to kill myself", CATS).self_harm).toBeGreaterThan(0.7);
  expect(heuristicScores("BUY NOW!!! click here for free money $$$", CATS).spam).toBeGreaterThan(
    0.9,
  );
  expect(Object.values(heuristicScores("The meeting moved to Tuesday.", CATS))).toEqual(
    CATS.map(() => 0),
  );
});

it("maps OpenAI's category scores onto the configured names", async () => {
  let sent: { url: string; auth: string | null; body: unknown } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent = {
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)),
    };
    return new Response(
      JSON.stringify({
        results: [
          {
            category_scores: {
              hate: 0.1,
              violence: 0.93,
              sexual: 0,
              "self-harm": 0.02,
              harassment: 0.4,
            },
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const scores = await openaiScores("text", CATS, "sk-test", fakeFetch);
  expect(sent?.url).toBe("https://api.openai.com/v1/moderations");
  expect(sent?.auth).toBe("Bearer sk-test");
  expect(scores).toEqual({
    hate: 0.1,
    violence: 0.93,
    sexual: 0,
    self_harm: 0.02,
    harassment: 0.4,
    spam: 0,
  });
});
