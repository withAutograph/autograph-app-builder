import { Suspense, ViewTransition } from "react";

import { HandoffLoadingShell } from "../../../ui/route-loading-shell";

import { HandoffContent } from "./handoff-content";

export const metadata = {
  title: "Continue your app | Autograph",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default function HandoffPage(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<HandoffLoadingShell />}>
      {/* Polling and action results must not interrupt the live controls. */}
      <ViewTransition update="none">
        <HandoffContent {...props} />
      </ViewTransition>
    </Suspense>
  );
}
