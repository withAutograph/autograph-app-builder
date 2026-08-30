import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${GeistSans.className} min-h-screen bg-background text-foreground antialiased`}
    >
      {children}
    </div>
  );
}
