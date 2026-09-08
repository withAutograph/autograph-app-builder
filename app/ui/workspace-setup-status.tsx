import styles from "./workspace-setup-status.module.css";

export function WorkspaceSetupStatus({
  status,
  callbackUrl = "/",
  loadingTitle = "Setting up your workspace…",
}: {
  status: "loading" | "error";
  callbackUrl?: string;
  loadingTitle?: string;
}) {
  if (status === "error")
    return (
      <main className={styles.page}>
        <section className={styles.statusCard}>
          <h1>Workspace setup failed</h1>
          <p>
            We couldn’t finish setting up your workspace. Please sign in again.
          </p>
          <a
            className={styles.primaryAction}
            href={`/auth/sign-in?callbackURL=${encodeURIComponent(callbackUrl)}`}
          >
            Return to sign in
          </a>
        </section>
      </main>
    );

  return (
    <main className={styles.page}>
      <section className={styles.statusCard} aria-live="polite">
        <div className={styles.spinner} aria-hidden="true" />
        <h1>{loadingTitle}</h1>
        <p>This will only take a moment.</p>
      </section>
    </main>
  );
}
