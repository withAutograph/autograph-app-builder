"use client";

import { isTwoFactorRedirect } from "@better-auth-ui/core/plugins/two-factor";
import { useAuth, useSession, useSignInEmail } from "@better-auth-ui/react";
import { useState } from "react";
import type { SubmitEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useSignInContinuation } from "@/lib/auth/use-sign-in-continuation";

export interface FreshSessionPromptProps {
  onFresh: () => void | Promise<void>;
}

const emailSchema = z.string().min(1);
const signInErrorMessageSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
  message: z.string().optional(),
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function FreshSessionPrompt({ onFresh }: FreshSessionPromptProps) {
  const auth = useAuth();
  const session = useSession(auth.authClient);
  const continueSignIn = useSignInContinuation();
  const [password, setPassword] = useState("");
  const signIn = useSignInEmail(auth.authClient, {
    meta: { errorPresentation: "inline" },
    onError: () => {
      setPassword("");
    },
    onSuccess: async (data) => {
      if (isTwoFactorRedirect(data)) {
        continueSignIn(data);
        return;
      }
      setPassword("");
      await onFresh();
    },
  });

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedEmail = emailSchema.safeParse(session.data?.user.email);
    if (!parsedEmail.success) {
      return;
    }
    signIn.mutate({ email: parsedEmail.data, password });
  };

  const parsedSignInError = signInErrorMessageSchema.safeParse(signIn.error);
  const signInErrorMessage = parsedSignInError.success
    ? (parsedSignInError.data.error?.message ?? parsedSignInError.data.message)
    : undefined;

  return (
    <div className="p-4">
      <FieldGroup className="gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{auth.localization.settings.freshSessionTitle}</h3>
          <FieldDescription>{auth.localization.settings.freshSessionDescription}</FieldDescription>
        </div>
        {auth.emailAndPassword?.enabled ? (
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <Field data-invalid={signIn.isError}>
              <FieldLabel htmlFor="fresh-session-password">
                {auth.localization.auth.password}
              </FieldLabel>
              <Input
                id="fresh-session-password"
                autoComplete="current-password"
                disabled={signIn.isPending}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
                type="password"
                required
              />
              {signInErrorMessage !== undefined && <FieldError>{signInErrorMessage}</FieldError>}
            </Field>
            <Button disabled={!password || signIn.isPending} type="submit">
              {signIn.isPending && <Spinner />}
              {auth.localization.settings.freshSessionSubmit}
            </Button>
          </form>
        ) : (
          <Button
            onClick={() => {
              auth.navigate({
                to: `${auth.basePaths.auth}/${auth.viewPaths.auth.signIn}`,
              });
            }}
          >
            {auth.localization.settings.freshSessionSignIn}
          </Button>
        )}
      </FieldGroup>
    </div>
  );
}
