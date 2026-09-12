import { Suspense } from "react";
import type { ReactNode } from "react";

import { AuthRouteProvider } from "@/components/providers";
import { passkeysFlag } from "@/lib/feature-flags";

async function AuthConfiguration({ children }: { children: ReactNode }) {
  const passkeysEnabled = await passkeysFlag();
  const showEmulatedProviders =
    process.env.NODE_ENV === "development" ||
    (process.env.VERCEL_ENV === "preview" &&
      process.env.APP_BUILDER_PREVIEW_PROVIDER_EMULATION === "1");

  return (
    <AuthRouteProvider
      githubAuthEnabled={Boolean(
        showEmulatedProviders || (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
      )}
      vercelAuthEnabled={Boolean(
        showEmulatedProviders ||
        (process.env.VERCEL_AUTH_CLIENT_ID && process.env.VERCEL_AUTH_CLIENT_SECRET),
      )}
      passkeysEnabled={passkeysEnabled}
    >
      {children}
    </AuthRouteProvider>
  );
}

/** Keep request-fresh auth configuration below each destination's static shell. */
export function RouteProviders({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <AuthConfiguration>{children}</AuthConfiguration>
    </Suspense>
  );
}
