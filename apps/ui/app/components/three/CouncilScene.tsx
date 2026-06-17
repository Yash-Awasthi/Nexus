import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { CouncilFigure } from "./CouncilFigure";
import { ParticleField } from "./ParticleField";

const figureData = [
  { color: "#4d7cff", armPose: "pointing" as const },
  { color: "#ff4de8", armPose: "wide" as const },
  { color: "#ff8a4d", armPose: "lean" as const },
  { color: "#4dff8a", armPose: "gesture" as const },
  { color: "#8a4dff", armPose: "crossed" as const },
];

function CouncilTable() {
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (ringRef.current) {
      const mat = ringRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.3 + Math.sin(clock.elapsedTime * 0.8) * 0.15;
    }
  });

  return (
    <group>
      {/* Table surface */}
      <mesh position={[0, -0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[1.4, 1.4, 0.03, 32]} />
        <meshStandardMaterial color="#0a0a1a" roughness={0.8} metalness={0.2} transparent opacity={0.6} />
      </mesh>
      {/* Glowing ring edge */}
      <mesh ref={ringRef} position={[0, -0.18, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.4, 0.015, 8, 64]} />
        <meshBasicMaterial color="#4d7cff" transparent opacity={0.4} />
      </mesh>
    </group>
  );
}

function Scene() {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(clock.elapsedTime * 0.1) * 0.15;
    }
  });

  return (
    <>
      <ambientLight intensity={0.25} />
      <directionalLight position={[5, 8, 3]} intensity={0.6} color="#ffffff" />
      <pointLight position={[0, 0.5, 0]} intensity={2} color="#4d7cff" distance={6} decay={2} />

      <fog attach="fog" args={["#050510", 4, 15]} />

      <group ref={groupRef}>
        <CouncilTable />

        {figureData.map((fig, i) => {
          const angle = (i / figureData.length) * Math.PI * 2 - Math.PI / 2;
          const radius = 2;
          const x = Math.cos(angle) * radius;
          const z = Math.sin(angle) * radius;
          const rotY = Math.atan2(-x, -z);

          return (
            <CouncilFigure
              key={i}
              position={[x, 0, z]}
              rotation={[0, rotY, 0]}
              color={fig.color}
              armPose={fig.armPose}
              index={i}
            />
          );
        })}
      </group>

      <ParticleField count={100} radius={5} color="#4d7cff" />

      <EffectComposer>
        <Bloom luminanceThreshold={0.3} intensity={0.8} luminanceSmoothing={0.9} radius={0.8} />
        <Vignette offset={0.3} darkness={0.7} />
      </EffectComposer>
    </>
  );
}

export default function CouncilCanvas() {
  return (
    <Canvas
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      dpr={[1, 1.5]}
      camera={{ position: [0, 2.5, 5], fov: 45 }}
      style={{ width: "100%", height: "100%" }}
    >
      <Scene />
    </Canvas>
  );
}
