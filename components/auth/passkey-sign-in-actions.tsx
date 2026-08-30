"use client";

import { Fingerprint } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

type OnboardingResponse = { context?: unknown };

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Passkey authentication could not be completed.";
}

export function PasskeySignInActions({
  onboardingEnabled,
}: {
  onboardingEnabled: boolean;
}) {
  const [pending, setPending] = useState<"register" | "sign-in" | null>(null);
  const [error, setError] = useState<string>();
  const router = useRouter();

  const finish = () => router.push("/auth/setting-up?callbackURL=%2F");

  const register = async () => {
    setPending("register");
    setError(undefined);
    try {
      const response = await fetch("/api/auth/passkey/onboarding-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      const body = (await response.json()) as OnboardingResponse;
      if (!response.ok || typeof body.context !== "string") {
        throw new Error("Passkey registration is unavailable.");
      }
      const result = await authClient.passkey.addPasskey({
        context: body.context,
        createSession: true,
        name: "Primary passkey",
      });
      if (result.error) throw new Error(result.error.message);
      finish();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const signIn = async () => {
    setPending("sign-in");
    setError(undefined);
    try {
      const result = await authClient.signIn.passkey({ autoFill: false });
      if (result.error) throw new Error(result.error.message);
      finish();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="outline"
        disabled={pending !== null}
        onClick={signIn}
      >
        <Fingerprint />
        {pending === "sign-in" ? "Signing in…" : "Sign in with a passkey"}
      </Button>
      {onboardingEnabled && (
        <Button type="button" disabled={pending !== null} onClick={register}>
          <Fingerprint />
          {pending === "register" ? "Creating passkey…" : "Create a passkey"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
