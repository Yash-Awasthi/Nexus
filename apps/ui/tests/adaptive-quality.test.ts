// SPDX-License-Identifier: Apache-2.0
/**
 * The adaptive-quality policy (plan M5.4.6): how much work a scene may do, decided from how fast it is
 * actually running.
 *
 * The point of testing the policy rather than a screenshot: "holds 60 fps" cannot be asserted on a
 * machine that is not the person's laptop, but "steps down when it cannot" can. A stuttering scene is
 * worse than a plain one, so the policy is monotone.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  QUALITY_STEPS,
  SLOW_FPS,
  nextQualityStep,
  pixelRatioFor,
  shouldAnimate,
} from "../app/lib/adaptive-quality";

describe("adaptive quality", () => {
  it("stays put when the frame rate is fine", () => {
    expect(nextQualityStep(0, 60)).toBe(0);
    expect(nextQualityStep(2, SLOW_FPS)).toBe(2);
  });

  it("steps down one at a time when frames are missed, and never up", () => {
    expect(nextQualityStep(0, 20)).toBe(1);
    expect(nextQualityStep(1, 20)).toBe(2);
    expect(nextQualityStep(2, 20)).toBe(3);
    // At the cheapest step it stops; a graph at 12 fps does not become better by trying harder.
    expect(nextQualityStep(3, 5)).toBe(3);
    // A recovering machine does not climb back and oscillate.
    expect(nextQualityStep(3, 120)).toBe(3);
  });

  it("ends with a static graph, not a slow one", () => {
    expect(shouldAnimate(0)).toBe(true);
    expect(shouldAnimate(QUALITY_STEPS.length - 1)).toBe(false);
  });

  it("never asks for more pixels than the display has", () => {
    expect(pixelRatioFor(0, 3)).toBe(2);
    expect(pixelRatioFor(0, 1)).toBe(1);
    expect(pixelRatioFor(1, 2)).toBe(1.5);
    expect(pixelRatioFor(3, 2)).toBe(1);
    expect(pixelRatioFor(99, 2)).toBe(1);
  });
});
