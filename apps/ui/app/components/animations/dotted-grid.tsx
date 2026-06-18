"use client";

export function DottedGrid({ className }: { className?: string }) {
  return (
    <div className={`absolute inset-0 overflow-hidden pointer-events-none ${className ?? ""}`}>
      <style>
        {`
          @keyframes dotPulse {
            0%, 100% { opacity: 0.3; }
            50% { opacity: 0.6; }
          }
          .dotted-grid-pattern {
            animation: dotPulse 4s ease-in-out infinite;
          }
        `}
      </style>
      <svg
        className="dotted-grid-pattern w-full h-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern
            id="dotted-grid"
            x="0"
            y="0"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="1" fill="currentColor" />
          </pattern>
          <radialGradient id="dotted-grid-mask" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="white" stopOpacity="1" />
            <stop offset="70%" stopColor="white" stopOpacity="0.5" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <mask id="dotted-grid-fade">
            <rect width="100%" height="100%" fill="url(#dotted-grid-mask)" />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="url(#dotted-grid)"
          mask="url(#dotted-grid-fade)"
          className="text-white/20"
        />
      </svg>
    </div>
  );
}
