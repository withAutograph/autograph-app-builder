"use client";

import type { MultiSessionAuthClient } from "@better-auth-ui/core/plugins/multi-session";
import { useAuth, useSession } from "@better-auth-ui/react";
import { useSetActiveSession } from "@better-auth-ui/react/plugins/multi-session";
import { ChevronsUpDown, LogIn, LogOut, Settings, UserPlus2 } from "lucide-react";
import Link from "next/link";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./user-avatar";
import { UserView } from "./user-view";

const menuAlignments = { center: true, end: true, start: true };
type MenuAlign = keyof typeof menuAlignments;
const buttonVariantClasses = {
  default: "bg-primary text-primary-foreground hover:bg-primary/80",
  destructive:
    "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
  ghost:
    "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
  link: "text-primary underline-offset-4 hover:underline",
  outline:
    "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
};
type ButtonVariant = keyof typeof buttonVariantClasses;

export interface UserButtonProps {
  className?: string;
  align?: MenuAlign;
  sideOffset?: number;
  size?: "default" | "icon";
  variant?: ButtonVariant;
}

/**
 * Render the stock user dropdown with identity, settings, and authentication actions.
 *
 * Includes user profile, settings, and sign-in/sign-up/sign-out actions depending on authentication state.
 *
 * @param className - Additional CSS classes applied to the button trigger
 * @param align - Alignment of the dropdown menu relative to the trigger
 * @param sideOffset - Offset between the trigger and the dropdown menu
 * @param size - "icon" renders only the avatar; "default" renders a full button with label and chevron
 * @param variant - Visual variant of the trigger button
 * @returns The dropdown menu component with user actions
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function UserButton({
  className,
  align,
  sideOffset,
  size = "default",
  variant = "ghost",
}: UserButtonProps) {
  const { authClient, basePaths, viewPaths, localization, plugins } =
    useAuth<MultiSessionAuthClient>();

  const { isPending: settingActiveSession } = useSetActiveSession(authClient);
  const { data: session, isPending: sessionPending } = useSession(authClient);

  const pluginMenuItems = plugins.flatMap(
    (plugin) =>
      plugin.userMenuItems?.map((Item, index) => <Item key={`${plugin.id}-${index}`} />) ?? [],
  );
  const isSessionLoading =
    (session !== null && session !== undefined) || sessionPending || settingActiveSession;
  const triggerClassName =
    size === "icon"
      ? cn("rounded-full", className)
      : cn(
          "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 h-9 gap-1.5 px-2.5",
          buttonVariantClasses[variant],
          "py-2.5 h-auto font-normal",
          className,
        );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={size === "icon" ? localization.auth.account : undefined}
        className={triggerClassName}
      >
        {size === "icon" ? (
          <UserAvatar />
        ) : (
          <>
            {isSessionLoading ? (
              <UserView isPending={settingActiveSession} />
            ) : (
              <>
                <UserAvatar />

                <div className="grid flex-1 text-left text-sm leading-tight">
                  {localization.auth.account}
                </div>
              </>
            )}

            <ChevronsUpDown className="ml-auto size-4" />
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="min-w-40 md:min-w-56 max-w-[48svw]"
        sideOffset={sideOffset}
        align={align}
      >
        {session && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-sm font-normal">
                <UserView />
              </DropdownMenuLabel>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />
          </>
        )}

        {session ? (
          <>
            <DropdownMenuItem
              render={<Link href={`${basePaths.settings}/${viewPaths.settings.account}`} />}
            >
              <Settings className="text-muted-foreground" />

              {localization.settings.settings}
            </DropdownMenuItem>

            {pluginMenuItems}

            <DropdownMenuSeparator />

            <DropdownMenuItem
              render={
                <Link href={`${basePaths.auth}/${viewPaths.auth.signOut}`} prefetch={false} />
              }
            >
              <LogOut className="text-muted-foreground" />

              {localization.auth.signOut}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem
              render={<Link href={`${basePaths.auth}/${viewPaths.auth.signIn}`} prefetch={false} />}
            >
              <LogIn className="text-muted-foreground" />

              {localization.auth.signIn}
            </DropdownMenuItem>

            <DropdownMenuItem
              render={<Link href={`${basePaths.auth}/${viewPaths.auth.signUp}`} prefetch={false} />}
            >
              <UserPlus2 className="text-muted-foreground" />

              {localization.auth.signUp}
            </DropdownMenuItem>

            {pluginMenuItems}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
