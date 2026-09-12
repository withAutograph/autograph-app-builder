import type { ReactNode } from "react";

import { RouteProviders } from "@/components/route-providers";
import { AuthLoadingShell } from "@/app/ui/route-loading-shell";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RouteProviders fallback={<AuthLoadingShell title="Signing out of Autograph" />}>
      {children}
    </RouteProviders>
  );
}
