"use client";

import type { AuthView } from "@better-auth-ui/core";
import type { PasskeyAuthClient } from "@better-auth-ui/core/plugins/passkey";
import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import {
  useAddPasskey,
  usePasskeyAutoFill,
  useSignInPasskey,
} from "@better-auth-ui/react/plugins/passkey";
import { Fingerprint } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { passkeyClientError } from "@/lib/auth/passkey-client-result";
import { isPasskeyOnboardingAlreadyAuthenticated } from "@/lib/auth/passkey-contract";
import { preferredPasskeyAuthenticatorAttachment } from "@/lib/auth/passkey-platform";
import { passkeyPlugin } from "@/lib/auth/passkey-plugin";
import { resolvePasskeyRedirectTo } from "@/lib/auth/preview-auth-ui";
import { cn } from "@/lib/utils";

export type PasskeyButtonProps = {
  /** @remarks `AuthView` */
  view?: AuthView;
};

type OnboardingResponse = { context?: unknown };

const passkeyResponseTimeoutMs = 3000;

async function awaitPasskeyResponse<T>(operation: Promise<T>): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error("Passkey verification timed out.")),
          passkeyResponseTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

/**
 * "Continue with Passkey" button rendered alongside the password sign-in form.
 *
 * Signs returning users in and starts first-passkey registration on sign-up.
 *
 * @param view - Current auth view. Selects registration on `"signUp"`.
 */
export function PasskeyButton({ view }: PasskeyButtonProps) {
  const { authClient, localization, redirectTo, navigate } = useAuth<PasskeyAuthClient>();
  const { localization: passkeyLocalization } = useAuthPlugin(passkeyPlugin);

  // A completed WebAuthn ceremony cannot safely be replayed. In particular,
  // retrying a transport failure can leave the UI pending after the assertion
  // has already been accepted by the authenticator. Surface the recoverable
  // failure immediately and let the person explicitly start a new ceremony.
  const signInPasskey = useSignInPasskey(authClient, { retry: false });
  const addPasskey = useAddPasskey(authClient, { retry: false });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // This is a client-only WebAuthn interaction, not a progressively enhanced
  // form submit. Keep the streamed button disabled until its handler exists.
  const isClientReady = useSyncExternalStore(
    () => () => {
      // Hydration readiness has no external subscription.
    },
    () => true,
    () => false,
  );

  // Surfaces passkeys in the browser's autofill dropdown while the sign-in
  // form is open. The button stays for anyone who dismisses it.
  usePasskeyAutoFill(authClient, {
    enabled: view !== "signUp",
    onSuccess: () =>
      navigate({
        to: resolvePasskeyRedirectTo(redirectTo, window.location.search, window.location.origin),
      }),
  });

  const continueWithPasskey = async () => {
    setPending(true);
    setFailed(false);
    const resolvedRedirectTo = resolvePasskeyRedirectTo(
      redirectTo,
      window.location.search,
      window.location.origin,
    );

    try {
      const result = await awaitPasskeyResponse(
        signInPasskey.mutateAsync({
          autoFill: false,
          returnWebAuthnResponse: true,
        }),
      );
      const resultError = passkeyClientError(result);
      if (resultError) throw resultError;
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
      const [response, authenticatorAttachment] = await Promise.all([
        fetch("/api/auth/passkey/onboarding-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        }),
        preferredPasskeyAuthenticatorAttachment(),
      ]);
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
        ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
      });
      if (isPasskeyOnboardingAlreadyAuthenticated(result)) {
        navigate({ to: resolvedRedirectTo, replace: true });
        return;
      }
      const resultError = passkeyClientError(result);
      if (resultError) throw resultError;
      navigate({ to: resolvedRedirectTo });
    } catch (error) {
      if (authenticatedRedirectTo && isPasskeyOnboardingAlreadyAuthenticated(error)) {
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
        // Conditional WebAuthn autofill is intentionally a long-lived mutation:
        // it waits for the browser's credential picker until this page unmounts.
        // Do not use the global Better Auth mutation count here or a stale
        // conditional request can permanently disable the explicit recovery
        // path. `pending` exclusively tracks a foreground ceremony started by
        // this button and prevents duplicate user-initiated requests.
        disabled={!isClientReady || pending}
        className={cn(
          "w-full",
          pending && "pointer-events-none opacity-50",
          failed &&
            "border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive",
        )}
        onClick={view === "signUp" ? createPasskey : continueWithPasskey}
      >
        {pending ? <Spinner /> : <Fingerprint />}
        {failed
          ? "Passkey failed (try again)"
          : localization.auth.continueWith.replace("{{provider}}", passkeyLocalization.passkey)}
      </Button>
    </div>
  );
}
