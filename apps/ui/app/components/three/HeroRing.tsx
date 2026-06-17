import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { ParticleField } from "./ParticleField";

function Ring({
  radius,
  tube,
  color,
  speed,
  tiltX,
  tiltZ,
}: {
  radius: number;
  tube: number;
  color: string;
  speed: number;
  tiltX: number;
  tiltZ: number;
}) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    ref.current.rotation.y = t * speed;
    ref.current.rotation.x = tiltX + Math.sin(t * 0.5) * 0.08;
    ref.current.rotation.z = tiltZ;
  });

  return (
    <mesh ref={ref}>
      <torusGeometry args={[radius, tube, 32, 128]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={1.5}
        roughness={0.2}
        metalness={0.8}
        transparent
        opacity={0.9}
      />
    </mesh>
  );
}

function HeroScene() {
  return (
    <>
      <ambientLight intensity={0.15} />
      <directionalLight position={[3, 5, 4]} intensity={0.4} />
      <pointLight position={[0, 0, 0]} intensity={1.5} color="#4d7cff" distance={8} />

      <fog attach="fog" args={["#050510", 3, 12]} />

      {/* Main ring */}
      <Ring radius={2.2} tube={0.06} color="#4d7cff" speed={0.3} tiltX={0.3} tiltZ={0} />
      {/* Secondary ring */}
      <Ring radius={2.6} tube={0.025} color="#4de8ff" speed={-0.2} tiltX={0.8} tiltZ={0.2} />
      {/* Tertiary ring */}
      <Ring radius={1.8} tube={0.02} color="#8a4dff" speed={0.15} tiltX={-0.4} tiltZ={-0.3} />

      {/* Center orb */}
      <mesh>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshStandardMaterial
          color="#4d7cff"
          emissive="#4d7cff"
          emissiveIntensity={2}
          transparent
          opacity={0.8}
        />
      </mesh>

      <ParticleField count={120} radius={6} color="#4d7cff" />

      <EffectComposer>
        <Bloom luminanceThreshold={0.2} intensity={1.2} luminanceSmoothing={0.9} radius={0.8} />
      </EffectComposer>
    </>
  );
}

export default function HeroCanvas() {
  return (
    <Canvas
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      dpr={[1, 1.5]}
      camera={{ position: [0, 0.5, 5], fov: 50 }}
      style={{ width: "100%", height: "100%" }}
    >
      <HeroScene />
    </Canvas>
  );
}
