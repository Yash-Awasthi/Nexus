// SPDX-License-Identifier: Apache-2.0
/** What the 3D council looks like while each landing section is on screen, and how it blends between them. */

export interface SceneState {
  /** Sideways offset of the whole scene, so it sits beside the text column */
  shiftX: number;
  ring: number;
  /** Ring tilt about the x axis, in radians */
  tilt: number;
  /** Ring rotation speed, radians a second */
  spin: number;
  /** 0 = members on the ring, 1 = drawn in around the core */
  gather: number;
  /** Strength of the argument arcs and the pulses running along them */
  arcs: number;
  core: number;
  /** Task nodes fanning out of the core */
  burst: number;
  /** How far the contrarian drifts from the others */
  dissent: number;
  /** Archetype names beside their members */
  labels: number;
  camY: number;
  camZ: number;
  /** Overall brightness of the canvas */
  dim: number;
  /** Vertical offset on a narrow screen, where the text column covers the middle */
  py: number;
  /** Brightness multiplier on a narrow screen, where the scene sits behind the text */
  pdim: number;
}

export const SCENES: Record<string, SceneState> = {
  hero: {
    shiftX: 3.5,
    ring: 3.7,
    tilt: 0.95,
    spin: 0.12,
    gather: 0,
    arcs: 0.2,
    core: 0.55,
    burst: 0,
    dissent: 0,
    labels: 0,
    camY: 0.6,
    camZ: 11.5,
    dim: 1,
    py: 3.4,
    pdim: 0.9,
  },
  seat: {
    shiftX: 2.6,
    ring: 3.0,
    tilt: 1.15,
    spin: 0.06,
    gather: 0,
    arcs: 0,
    core: 0.35,
    burst: 0,
    dissent: 0,
    labels: 1,
    camY: 1.5,
    camZ: 12.8,
    dim: 1,
    py: 3.4,
    pdim: 1,
  },
  argue: {
    shiftX: 3.0,
    ring: 3.5,
    tilt: 0.7,
    spin: 0.55,
    gather: 0.05,
    arcs: 1,
    core: 0.6,
    burst: 0,
    dissent: 0.3,
    labels: 0,
    camY: 0.4,
    camZ: 10.5,
    dim: 1,
    py: 3.4,
    pdim: 1,
  },
  synthesis: {
    shiftX: 3.0,
    ring: 3.6,
    tilt: 0.85,
    spin: 0.25,
    gather: 0.75,
    arcs: 0.35,
    core: 1,
    burst: 0,
    dissent: 1,
    labels: 0,
    camY: 0.5,
    camZ: 10.5,
    dim: 1,
    py: 3.4,
    pdim: 1,
  },
  work: {
    shiftX: 1.2,
    ring: 3.0,
    tilt: 0.9,
    spin: 0.18,
    gather: 0.85,
    arcs: 0.1,
    core: 0.85,
    burst: 1,
    dissent: 0.6,
    labels: 0,
    camY: 0.2,
    camZ: 12,
    dim: 1,
    py: 3.0,
    pdim: 1,
  },
  demo: {
    shiftX: 0,
    ring: 5,
    tilt: 1.0,
    spin: 0.08,
    gather: 0,
    arcs: 0.15,
    core: 0.4,
    burst: 0,
    dissent: 0,
    labels: 0,
    camY: 0.5,
    camZ: 14,
    dim: 0.35,
    py: 0,
    pdim: 0.6,
  },
  features: {
    shiftX: 0,
    ring: 5.5,
    tilt: 0.8,
    spin: 0.06,
    gather: 0.1,
    arcs: 0.1,
    core: 0.3,
    burst: 0,
    dissent: 0,
    labels: 0,
    camY: 0,
    camZ: 15,
    dim: 0.28,
    py: 0,
    pdim: 0.6,
  },
  local: {
    shiftX: 0.6,
    ring: 3.4,
    tilt: 1.1,
    spin: 0.1,
    gather: 0.3,
    arcs: 0.1,
    core: 0.45,
    burst: 0,
    dissent: 0,
    labels: 0,
    camY: 0.3,
    camZ: 12,
    dim: 0.32,
    py: 0,
    pdim: 0.6,
  },
  closing: {
    shiftX: 0,
    ring: 3.4,
    tilt: 1.0,
    spin: 0.22,
    gather: 0,
    arcs: 0.45,
    core: 0.6,
    burst: 0,
    dissent: 0.2,
    labels: 0,
    camY: 0.4,
    camZ: 11,
    dim: 0.9,
    py: 0,
    pdim: 0.5,
  },
};

const KEYS = Object.keys(SCENES.hero!) as (keyof SceneState)[];

export function mixState(a: SceneState, b: SceneState, t: number): SceneState {
  const out = { ...a };
  for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

const smooth = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/** A section on screen: its scene key and where its centre sits relative to the middle of the viewport. */
export interface SceneAnchor {
  key: string;
  center: number;
}

/**
 * The state for a page position. Anchors are in page order; each holds its own scene while it is
 * near the middle of the viewport and blends into the next one in between.
 */
export function sceneAt(anchors: SceneAnchor[]): { state: SceneState; key: string } {
  const first = anchors[0];
  if (!first) return { state: SCENES.hero!, key: "hero" };
  const at = (key: string): SceneState => SCENES[key] ?? SCENES.hero!;
  if (first.center >= 0) return { state: at(first.key), key: first.key };
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    if (b.center > 0) {
      const t = (0 - a.center) / (b.center - a.center);
      // Hold each scene through the middle of its section, blend across the seam.
      const eased = smooth((t - 0.3) / 0.4);
      return { state: mixState(at(a.key), at(b.key), eased), key: t < 0.5 ? a.key : b.key };
    }
  }
  const last = anchors[anchors.length - 1]!;
  return { state: at(last.key), key: last.key };
}
