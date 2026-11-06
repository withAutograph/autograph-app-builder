"use client";

import { getViewURL } from "@better-auth-ui/core";
import { useAuth, useChangeEmail, useSession } from "@better-auth-ui/react";
import { useState } from "react";
import type { SyntheticEvent } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const emailSchema = z.string();

export interface ChangeEmailProps {
  className?: string;
}

/**
 * Render a card containing a form to view and update the authenticated user's email.
 *
 * Shows a loading skeleton until session data is available, displays the current
 * email as the form's default value, and sends a verification email to the
 * new address upon successful submission.
 *
 * @returns A JSX element rendering the change-email card and form
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ChangeEmail({ className }: ChangeEmailProps) {
  const { authClient, basePaths, baseURL, localization, viewPaths } = useAuth();
  const { data: session } = useSession(authClient);
  const parsedEmail = emailSchema.safeParse(session?.user.email);
  const currentEmail = parsedEmail.success ? parsedEmail.data : null;

  const { mutate: changeEmail, isPending } = useChangeEmail(authClient, {
    onSuccess: () => toast.success(localization.settings.changeEmailSuccess),
  });

  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
  }>({});

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const email = formData.get("email");
    if (email instanceof File || email === null) {
      return;
    }

    changeEmail({
      callbackURL: getViewURL(baseURL, basePaths.settings, viewPaths.settings.account),
      newEmail: email,
    });
  }

  return (
    <div>
      <h2 className="text-sm font-semibold mb-3">{localization.settings.changeEmail}</h2>

      <form onSubmit={handleSubmit}>
        <Card className={cn(className)}>
          <CardContent className="flex flex-col gap-6">
            <Field data-invalid={!!fieldErrors.email}>
              <FieldLabel htmlFor="email">{localization.auth.email}</FieldLabel>

              {currentEmail !== null && currentEmail !== "" ? (
                <Input
                  key={currentEmail}
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  defaultValue={currentEmail}
                  placeholder={localization.auth.emailPlaceholder}
                  disabled={isPending}
                  required
                  onChange={() => {
                    setFieldErrors((prev) => ({
                      ...prev,
                      email: null,
                    }));
                  }}
                  onInvalid={(e) => {
                    e.preventDefault();
                    setFieldErrors((prev) => ({
                      ...prev,
                      email:
                        e.target instanceof HTMLInputElement ? e.target.validationMessage : null,
                    }));
                  }}
                  aria-invalid={fieldErrors.email !== undefined && fieldErrors.email !== ""}
                />
              ) : (
                <Skeleton>
                  <Input className="invisible" />
                </Skeleton>
              )}

              <FieldError>{fieldErrors.email}</FieldError>
            </Field>
          </CardContent>

          <CardFooter>
            <Button type="submit" size="sm" disabled={isPending || !session}>
              {isPending && <Spinner />}

              {localization.settings.updateEmail}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}
