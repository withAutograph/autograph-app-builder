export default function Loading() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 p-8"
    >
      <div className="h-7 w-44 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      <section className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800">
        <div className="h-8 w-48 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
        <div className="mt-4 h-24 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
        <div className="mt-5 h-10 w-32 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      </section>
    </main>
  );
}
