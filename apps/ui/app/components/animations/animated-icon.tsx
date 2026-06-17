"use client";

import { useState, type ElementType } from "react";

type AnimationType = "pulse" | "bounce" | "spin" | "float" | "glow";

interface AnimatedIconProps {
  icon: ElementType;
  className?: string;
  animation?: AnimationType;
  size?: number;
}

const animationStyles: Record<AnimationType, string> = {
  pulse: `
    @keyframes iconPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.2); }
    }
  `,
  bounce: `
    @keyframes iconBounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }
  `,
  spin: `
    @keyframes iconSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `,
  float: `
    @keyframes iconFloat {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      25% { transform: translateY(-3px) rotate(2deg); }
      75% { transform: translateY(3px) rotate(-2deg); }
    }
  `,
  glow: `
    @keyframes iconGlow {
      0%, 100% { filter: drop-shadow(0 0 2px currentColor); }
      50% { filter: drop-shadow(0 0 8px currentColor) drop-shadow(0 0 16px currentColor); }
    }
  `,
};

const animationCSS: Record<AnimationType, string> = {
  pulse: "iconPulse 0.6s ease-in-out",
  bounce: "iconBounce 0.5s ease-in-out",
  spin: "iconSpin 0.6s ease-in-out",
  float: "iconFloat 1s ease-in-out",
  glow: "iconGlow 1s ease-in-out",
};

export function AnimatedIcon({
  icon: Icon,
  className,
  animation = "pulse",
  size = 24,
}: AnimatedIconProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <>
      <style>{animationStyles[animation]}</style>
      <span
        className={`inline-flex items-center justify-center transition-colors duration-200 ${className ?? ""}`}
        style={{
          animation: isHovered ? animationCSS[animation] : "none",
          filter: isHovered
            ? "drop-shadow(0 0 6px currentColor)"
            : "drop-shadow(0 0 0px transparent)",
          transition: "filter 0.3s ease",
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <Icon size={size} />
      </span>
    </>
  );
}
