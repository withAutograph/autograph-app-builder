"use client";

import { isSessionNotFreshError } from "@better-auth-ui/core";
import type { AddPasskeyParams, PasskeyAuthClient } from "@better-auth-ui/core/plugins/passkey";
import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import { useAddPasskey } from "@better-auth-ui/react/plugins/passkey";
import { Fingerprint } from "lucide-react";
import { useRef } from "react";
import type { SyntheticEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { passkeyPlugin } from "@/lib/auth/passkey-plugin";
import { FreshSessionPrompt } from "../settings/security/fresh-session-prompt";

export interface AddPasskeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const errorMessageSchema = z.object({ message: z.string() });
const formNameSchema = z.string();

const getErrorMessage = function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  const parsedError = errorMessageSchema.safeParse(error);
  return parsedError.success ? parsedError.data.message : undefined;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function AddPasskeyDialog({ open, onOpenChange }: AddPasskeyDialogProps) {
  const { authClient, localization } = useAuth<PasskeyAuthClient>();
  const { authenticatorAttachment, localization: passkeyLocalization } =
    useAuthPlugin(passkeyPlugin);

  const addPasskey = useAddPasskey(authClient);
  const pendingRequest = useRef<AddPasskeyParams<PasskeyAuthClient>>();

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      addPasskey.reset();
      pendingRequest.current = null;
    }
    onOpenChange(nextOpen);
  };

  const submitRequest = (request: AddPasskeyParams<PasskeyAuthClient>) => {
    pendingRequest.current = request;
    addPasskey.mutate(request, {
      onSuccess: () => {
        handleOpenChange(false);
      },
    });
  };

  const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const name = formData
      .getAll("name")
      .map((value) => formNameSchema.safeParse(value))
      .filter((result) => result.success)
      .map((result) => result.data)
      .join("")
      .trim();

    const request: AddPasskeyParams<PasskeyAuthClient> = {};
    if (name) {
      request.name = name;
    }
    if (authenticatorAttachment) {
      request.authenticatorAttachment = authenticatorAttachment;
    }
    submitRequest(request);
  };

  const needsFreshSession = isSessionNotFreshError(addPasskey.error);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {needsFreshSession ? (
          <>
            <DialogHeader>
              <DialogTitle className="sr-only">
                {localization.settings.freshSessionTitle}
              </DialogTitle>
            </DialogHeader>
            <FreshSessionPrompt
              onFresh={() => {
                const request = pendingRequest.current;
                if (request) {
                  submitRequest(request);
                }
              }}
            />
          </>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-6">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Fingerprint />
                {passkeyLocalization.addPasskey}
              </DialogTitle>

              <DialogDescription>{passkeyLocalization.passkeysDescription}</DialogDescription>
            </DialogHeader>

            <Field data-invalid={addPasskey.isError}>
              <FieldLabel htmlFor="passkey-name">{passkeyLocalization.name}</FieldLabel>

              <Input
                id="passkey-name"
                name="name"
                autoFocus
                placeholder={localization.settings.optional}
                disabled={addPasskey.isPending}
                aria-invalid={addPasskey.isError}
              />

              {addPasskey.error && (
                <FieldError>
                  {getErrorMessage(addPasskey.error.error) ??
                    getErrorMessage(
                      addPasskey.error instanceof Error ? addPasskey.error : undefined,
                    ) ??
                    ""}
                </FieldError>
              )}
            </Field>

            <DialogFooter>
              <DialogClose
                className={buttonVariants({ variant: "outline" })}
                disabled={addPasskey.isPending}
                type="button"
              >
                {localization.settings.cancel}
              </DialogClose>

              <Button type="submit" disabled={addPasskey.isPending}>
                {addPasskey.isPending && <Spinner />}

                {passkeyLocalization.addPasskey}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
