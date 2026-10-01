// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";

import { missionDir } from "../../src/routes/missions.js";

it("gives two owners of the same mission id separate folders", async () => {
  const a = await missionDir("user-a", "mission-same");
  const b = await missionDir("user-b", "mission-same");
  expect(a).not.toBe(b);
  expect(a.endsWith("mission-same")).toBe(true);
});
