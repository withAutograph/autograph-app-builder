"use client";

import { authMutationKeys, getAuthLinkURL } from "@better-auth-ui/core";
import {
  isPasskeyAutoFillEnabled,
  withPasskeyAutoFill,
} from "@better-auth-ui/core/plugins/passkey";
import { AuthPrompts, useAuth, useFetchOptions, useSignInEmail } from "@better-auth-ui/react";
import { useIsMutating } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import type { SyntheticEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { resolvePasskeyRedirectTo } from "@/lib/auth/preview-auth-ui";
import { useSignInContinuation } from "@/lib/auth/use-sign-in-continuation";
import { cn } from "@/lib/utils";
import { LastUsedBadge } from "./last-login-method/last-used-badge";
import { ProviderButtons } from "./provider-buttons";
import type { SocialLayout } from "./provider-buttons";

export interface SignInProps {
  className?: string;
  signUpRedirectTo?: string;
  socialLayout?: SocialLayout;
  socialPosition?: "top" | "bottom";
}

interface EmailPasswordFormProps {
  emailAndPassword: NonNullable<ReturnType<typeof useAuth>["emailAndPassword"]>;
  fieldErrors: { email?: string | null; password?: string | null };
  isPending: boolean;
  isPasswordVisible: boolean;
  localization: ReturnType<typeof useAuth>["localization"];
  passkeyAutoFill: boolean;
  password: string;
  signInEmailPending: boolean;
  onPasswordChange: (password: string) => void;
  onFieldErrorsChange: React.Dispatch<
    React.SetStateAction<{ email?: string | null; password?: string | null }>
  >;
  onPasswordVisibilityChange: React.Dispatch<React.SetStateAction<boolean>>;
  onSubmit: (e: SyntheticEvent<HTMLFormElement>) => void;
}

const EmailPasswordForm = ({
  emailAndPassword,
  fieldErrors,
  isPending,
  isPasswordVisible,
  localization,
  passkeyAutoFill,
  password,
  signInEmailPending,
  onPasswordChange,
  onFieldErrorsChange,
  onPasswordVisibilityChange,
  onSubmit,
}: EmailPasswordFormProps) => (
  <form onSubmit={onSubmit}>
    <FieldGroup>
      <Field data-invalid={Boolean(fieldErrors.email)}>
        <FieldLabel htmlFor="email">{localization.auth.email}</FieldLabel>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete={withPasskeyAutoFill("email", passkeyAutoFill)}
          placeholder={localization.auth.emailPlaceholder}
          required
          disabled={isPending}
          onChange={() => {
            onFieldErrorsChange((prev) => {
              const next = { ...prev };
              next.email = null;
              return next;
            });
          }}
          onInvalid={(e) => {
            e.preventDefault();
            const msg = e.currentTarget.validity.valueMissing
              ? localization.auth.fieldRequired
              : localization.auth.invalidEmail;
            onFieldErrorsChange((prev) => ({ ...prev, email: msg }));
          }}
          aria-invalid={Boolean(fieldErrors.email)}
        />
        <FieldError>{fieldErrors.email}</FieldError>
      </Field>

      <Field data-invalid={Boolean(fieldErrors.password)}>
        <FieldLabel htmlFor="password">{localization.auth.password}</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="password"
            name="password"
            type={isPasswordVisible ? "text" : "password"}
            autoComplete={withPasskeyAutoFill("current-password", passkeyAutoFill)}
            value={password}
            onChange={(e) => {
              onPasswordChange(e.target.value);
              onFieldErrorsChange((prev) => {
                const next = { ...prev };
                next.password = null;
                return next;
              });
            }}
            placeholder={localization.auth.passwordPlaceholder}
            required
            minLength={emailAndPassword.minPasswordLength}
            maxLength={emailAndPassword.maxPasswordLength}
            disabled={isPending}
            onInvalid={(e) => {
              e.preventDefault();
              const min = emailAndPassword.minPasswordLength;
              const max = emailAndPassword.maxPasswordLength;
              let msg = localization.auth.tooLong.replace("{{max}}", String(max));
              if (e.currentTarget.validity.valueMissing) {
                msg = localization.auth.fieldRequired;
              } else if (e.currentTarget.validity.tooShort) {
                msg = localization.auth.tooShort.replace("{{min}}", String(min));
              }
              onFieldErrorsChange((prev) => ({ ...prev, password: msg }));
            }}
            aria-invalid={Boolean(fieldErrors.password)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label={
                isPasswordVisible ? localization.auth.hidePassword : localization.auth.showPassword
              }
              title={
                isPasswordVisible ? localization.auth.hidePassword : localization.auth.showPassword
              }
              onClick={() => {
                onPasswordVisibilityChange((visible) => !visible);
              }}
            >
              {isPasswordVisible ? <EyeOff /> : <Eye />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FieldError>{fieldErrors.password}</FieldError>
      </Field>

      {emailAndPassword.rememberMe === true && (
        <Field className="my-1">
          <div className="flex items-center gap-3">
            <Checkbox id="rememberMe" name="rememberMe" disabled={isPending} />
            <FieldLabel htmlFor="rememberMe" className="cursor-pointer text-sm font-normal">
              {localization.auth.rememberMe}
            </FieldLabel>
          </div>
        </Field>
      )}

      <div className="flex flex-col gap-3">
        <Button type="submit" className="relative overflow-visible" disabled={isPending}>
          {signInEmailPending && <Spinner />}
          {localization.auth.signIn}
          <LastUsedBadge method="email" floating />
        </Button>
      </div>
    </FieldGroup>
  </form>
);

/**
 * Render the sign-in form UI with email/password, magic link, and social provider options.
 *
 * @param className - Optional additional container class names
 * @param socialLayout - Layout style for social provider buttons
 * @param socialPosition - Position of social provider buttons; `"top"` or `"bottom"`. Defaults to `"bottom"`.
 * @returns The rendered sign-in UI as a JSX element
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function SignIn({
  className,
  signUpRedirectTo,
  socialLayout,
  socialPosition = "bottom",
}: SignInProps) {
  const {
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
  const continueSignIn = useSignInContinuation();

  const [password, setPassword] = useState("");
  const currentLocation = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("popstate", onStoreChange);
      return () => {
        window.removeEventListener("popstate", onStoreChange);
      };
    },
    () => window.location.href,
    () => "",
  );
  const currentSearch = currentLocation.length > 0 ? new URL(currentLocation).search : "";
  const currentOrigin = currentLocation.length > 0 ? new URL(currentLocation).origin : "";

  const { mutate: signInEmail, isPending: signInEmailPending } = useSignInEmail(authClient, {
    onError: (error, { email }) => {
      setPassword("");
      const errorCode: unknown = Object.getOwnPropertyDescriptor(error.error, "code")?.value;

      if (errorCode === "EMAIL_NOT_VERIFIED") {
        sessionStorage.setItem("better-auth-ui.verify-email", email);
        navigate({
          to: `${basePaths.auth}/${viewPaths.auth.verifyEmail}`,
        });
      }

      resetFetchOptions();
    },
    onSuccess: (data) => {
      continueSignIn(data);
    },
  });

  const signInMutating = useIsMutating({
    mutationKey: authMutationKeys.signIn.all,
  });
  const signUpMutating = useIsMutating({
    mutationKey: authMutationKeys.signUp.all,
  });
  const isPending = signInMutating + signUpMutating > 0;

  const passkeyAutoFill = isPasskeyAutoFillEnabled(plugins);

  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<{
    email?: string | null;
    password?: string | null;
  }>({});

  const handleSubmit = (e: SyntheticEvent<HTMLFormElement>): void => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const emailField = e.currentTarget.elements.namedItem("email");
    const email = emailField instanceof HTMLInputElement ? emailField.value : "";
    const rememberMe = formData.get("rememberMe") === "on";

    const variables: Parameters<typeof signInEmail>[0] = {
      email,
      fetchOptions,
      password,
    };
    if (emailAndPassword?.rememberMe === true) {
      variables.rememberMe = rememberMe;
    }
    signInEmail(variables);
  };

  const showSeparator = (emailAndPassword?.enabled ?? false) && (socialProviders?.length ?? 0) > 0;
  const hasSocialProviders = (socialProviders?.length ?? 0) > 0;
  const showTopSocial = socialPosition === "top" && hasSocialProviders;
  const showTopSeparator = socialPosition === "top" && showSeparator;
  const showBottomSocial = socialPosition === "bottom" && hasSocialProviders;
  const showBottomSeparator = socialPosition === "bottom" && showSeparator;
  const showForgotPassword = emailAndPassword?.enabled && emailAndPassword.forgotPassword;
  const alternateRedirectTo =
    signUpRedirectTo ??
    (currentSearch.length > 0
      ? resolvePasskeyRedirectTo(redirectTo, currentSearch, currentOrigin)
      : redirectTo);

  return (
    <div className="relative w-full max-w-sm">
      <Card className={cn("w-full", className)}>
        <AuthPrompts view="signIn" />
        <CardHeader>
          <CardTitle className="text-xl font-semibold">{localization.auth.signIn}</CardTitle>
        </CardHeader>

        <CardContent>
          <div className="flex flex-col gap-3">
            {plugins.flatMap((plugin) =>
              (plugin.authButtons ?? []).map((AuthButton, index) => (
                <AuthButton key={`${plugin.id}-${index.toString()}`} view="signIn" />
              )),
            )}
            {showTopSocial && <ProviderButtons socialLayout={socialLayout} view="signIn" />}
            {showTopSeparator && (
              <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card m-0 text-xs flex items-center">
                {localization.auth.or}
              </FieldSeparator>
            )}

            {(emailAndPassword?.enabled ?? false) && (
              <EmailPasswordForm
                emailAndPassword={emailAndPassword}
                fieldErrors={fieldErrors}
                isPending={isPending}
                isPasswordVisible={isPasswordVisible}
                localization={localization}
                passkeyAutoFill={passkeyAutoFill}
                password={password}
                signInEmailPending={signInEmailPending}
                onPasswordChange={setPassword}
                onFieldErrorsChange={setFieldErrors}
                onPasswordVisibilityChange={setIsPasswordVisible}
                onSubmit={handleSubmit}
              />
            )}

            {showBottomSeparator && (
              <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card text-xs flex items-center">
                {localization.auth.or}
              </FieldSeparator>
            )}
            {showBottomSocial && <ProviderButtons socialLayout={socialLayout} view="signIn" />}
          </div>

          {showForgotPassword && (
            <div className="flex flex-col gap-3 items-center w-full mt-4">
              <Link
                href={`${basePaths.auth}/${viewPaths.auth.forgotPassword}`}
                className="self-center text-sm underline-offset-4 hover:underline"
              >
                {localization.auth.forgotPasswordLink}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      <FieldDescription className="absolute top-full left-0 mt-3 w-full text-center">
        {localization.auth.needToCreateAnAccount}{" "}
        <Link
          href={getAuthLinkURL(`${basePaths.auth}/${viewPaths.auth.signUp}`, alternateRedirectTo)}
          className="underline underline-offset-4"
        >
          {localization.auth.signUp}
        </Link>
      </FieldDescription>
    </div>
  );
}
