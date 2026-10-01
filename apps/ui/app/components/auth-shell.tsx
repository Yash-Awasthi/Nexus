// SPDX-License-Identifier: Apache-2.0
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { NexusMark } from "~/components/brand";
import { Button } from "~/components/ui/button";

/** The frame around sign-in and sign-up: a short pitch beside the form. */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r bg-muted/40 p-10 lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,var(--color-primary)_0%,transparent_55%)] opacity-15"
        />
        <Link to="/" className="relative flex items-center gap-2">
          <NexusMark className="size-8" />
          <span className="text-lg font-semibold tracking-tight">Nexus</span>
        </Link>
        <blockquote className="relative max-w-md space-y-3">
          <p className="text-2xl leading-snug font-medium tracking-tight">
            “A single model agrees with itself. A council shows you the strongest objection before
            you commit.”
          </p>
          <p className="text-sm text-muted-foreground">
            Several models, each speaking as an archetype, argue — and a chair writes the answer
            that survived.
          </p>
        </blockquote>
      </aside>
      <main className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center gap-2 lg:hidden">
            <NexusMark className="size-7" />
            <span className="font-semibold tracking-tight">Nexus</span>
          </Link>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function Notice({ tone, children }: { tone: "error" | "success"; children: string }) {
  const Icon = tone === "error" ? AlertCircle : CheckCircle2;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          : "flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm"
      }
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Google and GitHub buttons, shown only for providers this server can complete. */
export function OAuthButtons({ onPick }: { onPick: (provider: "google" | "github") => void }) {
  const [enabled, setEnabled] = useState<{ google: boolean; github: boolean } | null>(null);
  useEffect(() => {
    void fetch("/api/v1/oauth/providers")
      .then((r) => (r.ok ? r.json() : null))
      .then(setEnabled)
      .catch(() => setEnabled(null));
  }, []);
  if (!enabled?.google && !enabled?.github) return null;
  return (
    <>
      <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      <div className="grid gap-2">
        {enabled.google && (
          <Button variant="outline" className="h-10" type="button" onClick={() => onPick("google")}>
            <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </Button>
        )}
        {enabled.github && (
          <Button variant="outline" className="h-10" type="button" onClick={() => onPick("github")}>
            <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            Continue with GitHub
          </Button>
        )}
      </div>
    </>
  );
}
