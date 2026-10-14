// SPDX-License-Identifier: Apache-2.0
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import type { Route } from "./+types/verify-email";

import { AuthShell, Notice } from "~/components/auth-shell";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Confirm email · Nexus" }];
}

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    token ? null : { ok: false, text: "This link is missing its token." },
  );
  // The token is single-use, so a second run of the effect must not spend it again.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void (async () => {
      const res = await fetch("/api/v1/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }).catch(() => null);
      const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
      setResult(
        res?.ok
          ? { ok: true, text: "Email confirmed." }
          : { ok: false, text: body?.message ?? "This link is invalid, expired or already used." },
      );
    })();
  }, [token]);

  return (
    <AuthShell
      title="Confirm your email"
      subtitle={
        <Link to="/dashboard" className="text-primary hover:underline">
          Go to Nexus
        </Link>
      }
    >
      {result ? (
        <Notice tone={result.ok ? "success" : "error"}>{result.text}</Notice>
      ) : (
        <Loader2 className="mx-auto animate-spin" aria-label="Confirming" />
      )}
    </AuthShell>
  );
}
