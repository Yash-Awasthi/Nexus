// SPDX-License-Identifier: Apache-2.0
/** A 3D force layout: nodes push apart, linked nodes pull together, everything drifts to the centre. */

export interface LayoutEdge {
  subjectId: string;
  objectId: string;
}

/** Deterministic, so the same graph always settles into the same shape. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** x, y, z for each node id, in the order given, roughly within a unit-scale ball. */
export function layoutGraph(
  ids: string[],
  edges: LayoutEdge[],
  steps = 260,
  linkLength = 1.1,
): Float32Array {
  const n = ids.length;
  const pos = new Float32Array(n * 3);
  if (n === 0) return pos;
  const rand = seeded(n * 7919 + edges.length);
  const radius = Math.cbrt(n) * linkLength;
  for (let i = 0; i < n; i++) {
    // A point in a ball, not on a shell, so nothing starts on top of another.
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = radius * Math.cbrt(rand());
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(t), r * u, r * s * Math.sin(t)], i * 3);
  }
  const index = new Map(ids.map((id, i) => [id, i]));
  const links = edges
    .map((e) => [index.get(e.subjectId), index.get(e.objectId)] as const)
    .filter(
      (l): l is readonly [number, number] =>
        l[0] !== undefined && l[1] !== undefined && l[0] !== l[1],
    );

  const force = new Float32Array(n * 3);
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps;
    force.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i * 3]! - pos[j * 3]!;
        let dy = pos[i * 3 + 1]! - pos[j * 3 + 1]!;
        let dz = pos[i * 3 + 2]! - pos[j * 3 + 2]!;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-4) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          dz = rand() - 0.5;
          d2 = 0.25;
        }
        const push = (linkLength * linkLength) / d2;
        force[i * 3]! += dx * push;
        force[i * 3 + 1]! += dy * push;
        force[i * 3 + 2]! += dz * push;
        force[j * 3]! -= dx * push;
        force[j * 3 + 1]! -= dy * push;
        force[j * 3 + 2]! -= dz * push;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[b * 3]! - pos[a * 3]!;
      const dy = pos[b * 3 + 1]! - pos[a * 3 + 1]!;
      const dz = pos[b * 3 + 2]! - pos[a * 3 + 2]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      const pull = ((d - linkLength) / d) * 0.35;
      force[a * 3]! += dx * pull;
      force[a * 3 + 1]! += dy * pull;
      force[a * 3 + 2]! += dz * pull;
      force[b * 3]! -= dx * pull;
      force[b * 3 + 1]! -= dy * pull;
      force[b * 3 + 2]! -= dz * pull;
    }
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const f = force[i * 3 + k]! - pos[i * 3 + k]! * 0.06;
        // Cap each step so a close pair cannot fling a node out of the picture.
        pos[i * 3 + k]! += Math.max(-0.4, Math.min(0.4, f * 0.05)) * cool;
      }
    }
  }
  return pos;
}
