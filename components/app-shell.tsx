import type { ReactNode } from "react";

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
    <div className="app-shell">
      <Providers
        githubAuthEnabled={githubAuthEnabled}
        vercelAuthEnabled={vercelAuthEnabled}
      >
        {children}
      </Providers>
    </div>
  );
}
