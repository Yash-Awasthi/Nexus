"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface MagneticButtonProps {
  children: ReactNode;
  className?: string;
  strength?: number; // kept for API compat, unused
}

export function MagneticButton({ children, className }: MagneticButtonProps) {
  return (
    <motion.div
      className={`inline-block ${className ?? ""}`}
      whileHover={{ scale: 1.04, y: -2 }}
      whileTap={{ scale: 0.97, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {children}
    </motion.div>
  );
}
