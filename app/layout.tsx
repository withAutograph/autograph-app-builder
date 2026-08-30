import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";

import { AppShell } from "@/components/app-shell";

import "./globals.css";

export const metadata: Metadata = {
  title: "Autograph App Builder",
  description:
    "Design, plan, create, and validate supported apps with Autograph App Builder.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const showLocalAuthProviders = process.env.NODE_ENV === "development";
  const showPreviewEmulatedAuthProviders =
    process.env.VERCEL_ENV === "preview" &&
    process.env.APP_BUILDER_PREVIEW_PROVIDER_EMULATION === "1";

  return (
    <html lang="en" className={`${GeistSans.className} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <AppShell
          githubAuthEnabled={Boolean(
            showLocalAuthProviders ||
            showPreviewEmulatedAuthProviders ||
            (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
          )}
          vercelAuthEnabled={Boolean(
            showLocalAuthProviders ||
            showPreviewEmulatedAuthProviders ||
            (process.env.VERCEL_AUTH_CLIENT_ID &&
              process.env.VERCEL_AUTH_CLIENT_SECRET),
          )}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
