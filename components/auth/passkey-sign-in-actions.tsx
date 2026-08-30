"use client";

import type { PasskeyAuthClient } from "@better-auth-ui/core/plugins/passkey";
import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import { useAddPasskey } from "@better-auth-ui/react/plugins/passkey";
import { Fingerprint } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { passkeyPlugin } from "@/lib/auth/passkey-plugin";

type OnboardingResponse = { context?: unknown };

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Passkey authentication could not be completed.";
}

export function PasskeyOnboardingAction() {
  const { authClient, navigate, redirectTo } = useAuth<PasskeyAuthClient>();
  const { localization } = useAuthPlugin(passkeyPlugin);
  const addPasskey = useAddPasskey(authClient);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const register = async () => {
    setPending(true);
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
      await addPasskey.mutateAsync({
        context: body.context,
        createSession: true,
        name: "Primary passkey",
      });
      navigate({ to: redirectTo });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button type="button" disabled={pending} onClick={register}>
        <Fingerprint data-icon="inline-start" />
        {pending ? "Creating passkey…" : localization.addPasskey}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
