"use client";

import type { ComponentProps } from "react";
import { useAuth } from "@better-auth-ui/react";

import { cn } from "@/lib/utils";
import { UserProfile } from "./user-profile";

export type AccountSettingsProps = {
  className?: string;
};

/**
 * Renders the account settings layout.
 *
 * Uses `emailAndPassword` and `plugins` from `useAuth()` to conditionally
 * show sections:
 * - `UserProfile` always renders.
 * - The change-email card renders when `emailAndPassword?.enabled` is truthy
 *   or the `magicLink` plugin is registered, and a plugin may replace it via
 *   `cardOverrides.account.changeEmail` (the email-OTP plugin swaps in its
 *   code-based flow).
 * - Plugin-contributed account cards are rendered via the plugins array.
 */
export function AccountSettings({
  className,
  ...props
}: AccountSettingsProps & ComponentProps<"div">) {
  const { plugins } = useAuth();

  return (
    <div
      className={cn("flex w-full flex-col gap-4 md:gap-6", className)}
      {...props}
    >
      <UserProfile />
      {plugins.flatMap(
        (plugin) =>
          plugin.securityCards?.map((SecurityCard, index) => (
            <SecurityCard key={`${plugin.id}-security-${index.toString()}`} />
          )) ?? [],
      )}
      {plugins.flatMap(
        (plugin) =>
          plugin.accountCards?.map((AccountCard, index) => (
            <AccountCard key={`${plugin.id}-account-${index.toString()}`} />
          )) ?? [],
      )}
    </div>
  );
}
