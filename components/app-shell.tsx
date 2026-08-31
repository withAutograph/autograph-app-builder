import type { ReactNode } from "react";

import { Providers } from "@/components/providers";

export function AppShell({
  children,
  githubAuthEnabled = false,
  passkeysEnabled = false,
  vercelAuthEnabled = false,
}: {
  children: ReactNode;
  githubAuthEnabled?: boolean;
  passkeysEnabled?: boolean;
  vercelAuthEnabled?: boolean;
}) {
  return (
    <div className="app-shell">
      <Providers
        githubAuthEnabled={githubAuthEnabled}
        passkeysEnabled={passkeysEnabled}
        vercelAuthEnabled={vercelAuthEnabled}
      >
        {children}
      </Providers>
    </div>
  );
}
