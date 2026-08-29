import Link from "next/link";

import type { WorkspaceOnboardingFailure } from "@/lib/auth/workspace-onboarding";

import styles from "./app-builder.module.css";

const content = {
  "workspace-setup-retry": {
    title: "We couldn’t finish setting up your workspace",
    description:
      "Try again. Your progress is safe, and retrying won’t create a duplicate workspace.",
    action: "Try again",
  },
  "workspace-ambiguous": {
    title: "Choose your Autograph workspace",
    description:
      "We found more than one workspace for this account. Contact support to choose the one you want to use.",
    action: "Try again",
  },
  "access-denied": {
    title: "Your workspace isn’t available",
    description:
      "This account can’t access an Autograph workspace. Sign out and use another account, or contact support.",
    action: "Try again",
  },
} satisfies Record<
  WorkspaceOnboardingFailure,
  { title: string; description: string; action: string }
>;

export function WorkspaceOnboarding({
  status,
}: {
  status: WorkspaceOnboardingFailure;
}) {
  const message = content[status];
  return (
    <main className={styles.onboardingPage} id="main-content">
      <section
        className={styles.onboardingCard}
        aria-labelledby="onboarding-title"
      >
        <p className={styles.onboardingBrand}>Autograph</p>
        <h1 id="onboarding-title">{message.title}</h1>
        <p>{message.description}</p>
        <div className={styles.onboardingActions}>
          <Link href="/">{message.action}</Link>
          <Link href="/auth/sign-out">Sign out</Link>
        </div>
      </section>
    </main>
  );
}
