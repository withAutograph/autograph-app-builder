import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "../globals.css";

export const metadata: Metadata = {
  title: {
    default: "Documentation | Autograph App Builder",
    template: "%s | Autograph App Builder",
  },
  description:
    "Get started with Autograph App Builder, from installation to your first app.",
};

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.className} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
