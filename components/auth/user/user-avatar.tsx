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
    enabled: user === null || user === undefined ? isPending !== true : false,
  });

  if ((isPending === true || sessionPending) && (user === null || user === undefined)) {
    return <Skeleton className={cn("size-8 rounded-full", className)} />;
  }

  const resolvedUser = user ?? session?.user;

  const username = resolvedUser?.username;
  const name = resolvedUser?.name;
  const email = resolvedUser?.email;
  let initials: string | undefined;
  if (username !== undefined && username.length > 0) {
    initials = username;
  } else if (name !== undefined && name.length > 0) {
    initials = name;
  } else if (email !== undefined && email.length > 0) {
    initials = email.slice(0, 2).toUpperCase();
  }
  const displayName = resolvedUser?.displayUsername;
  let alt: string | undefined;
  if (displayName !== undefined && displayName.length > 0) {
    alt = displayName;
  } else if (name !== undefined && name.length > 0) {
    alt = name;
  } else if (email !== undefined && email.length > 0) {
    alt = email;
  }
  const fallbackContent =
    fallback ??
    (initials !== undefined && initials.length > 0 ? initials : <User2 className="size-4" />);

  return (
    <Avatar className={cn("size-8 bg-muted text-foreground text-sm rounded-full", className)}>
      <AvatarImage src={resolvedUser?.image ?? undefined} alt={alt} />

      <AvatarFallback className="text-muted-foreground!">{fallbackContent}</AvatarFallback>
    </Avatar>
  );
}
