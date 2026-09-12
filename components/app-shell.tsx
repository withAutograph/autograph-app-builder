import type { ReactNode } from "react";

import { Providers } from "@/components/providers";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <Providers>{children}</Providers>
    </div>
  );
}
