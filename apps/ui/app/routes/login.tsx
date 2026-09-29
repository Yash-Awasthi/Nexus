// SPDX-License-Identifier: Apache-2.0
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import type { Route } from "./+types/login";

import { AuthShell, Notice, OAuthButtons } from "~/components/auth-shell";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { refreshSession, useAuth, type HostSession } from "~/context/AuthContext";
import { hostCan, hostInvoke } from "~/lib/host";
import { getSessionToken, setSessionToken } from "~/lib/session-token";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Sign in · Nexus" }];
}

const OAUTH_ERRORS: Record<string, string> = {
  email_conflict: "An account with this email already exists. Please sign in with your password.",
  oauth_failed: "Sign-in failed. Please try again.",
  google_not_configured:
    "Google sign-in is not set up on this server. Use your email and password.",
  no_email: "No verified email returned. Please verify your GitHub email and try again.",
  access_denied: "Sign-in was cancelled.",
  email_not_verified: "Your identity provider has not verified your email address.",
  no_account: "No Nexus account uses this email yet. Ask an admin to invite you.",
};

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, setUser, isAuthenticated } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Set once the password is right and the account asks for an authenticator code.
  const [mfaCode, setMfaCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const next = searchParams.get("next");
  const destination = next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) navigate(destination, { replace: true });
  }, [isAuthenticated, navigate, destination]);

  // A provider sign-in lands here with the refresh token already in its httpOnly cookie.
  // Once only: the cookie rotates on every exchange.
  const pickedUp = useRef(false);
  useEffect(() => {
    if (pickedUp.current || searchParams.get("signed_in") !== "1" || hostCan("localAccount"))
      return;
    pickedUp.current = true;
    void (async () => {
      const me =
        (await refreshSession()) &&
        (await fetch("/api/v1/auth/me", {
          headers: { Authorization: `Bearer ${getSessionToken()}` },
        }).catch(() => null));
      if (me && me.ok) setUser((await me.json()) as Parameters<typeof setUser>[0]);
      else setError("Sign-in failed. Please try again.");
    })();
  }, [searchParams, setUser]);

  // Show OAuth errors or post-registration success banner
  useEffect(() => {
    const errorCode = searchParams.get("error");
    if (errorCode) {
      setError(OAUTH_ERRORS[errorCode] ?? "An error occurred. Please try again.");
    } else if (searchParams.get("registered") === "1") {
      setSuccess("Account created! Sign in to get started.");
    }
  }, [searchParams]);

  const handleSignIn = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      await login(email, password, mfaCode ?? undefined);
      navigate("/dashboard");
    } catch (err) {
      if ((err as { code?: string }).code === "mfa_required") setMfaCode("");
      else setError(err instanceof Error ? err.message : "Sign in failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  // A host that owns the session signs in through its own browser window and
  // keeps the token out of this page entirely; a browser tab navigates to the
  // API's consent entry point as before.
  const oauthSignIn = async (provider: "google" | "github") => {
    if (!hostCan("localAccount")) {
      window.location.href = `/api/v1/oauth/${provider}`;
      return;
    }
    setError("");
    try {
      const session = await hostInvoke<HostSession>("localAccount", "signIn", provider);
      setSessionToken(session.accessToken);
      setUser({
        id: session.user.id,
        username: session.user.email ?? "You",
        ...(session.user.email ? { email: session.user.email } : {}),
      });
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed. Please try again.");
    }
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle={
        <>
          New here?{" "}
          <Link to="/register" className="text-primary hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {success && <Notice tone="success">{success}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <form onSubmit={handleSignIn} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="h-10"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-10"
              required
            />
          </div>
          {mfaCode !== null && (
            <div className="space-y-1.5">
              <Label htmlFor="mfa-code">Authenticator code</Label>
              <Input
                id="mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                className="h-10 font-mono tracking-widest"
                autoFocus
                required
              />
            </div>
          )}
          <Button type="submit" className="h-10 w-full" disabled={isLoading}>
            {isLoading && <Loader2 className="animate-spin" />}
            {mfaCode !== null ? "Verify" : "Sign in"}
          </Button>
        </form>
        <OAuthButtons onPick={(p) => void oauthSignIn(p)} />
      </div>
    </AuthShell>
  );
}
