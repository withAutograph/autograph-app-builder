import type { Metadata } from "next";
import type { ReactNode } from "react";

<<<<<<< HEAD
import { AppShell } from "@/components/app-shell";
import { AppShell } from "@/components/app-shell";

import "./globals.css";

export const metadata: Metadata = {
  title: "Autograph App Builder",
  description:
    "Design, plan, create, and validate supported apps with Autograph App Builder.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const showLocalAuthProviders = process.env.NODE_ENV === "development";

  return (
    <html lang="en">
      <body>
        <AppShell
          githubAuthEnabled={Boolean(
            showLocalAuthProviders ||
            (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
          )}
          vercelAuthEnabled={Boolean(
            showLocalAuthProviders ||
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
