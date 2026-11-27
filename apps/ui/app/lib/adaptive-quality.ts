// SPDX-License-Identifier: Apache-2.0
/**
 * How much work the 3-D graph is allowed to do, decided from how fast it is actually running.
 *
 * A knowledge graph of a few thousand entities is fine on a discrete GPU and a slideshow on an old
 * laptop's integrated one. There is no setting a person should have to find for that: the renderer
 * measures its own frame rate and steps down — first the pixel ratio, then the idle rotation — until the
 * frame budget holds. Pure functions so the policy can be tested without a browser.
 *
 * The steps are ordered from best to cheapest, and the last one stops animating entirely: a static graph
 * that responds to drags is still a good graph, while a spinning one at 12 fps is not.
 */

export interface QualityStep {
  /** Device pixel ratio cap. Halving it quarters the fragment work. */
  dpr: number;
  /** Whether the graph turns on its own when nobody is touching it. */
  animate: boolean;
}

export const QUALITY_STEPS: readonly QualityStep[] = [
  { dpr: 2, animate: true },
  { dpr: 1.5, animate: true },
  { dpr: 1, animate: true },
  { dpr: 1, animate: false },
];

/** Below this the graph feels broken rather than busy. */
export const SLOW_FPS = 45;

/** How many frames to average before judging; a single slow frame is a garbage collection, not a laptop. */
export const SAMPLE_FRAMES = 90;

/**
 * The next step to use, given the current one and the measured rate.
 *
 * Monotone: it only ever steps down. A graph that stuttered once while a page was loading should not
 * climb back to the expensive setting and stutter again on the next scroll — that oscillation is worse
 * than staying plain.
 */
export function nextQualityStep(current: number, avgFps: number): number {
  const index = Math.max(0, Math.min(QUALITY_STEPS.length - 1, Math.trunc(current)));
  if (avgFps >= SLOW_FPS) return index;
  return Math.min(QUALITY_STEPS.length - 1, index + 1);
}

/** The pixel ratio to ask the renderer for, never above what the display actually has. */
export function pixelRatioFor(step: number, devicePixelRatio: number): number {
  const cap = QUALITY_STEPS[Math.max(0, Math.min(QUALITY_STEPS.length - 1, step))]!.dpr;
  return Math.min(Math.max(devicePixelRatio || 1, 1), cap);
}

/** Whether the idle rotation is allowed at this step. */
export function shouldAnimate(step: number): boolean {
  return QUALITY_STEPS[Math.max(0, Math.min(QUALITY_STEPS.length - 1, step))]!.animate;
}
