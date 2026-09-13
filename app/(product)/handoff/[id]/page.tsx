import { Suspense, ViewTransition } from "react";

import { HandoffLoadingShell } from "../../../ui/route-loading-shell";

import { HandoffContent } from "./handoff-content";

export const metadata = {
  referrer: "no-referrer" as const,
  robots: { follow: false, index: false },
  title: "Continue your app | Autograph",
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
