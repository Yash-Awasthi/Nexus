// SPDX-License-Identifier: Apache-2.0
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

export function FeatureCard({
  icon: Icon,
  label,
  description,
  to,
  color,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  to: string;
  color: string;
}) {
  return (
    <Link
      to={to}
      className="group flex items-start gap-3 p-3 rounded-xl transition-colors hover:bg-muted/50"
      style={{ border: "1px solid hsl(var(--border)/0.5)" }}
    >
      <div className={`p-2 rounded-lg shrink-0 ${color}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium group-hover:text-primary transition-colors">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{description}</p>
      </div>
      <ArrowRight className="size-3.5 shrink-0 mt-1 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}
