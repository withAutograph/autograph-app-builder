import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import { passkeysFlag } from "@/lib/feature-flags";

import "./globals.css";

export const metadata: Metadata = {
  description:
    "Design, plan, create, and validate supported apps with Autograph App Builder.",
  title: "Autograph App Builder",
};

function ShellLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      className="flex min-h-svh items-center justify-center p-6"
    >
      <p className="text-muted-foreground text-sm" role="status">
        Loading App Builder…
      </p>
    </main>
  );
}

async function ShellContent({
  children,
  githubAuthEnabled,
  vercelAuthEnabled,
}: {
  children: ReactNode;
  githubAuthEnabled: boolean;
  vercelAuthEnabled: boolean;
}) {
  const passkeysEnabled = await passkeysFlag();

  return (
    <AppShell
      githubAuthEnabled={githubAuthEnabled}
      vercelAuthEnabled={vercelAuthEnabled}
      passkeysEnabled={passkeysEnabled}
    >
      {children}
    </AppShell>
  );
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const showLocalAuthProviders = process.env.NODE_ENV === "development";
  const showPreviewEmulatedAuthProviders =
    process.env.VERCEL_ENV === "preview" &&
    process.env.APP_BUILDER_PREVIEW_PROVIDER_EMULATION === "1";

  return (
    <html
      lang="en"
      className={`${GeistSans.className} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <Suspense fallback={<ShellLoading />}>
          <ShellContent
            githubAuthEnabled={Boolean(
              showLocalAuthProviders ||
              showPreviewEmulatedAuthProviders ||
              (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
            )}
            vercelAuthEnabled={Boolean(
              showLocalAuthProviders ||
              showPreviewEmulatedAuthProviders ||
              (process.env.VERCEL_AUTH_CLIENT_ID &&
                process.env.VERCEL_AUTH_CLIENT_SECRET)
            )}
          >
            {children}
          </ShellContent>
        </Suspense>
      </body>
    </html>
  );
}
