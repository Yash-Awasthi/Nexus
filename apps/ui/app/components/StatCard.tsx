// SPDX-License-Identifier: Apache-2.0
import { Card, CardContent } from "~/components/ui/card";

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color = "text-primary",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1 tracking-tight">{value}</p>
            {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={`p-2 rounded-lg bg-primary/10 ${color}`}>
            <Icon className="size-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
