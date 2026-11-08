import {
  authMutationKeys,
  authQueryKeys,
  getAuthErrorPresentation,
  isPasswordCompromisedError,
  isSessionNotFreshError,
} from "@better-auth-ui/core";
import { oneTapMutationKeys } from "@better-auth-ui/core/plugins/one-tap";
import { matchMutation, matchQuery, useQueryClient } from "@tanstack/react-query";
import type { BetterFetchError } from "better-auth/react";
import { useEffect } from "react";
import { toast } from "sonner";

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- React components use PascalCase names for JSX and diagnostics. Preserve function declaration hoisting and initialization timing.
export function ErrorToaster() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    const previousQueryOnError = queryCache.config.onError;

    queryCache.config.onError = (error, query) => {
      previousQueryOnError?.(error, query);

      if (!matchQuery({ queryKey: authQueryKeys.all }, query)) {
        return;
      }
      if (getAuthErrorPresentation(query.meta) !== "toast") {
        return;
      }
      if (isSessionNotFreshError(error)) {
        return;
      }

      const err = error as BetterFetchError;
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing untyped input or fixture boundary.
      if (err?.error?.code === "EMAIL_NOT_VERIFIED") {
        return;
      }
      if (err?.error) {
        // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Preserve the existing auth error passed to the toast.
        toast.error(err.error.message);
      }
    };

    const mutationCache = queryClient.getMutationCache();
    const previousMutationOnError = mutationCache.config.onError;

    mutationCache.config.onError = (error, variables, onMutateResult, mutation, context) => {
      previousMutationOnError?.(error, variables, onMutateResult, mutation, context);

      if (!matchMutation({ mutationKey: authMutationKeys.all }, mutation)) {
        return;
      }
      if (getAuthErrorPresentation(mutation.meta) !== "toast") {
        return;
      }
      if (isSessionNotFreshError(error)) {
        return;
      }
      // Every form that sets a new password renders this one against the
      // password field, so a toast would just repeat it.
      if (isPasswordCompromisedError(error)) {
        return;
      }

      const err = error as BetterFetchError;
      if (
        // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing untyped input or fixture boundary.
        err.error?.code === "EMAIL_NOT_VERIFIED" &&
        !matchMutation({ mutationKey: oneTapMutationKeys.prompt }, mutation)
      ) {
        return;
      }
      // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/prefer-nullish-coalescing, typescript/no-unsafe-argument -- Preserve auth error messaging and its empty-message fallback.
      toast.error(err.error?.message || err.message);
    };

    return () => {
      queryCache.config.onError = previousQueryOnError;
      mutationCache.config.onError = previousMutationOnError;
    };
  }, [queryClient]);

  return null;
}
