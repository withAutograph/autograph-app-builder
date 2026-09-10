import { Suspense, ViewTransition } from "react";

import { HandoffContent } from "./handoff-content";

export const metadata = {
  title: "Continue your app | Autograph",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
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
