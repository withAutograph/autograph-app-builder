import { Suspense, ViewTransition } from "react";

import { HandoffContent } from "./handoff-content";

export const metadata = {
  referrer: "no-referrer" as const,
  robots: { follow: false, index: false },
  title: "Continue your app | Autograph",
};

export default function HandoffPage(props: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<main className="min-h-svh" aria-busy="true" />}>
      <ViewTransition>
        <HandoffContent {...props} />
      </ViewTransition>
    </Suspense>
  );
}
