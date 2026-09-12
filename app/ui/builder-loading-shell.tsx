type BuilderLoadingShellProps = {
  /**
   * This fallback is reused for the route segment and a page-local Suspense
   * boundary, so it must be useful during client navigations as well.
   */
  title?: string;
};

/** Static shell for request-bound builder content. */
export function BuilderLoadingShell({
  title = "Create an app",
}: BuilderLoadingShellProps) {
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
      <form
        aria-label="Builder form loading"
        className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800"
      >
        <fieldset disabled className="space-y-5">
          <legend className="sr-only">Builder details</legend>
          <label className="grid gap-2 text-sm font-medium">
            App Name
            <input
              aria-label="App Name"
              className="h-10 w-full animate-pulse rounded border-0 bg-neutral-100 dark:bg-neutral-900"
              disabled
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            What should this app do?
            <textarea
              aria-label="What should this app do?"
              className="h-24 w-full animate-pulse resize-none rounded border-0 bg-neutral-100 dark:bg-neutral-900"
              disabled
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Where should we prepare it?
            <select
              aria-label="Where should we prepare it?"
              className="h-10 w-full animate-pulse rounded border-0 bg-neutral-100 dark:bg-neutral-900"
              disabled
              defaultValue=""
            >
              <option value="" />
            </select>
          </label>
        </fieldset>
      </form>
    </main>
  );
}
