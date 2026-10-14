// SPDX-License-Identifier: Apache-2.0
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/forgot-password";

import { AuthShell, Notice } from "~/components/auth-shell";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Reset password · Nexus" }];
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      title="Reset your password"
      subtitle={
        <>
          Remembered it?{" "}
          <Link to="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {sent ? (
        <Notice tone="success">
          If an account uses that address, a reset link is on its way. It works for one hour.
        </Notice>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <Notice tone="error">{error}</Notice>}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              maxLength={320}
              className="h-10"
              required
            />
          </div>
          <Button type="submit" className="h-10 w-full" disabled={isLoading}>
            {isLoading && <Loader2 className="animate-spin" />}
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
