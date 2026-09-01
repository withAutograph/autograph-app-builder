"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThemeProvider, useTheme } from "next-themes";
import type { ReactNode } from "react";
import { SiVercel } from "react-icons/si";

import { AuthProvider } from "@/components/auth/auth-provider";
import { OAuthConsent } from "@/components/auth/oauth-provider/oauth-consent";
import { PasskeyButton } from "@/components/auth/passkey/passkey-button";
import { Passkeys } from "@/components/auth/passkey/passkeys";
import { Appearance } from "@/components/auth/theme/appearance";
import { ThemeToggleItem } from "@/components/auth/theme/theme-toggle-item";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth-client";
import { oauthProviderPlugin } from "@/lib/auth/oauth-provider-plugin";
import { passkeyPlugin } from "@/lib/auth/passkey-plugin";
import { passkeyUiPlugins } from "@/lib/auth/passkey-ui-plugins";
import { DEFAULT_AUTH_REDIRECT_TO } from "@/lib/auth/preview-auth-ui";
import { themePlugin } from "@/lib/auth/theme-plugin";
import { getQueryClient } from "@/lib/query-client";

export function authPlugins(
  passkeysEnabled: boolean,
  themeHook: typeof useTheme,
) {
  return [
    {
      ...oauthProviderPlugin(),
      views: {
        auth: {
          oauthConsent: OAuthConsent,
        },
      },
    },
    ...passkeyUiPlugins(passkeysEnabled, () => ({
      ...passkeyPlugin({ autoFill: false }),
      authButtons: [PasskeyButton],
      securityCards: [Passkeys],
    })),
    {
      ...themePlugin({ useTheme: themeHook }),
      userMenuItems: [ThemeToggleItem],
      accountCards: [Appearance],
    },
  ];
}

export function Providers({
  children,
  githubAuthEnabled,
  passkeysEnabled,
  vercelAuthEnabled,
}: {
  children: ReactNode;
  githubAuthEnabled: boolean;
  passkeysEnabled: boolean;
  vercelAuthEnabled: boolean;
}) {
  const router = useRouter();
  const queryClient = getQueryClient();

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
      enableColorScheme
      enableSystem
      themes={["light", "dark"]}
    >
      <QueryClientProvider client={queryClient}>
        <AuthProvider
          authClient={authClient}
          Link={Link}
          navigate={({ to, replace }) =>
            replace ? router.replace(to) : router.push(to)
          }
          plugins={authPlugins(passkeysEnabled, useTheme)}
          emailAndPassword={{ enabled: false }}
          redirectTo={DEFAULT_AUTH_REDIRECT_TO}
          socialProviders={[
            ...(vercelAuthEnabled
              ? [{ id: "vercel", label: "Vercel", icon: <SiVercel /> }]
              : []),
            ...(githubAuthEnabled ? (["github"] as const) : []),
          ]}
        >
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
