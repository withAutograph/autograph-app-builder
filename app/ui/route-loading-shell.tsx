interface AuthLoadingShellProps {
  title: string;
  description?: string;
  label?: string;
}

/**
 * Static, route-local fallbacks are intentionally free of request state. They
 * are partially prefetched by Next before the authenticated route content is
 * available, so a transition always has useful UI to show.
 */
export function AuthLoadingShell({
  title,
  description = "Preparing secure sign-in…",
  label = "Authentication form loading",
}: AuthLoadingShellProps) {
  return (
    <main aria-busy="true" className="flex min-h-svh items-center justify-center p-6">
      <section
        aria-label={label}
        className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm"
      >
        <p className="text-sm font-medium text-muted-foreground">Autograph</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {description}
        </p>
        <div className="mt-6 space-y-4" aria-hidden="true">
          <div className="h-10 animate-pulse rounded-md bg-muted" />
          <div className="h-10 animate-pulse rounded-md bg-muted" />
          <div className="h-10 animate-pulse rounded-md bg-muted" />
        </div>
      </section>
    </main>
  );
}

interface ProviderConnectionLoadingShellProps {
  description: string;
  title: string;
}

export function ProviderConnectionLoadingShell({
  description,
  title,
}: ProviderConnectionLoadingShellProps) {
  return (
    <main className="min-h-svh bg-background text-foreground" aria-busy="true">
      <header className="flex h-14 items-center border-b bg-background px-4 text-sm sm:px-8">
        <span className="text-muted-foreground">Back</span>
        <span className="mx-auto font-medium">New App</span>
        <span aria-hidden="true" className="w-12" />
      </header>
      <section
        aria-label="Provider connection loading"
        className="mx-auto mt-8 w-[calc(100%-2rem)] max-w-md rounded-xl border bg-card p-6 shadow-sm sm:mt-12"
      >
        <p className="text-sm font-medium text-muted-foreground">Autograph</p>
        <h1 className="mt-3 text-xl font-semibold">{title}</h1>
        <p className="mt-3 leading-6 text-muted-foreground">{description}</p>
        <p className="mt-5 text-sm text-muted-foreground" role="status">
          Preparing connection options…
        </p>
        <div aria-hidden="true" className="mt-5 h-10 animate-pulse rounded-md bg-muted" />
      </section>
    </main>
  );
}

export function HandoffLoadingShell() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 p-8"
    >
      <header className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Autograph</p>
        <h1 className="text-3xl font-semibold tracking-tight">Continue your app</h1>
        <p className="text-muted-foreground" role="status">
          Loading your saved handoff…
        </p>
      </header>
      <section
        aria-label="Handoff loading"
        className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800"
      >
        <div className="h-5 w-48 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
        <div className="mt-5 h-16 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
        <div className="mt-5 h-10 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
      </section>
    </main>
  );
}
