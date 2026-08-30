"use client";

import { type AuthView, authMutationKeys } from "@better-auth-ui/core";
import type { PasskeyAuthClient } from "@better-auth-ui/core/plugins/passkey";
import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import {
  useAddPasskey,
  usePasskeyAutoFill,
  useSignInPasskey,
} from "@better-auth-ui/react/plugins/passkey";
import { useIsMutating } from "@tanstack/react-query";
import { Fingerprint } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { passkeyPlugin } from "@/lib/auth/passkey-plugin";
import { cn } from "@/lib/utils";

export type PasskeyButtonProps = {
  /** @remarks `AuthView` */
  view?: AuthView;
};

type OnboardingResponse = { context?: unknown };

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Passkey authentication could not be completed.";
}

/**
 * "Continue with Passkey" button rendered alongside the password sign-in form.
 *
 * Hidden on the sign-up view where passkey sign-in isn't applicable.
 *
 * @param view - Current auth view. Hides the button on `"signUp"`.
 */
export function PasskeyButton({ view }: PasskeyButtonProps) {
  const { authClient, localization, redirectTo, navigate } =
    useAuth<PasskeyAuthClient>();
  const { localization: passkeyLocalization } = useAuthPlugin(passkeyPlugin);

  const signInPasskey = useSignInPasskey(authClient);
  const addPasskey = useAddPasskey(authClient);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  // Surfaces passkeys in the browser's autofill dropdown while the sign-in
  // form is open. The button stays for anyone who dismisses it.
  usePasskeyAutoFill(authClient, {
    enabled: view !== "signUp",
    onSuccess: () => navigate({ to: redirectTo }),
  });

  const signInMutating = useIsMutating({
    mutationKey: authMutationKeys.signIn.all,
  });
  const signUpMutating = useIsMutating({
    mutationKey: authMutationKeys.signUp.all,
  });
  const isPending = signInMutating + signUpMutating > 0;

  const continueWithPasskey = async () => {
    setPending(true);
    setError(undefined);

    try {
      await signInPasskey.mutateAsync({ autoFill: false });
      navigate({ to: redirectTo });
      return;
    } catch (signInError) {
      try {
        const response = await fetch("/api/auth/passkey/onboarding-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        });
        const body = (await response.json()) as OnboardingResponse;
        if (!response.ok || typeof body.context !== "string") {
          setError(errorMessage(signInError));
          return;
        }

        await addPasskey.mutateAsync({
          context: body.context,
          createSession: true,
          name: "Primary passkey",
        });
        navigate({ to: redirectTo });
      } catch (onboardingError) {
        setError(errorMessage(onboardingError));
      }
    } finally {
      setPending(false);
    }
  };

  // Passkey sign-in isn't relevant on the sign-up flow.
  if (view === "signUp") return null;

  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="outline"
        disabled={isPending || pending}
        className={cn(
          "w-full",
          (isPending || pending) && "pointer-events-none opacity-50",
        )}
        onClick={continueWithPasskey}
      >
        {pending ? <Spinner /> : <Fingerprint />}
        {localization.auth.continueWith.replace(
          "{{provider}}",
          passkeyLocalization.passkey,
        )}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
