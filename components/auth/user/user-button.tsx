"use client";

import type { MultiSessionAuthClient } from "@better-auth-ui/core/plugins/multi-session";
import { useAuth, useSession } from "@better-auth-ui/react";
import { useSetActiveSession } from "@better-auth-ui/react/plugins/multi-session";
import {
  ChevronsUpDown,
  LogIn,
  LogOut,
  Settings,
  UserPlus2,
} from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
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

export type UserButtonProps = {
  className?: string;
  align?: "center" | "end" | "start" | undefined;
  sideOffset?: number;
  size?: "default" | "icon";
  variant?:
    "default" | "destructive" | "ghost" | "link" | "outline" | "secondary";
};

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
      plugin.userMenuItems?.map((Item, index) => (
        <Item key={`${plugin.id}-${index.toString()}`} />
      )) ?? [],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={size === "icon" ? localization.auth.account : undefined}
        className={
          size === "icon"
            ? cn("rounded-full", className)
            : cn(
                buttonVariants({ variant, size: "lg" }),
                "py-2.5 h-auto font-normal",
                className,
              )
        }
      >
        {size === "icon" ? (
          <UserAvatar />
        ) : (
          <>
            {session || sessionPending || settingActiveSession ? (
              <UserView isPending={!!settingActiveSession} />
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
              render={
                <Link
                  href={`${basePaths.settings}/${viewPaths.settings.account}`}
                />
              }
            >
              <Settings className="text-muted-foreground" />

              {localization.settings.settings}
            </DropdownMenuItem>

            {pluginMenuItems}

            <DropdownMenuSeparator />

            <DropdownMenuItem
              render={
                <Link
                  href={`${basePaths.auth}/${viewPaths.auth.signOut}`}
                  prefetch={false}
                />
              }
            >
              <LogOut className="text-muted-foreground" />

              {localization.auth.signOut}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem
              render={
                <Link
                  href={`${basePaths.auth}/${viewPaths.auth.signIn}`}
                  prefetch={false}
                />
              }
            >
              <LogIn className="text-muted-foreground" />

              {localization.auth.signIn}
            </DropdownMenuItem>

            <DropdownMenuItem
              render={
                <Link
                  href={`${basePaths.auth}/${viewPaths.auth.signUp}`}
                  prefetch={false}
                />
              }
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
