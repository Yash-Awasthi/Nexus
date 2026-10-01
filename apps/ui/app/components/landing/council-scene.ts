// SPDX-License-Identifier: Apache-2.0
/**
 * The landing page's 3D council: seven members on a ring around a core. Scrolling changes what
 * they do (take their seats, argue along arcs, gather around a synthesis with the contrarian
 * holding out, fan tasks out to a team) using the states in scene-state.ts.
 */
import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  QuadraticBezierCurve3,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLRenderer,
  WireframeGeometry,
} from "three";

import { SCENES, sceneAt, type SceneAnchor, type SceneState } from "./scene-state";

const MEMBERS = [
  { name: "Architect", color: 0x7c83ff },
  { name: "Contrarian", color: 0xff7a59 },
  { name: "Empiricist", color: 0x3fd0e0 },
  { name: "Ethicist", color: 0x6ee7a8 },
  { name: "Futurist", color: 0xc084fc },
  { name: "Pragmatist", color: 0xfbbf24 },
  { name: "Historian", color: 0xf472b6 },
] as const;
const CONTRARIAN = 1;
const PAIRS: [number, number][] = [
  [0, 2],
  [2, 4],
  [4, 6],
  [6, 1],
  [1, 3],
  [3, 5],
  [5, 0],
  [0, 3],
  [2, 5],
];
const ARC_POINTS = 28;
const X_AXIS = new Vector3(1, 0, 0);
const WHITE = new Color(0xffffff);

const ORB_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const ORB_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 2.2);
    vec3 c = uColor * (0.32 + rim * 1.5) + vec3(rim * 0.22);
    gl_FragColor = vec4(c, 0.6 + rim * 0.4);
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 1.6);
    vec3 c = mix(uColor, vec3(1.0), 0.3) * (0.7 + rim * 0.9);
    gl_FragColor = vec4(c, 1.0);
  }
