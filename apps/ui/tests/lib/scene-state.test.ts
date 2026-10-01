// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { SCENES, mixState, sceneAt } from "~/components/landing/scene-state";

describe("mixState", () => {
  it("returns each end at 0 and 1 and the midpoint between", () => {
    const a = SCENES.hero!;
    const b = SCENES.synthesis!;
    expect(mixState(a, b, 0)).toEqual(a);
    expect(mixState(a, b, 1)).toEqual(b);
    expect(mixState(a, b, 0.5).gather).toBeCloseTo((a.gather + b.gather) / 2);
  });
});

describe("sceneAt", () => {
  const anchors = (...centers: number[]) =>
    centers.map((center, i) => ({ key: ["hero", "seat", "argue"][i]!, center }));

  it("holds the first scene before its section reaches the middle", () => {
    expect(sceneAt(anchors(300, 1000)).key).toBe("hero");
    expect(sceneAt(anchors(300, 1000)).state).toEqual(SCENES.hero);
  });

  it("holds a scene while its section is near the middle of the viewport", () => {
    // hero centre 100px above the middle, next section 900px below: still the hero's scene
    expect(sceneAt(anchors(-100, 900)).state).toEqual(SCENES.hero);
  });

  it("blends across the seam between two sections", () => {
    const { state, key } = sceneAt(anchors(-500, 500));
    expect(key).toBe("seat");
    expect(state).toEqual(mixState(SCENES.hero!, SCENES.seat!, 0.5));
  });

  it("holds the last scene once every section is above the middle", () => {
    expect(sceneAt(anchors(-900, -100, -50)).key).toBe("argue");
  });

  it("falls back to the hero scene with no anchors or an unknown key", () => {
    expect(sceneAt([]).key).toBe("hero");
    expect(sceneAt([{ key: "nope", center: -10 }]).state).toEqual(SCENES.hero);
  });
});
