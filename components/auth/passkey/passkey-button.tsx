"use client";

import {
  type AuthView,
  authMutationKeys,
  getAuthLinkURL,
} from "@better-auth-ui/core";
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
import {
  passkeyAuthenticationFailure,
  passkeyClientError,
  withPasskeyUnavailable,
} from "@/lib/auth/passkey-client-result";
import { isPasskeyOnboardingAlreadyAuthenticated } from "@/lib/auth/passkey-contract";
import { passkeyPlugin } from "@/lib/auth/passkey-plugin";
import { resolvePasskeyRedirectTo } from "@/lib/auth/preview-auth-ui";
import { cn } from "@/lib/utils";

export type PasskeyButtonProps = {
  /** @remarks `AuthView` */
  view?: AuthView;
};

type OnboardingResponse = { context?: unknown };

/**
 * "Continue with Passkey" button rendered alongside the password sign-in form.
 *
 * Signs returning users in and starts first-passkey registration on sign-up.
 *
 * @param view - Current auth view. Selects registration on `"signUp"`.
 */
export function PasskeyButton({ view }: PasskeyButtonProps) {
  const {
    authClient,
    basePaths,
    localization,
    redirectTo,
    navigate,
    viewPaths,
  } = useAuth<PasskeyAuthClient>();
  const { localization: passkeyLocalization } = useAuthPlugin(passkeyPlugin);

  const signInPasskey = useSignInPasskey(authClient);
  const addPasskey = useAddPasskey(authClient);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // Surfaces passkeys in the browser's autofill dropdown while the sign-in
  // form is open. The button stays for anyone who dismisses it.
  usePasskeyAutoFill(authClient, {
    enabled: view !== "signUp",
    onSuccess: () =>
      navigate({
        to: resolvePasskeyRedirectTo(
          redirectTo,
          window.location.search,
          window.location.origin,
        ),
      }),
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
    setFailed(false);

    try {
      const resolvedRedirectTo = resolvePasskeyRedirectTo(
        redirectTo,
        window.location.search,
        window.location.origin,
      );
      const result = await signInPasskey.mutateAsync({
        autoFill: false,
        returnWebAuthnResponse: true,
      });
      const failure = passkeyAuthenticationFailure(result);
      if (failure?.redirectToSignUp) {
        navigate({
          to: withPasskeyUnavailable(
            getAuthLinkURL(
              `${basePaths.auth}/${viewPaths.auth.signUp}`,
              resolvedRedirectTo,
            ),
          ),
        });
        return;
      }
      if (failure) throw failure.error;
      navigate({ to: resolvedRedirectTo });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  const createPasskey = async () => {
    setPending(true);
    setFailed(false);
    let authenticatedRedirectTo: string | undefined;

    try {
      const resolvedRedirectTo = resolvePasskeyRedirectTo(
        redirectTo,
        window.location.search,
        window.location.origin,
      );
      authenticatedRedirectTo = resolvedRedirectTo;
      const response = await fetch("/api/auth/passkey/onboarding-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      const body = (await response.json()) as OnboardingResponse;
      if (isPasskeyOnboardingAlreadyAuthenticated(body)) {
        navigate({ to: resolvedRedirectTo, replace: true });
        return;
      }
      if (!response.ok || typeof body.context !== "string") {
        throw new Error("Passkey registration is unavailable.");
      }

      const result = await addPasskey.mutateAsync({
        context: body.context,
        createSession: true,
        name: "Primary passkey",
      });
      if (isPasskeyOnboardingAlreadyAuthenticated(result)) {
        navigate({ to: resolvedRedirectTo, replace: true });
        return;
      }
      const resultError = passkeyClientError(result);
      if (resultError) throw resultError;
      navigate({ to: resolvedRedirectTo });
    } catch (error) {
      if (
        authenticatedRedirectTo &&
        isPasskeyOnboardingAlreadyAuthenticated(error)
      ) {
        navigate({ to: authenticatedRedirectTo, replace: true });
        return;
      }
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="outline"
        disabled={isPending || pending}
        className={cn(
          "w-full",
          (isPending || pending) && "pointer-events-none opacity-50",
          failed &&
            "border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive",
        )}
        onClick={view === "signUp" ? createPasskey : continueWithPasskey}
      >
        {pending ? <Spinner /> : <Fingerprint />}
        {failed
          ? "Passkey failed (try again)"
          : localization.auth.continueWith.replace(
              "{{provider}}",
              passkeyLocalization.passkey,
            )}
      </Button>
    </div>
  );
}
