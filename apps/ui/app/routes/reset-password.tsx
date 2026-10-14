// SPDX-License-Identifier: Apache-2.0
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import type { Route } from "./+types/reset-password";

import { AuthShell, Notice } from "~/components/auth-shell";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Choose a new password · Nexus" }];
}

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(token ? "" : "This link is missing its token.");

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("The passwords don't match.");
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `Reset failed (${res.status})`);
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      title="Choose a new password"
      subtitle={
        <>
          Link expired?{" "}
          <Link to="/forgot-password" className="text-primary hover:underline">
            Send another
          </Link>
        </>
      }
    >
      {done ? (
        <div className="space-y-4">
          <Notice tone="success">
            Password changed and every device signed out. Sign in with the new password.
          </Notice>
          <Button asChild className="h-10 w-full">
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <Notice tone="error">{error}</Notice>}
          <div className="space-y-1.5">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              placeholder="At least 12 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              className="h-10"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              className="h-10"
              required
            />
          </div>
          <Button type="submit" className="h-10 w-full" disabled={isLoading || !token}>
            {isLoading && <Loader2 className="animate-spin" />}
            Set password
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
