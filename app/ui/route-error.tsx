"use client";

import { useSyncExternalStore } from "react";

export interface RouteErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
}

const subscribe = () => () => undefined;
const clientReady = () => true;
const serverReady = () => false;

/** Recovery re-fetches the segment through Next, never an application mutation. */
export function RouteError({ retry, title }: RouteErrorProps & { title: string }) {
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <section className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
        <p className="text-sm font-medium text-muted-foreground">Autograph</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm text-muted-foreground" role="alert">
          This page could not be loaded. Try again to reload its latest state.
        </p>
        <button
          type="button"
          disabled={!ready}
          onClick={retry}
          className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Try again
        </button>
      </section>
    </main>
  );
}
