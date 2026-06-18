"use client";

export function GlowOrbs({ className }: { className?: string }) {
  return (
    <div
      className={`absolute inset-0 overflow-hidden pointer-events-none ${className ?? ""}`}
    >
      <style>
        {`
          @keyframes orbFloat1 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            25% { transform: translate(80px, -60px) scale(1.1); }
            50% { transform: translate(-40px, -120px) scale(0.95); }
            75% { transform: translate(-80px, 40px) scale(1.05); }
          }
          @keyframes orbFloat2 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            25% { transform: translate(-100px, 80px) scale(1.05); }
            50% { transform: translate(60px, 40px) scale(1.1); }
            75% { transform: translate(40px, -80px) scale(0.9); }
          }
          @keyframes orbFloat3 {
            0%, 100% { transform: translate(0, 0) scale(1.05); }
            25% { transform: translate(60px, 100px) scale(0.95); }
            50% { transform: translate(-80px, 60px) scale(1.1); }
            75% { transform: translate(100px, -40px) scale(1); }
          }
          @keyframes orbFloat4 {
            0%, 100% { transform: translate(0, 0) scale(0.95); }
            25% { transform: translate(-60px, -80px) scale(1.1); }
            50% { transform: translate(100px, -40px) scale(1); }
            75% { transform: translate(-40px, 60px) scale(1.05); }
          }
        `}
      </style>

      {/* Blue orb */}
      <div
        className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full opacity-[0.12]"
        style={{
          background: "radial-gradient(circle, rgba(59,130,246,0.8) 0%, transparent 70%)",
          animation: "orbFloat1 20s ease-in-out infinite",
          filter: "blur(80px)",
        }}
      />

      {/* Violet orb */}
      <div
        className="absolute top-1/2 right-1/4 w-[450px] h-[450px] rounded-full opacity-[0.10]"
        style={{
          background: "radial-gradient(circle, rgba(139,92,246,0.8) 0%, transparent 70%)",
          animation: "orbFloat2 25s ease-in-out infinite",
          filter: "blur(80px)",
        }}
      />

      {/* Emerald orb */}
      <div
        className="absolute bottom-1/4 left-1/2 w-[400px] h-[400px] rounded-full opacity-[0.08]"
        style={{
          background: "radial-gradient(circle, rgba(16,185,129,0.8) 0%, transparent 70%)",
          animation: "orbFloat3 22s ease-in-out infinite",
          filter: "blur(80px)",
        }}
      />

      {/* Cyan accent orb */}
      <div
        className="absolute top-1/3 right-1/3 w-[350px] h-[350px] rounded-full opacity-[0.06]"
        style={{
          background: "radial-gradient(circle, rgba(6,182,212,0.8) 0%, transparent 70%)",
          animation: "orbFloat4 28s ease-in-out infinite",
          filter: "blur(80px)",
        }}
      />
    </div>
  );
}
