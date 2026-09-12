"use client";

import { getProviderId } from "@better-auth-ui/core";
import type { AuthView } from "@better-auth-ui/core";
import { useAuth } from "@better-auth-ui/react";
import { useMemo, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import { ProviderButton } from "./provider-button";

export interface ProviderButtonsProps {
  socialLayout?: SocialLayout;
  view?: AuthView;
}

export type SocialLayout = "auto" | "horizontal" | "vertical" | "grid";

/**
 * Render sign-in buttons for configured social providers. Each button owns its own sign-in mutation
 * and reads the shared sign-in pending state from React Query.
 *
 * @param socialLayout - Preferred layout for the provider buttons; `"auto"` chooses based on the number of providers.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ProviderButtons({ socialLayout = "auto", view = "signIn" }: ProviderButtonsProps) {
  const { socialProviders } = useAuth();
  // Better Auth starts social sign-in through a client mutation. Keep its
  // controls disabled until React has attached those event handlers. The
  // server snapshot deliberately stays false, while the browser snapshot
  // becomes true during hydration without an effect-driven render cascade.
  const isClientReady = useSyncExternalStore(
    () => () => {
      // Provider readiness has no external subscription.
    },
    () => true,
    () => false,
  );

  const resolvedSocialLayout = useMemo(() => {
    if (socialLayout === "auto") {
      if (socialProviders?.length && socialProviders.length >= 4) {
        return "horizontal";
      }

      return "vertical";
    }

    return socialLayout;
  }, [socialLayout, socialProviders?.length]);

  return (
    <div
      data-auth-social-ready={isClientReady ? "true" : "false"}
      className={cn(
        "gap-3",
        resolvedSocialLayout === "grid" && "grid grid-cols-2",
        resolvedSocialLayout === "vertical" && "flex flex-col",
        resolvedSocialLayout === "horizontal" && "flex flex-row flex-wrap",
      )}
    >
      {socialProviders?.map((provider) => (
        <ProviderButton
          key={getProviderId(provider)}
          provider={provider}
          isReady={isClientReady}
          view={view}
          display={
            resolvedSocialLayout === "vertical"
              ? "full"
              : resolvedSocialLayout === "grid"
                ? "name"
                : "icon"
          }
          className={cn(resolvedSocialLayout === "horizontal" && "flex-1")}
        />
      ))}
    </div>
  );
}
