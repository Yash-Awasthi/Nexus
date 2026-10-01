// SPDX-License-Identifier: Apache-2.0
/**
 * Two-factor sign-in: set up with an authenticator app, confirm with its
 * first code, and turn off with a current one.
 *
 * API: GET /api/v1/mfa/status · POST /api/v1/mfa/setup | verify | disable
 */
import { Loader2, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { Section } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { apiFetch } from "~/lib/api";

type Step = "loading" | "off" | "setup" | "on" | "disabling" | "unavailable";

export function MfaSection() {
  const [step, setStep] = useState<Step>("loading");
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<{ mfaEnabled: boolean }>("/api/v1/mfa/status")
      .then((r) => setStep(r.mfaEnabled ? "on" : "off"))
      .catch(() => setStep("unavailable"));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const begin = () =>
    run(async () => {
      const r = await apiFetch<{ secret: string; otpauthUrl: string }>("/api/v1/mfa/setup", {
        method: "POST",
      });
      setSecret(r.secret);
      setQr(await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 192 }));
      setCode("");
      setStep("setup");
    });

  const confirm = () =>
    run(async () => {
      await apiFetch("/api/v1/mfa/verify", { method: "POST", json: { code } });
      setSecret("");
      setQr("");
      setCode("");
      setStep("on");
    });

  const turnOff = () =>
    run(async () => {
      await apiFetch("/api/v1/mfa/disable", { method: "POST", json: { code } });
      setCode("");
      setStep("off");
    });

  const codeField = (onSubmit: () => void, action: string) => (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{6}$/.test(code)) onSubmit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="mfa-code">Code from your app</Label>
        <Input
          id="mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className="w-32 font-mono tracking-widest"
        />
      </div>
      <Button type="submit" size="sm" disabled={busy || code.length !== 6}>
        {busy && <Loader2 className="animate-spin" />}
        {action}
      </Button>
    </form>
  );

  if (step === "loading" || step === "unavailable") return null;
  return (
    <Section
      title="Two-factor sign-in"
      description="Ask for a code from an authenticator app as well as your password."
    >
      <div className="space-y-3 py-3">
        {step === "on" && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-success" /> Two-factor sign-in is on
            </p>
            <Button variant="outline" size="sm" onClick={() => setStep("disabling")}>
              Turn off
            </Button>
          </div>
        )}
        {step === "disabling" && (
          <>
            <p className="text-sm text-muted-foreground">
              Enter a current code to turn two-factor sign-in off.
            </p>
            {codeField(turnOff, "Turn off")}
          </>
        )}
        {step === "off" && (
          <Button size="sm" onClick={() => void begin()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Set up two-factor sign-in
          </Button>
        )}
        {step === "setup" && (
          <>
            <p className="text-sm text-muted-foreground">
              Scan this with your authenticator app, or type the key into it, then enter the code it
              shows.
            </p>
            {qr && (
              <img
                src={qr}
                alt="Authenticator QR code"
                className="size-48 rounded-md border bg-white p-1"
              />
            )}
            <p className="text-xs text-muted-foreground">
              Key:{" "}
              <code data-testid="mfa-secret" className="font-mono break-all text-foreground">
                {secret.replace(/(.{4})/g, "$1 ").trim()}
              </code>
            </p>
            {codeField(confirm, "Turn on")}
          </>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Section>
  );
}
