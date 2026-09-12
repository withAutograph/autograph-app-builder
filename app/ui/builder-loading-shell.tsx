interface BuilderLoadingShellProps {
  /**
   * This fallback is reused for the route segment and a page-local Suspense
   * boundary, so it must be useful during client navigations as well.
   */
  title?: string;
}

/** Static shell for request-bound builder content. */
export function BuilderLoadingShell({ title = "Create an app" }: BuilderLoadingShellProps) {
  return (
    <main
      id="main-content"
      aria-busy="true"
      className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 p-8"
    >
      <header className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Autograph</p>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground" role="status">
          Preparing your workspace…
        </p>
      </header>
      <section
        aria-label="Builder form loading"
        className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800"
      >
        <div className="space-y-5">
          {[
            ["App Name", "h-10"],
            ["What should this app do?", "h-24"],
            ["Where should we prepare it?", "h-10"],
          ].map(([label, height]) => (
            <div className="grid gap-2 text-sm font-medium" key={label}>
              <p>{label}</p>
              <div
                aria-hidden="true"
                className={`${height} w-full animate-pulse rounded bg-neutral-100 dark:bg-neutral-900`}
              />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
