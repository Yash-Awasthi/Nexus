// SPDX-License-Identifier: Apache-2.0
/** Draws the knowledge graph in 3D: a sphere per entity, a line per relationship, drag to turn it. */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  WebGLRenderer,
} from "three";

import { layoutGraph } from "~/lib/graph-layout";

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  rank?: number;
}
export interface GraphEdge {
  id: string;
  subjectId: string;
  predicate: string;
  objectId: string;
}

const FADED = new Color(0xb4b8c8);

const TYPE_COLORS: Record<string, number> = {
  PERSON: 0x7c83ff,
  ORG: 0x3fd0e0,
  LOCATION: 0x6ee7a8,
  DATE: 0xfbbf24,
  PRODUCT: 0xc084fc,
  EVENT: 0xf472b6,
  OTHER: 0x9aa0b4,
};
const colorOf = (type: string): number => TYPE_COLORS[type] ?? TYPE_COLORS.OTHER!;

export interface GraphHandle {
  select(id: string | null): void;
  zoom(factor: number): void;
  spin(on: boolean): void;
  dispose(): void;
}

interface GraphOptions {
  reducedMotion: boolean;
  onSelect(id: string | null): void;
  onHover(id: string | null, x: number, y: number): void;
}

/** Returns null when WebGL is unavailable. */
export function mountGraph(
  host: HTMLElement,
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: GraphOptions,
): GraphHandle | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  // Vertical drags still scroll the page on a phone; sideways ones turn the graph.
  canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:pan-y;cursor:grab";
  host.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 200);
  const world = new Group();
  scene.add(world);

  const pos = layoutGraph(
    nodes.map((n) => n.id),
    edges,
  );
  let extent = 1;
  for (let i = 0; i < nodes.length; i++) {
    extent = Math.max(extent, Math.hypot(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!));
  }
  let distance = extent * 2.4 + 1.5;
  const minDistance = extent * 0.8 + 1;
  const maxDistance = extent * 6 + 6;

  // ── nodes ────────────────────────────────────────────────────────────────
  const sphere = new SphereGeometry(1, 18, 14);
  const sphereMat = new MeshBasicMaterial();
  const mesh = new InstancedMesh(sphere, sphereMat, Math.max(nodes.length, 1));
  const dummy = new Object3D();
  const base = new Color();
  const sizes = nodes.map((n) => 0.14 + Math.min(n.rank ?? 0, 10) * 0.035);
  const paint = (selected: number, near: Set<number>) => {
    nodes.forEach((n, i) => {
      dummy.position.set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
      dummy.scale.setScalar(sizes[i]! * (i === selected ? 1.6 : 1));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      base.setHex(colorOf(n.type));
      // Everything but the chosen node and its neighbours steps back.
      if (selected >= 0 && i !== selected && !near.has(i)) base.lerp(FADED, 0.72);
      mesh.setColorAt(i, base);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
  mesh.count = nodes.length;
  world.add(mesh);

  // ── edges ────────────────────────────────────────────────────────────────
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const links = edges
    .map((e) => [index.get(e.subjectId), index.get(e.objectId)] as const)
    .filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined);
  const linePos = new Float32Array(links.length * 6);
  const lineCol = new Float32Array(links.length * 6);
  links.forEach(([a, b], k) => {
    linePos.set(
      [
        pos[a * 3]!,
        pos[a * 3 + 1]!,
        pos[a * 3 + 2]!,
        pos[b * 3]!,
        pos[b * 3 + 1]!,
        pos[b * 3 + 2]!,
      ],
      k * 6,
    );
  });
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute("position", new BufferAttribute(linePos, 3));
  lineGeo.setAttribute("color", new BufferAttribute(lineCol, 3).setUsage(DynamicDrawUsage));
  const lineMat = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
  world.add(new LineSegments(lineGeo, lineMat));
  const shade = (selected: number) => {
    const dim = new Color(0x3b4160);
    const lit = new Color(0xb9c0ff);
    links.forEach(([a, b], k) => {
      const c =
        selected < 0
          ? dim.clone().multiplyScalar(1.5)
          : a === selected || b === selected
            ? lit
            : dim.clone().multiplyScalar(0.35);
      lineCol.set([c.r, c.g, c.b, c.r, c.g, c.b], k * 6);
    });
    lineGeo.getAttribute("color").needsUpdate = true;
  };

  // ── selection ────────────────────────────────────────────────────────────
  let selected = -1;
  const select = (id: string | null) => {
    selected = id === null ? -1 : (index.get(id) ?? -1);
    const near = new Set<number>();
    if (selected >= 0) {
      for (const [a, b] of links) {
        if (a === selected) near.add(b);
        else if (b === selected) near.add(a);
      }
    }
    paint(selected, near);
    shade(selected);
  };
  select(null);

  // ── input ────────────────────────────────────────────────────────────────
  let rotY = 0.4;
  let rotX = 0.25;
  let auto = !opts.reducedMotion;
  let dragging = false;
  let moved = 0;
  let last = { x: 0, y: 0 };
  const ray = new Raycaster();
  const pointer = new Vector2();
  const pick = (e: PointerEvent): number => {
    const r = canvas.getBoundingClientRect();
    pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    ray.setFromCamera(pointer, camera);
    return ray.intersectObject(mesh)[0]?.instanceId ?? -1;
  };
  const onDown = (e: PointerEvent) => {
    dragging = true;
    moved = 0;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  };
  const onMove = (e: PointerEvent) => {
    if (dragging) {
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: e.clientX, y: e.clientY };
      rotY += dx * 0.008;
      rotX = Math.max(-1.3, Math.min(1.3, rotX + dy * 0.008));
      opts.onHover(null, 0, 0);
      return;
    }
    if (e.pointerType === "touch") return;
    const i = pick(e);
    canvas.style.cursor = i >= 0 ? "pointer" : "grab";
    const r = canvas.getBoundingClientRect();
    opts.onHover(i >= 0 ? nodes[i]!.id : null, e.clientX - r.left, e.clientY - r.top);
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    canvas.style.cursor = "grab";
    if (moved < 5) {
      const i = pick(e);
      opts.onSelect(i >= 0 ? nodes[i]!.id : null);
    }
  };
  const onLeave = () => opts.onHover(null, 0, 0);
  const onWheel = (e: WheelEvent) => {
    // Plain scrolling belongs to the page; pinch or Ctrl+wheel zooms.
    if (!e.ctrlKey) return;
    e.preventDefault();
    distance = Math.max(minDistance, Math.min(maxDistance, distance * (1 + e.deltaY * 0.004)));
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // ── loop ─────────────────────────────────────────────────────────────────
  const resize = () => {
    const w = host.clientWidth || 300;
    const h = host.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  function render() {
    world.rotation.set(rotX, rotY, 0);
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  let lastTime = performance.now();
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    if (auto && !dragging) rotY += dt * 0.12;
    render();
  });
  resize();

  return {
    select,
    zoom(factor) {
      distance = Math.max(minDistance, Math.min(maxDistance, distance * factor));
    },
    spin(on) {
      auto = on && !opts.reducedMotion;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      sphere.dispose();
      sphereMat.dispose();
      mesh.dispose();
      lineGeo.dispose();
      lineMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
