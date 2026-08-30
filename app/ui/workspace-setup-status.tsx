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
      <main className="flex min-h-svh items-center justify-center p-6">
        <section className="flex w-full max-w-sm flex-col gap-4 text-center">
          <h1 className="text-xl font-semibold">Workspace setup failed</h1>
          <p className="text-sm text-muted-foreground">
            We couldn’t finish setting up your workspace. Please sign in again.
          </p>
          <a
            className="text-sm font-medium underline underline-offset-4"
            href={`/auth/sign-in?callbackURL=${encodeURIComponent(callbackUrl)}`}
          >
            Return to sign in
          </a>
        </section>
      </main>
    );

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <section
        className="flex w-full max-w-sm flex-col items-center gap-4 text-center"
        aria-live="polite"
      >
        <div
          className="size-8 animate-spin rounded-full border-2 border-muted border-t-foreground"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold">{loadingTitle}</h1>
        <p className="text-sm text-muted-foreground">
          This will only take a moment.
        </p>
      </section>
    </main>
  );
}