`;

function glowTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function labelTexture(text: string, color: number): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 72;
  const g = c.getContext("2d")!;
  g.font = '500 30px "JetBrains Mono Variable", ui-monospace, monospace';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  g.fillText(text.toUpperCase(), 160, 36);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

const smoothstep = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/** Task nodes of a small team: three leads, each with three reports. */
const TREE: { pos: Vector3; parent: number; size: number }[] = (() => {
  const nodes: { pos: Vector3; parent: number; size: number }[] = [];
  [-1.7, 0, 1.7].forEach((y, j) =>
    nodes.push({ pos: new Vector3(2.7, y, (j - 1) * 0.4), parent: -1, size: 0.3 }),
  );
  [-1.7, 0, 1.7].forEach((y, j) =>
    [-0.62, 0, 0.62].forEach((dy, k) =>
      nodes.push({ pos: new Vector3(4.7, y + dy, (k - 1) * 0.5), parent: j, size: 0.2 }),
    ),
  );
  return nodes;
})();

export interface MountOptions {
  reducedMotion: boolean;
  onSection?: (key: string) => void;
}

/** Builds the scene inside `host`. Returns a disposer, or null when WebGL is unavailable. */
export function mountCouncilScene(host: HTMLElement, opts: MountOptions): (() => void) | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
  const lowPower =
    (navigator.hardwareConcurrency ?? 8) <= 4 || window.matchMedia("(max-width: 640px)").matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPower ? 1.25 : 1.75));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.style.cssText = "width:100%;height:100%;display:block";
  host.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  const world = new Group();
  scene.add(world);

  const glow = glowTexture();
  const disposables: { dispose(): void }[] = [glow];
  const own = <T extends { dispose(): void }>(x: T): T => (disposables.push(x), x);

  // ── stars ────────────────────────────────────────────────────────────────
  const starCount = lowPower ? 700 : 1500;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 10 + Math.random() * 26;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    // Behind the scene and to the sides, never near the camera, where a point would swell into a square.
    const z = r * Math.sin(ph) * Math.sin(th);
    starPos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.7, z > 4 ? -z : z], i * 3);
  }
  const starGeo = own(new BufferGeometry());
  starGeo.setAttribute("position", new BufferAttribute(starPos, 3));
  const starMat = own(
    new PointsMaterial({
      size: 0.16,
      map: glow,
      color: 0xb8c0ff,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const stars = new Points(starGeo, starMat);
  scene.add(stars);

  // ── ring guide ───────────────────────────────────────────────────────────
  const ringPts: number[] = [];
  for (let i = 0; i < 160; i++)
    ringPts.push(Math.cos((i / 160) * Math.PI * 2), 0, Math.sin((i / 160) * Math.PI * 2));
  const ringGeo = own(new BufferGeometry());
  ringGeo.setAttribute("position", new BufferAttribute(new Float32Array(ringPts), 3));
  const ringMat = own(new LineBasicMaterial({ color: 0x8f9bff, transparent: true, opacity: 0.16 }));
  const ringGuide = new LineLoop(ringGeo, ringMat);
  world.add(ringGuide);

  // ── core ─────────────────────────────────────────────────────────────────
  const coreMat = own(
    new ShaderMaterial({
      uniforms: { uColor: { value: new Color(0x9aa4ff) } },
      vertexShader: ORB_VERTEX,
      fragmentShader: CORE_FRAGMENT,
    }),
  );
  const coreMesh = new Mesh(own(new SphereGeometry(0.5, 32, 24)), coreMat);
  const wireGeo = own(new WireframeGeometry(new IcosahedronGeometry(0.85, 1)));
  const coreWire = new LineSegments(
    wireGeo,
    own(
      new LineBasicMaterial({
        color: 0x8f9bff,
        transparent: true,
        opacity: 0.75,
        blending: AdditiveBlending,
      }),
    ),
  );
  const haloMat = own(
    new SpriteMaterial({
      map: glow,
      color: 0x7c83ff,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const coreHalo = new Sprite(haloMat);
  world.add(coreMesh, coreWire, coreHalo);

  // ── members ──────────────────────────────────────────────────────────────
  const orbGeo = own(new SphereGeometry(0.27, 40, 24));
  const orbs = MEMBERS.map((m) => {
    const mat = own(
      new ShaderMaterial({
        uniforms: { uColor: { value: new Color(m.color) } },
        vertexShader: ORB_VERTEX,
        fragmentShader: ORB_FRAGMENT,
        transparent: true,
      }),
    );
    const mesh = new Mesh(orbGeo, mat);
    const halo = new Sprite(
      own(
        new SpriteMaterial({
          map: glow,
          color: m.color,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      ),
    );
    halo.scale.setScalar(1.6);
    mesh.add(halo);
    const label = new Sprite(
      own(
        new SpriteMaterial({
          map: own(labelTexture(m.name, m.color)),
          transparent: true,
          opacity: 0,
          depthTest: false,
        }),
      ),
    );
    label.scale.set(1.55, 0.35, 1);
    label.position.y = 0.58;
    label.renderOrder = 10;
    mesh.add(label);
    world.add(mesh);
    return { mesh, label, labelMat: label.material };
  });

  // ── arcs and the pulses that run along them ──────────────────────────────
  const arcMat = own(
    new LineBasicMaterial({
      color: 0x9aa4ff,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
    }),
  );
  const arcs = PAIRS.map(() => {
    const geo = own(new BufferGeometry());
    geo.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(ARC_POINTS * 3), 3).setUsage(DynamicDrawUsage),
    );
    const line = new Line(geo, arcMat);
    line.frustumCulled = false;
    world.add(line);
    return { geo, curve: new QuadraticBezierCurve3(new Vector3(), new Vector3(), new Vector3()) };
  });
  const pulseGeo = own(new BufferGeometry());
  pulseGeo.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(PAIRS.length * 2 * 3), 3).setUsage(DynamicDrawUsage),
  );
  const pulseMat = own(
    new PointsMaterial({
      size: 0.34,
      map: glow,
      color: 0xdfe3ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const pulses = new Points(pulseGeo, pulseMat);
  pulses.frustumCulled = false;
  world.add(pulses);

  // ── dissent line ─────────────────────────────────────────────────────────
  const dissentGeo = own(new BufferGeometry());
  dissentGeo.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(6), 3).setUsage(DynamicDrawUsage),
  );
  const dissentMat = own(
    new LineBasicMaterial({
      color: 0xff7a59,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
    }),
  );
  const dissentLine = new Line(dissentGeo, dissentMat);
  dissentLine.frustumCulled = false;
  world.add(dissentLine);

  // ── team ─────────────────────────────────────────────────────────────────
  const boxes = new InstancedMesh(
    own(new BoxGeometry(1, 1, 1)),
    own(new MeshLambertMaterial({ color: 0x5eead4, emissive: 0x0f766e })),
    TREE.length,
  );
  boxes.instanceMatrix.setUsage(DynamicDrawUsage);
  boxes.frustumCulled = false;
  const treeGeo = own(new BufferGeometry());
  treeGeo.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(TREE.length * 6), 3).setUsage(DynamicDrawUsage),
  );
  const treeMat = own(
    new LineBasicMaterial({
      color: 0x5eead4,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
    }),
  );
  const treeLines = new LineSegments(treeGeo, treeMat);
  treeLines.frustumCulled = false;
  world.add(boxes, treeLines);
  scene.add(
    new AmbientLight(0xffffff, 1.1),
    new DirectionalLight(0xffffff, 2.2).translateX(3).translateY(4).translateZ(5),
  );
  const dummy = new Object3D();

  // ── state ────────────────────────────────────────────────────────────────
  const cur: SceneState = { ...SCENES.hero! };
  let angle = 0;
  let pulsePhase = 0;
  let time = 0;
  let section = "";
  let desktop = 1;
  const mouse = { x: 0, y: 0 };
  const sections = () => Array.from(document.querySelectorAll<HTMLElement>("[data-scene]"));
  const target = (): { state: SceneState; key: string } => {
    const mid = window.innerHeight / 2;
    const anchors: SceneAnchor[] = sections().map((el) => {
      const r = el.getBoundingClientRect();
      return { key: el.dataset.scene ?? "hero", center: r.top + r.height / 2 - mid };
    });
    return sceneAt(anchors);
  };

  const pos = new Vector3();
  const positions = MEMBERS.map(() => new Vector3());
  const tmp = new Vector3();

  function frame(dt: number) {
    const { state: goal, key } = target();
    if (key !== section) {
      section = key;
      opts.onSection?.(key);
    }
    const k = opts.reducedMotion ? 1 : 1 - Math.exp(-dt * 3.4);
    for (const name of Object.keys(goal) as (keyof SceneState)[])
      cur[name] += (goal[name] - cur[name]) * k;

    if (!opts.reducedMotion) {
      time += dt;
      angle += dt * cur.spin;
      pulsePhase += dt * (0.25 + cur.arcs * 0.7);
    }

    world.position.x = cur.shiftX * desktop;
    world.position.y = cur.py * (1 - desktop);
    world.scale.setScalar(0.62 + 0.38 * desktop);
    world.rotation.y += (mouse.x * 0.22 - world.rotation.y) * 0.04;
    world.rotation.x += (mouse.y * 0.08 - world.rotation.x) * 0.04;
    camera.position.set(0, cur.camY, cur.camZ * (1 + (1 - desktop) * 0.35));
    camera.lookAt(0, 0, 0);
    host.style.opacity = (cur.dim * (cur.pdim + (1 - cur.pdim) * desktop)).toFixed(3);

    // members
    const ringR = cur.ring * (1 - cur.gather * 0.6);
    ringGuide.scale.setScalar(ringR);
    ringGuide.rotation.x = cur.tilt;
    ringMat.opacity = 0.16 * (1 - cur.gather * 0.6);
    const jitter = cur.arcs * 0.16;
    orbs.forEach((o, i) => {
      let r = ringR;
      let a = angle + (i / MEMBERS.length) * Math.PI * 2;
      if (i === CONTRARIAN) {
        r += cur.dissent * 2.3;
        a += cur.dissent * 0.4;
      }
      pos.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      pos.x += Math.sin(time * 2.1 + i * 1.7) * jitter;
      pos.y += Math.sin(time * 1.3 + i * 0.9) * (0.1 + jitter);
      pos.z += Math.cos(time * 1.9 + i * 2.3) * jitter;
      pos.applyAxisAngle(X_AXIS, cur.tilt);
      positions[i]!.copy(pos);
      o.mesh.position.copy(pos);
      o.mesh.scale.setScalar(i === CONTRARIAN ? 1 : 1 - cur.gather * 0.22);
      o.labelMat.opacity = cur.labels;
    });

    // core
    const cs = 0.7 + cur.core * 0.75;
    coreMesh.scale.setScalar(cs);
    coreWire.scale.setScalar(cs);
    coreWire.rotation.y += dt * 0.35;
    coreWire.rotation.x += dt * 0.2;
    (coreMat.uniforms.uColor!.value as Color).setHex(0x8f9bff).lerp(WHITE, cur.core * 0.6);
    coreHalo.scale.setScalar(2.4 + cur.core * 4);
    haloMat.opacity = 0.22 + cur.core * 0.55;

    // arcs
    arcMat.opacity = cur.arcs * 0.5;
    const arr = pulseGeo.getAttribute("position") as BufferAttribute;
    PAIRS.forEach(([ai, bi], n) => {
      const arc = arcs[n]!;
      const a = positions[ai]!;
      const b = positions[bi]!;
      arc.curve.v0.copy(a);
      arc.curve.v2.copy(b);
      arc.curve.v1.copy(a).add(b).multiplyScalar(0.18);
      const attr = arc.geo.getAttribute("position") as BufferAttribute;
      for (let p = 0; p < ARC_POINTS; p++) {
        arc.curve.getPoint(p / (ARC_POINTS - 1), tmp);
        attr.setXYZ(p, tmp.x, tmp.y, tmp.z);
      }
      attr.needsUpdate = true;
      for (let q = 0; q < 2; q++) {
        const t = (pulsePhase + n * 0.19 + q * 0.5) % 1;
        arc.curve.getPoint(q === 0 ? t : 1 - t, tmp);
        arr.setXYZ(n * 2 + q, tmp.x, tmp.y, tmp.z);
      }
    });
    arr.needsUpdate = true;
    pulseMat.opacity = Math.min(1, cur.arcs * 1.3);

    // dissent
    const dl = dissentGeo.getAttribute("position") as BufferAttribute;
    const cp = positions[CONTRARIAN]!;
    dl.setXYZ(0, 0, 0, 0);
    dl.setXYZ(1, cp.x, cp.y, cp.z);
    dl.needsUpdate = true;
    dissentMat.opacity = cur.dissent * 0.55;

    // team
    const show = cur.burst > 0.002;
    boxes.visible = treeLines.visible = show;
    if (show) {
      const tl = treeGeo.getAttribute("position") as BufferAttribute;
      const placed: Vector3[] = [];
      TREE.forEach((node, i) => {
        const level = node.parent < 0 ? 0 : 1;
        const e = smoothstep(cur.burst * 1.7 - level * 0.55 - (i % 9) * 0.03);
        const p = node.pos.clone().multiplyScalar(e);
        placed.push(p);
        dummy.position.copy(p);
        dummy.rotation.set(time * 0.6 + i, time * 0.8 + i, 0);
        dummy.scale.setScalar(node.size * e);
        dummy.updateMatrix();
        boxes.setMatrixAt(i, dummy.matrix);
        const from = node.parent < 0 ? new Vector3() : placed[node.parent]!;
        tl.setXYZ(i * 2, from.x, from.y, from.z);
        tl.setXYZ(i * 2 + 1, p.x, p.y, p.z);
      });
      boxes.instanceMatrix.needsUpdate = true;
      tl.needsUpdate = true;
      treeMat.opacity = cur.burst * 0.5;
    }

    stars.rotation.y += dt * 0.008;
    renderer.render(scene, camera);
  }

  // ── size, input, loop ────────────────────────────────────────────────────
  const resize = () => {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    desktop = smoothstep((camera.aspect - 0.85) / 0.5);
    if (opts.reducedMotion) frame(0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
  };
  const onScroll = () => opts.reducedMotion && frame(0);
  const onLost = (e: Event) => {
    e.preventDefault();
    renderer.setAnimationLoop(null);
  };
  const onRestored = () => start();
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  let last = performance.now();
  function start() {
    if (opts.reducedMotion) return frame(0);
    last = performance.now();
    renderer.setAnimationLoop((now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frame(dt);
    });
  }
  start();

  return () => {
    renderer.setAnimationLoop(null);
    ro.disconnect();
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("scroll", onScroll);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    for (const d of disposables) d.dispose();
    boxes.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
