"use client";

import type { UsernameAuthClient } from "@better-auth-ui/core/plugins/username";
import { useAuth, useSession } from "@better-auth-ui/react";
import type { User } from "better-auth";
import { User2 } from "lucide-react";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface UserAvatarProps {
  className?: string;
  fallback?: ReactNode;
  isPending?: boolean;
  /** `User` */
  user?: User & { username?: string | null; displayUsername?: string | null };
}

/**
 * Display a user's avatar using session information or an explicit user prop.
 *
 * Renders a circular avatar that shows the user's image when available, a fallback node if provided, or the user's first two initials; while the session is loading (or when `isPending` is true) and no `user` prop is supplied, renders a skeleton placeholder.
 *
 * @param className - Additional CSS classes applied to the avatar container
 * @param user - Optional user object to display instead of the session user
 * @param isPending - When true, treat the component as loading and show the skeleton if no `user` is provided
 * @param fallback - Node to render inside the avatar fallback area before initials or the default icon
 * @returns The avatar element to render (JSX)
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function UserAvatar({ className, user, isPending, fallback }: UserAvatarProps) {
  const { authClient } = useAuth<UsernameAuthClient>();
  const { data: session, isPending: sessionPending } = useSession(authClient, {
    enabled: !user && !(isPending ?? false),
  });

  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve false and nullish truthiness. */
  if ((isPending || sessionPending) && !user) {
    return <Skeleton className={cn("size-8 rounded-full", className)} />;
  }
  /* oxlint-enable typescript/strict-boolean-expressions */

  const resolvedUser = user ?? session?.user;

  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- Empty user names fall through to the next identifier.
  const initials = (resolvedUser?.username || resolvedUser?.name || resolvedUser?.email)
    ?.slice(0, 2)
    .toUpperCase();
  /* oxlint-enable typescript/strict-boolean-expressions */

  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve the existing truthiness for supported values. */
  return (
    <Avatar className={cn("size-8 bg-muted text-foreground text-sm rounded-full", className)}>
      <AvatarImage
        src={resolvedUser?.image ?? undefined}
        alt={
          // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- Empty display names fall through to another identifier.
          resolvedUser?.displayUsername || resolvedUser?.name || resolvedUser?.email
        }
      />

      <AvatarFallback className="text-muted-foreground!">
        {
          // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- Empty fallback content and initials use the next fallback.
          fallback || initials || <User2 className="size-4" />
        }
      </AvatarFallback>
    </Avatar>
  );
  /* oxlint-enable typescript/strict-boolean-expressions */
}
