"use client";

import {
  authMutationKeys,
  getAuthLinkURL,
  isPasswordCompromisedError,
  parseAdditionalFieldValue,
} from "@better-auth-ui/core";
import { AuthPrompts, useAuth, useFetchOptions, useSignUpEmail } from "@better-auth-ui/react";
import type { AdditionalField as AdditionalFieldConfig } from "@better-auth-ui/core";
import { useIsMutating } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
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

interface FormFieldErrors {
  confirmPassword: string | null;
  email: string | null;
  name: string | null;
  password: string | null;
}

const hasSignUpField = function hasSignUpField(field: AdditionalFieldConfig) {
  return field.signUp !== undefined && field.signUp !== false;
};

const validateAdditionalFields = async function validateAdditionalFields(
  fields: AdditionalFieldConfig[] | undefined,
  formData: FormData,
): Promise<Record<string, string | number | boolean | Date | null> | null> {
  const values: Record<string, string | number | boolean | Date | null> = {};

  const validateAt = async function validateAt(index: number): Promise<boolean> {
    const field = fields?.[index];
    if (!field) {
      return true;
    }
    if (!hasSignUpField(field) || field.readOnly === true) {
      return await validateAt(index + 1);
    }
    const entry = formData.get(field.name);
    const value = parseAdditionalFieldValue(field, entry instanceof File ? null : entry);

    if (field.validate) {
      try {
        await field.validate(value);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    }
    if (value !== undefined) {
      values[field.name] = value;
    }
    return await validateAt(index + 1);
  };

  const valid = await validateAt(0);
  return valid ? values : null;
};

const signUpAdditionalFields = function signUpAdditionalFields({
  fields,
  isPending,
  optionalLabel,
  position,
}: {
  fields: AdditionalFieldConfig[] | undefined;
  isPending: boolean;
  optionalLabel: string;
  position: "above" | "below";
}) {
  return fields?.map((field) => {
    const visible =
      hasSignUpField(field) &&
      (position === "above" ? field.signUp === "above" : field.signUp !== "above");
    return visible ? (
      <AdditionalField
        key={field.name}
        name={field.name}
        field={field}
        isPending={isPending}
        optionalLabel={optionalLabel}
      />
    ) : null;
  });
};

const PasswordInput = function PasswordInput({
  id,
  label,
  value,
  visible,
  error,
  placeholder,
  minLength,
  maxLength,
  isPending,
  onChange,
  onVisibilityChange,
  onInvalid,
}: {
  id: "password" | "confirmPassword";
  label: string;
  value: string;
  visible: boolean;
  error: string | null;
  placeholder: string;
  minLength: number | undefined;
  maxLength: number | undefined;
  isPending: boolean;
  onChange: (value: string) => void;
  onVisibilityChange: () => void;
  onInvalid: (event: React.InvalidEvent<HTMLInputElement>) => void;
}) {
  return (
    <Field data-invalid={error !== "" && error !== null}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          placeholder={placeholder}
          required
          minLength={minLength}
          maxLength={maxLength}
          disabled={isPending}
          onInvalid={onInvalid}
          aria-invalid={error !== "" && error !== null}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={visible ? "Hide password" : "Show password"}
            onClick={onVisibilityChange}
          >
            {visible ? <EyeOff /> : <Eye />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <FieldError>{error}</FieldError>
    </Field>
  );
};

const SignUpIdentityFields = function SignUpIdentityFields({
  showName,
  errors,
  isPending,
  labels,
  clearError,
}: {
  showName: boolean;
  errors: FormFieldErrors;
  isPending: boolean;
  labels: {
    name: string;
    namePlaceholder: string;
    email: string;
    emailPlaceholder: string;
    fieldRequired: string;
    invalidEmail: string;
  };
  clearError: (field: "name" | "email", value: string | null) => void;
}) {
  return (
    <>
      {showName && (
        <Field data-invalid={errors.name !== "" && errors.name !== null}>
          <FieldLabel htmlFor="name">{labels.name}</FieldLabel>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder={labels.namePlaceholder}
            required
            disabled={isPending}
            onChange={() => {
              clearError("name", null);
            }}
            onInvalid={(event) => {
              event.preventDefault();
              clearError("name", labels.fieldRequired);
            }}
            aria-invalid={errors.name !== "" && errors.name !== null}
          />
          <FieldError>{errors.name}</FieldError>
        </Field>
      )}
      <Field data-invalid={errors.email !== "" && errors.email !== null}>
        <FieldLabel htmlFor="email">{labels.email}</FieldLabel>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder={labels.emailPlaceholder}
          required
          disabled={isPending}
          onChange={() => {
            clearError("email", null);
          }}
          onInvalid={(event) => {
            event.preventDefault();
            const input = event.currentTarget;
            clearError(
              "email",
              input.validity.valueMissing ? labels.fieldRequired : labels.invalidEmail,
            );
          }}
          aria-invalid={errors.email !== "" && errors.email !== null}
        />
        <FieldError>{errors.email}</FieldError>
      </Field>
    </>
  );
};

const SignUpProviderOptions = function SignUpProviderOptions({
  hasSocialProviders,
  showSeparator,
  socialLayout,
  socialPosition,
  separatorLabel,
}: {
  hasSocialProviders: boolean;
  showSeparator: boolean;
  socialLayout: SocialLayout | undefined;
  socialPosition: "top" | "bottom";
  separatorLabel: string;
}) {
  if (socialPosition === "top") {
    return null;
  }
  return (
    <>
      {hasSocialProviders ? <ProviderButtons socialLayout={socialLayout} view="signUp" /> : null}
      {showSeparator ? (
        <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card text-xs flex items-center">
          {separatorLabel}
        </FieldSeparator>
      ) : null}
    </>
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
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function SignUp({
  className,
  signInRedirectTo,
  socialLayout,
  socialPosition = "bottom",
  onSignUpSuccess,
}: SignUpProps) {
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
  const [fieldErrors, setFieldErrors] = useState<FormFieldErrors>({
    confirmPassword: "",
    email: "",
    name: "",
    password: "",
  });
  const currentLocation = useSyncExternalStore(
    () => {
      const onLocationChange = function onLocationChange() {
        window.dispatchEvent(new Event("locationchange"));
      };
      window.addEventListener("popstate", onLocationChange);
      window.addEventListener("locationchange", onLocationChange);
      return () => {
        window.removeEventListener("popstate", onLocationChange);
        window.removeEventListener("locationchange", onLocationChange);
      };
    },
    () => window.location.href,
    () => "",
  );
  const currentSearch = currentLocation.length > 0 ? new URL(currentLocation).search : "";
  const currentOrigin = currentLocation.length > 0 ? new URL(currentLocation).origin : "";

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

  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isConfirmPasswordVisible, setIsConfirmPasswordVisible] = useState(false);

  const handleSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    // `emailAndPassword.name === false` hides the name field and submits "".
    const nameEntry = formData.get("name");
    const emailEntry = formData.get("email");
    const name = nameEntry instanceof File ? "" : (nameEntry ?? "");
    const email = emailEntry instanceof File ? "" : (emailEntry ?? "");

    if (emailAndPassword?.confirmPassword === true && password !== confirmPassword) {
      toast.error(localization.auth.passwordsDoNotMatch);
      setPassword("");
      setConfirmPassword("");
      return;
    }

    const additionalFieldValues = await validateAdditionalFields(additionalFields, formData);
    if (additionalFieldValues === null) {
      return;
    }

    signUpEmail({
      email,
      fetchOptions,
      name,
      password,
      ...additionalFieldValues,
    });
  };

  const showSeparator =
    emailAndPassword?.enabled && socialProviders !== undefined && socialProviders.length > 0;
  const hasSocialProviders = socialProviders !== undefined && socialProviders.length > 0;
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
            <SignUpProviderOptions
              hasSocialProviders={hasSocialProviders}
              showSeparator={showSeparator}
              socialLayout={socialLayout}
              socialPosition={socialPosition}
              separatorLabel={localization.auth.or}
            />

            {emailAndPassword?.enabled && (
              <form
                onSubmit={(event) => {
                  void handleSubmit(event);
                }}
              >
                <FieldGroup>
                  <SignUpIdentityFields
                    showName={emailAndPassword.name !== false}
                    errors={fieldErrors}
                    isPending={isPending}
                    labels={{
                      email: localization.auth.email,
                      emailPlaceholder: localization.auth.emailPlaceholder,
                      fieldRequired: localization.auth.fieldRequired,
                      invalidEmail: localization.auth.invalidEmail,
                      name: localization.auth.name,
                      namePlaceholder: localization.auth.namePlaceholder,
                    }}
                    clearError={(field, value) => {
                      setFieldErrors((previous) => ({ ...previous, [field]: value }));
                    }}
                  />

                  {signUpAdditionalFields({
                    fields: additionalFields,
                    isPending,
                    optionalLabel: localization.auth.optional,
                    position: "above",
                  })}

                  <>
                    <PasswordInput
                      id="password"
                      label={localization.auth.password}
                      value={password}
                      visible={isPasswordVisible}
                      error={fieldErrors.password}
                      placeholder={localization.auth.passwordPlaceholder}
                      minLength={emailAndPassword?.minPasswordLength}
                      maxLength={emailAndPassword?.maxPasswordLength}
                      isPending={isPending}
                      onChange={(value) => {
                        setPassword(value);
                        setFieldErrors((prev) => ({ ...prev, password: null }));
                      }}
                      onVisibilityChange={() => {
                        setIsPasswordVisible((visible) => !visible);
                      }}
                      onInvalid={(event) => {
                        event.preventDefault();
                        const input = event.currentTarget;
                        let message = localization.auth.tooLong.replace(
                          "{{max}}",
                          String(emailAndPassword?.maxPasswordLength),
                        );
                        if (input.validity.valueMissing) {
                          message = localization.auth.fieldRequired;
                        } else if (input.validity.tooShort) {
                          message = localization.auth.tooShort.replace(
                            "{{min}}",
                            String(emailAndPassword?.minPasswordLength),
                          );
                        }
                        setFieldErrors((prev) => ({ ...prev, password: message }));
                      }}
                    />
                    <PasswordStrengthMeter password={password} />
                    {emailAndPassword?.confirmPassword === true && (
                      <PasswordInput
                        id="confirmPassword"
                        label={localization.auth.confirmPassword}
                        value={confirmPassword}
                        visible={isConfirmPasswordVisible}
                        error={fieldErrors.confirmPassword}
                        placeholder={localization.auth.confirmPasswordPlaceholder}
                        minLength={emailAndPassword.minPasswordLength}
                        maxLength={emailAndPassword.maxPasswordLength}
                        isPending={isPending}
                        onChange={(value) => {
                          setConfirmPassword(value);
                          setFieldErrors((prev) => ({ ...prev, confirmPassword: null }));
                        }}
                        onVisibilityChange={() => {
                          setIsConfirmPasswordVisible((visible) => !visible);
                        }}
                        onInvalid={(event) => {
                          event.preventDefault();
                          const input = event.currentTarget;
                          let message = localization.auth.tooLong.replace(
                            "{{max}}",
                            String(emailAndPassword.maxPasswordLength),
                          );
                          if (input.validity.valueMissing) {
                            message = localization.auth.fieldRequired;
                          } else if (input.validity.tooShort) {
                            message = localization.auth.tooShort.replace(
                              "{{min}}",
                              String(emailAndPassword.minPasswordLength),
                            );
                          }
                          setFieldErrors((prev) => ({ ...prev, confirmPassword: message }));
                        }}
                      />
                    )}
                  </>

                  {signUpAdditionalFields({
                    fields: additionalFields,
                    isPending,
                    optionalLabel: localization.auth.optional,
                    position: "below",
                  })}

                  <div className="flex flex-col gap-3">
                    <Button type="submit" disabled={isPending}>
                      {signUpEmailPending && <Spinner />}

                      {localization.auth.signUp}
                    </Button>
                  </div>
                </FieldGroup>
              </form>
            )}

            <SignUpProviderOptions
              hasSocialProviders={hasSocialProviders}
              showSeparator={showSeparator}
              socialLayout={socialLayout}
              socialPosition={socialPosition}
              separatorLabel={localization.auth.or}
            />
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
}
