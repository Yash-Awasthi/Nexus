"use client";

import type { ReactNode } from "react";

export function TextShimmer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      <style>
        {`
          @keyframes textShimmer {
            0% { background-position: -200% center; }
            100% { background-position: 200% center; }
          }
        `}
      </style>
      <span
        className={`inline-block bg-clip-text text-transparent ${className ?? ""}`}
        style={{
          backgroundImage:
            "linear-gradient(90deg, rgba(148,163,184,0.6) 0%, rgba(255,255,255,1) 25%, rgba(165,180,252,1) 50%, rgba(255,255,255,1) 75%, rgba(148,163,184,0.6) 100%)",
          backgroundSize: "200% auto",
          animation: "textShimmer 4s linear infinite",
          WebkitBackgroundClip: "text",
        }}
      >
        {children}
      </span>
    </>
  );
}
