import { useEffect } from "react";
import { LandingNavbar } from "./LandingNavbar";
import { HeroSection } from "./HeroSection";
import { CouncilSection } from "./CouncilSection";
import { FeaturesSection } from "./FeaturesSection";
import { HowItWorksSection } from "./HowItWorksSection";
import { CtaSection } from "./CtaSection";
import { LandingFooter } from "./LandingFooter";

export function LandingPage() {
  // Force dark theme on landing page
  useEffect(() => {
    const html = document.documentElement;
    const wasDark = html.classList.contains("dark");
    html.classList.add("dark");
    return () => {
      if (!wasDark) html.classList.remove("dark");
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[oklch(0.05_0.02_260)] via-[oklch(0.06_0.025_265)] to-[oklch(0.08_0.03_270)] text-white overflow-x-hidden">
      <LandingNavbar />
      <HeroSection />
      <FeaturesSection />
      <CouncilSection />
      <HowItWorksSection />
      <CtaSection />
      <LandingFooter />
    </div>
  );
}
