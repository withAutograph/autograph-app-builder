"use client";

import {
  authMutationKeys,
  getAuthLinkURL,
  isPasswordCompromisedError,
  parseAdditionalFieldValue,
} from "@better-auth-ui/core";
import type { AdditionalFieldFormValues } from "@better-auth-ui/core";
import { AuthPrompts, useAuth, useFetchOptions, useSignUpEmail } from "@better-auth-ui/react";
import { useIsMutating } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import type { SyntheticEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { resolvePasskeyRedirectTo } from "@/lib/auth/preview-auth-ui";
import { cn } from "@/lib/utils";
import { AdditionalField } from "./additional-field";
import { PasswordStrengthMeter } from "./password-strength-meter";
import { ProviderButtons } from "./provider-buttons";
import type { SocialLayout } from "./provider-buttons";

export interface SignUpProps {
  className?: string;
  signInRedirectTo?: string;
  socialLayout?: SocialLayout;
  socialPosition?: "top" | "bottom";
  /**
   * Runs instead of the post-sign-up redirect, but only when the sign-up
   * created an immediately usable session. Email verification still takes
   * priority, and social sign-ups are unaffected.
   */
  onSignUpSuccess?: () => void;
}

interface SignUpFieldErrors {
  name?: string | null;
  email?: string | null;
  password?: string | null;
  confirmPassword?: string | null;
}

const readFormString = (data: FormData, name: string): string | null => {
  const value = data.get(name);
  return value instanceof File ? null : value;
};

const SignUpFields = ({
  emailAndPassword,
  isPending,
  signUpEmailPending,
  password,
  confirmPassword,
  setPassword,
  setConfirmPassword,
  fieldErrors,
  setFieldErrors,
  onSubmit,
}: {
  emailAndPassword: ReturnType<typeof useAuth>["emailAndPassword"];
  isPending: boolean;
  signUpEmailPending: boolean;
  password: string;
  confirmPassword: string;
  setPassword: (value: string) => void;
  setConfirmPassword: (value: string) => void;
  fieldErrors: SignUpFieldErrors;
  setFieldErrors: React.Dispatch<React.SetStateAction<SignUpFieldErrors>>;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
}) => {
  const { localization, additionalFields } = useAuth();
  const PasswordFields = (
    <>
      <Field data-invalid={fieldErrors.password !== null && fieldErrors.password !== undefined}>
        <FieldLabel htmlFor="password">{localization.auth.password}</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setFieldErrors((previous) => ({ ...previous, password: null }));
            }}
            placeholder={localization.auth.passwordPlaceholder}
            required
            minLength={emailAndPassword?.minPasswordLength}
            maxLength={emailAndPassword?.maxPasswordLength}
            disabled={isPending}
            aria-invalid={fieldErrors.password !== null && fieldErrors.password !== undefined}
          />
        </InputGroup>
        <FieldError>{fieldErrors.password}</FieldError>
        <PasswordStrengthMeter password={password} />
      </Field>
      {emailAndPassword?.confirmPassword === true && (
        <Field
          data-invalid={
            fieldErrors.confirmPassword !== null && fieldErrors.confirmPassword !== undefined
          }
        >
          <FieldLabel htmlFor="confirmPassword">{localization.auth.confirmPassword}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setFieldErrors((previous) => ({ ...previous, confirmPassword: null }));
              }}
              placeholder={localization.auth.confirmPasswordPlaceholder}
              required
              minLength={emailAndPassword.minPasswordLength}
              maxLength={emailAndPassword.maxPasswordLength}
              disabled={isPending}
              aria-invalid={
                fieldErrors.confirmPassword !== null && fieldErrors.confirmPassword !== undefined
              }
            />
          </InputGroup>
          <FieldError>{fieldErrors.confirmPassword}</FieldError>
        </Field>
      )}
    </>
  );
  return (
    <form
      onSubmit={(event) => {
        onSubmit(event);
      }}
    >
      <FieldGroup>
        {emailAndPassword?.name !== false && (
          <Field data-invalid={fieldErrors.name !== null && fieldErrors.name !== undefined}>
            <FieldLabel htmlFor="name">{localization.auth.name}</FieldLabel>
            <Input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              placeholder={localization.auth.namePlaceholder}
              required
              disabled={isPending}
              onChange={() => {
                setFieldErrors((previous) => ({ ...previous, name: null }));
              }}
              aria-invalid={fieldErrors.name !== null && fieldErrors.name !== undefined}
            />
            <FieldError>{fieldErrors.name}</FieldError>
          </Field>
        )}
        <Field data-invalid={fieldErrors.email !== null && fieldErrors.email !== undefined}>
          <FieldLabel htmlFor="email">{localization.auth.email}</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder={localization.auth.emailPlaceholder}
            required
            disabled={isPending}
            onChange={() => {
              setFieldErrors((previous) => ({ ...previous, email: null }));
            }}
            aria-invalid={fieldErrors.email !== null && fieldErrors.email !== undefined}
          />
          <FieldError>{fieldErrors.email}</FieldError>
        </Field>
        {additionalFields?.flatMap((field) =>
          field.signUp === "above"
            ? [
                <AdditionalField
                  key={field.name}
                  name={field.name}
                  field={field}
                  isPending={isPending}
                  optionalLabel={localization.auth.optional}
                />,
              ]
            : [],
        )}
        {PasswordFields}
        {additionalFields?.flatMap((field) =>
          Boolean(field.signUp) && field.signUp !== "above"
            ? [
                <AdditionalField
                  key={field.name}
                  name={field.name}
                  field={field}
                  isPending={isPending}
                  optionalLabel={localization.auth.optional}
                />,
              ]
            : [],
        )}
        <Button type="submit" disabled={isPending}>
          {signUpEmailPending && <Spinner />}
          {localization.auth.signUp}
        </Button>
      </FieldGroup>
    </form>
  );
};

