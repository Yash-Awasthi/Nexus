// SPDX-License-Identifier: Apache-2.0
// Ambient declaration for dynamically-loaded gsap.
// Keeps TypeScript happy without requiring the package in dependencies.
declare module "gsap" {
  interface GsapVars {
    opacity?: number;
    y?: number;
    x?: number;
    scale?: number;
    duration?: number;
    stagger?: number;
    ease?: string;
    delay?: number;
    [key: string]: unknown;
  }
  const gsap: {
    fromTo(targets: unknown, from: GsapVars, to: GsapVars): unknown;
    to(targets: unknown, vars: GsapVars): unknown;
    from(targets: unknown, vars: GsapVars): unknown;
    set(targets: unknown, vars: GsapVars): unknown;
    registerPlugin(...args: unknown[]): void;
  };
  export default gsap;
}

declare module "gsap/ScrollTrigger" {
  const ScrollTrigger: unknown;
  export { ScrollTrigger };
  export default ScrollTrigger;
}
