import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

interface CouncilFigureProps {
  position: [number, number, number];
  rotation: [number, number, number];
  color: string;
  armPose: "pointing" | "wide" | "lean" | "crossed" | "gesture";
  index: number;
}

export function CouncilFigure({ position, rotation, color, armPose, index }: CouncilFigureProps) {
  const groupRef = useRef<THREE.Group>(null);
  const leftArmRef = useRef<THREE.Mesh>(null);
  const rightArmRef = useRef<THREE.Mesh>(null);

  // Arm rotation based on pose
  const armAngles = {
    pointing: { left: [0, 0, 0.5], right: [-0.8, 0, -0.3] },
    wide: { left: [0, 0, 1.2], right: [0, 0, -1.2] },
    lean: { left: [0.3, 0, 0.4], right: [0.3, 0, -0.4] },
    crossed: { left: [0.5, 0.3, 0.8], right: [0.5, -0.3, -0.8] },
    gesture: { left: [-0.5, 0, 0.6], right: [0.2, 0, -0.3] },
  };

  const arms = armAngles[armPose];

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    // Gentle bob
    groupRef.current.position.y = position[1] + Math.sin(t * 0.8 + index * 1.3) * 0.05;

    // Arm animation
    if (leftArmRef.current) {
      leftArmRef.current.rotation.z = arms.left[2] + Math.sin(t * 0.6 + index) * 0.15;
      leftArmRef.current.rotation.x = arms.left[0] + Math.sin(t * 0.4 + index * 0.7) * 0.1;
    }
    if (rightArmRef.current) {
      rightArmRef.current.rotation.z = arms.right[2] + Math.sin(t * 0.5 + index + 1) * 0.15;
      rightArmRef.current.rotation.x = arms.right[0] + Math.cos(t * 0.4 + index * 0.5) * 0.1;
    }
  });

  return (
    <group ref={groupRef} position={position} rotation={rotation}>
      {/* Head */}
      <mesh position={[0, 0.65, 0]}>
        <sphereGeometry args={[0.16, 16, 16]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.1} />
      </mesh>

      {/* Body (capsule) */}
      <mesh position={[0, 0.15, 0]}>
        <capsuleGeometry args={[0.15, 0.35, 8, 16]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} />
      </mesh>

      {/* Left arm */}
      <mesh
        ref={leftArmRef}
        position={[0.22, 0.3, 0]}
        rotation={[arms.left[0], arms.left[1], arms.left[2]]}
      >
        <cylinderGeometry args={[0.035, 0.03, 0.35, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>

      {/* Right arm */}
      <mesh
        ref={rightArmRef}
        position={[-0.22, 0.3, 0]}
        rotation={[arms.right[0], arms.right[1], arms.right[2]]}
      >
        <cylinderGeometry args={[0.035, 0.03, 0.35, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>

      {/* Glow at feet */}
      <mesh position={[0, -0.15, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.2, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.15} />
      </mesh>
    </group>
  );
}
