import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";

import { Providers } from "@/components/providers";

export function AppShell({
  children,
  githubAuthEnabled = false,
  vercelAuthEnabled = false,
}: {
  children: ReactNode;
  githubAuthEnabled?: boolean;
  vercelAuthEnabled?: boolean;
}) {
  return (
    <div
      className={`${GeistSans.className} flex min-h-screen flex-col bg-background text-foreground antialiased`}
    >
      <Providers
        githubAuthEnabled={githubAuthEnabled}
        vercelAuthEnabled={vercelAuthEnabled}
      >
        {children}
      </Providers>
    </div>
  );
}
