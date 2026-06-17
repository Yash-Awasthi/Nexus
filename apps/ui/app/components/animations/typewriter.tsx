"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface TypewriterProps {
  texts: string[];
  speed?: number;
  delay?: number;
  className?: string;
}

export function Typewriter({
  texts,
  speed = 50,
  delay = 2000,
  className,
}: TypewriterProps) {
  const [displayed, setDisplayed] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const indexRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const tick = useCallback(() => {
    const currentText = texts[indexRef.current];

    if (!isDeleting) {
      // Typing
      if (displayed.length < currentText.length) {
        timeoutRef.current = setTimeout(() => {
          setDisplayed(currentText.slice(0, displayed.length + 1));
        }, speed);
      } else {
        // Finished typing, pause then delete
        timeoutRef.current = setTimeout(() => {
          setIsDeleting(true);
        }, delay);
      }
    } else {
      // Deleting
      if (displayed.length > 0) {
        timeoutRef.current = setTimeout(() => {
          setDisplayed(displayed.slice(0, -1));
        }, speed / 2);
      } else {
        // Finished deleting, move to next text
        setIsDeleting(false);
        indexRef.current = (indexRef.current + 1) % texts.length;
      }
    }
  }, [displayed, isDeleting, texts, speed, delay]);

  useEffect(() => {
    tick();
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [tick]);

  return (
    <span className={className}>
      {displayed}
      <span
        className="inline-block w-[2px] h-[1em] bg-current ml-0.5 align-middle"
        style={{
          animation: "blink 1s step-end infinite",
        }}
      />
      <style>
        {`
          @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}
      </style>
    </span>
  );
}
