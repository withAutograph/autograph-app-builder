import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { GeistSans } from "geist/font/sans";

import { AppShell } from "@/components/app-shell";
import { passkeysFlag } from "@/lib/feature-flags";

import "../globals.css";

export const metadata: Metadata = {
  title: "Autograph App Builder",
  description: "Design, plan, create, and validate supported apps with Autograph App Builder.",
};

function ShellLoading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 p-8"
    >
      <header className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Autograph</p>
        <h1 className="text-3xl font-semibold tracking-tight">Autograph App Builder</h1>
        <p className="text-muted-foreground" role="status">
          Loading your workspace…
        </p>
      </header>
      <section
        aria-label="App Builder loading"
        className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800"
      >
        <div className="h-5 w-40 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
        <div className="mt-4 h-10 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
      </section>
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

export default async function RootLayout({ children }: { children: ReactNode }) {
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
      <body className="min-h-full flex flex-col">
        <Suspense fallback={<ShellLoading />}>
          <ShellContent
            githubAuthEnabled={Boolean(
              showLocalAuthProviders ||
              showPreviewEmulatedAuthProviders ||
              (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
            )}
            vercelAuthEnabled={Boolean(
              showLocalAuthProviders ||
              showPreviewEmulatedAuthProviders ||
              (process.env.VERCEL_AUTH_CLIENT_ID && process.env.VERCEL_AUTH_CLIENT_SECRET),
            )}
          >
            {children}
          </ShellContent>
        </Suspense>
      </body>
    </html>
  );
}
