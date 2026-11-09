/* oxlint-disable typescript/no-unsafe-type-assertion, sonarjs/no-undefined-assignment -- Preserve explicit undefined values in existing JSX or generated-source expressions. */
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
import type { Dispatch, SetStateAction, SyntheticEvent } from "react";

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

const passwordValidationMessage = (
  input: HTMLInputElement,
  emailAndPassword: ReturnType<typeof useAuth>["emailAndPassword"],
  localization: ReturnType<typeof useAuth>["localization"],
) => {
  const min = emailAndPassword?.minPasswordLength;
  const max = emailAndPassword?.maxPasswordLength;
  let message = localization.auth.tooLong.replace("{{max}}", String(max));
  if (input.validity.valueMissing) {
    message = localization.auth.fieldRequired;
  } else if (input.validity.tooShort) {
    message = localization.auth.tooShort.replace("{{min}}", String(min));
  }
  return message;
};

const emailValidationMessage = (
  input: HTMLInputElement,
  localization: ReturnType<typeof useAuth>["localization"],
) =>
  input.validity.valueMissing ? localization.auth.fieldRequired : localization.auth.invalidEmail;

const renderSocialSignIn = (
  position: "top" | "bottom",
  socialProviders: ReturnType<typeof useAuth>["socialProviders"],
  socialLayout: SocialLayout | undefined,
  showSeparator: boolean | null | undefined,
  localization: ReturnType<typeof useAuth>["localization"],
) => {
  if (position === "top") {
    return (
      <>
        {socialProviders !== undefined &&
          socialProviders !== null &&
          socialProviders.length > 0 && (
            <ProviderButtons socialLayout={socialLayout} view="signIn" />
          )}
        {showSeparator === true && (
          <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card m-0 text-xs flex items-center">
            {localization.auth.or}
          </FieldSeparator>
        )}
      </>
    );
  }
  return (
    <>
      {showSeparator === true && (
        <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card text-xs flex items-center">
          {localization.auth.or}
        </FieldSeparator>
      )}
      {socialProviders !== undefined && socialProviders !== null && socialProviders.length > 0 && (
        <ProviderButtons socialLayout={socialLayout} view="signIn" />
      )}
    </>
  );
};

const renderSignUpPrompt = ({
  Link,
  alternateRedirectTo,
  basePaths,
  localization,
  viewPaths,
}: Pick<ReturnType<typeof useAuth>, "Link" | "basePaths" | "localization" | "viewPaths"> & {
  alternateRedirectTo: Parameters<typeof getAuthLinkURL>[1];
}) => (
  <FieldDescription className="absolute top-full left-0 mt-3 w-full text-center">
    {localization.auth.needToCreateAnAccount}{" "}
    <Link
      href={getAuthLinkURL(`${basePaths.auth}/${viewPaths.auth.signUp}`, alternateRedirectTo)}
      className="underline underline-offset-4"
    >
      {localization.auth.signUp}
    </Link>
  </FieldDescription>
);

interface EmailPasswordFormProps {
  emailAndPassword: NonNullable<ReturnType<typeof useAuth>["emailAndPassword"]>;
  fieldErrors: { email?: string; password?: string };
  handleSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  isPasswordVisible: boolean;
  isPending: boolean;
  localization: ReturnType<typeof useAuth>["localization"];
  passkeyAutoFill: ReturnType<typeof isPasskeyAutoFillEnabled>;
  password: string;
  setFieldErrors: Dispatch<SetStateAction<{ email?: string; password?: string }>>;
  setIsPasswordVisible: Dispatch<SetStateAction<boolean>>;
  setPassword: Dispatch<SetStateAction<string>>;
  signInEmailPending: boolean;
}

const renderEmailPasswordForm = ({
  emailAndPassword,
  fieldErrors,
  handleSubmit,
  isPasswordVisible,
  isPending,
  localization,
  passkeyAutoFill,
  password,
  setFieldErrors,
  setIsPasswordVisible,
  setPassword,
  signInEmailPending,
}: EmailPasswordFormProps) => (
  <form onSubmit={handleSubmit}>
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
            setFieldErrors((prev) => ({
              ...prev,
              email: undefined,
            }));
          }}
          onInvalid={(e) => {
            e.preventDefault();
            // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
            const el = e.target as HTMLInputElement;
            const msg = emailValidationMessage(el, localization);

            setFieldErrors((prev) => ({
              ...prev,
              email: msg,
            }));
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
              setPassword(e.target.value);

              setFieldErrors((prev) => ({
                ...prev,
                password: undefined,
              }));
            }}
            placeholder={localization.auth.passwordPlaceholder}
            required
            minLength={emailAndPassword?.minPasswordLength}
            maxLength={emailAndPassword?.maxPasswordLength}
            disabled={isPending}
            onInvalid={(e) => {
              e.preventDefault();
              // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
              const el = e.target as HTMLInputElement;
              const msg = passwordValidationMessage(el, emailAndPassword, localization);

              setFieldErrors((prev) => ({
                ...prev,
                password: msg,
              }));
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
                setIsPasswordVisible((visible) => !visible);
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
    // oxlint-disable-next-line typescript/strict-void-return -- Preserve the existing callback return contract.
    () => () => null,
    () => window.location.href,
    () => "",
  );
  const currentSearch = currentLocation ? new URL(currentLocation).search : "";
  const currentOrigin = currentLocation ? new URL(currentLocation).origin : "";

  const { mutate: signInEmail, isPending: signInEmailPending } = useSignInEmail(authClient, {
    onError: (error, { email }) => {
      setPassword("");

      // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing untyped input or fixture boundary.
      if (error.error?.code === "EMAIL_NOT_VERIFIED") {
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
    email?: string;
    password?: string;
  }>({});

  const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
    const email = formData.get("email") as string;
    const rememberMe = formData.get("rememberMe") === "on";

    signInEmail({
      email,
      password,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
      ...(emailAndPassword?.rememberMe === true ? { rememberMe } : {}),
      fetchOptions,
    });
  };

  const showSeparator = emailAndPassword?.enabled && socialProviders && socialProviders.length > 0;
  const alternateRedirectTo =
    signUpRedirectTo ??
    (currentSearch
      ? resolvePasskeyRedirectTo(redirectTo, currentSearch, currentOrigin)
      : redirectTo);

  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
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
            {socialPosition === "top" &&
              renderSocialSignIn("top", socialProviders, socialLayout, showSeparator, localization)}

            {emailAndPassword?.enabled &&
              renderEmailPasswordForm({
                emailAndPassword,
                fieldErrors,
                handleSubmit,
                isPasswordVisible,
                isPending,
                localization,
                passkeyAutoFill,
                password,
                setFieldErrors,
                setIsPasswordVisible,
                setPassword,
                signInEmailPending,
              })}

            {socialPosition === "bottom" &&
              renderSocialSignIn(
                "bottom",
                socialProviders,
                socialLayout,
                showSeparator,
                localization,
              )}
          </div>

          {emailAndPassword?.enabled && emailAndPassword?.forgotPassword && (
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

      {renderSignUpPrompt({ Link, alternateRedirectTo, basePaths, localization, viewPaths })}
    </div>
  );
  /* oxlint-enable typescript/strict-boolean-expressions */
}
