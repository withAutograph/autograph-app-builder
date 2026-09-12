"use client";

import { useAuth, useSignOut } from "@better-auth-ui/react";
import { useEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface SignOutProps {
  className?: string;
}

/**
 * Signs the current user out on mount and renders a centered spinner while the operation completes.
 *
 * @param className - Optional additional class names appended to the root element
 * @returns The spinner shown during sign-out
 */
export function SignOut({ className }: SignOutProps) {
  const { authClient, basePaths, viewPaths } = useAuth();
  const signInHref = `${basePaths.auth}/${viewPaths.auth.signIn}`;

  const { mutate: signOut } = useSignOut(authClient, {
    onError: () => window.location.replace(signInHref),
    onSuccess: () => window.location.replace(signInHref),
  });

  const hasSignedOut = useRef(false);

  useEffect(() => {
    if (hasSignedOut.current) {
      return;
    }
    hasSignedOut.current = true;

    signOut();
  }, [signOut]);

  return <Spinner className={cn("mx-auto my-auto", className)} />;
}
