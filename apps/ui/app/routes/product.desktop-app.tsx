import type { Route } from "./+types/product.desktop-app";
import { ProductPage } from "~/components/product-page";
import {
  Monitor,
  WifiOff,
  PanelTop,
  Keyboard,
  LayoutDashboard,
  RefreshCw,
} from "lucide-react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Desktop App | JUDICA" },
    {
      name: "description",
      content:
        "Native application for Windows, macOS, and Linux. Full deliberation power without the browser.",
    },
  ];
}

export default function ProductDesktopApp() {
  return (
    <ProductPage
      badge="Desktop"
      title="JUDICA on Your"
      titleHighlight="Desktop"
      subtitle="Native application for Windows, macOS, and Linux. Full deliberation power without the browser."
      features={[
        {
          icon: Monitor,
          title: "Native Performance",
          description:
            "Built for speed with native rendering. Faster startup, lower memory usage, and smoother interactions than any browser tab.",
        },
        {
          icon: WifiOff,
          title: "Offline Mode",
          description:
            "Works with Ollama local models when you have no internet connection. Full deliberation power, completely offline.",
        },
        {
          icon: PanelTop,
          title: "System Tray",
          description:
            "Always accessible from your system tray. Quick-launch deliberations without switching windows or opening a browser.",
        },
        {
          icon: Keyboard,
          title: "Keyboard Shortcuts",
          description:
            "Power-user keyboard shortcuts for every action. Navigate, create, and manage deliberations without touching the mouse.",
        },
        {
          icon: LayoutDashboard,
          title: "Multi-Window",
          description:
            "Run multiple deliberations side by side in separate windows. Compare results and work across projects simultaneously.",
        },
        {
          icon: RefreshCw,
          title: "Auto-Updates",
          description:
            "Always running the latest version. Automatic background updates keep you on the newest features and security patches.",
        },
      ]}
      howItWorks={[
        {
          step: "1",
          title: "Download",
          description:
            "Choose your platform — Windows, macOS, or Linux. One download, no dependencies.",
        },
        {
          step: "2",
          title: "Install",
          description:
            "One-click setup. Sign in with your JUDICA account or connect to a self-hosted instance.",
        },
        {
          step: "3",
          title: "Deliberate",
          description:
            "The same powerful council experience, running natively on your desktop with full offline support.",
        },
      ]}
    />
  );
}
