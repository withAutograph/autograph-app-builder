"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { SiVercel } from "react-icons/si";

import { AuthProvider } from "@/components/auth/auth-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth-client";
import { oauthProviderPlugin } from "@/lib/auth/oauth-provider-plugin";
import { getQueryClient } from "@/lib/query-client";

export function Providers({
  children,
  vercelAuthEnabled,
}: {
  children: ReactNode;
  vercelAuthEnabled: boolean;
}) {
  const router = useRouter();
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        authClient={authClient}
        Link={Link}
        navigate={({ to, replace }) =>
          replace ? router.replace(to) : router.push(to)
        }
        plugins={[oauthProviderPlugin()]}
        redirectTo="/"
        socialProviders={[
          ...(vercelAuthEnabled
            ? [{ id: "vercel", label: "Vercel", icon: <SiVercel /> }]
            : []),
          "github",
        ]}
      >
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