/**
 * Renders a sign-up form with name, email, and password fields, optional social provider buttons, and submission handling.
 *
 * Submits credentials to the configured auth client and handles the response:
 * - If email verification is required, shows a notification and navigates to sign-in
 * - On success, refreshes the session and navigates to the configured redirect path
 * - On failure, displays error toasts
 * - Manages a pending state while the request is in-flight
 *
 * @param className - Additional CSS classes applied to the outer container
 * @param socialLayout - Social layout to apply to the component
 * @param socialPosition - Social position to apply to the component
 * @param onSignUpSuccess - Replaces the post-sign-up redirect when the new account is immediately usable
 * @returns The sign-up form React element.
 */
export const SignUp = ({
  className,
  signInRedirectTo,
  socialLayout,
  socialPosition = "bottom",
  onSignUpSuccess,
}: SignUpProps) => {
  const {
    additionalFields,
    authClient,
    basePaths,
    emailAndPassword,
    localization,
    plugins,
    redirectTo,
    socialProviders,
    viewPaths,
    navigate,
    Link,
  } = useAuth();

  const { fetchOptions, resetFetchOptions } = useFetchOptions();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<SignUpFieldErrors>({});
  const currentLocation = useSyncExternalStore(
    () => () => null,
    () => window.location.href,
    () => "",
  );
  const currentUrl = currentLocation.length > 0 ? new URL(currentLocation) : null;
  const currentSearch = currentUrl?.search ?? "";
  const currentOrigin = currentUrl?.origin ?? "";

  const { mutate: signUpEmail, isPending: signUpEmailPending } = useSignUpEmail(authClient, {
    onError: (error) => {
      // The haveIBeenPwned plugin rejects on the password itself,
      // so it belongs against the field rather than in a toast.
      if (isPasswordCompromisedError(error)) {
        setFieldErrors((prev) => ({
          ...prev,
          password: localization.auth.passwordCompromised,
        }));
      }

      setPassword("");
      setConfirmPassword("");
      resetFetchOptions();
    },
    onSuccess: (_data, { email }) => {
      if (emailAndPassword?.requireEmailVerification === true) {
        sessionStorage.setItem("better-auth-ui.verify-email", email);
        navigate({
          to: getAuthLinkURL(`${basePaths.auth}/${viewPaths.auth.verifyEmail}`, redirectTo),
        });
      } else if (onSignUpSuccess) {
        onSignUpSuccess();
      } else {
        navigate({ to: redirectTo });
      }
    },
  });

  const signInMutating = useIsMutating({
    mutationKey: authMutationKeys.signIn.all,
  });
  const signUpMutating = useIsMutating({
    mutationKey: authMutationKeys.signUp.all,
  });
  const isPending = signInMutating + signUpMutating > 0;

  const handleSubmit = async (e: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    // `emailAndPassword.name === false` hides the name field and submits "".
    const name = readFormString(formData, "name") ?? "";
    const email = readFormString(formData, "email") ?? "";

    if (emailAndPassword?.confirmPassword === true && password !== confirmPassword) {
      toast.error(localization.auth.passwordsDoNotMatch);
      setPassword("");
      setConfirmPassword("");
      return;
    }

    const parsedFields = (additionalFields ?? []).flatMap((field) => {
      if (
        field.signUp === null ||
        field.signUp === undefined ||
        field.signUp === false ||
        field.readOnly === true
      ) {
        return [];
      }
      return [
        { field, value: parseAdditionalFieldValue(field, readFormString(formData, field.name)) },
      ];
    });
    const outcomes = await Promise.all(
      parsedFields.map(async ({ field, value }) => {
        try {
          await field.validate?.(value);
          return { error: null, value };
        } catch (error) {
          return { error, value };
        }
      }),
    );
    const failed = outcomes.find((outcome) => outcome.error !== null);
    if (failed) {
      toast.error(failed.error instanceof Error ? failed.error.message : String(failed.error));
      return;
    }
    const additionalFieldValues: AdditionalFieldFormValues = {};
    for (const [index, { field }] of parsedFields.entries()) {
      const value = outcomes[index]?.value;
      if (value !== undefined) {
        additionalFieldValues[field.name] = value;
      }
    }

    signUpEmail({
      email,
      fetchOptions,
      name,
      password,
      ...additionalFieldValues,
    });
  };

  const showSeparator = emailAndPassword?.enabled && (socialProviders?.length ?? 0) > 0;
  const renderSocialProviders = (position: "top" | "bottom") => (
    <>
      {showSeparator && position === "bottom" && (
        <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card text-xs flex items-center">
          {localization.auth.or}
        </FieldSeparator>
      )}
      {(socialProviders?.length ?? 0) > 0 && (
        <ProviderButtons socialLayout={socialLayout} view="signUp" />
      )}
      {showSeparator && position === "top" && (
        <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card text-xs flex items-center">
          {localization.auth.or}
        </FieldSeparator>
      )}
    </>
  );
  const alternateRedirectTo =
    signInRedirectTo ??
    (currentSearch.length > 0
      ? resolvePasskeyRedirectTo(redirectTo, currentSearch, currentOrigin)
      : redirectTo);

  return (
    <div className="relative w-full max-w-sm">
      <Card className={cn("w-full", className)}>
        <AuthPrompts view="signUp" />
        <CardHeader>
          <CardTitle className="text-xl font-semibold">{localization.auth.signUp}</CardTitle>
        </CardHeader>

        <CardContent>
          <div className="flex flex-col gap-3">
            {plugins.flatMap((plugin) =>
              (plugin.authButtons ?? []).map((AuthButton, index) => (
                <AuthButton key={`${plugin.id}-${index.toString()}`} view="signUp" />
              )),
            )}
            {socialPosition === "top" && renderSocialProviders("top")}

            {emailAndPassword?.enabled && (
              <SignUpFields
                emailAndPassword={emailAndPassword}
                isPending={isPending}
                signUpEmailPending={signUpEmailPending}
                password={password}
                confirmPassword={confirmPassword}
                setPassword={setPassword}
                setConfirmPassword={setConfirmPassword}
                fieldErrors={fieldErrors}
                setFieldErrors={setFieldErrors}
                onSubmit={async (event): Promise<void> => {
                  await handleSubmit(event);
                }}
              />
            )}

            {socialPosition === "bottom" && renderSocialProviders("bottom")}
          </div>
        </CardContent>
      </Card>

      <FieldDescription className="absolute top-full left-0 mt-3 w-full text-center">
        {localization.auth.alreadyHaveAnAccount}{" "}
        <Link
          href={getAuthLinkURL(`${basePaths.auth}/${viewPaths.auth.signIn}`, alternateRedirectTo)}
          className="underline underline-offset-4"
        >
          {localization.auth.signIn}
        </Link>
      </FieldDescription>
    </div>
  );
};
